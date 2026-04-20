/**
 * modules/earn/service.ts
 * Earn orchestration: list strategies, execute deposits/withdrawals, track positions.
 */

import type { SQL } from 'postgres';
import { generateUUID, nowISO, isValidAmount } from '@finlayer/utils';
import type {
  UUID,
  EarnStrategy,
  EarnPosition,
  EarnDepositRequest,
  EarnDepositResponse,
  EarnStrategiesResponse,
  EarnWithdrawRequest,
  EarnWithdrawResponse,
  EarnPositionsResponse,
} from '@finlayer/types';
import type { IEarnProviderAdapter, EarnStrategyResult } from '../shared/types/index.js';
import {
  ValidationError,
  IdempotencyError,
  DuplicateIdempotencyKeyError,
  EarnStrategyNotFoundError,
  EarnPositionNotFoundError,
  EarnDepositBelowMinimumError,
  EarnPositionLockedError,
} from '../shared/errors/index.js';
import { RevenueService } from '../swap/revenue.js';
import { logger } from '../shared/utils/logger.js';
import { DEFAULT_REVENUE_CONFIG } from '../shared/types/index.js';

interface DbEarnPosition {
  id: string;
  user_id: string;
  provider_id: string;
  provider_name: string;
  provider_strategy_id: string;
  provider_position_id: string | null;
  asset: string;
  network: string;
  deposited_amount: string;
  current_value: string;
  earned_yield: string;
  status: 'pending' | 'active' | 'withdrawn';
  deposit_tx_hash: string | null;
  deposit_transaction_id: string | null;
  unlocks_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class EarnService {
  private readonly revenueService: RevenueService;

  constructor(
    private readonly sql: SQL,
    /** Map of provider.name → adapter instance. */
    private readonly providers: Map<string, IEarnProviderAdapter>
  ) {
    this.revenueService = new RevenueService(sql, DEFAULT_REVENUE_CONFIG);
  }

  /**
   * List yield strategies across all active earn providers.
   * Queries adapters live so APY is always fresh (rate-limited internally).
   */
  async listStrategies(filter?: { asset?: string }): Promise<EarnStrategiesResponse> {
    const providerRows = await this.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM providers
      WHERE domain = 'earn' AND is_active = TRUE
      ORDER BY priority DESC
    `;

    const strategyPromises = providerRows.map(async (row) => {
      const adapter = this.providers.get(row.name);
      if (!adapter) return [];
      try {
        const results = await adapter.getStrategies();
        return results.map((s) => this.toApiStrategy(s, row.id, row.name));
      } catch (err) {
        logger.warn(`Earn provider ${row.name} list failed`, { error: String(err) });
        return [];
      }
    });

    const all = (await Promise.all(strategyPromises)).flat();
    const filtered = filter?.asset
      ? all.filter((s) => s.asset.toUpperCase() === filter.asset!.toUpperCase())
      : all;

    return { strategies: filtered };
  }

  /**
   * Initiate a deposit into an earn strategy.
   * Creates a transaction record and an earn_positions row in 'pending' state.
   */
  async deposit(userId: UUID, request: EarnDepositRequest): Promise<EarnDepositResponse> {
    if (!request.idempotency_key) {
      throw new IdempotencyError();
    }
    if (!isValidAmount(request.amount)) {
      throw new ValidationError(`Invalid amount: ${request.amount}`);
    }

    // Duplicate idempotency check
    const [dup] = await this.sql<{ id: string }[]>`
      SELECT id FROM transactions WHERE idempotency_key = ${request.idempotency_key}
    `;
    if (dup) {
      throw new DuplicateIdempotencyKeyError(dup.id);
    }

    // strategy_id in the API is our composite: "<provider_id>:<provider_strategy_id>"
    const { providerId, providerStrategyId } = this.parseStrategyId(request.strategy_id);

    const [providerRow] = await this.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM providers WHERE id = ${providerId} AND domain = 'earn' AND is_active = TRUE
    `;
    if (!providerRow) {
      throw new EarnStrategyNotFoundError(request.strategy_id);
    }
    const adapter = this.providers.get(providerRow.name);
    if (!adapter) {
      throw new EarnStrategyNotFoundError(request.strategy_id);
    }

    const strategy = await adapter.getStrategy(providerStrategyId);
    if (!strategy) {
      throw new EarnStrategyNotFoundError(request.strategy_id);
    }

    if (parseFloat(request.amount) < parseFloat(strategy.minDeposit)) {
      throw new EarnDepositBelowMinimumError(strategy.minDeposit, strategy.asset);
    }

    // Execute deposit on provider
    const depositResult = await adapter.deposit({
      strategyId: providerStrategyId,
      amount: request.amount,
      fromAddress: request.from_address,
    });

    const txId = generateUUID();
    const positionId = generateUUID();
    const now = nowISO();
    const unlocksAt =
      strategy.lockPeriodDays > 0
        ? new Date(Date.now() + strategy.lockPeriodDays * 86_400_000).toISOString()
        : null;

    await this.sql`
      INSERT INTO transactions (
        id, type, domain, status, user_id,
        from_asset, to_asset, amount,
        provider_id, provider_tx_id,
        idempotency_key, affiliate_id,
        metadata, created_at, updated_at
      ) VALUES (
        ${txId}, 'earn_deposit', 'earn', ${depositResult.status},
        ${userId}, ${strategy.asset}, ${null},
        ${request.amount}, ${providerRow.id},
        ${depositResult.providerPositionId},
        ${request.idempotency_key},
        ${request.affiliate_id ?? null},
        ${JSON.stringify({
          earn: {
            strategy_id: request.strategy_id,
            provider_strategy_id: providerStrategyId,
            from_address: request.from_address,
            deposit_address: depositResult.depositAddress,
            apy_at_deposit: strategy.apy,
            protocol: strategy.protocol,
          },
        })},
        ${now}, ${now}
      )
    `;

    await this.sql`
      INSERT INTO earn_positions (
        id, user_id, provider_id,
        provider_strategy_id, provider_position_id,
        asset, network,
        deposited_amount, current_value, earned_yield,
        status, deposit_transaction_id, unlocks_at,
        created_at, updated_at
      ) VALUES (
        ${positionId}, ${userId}, ${providerRow.id},
        ${providerStrategyId}, ${depositResult.providerPositionId},
        ${strategy.asset}, ${strategy.network},
        ${request.amount}, ${request.amount}, ${'0'},
        'pending', ${txId}, ${unlocksAt},
        ${now}, ${now}
      )
    `;

    const platformFee = this.revenueService.calculatePlatformFee(request.amount);
    const revenueEventId = await this.revenueService.createRevenueEvent({
      transactionId: txId,
      domain: 'earn',
      totalFee: platformFee,
      feeAsset: strategy.asset,
      affiliateId: request.affiliate_id,
    });

    await this.sql`
      UPDATE transactions SET revenue_event_id = ${revenueEventId} WHERE id = ${txId}
    `;

    logger.info('Earn deposit executed', {
      txId,
      positionId,
      provider: providerRow.name,
      asset: strategy.asset,
      amount: request.amount,
    });

    const apiStrategy = this.toApiStrategy(strategy, providerRow.id, providerRow.name);

    const position: EarnPosition = {
      id: positionId,
      strategy: apiStrategy,
      deposited_amount: request.amount,
      current_value: request.amount,
      earned_yield: '0',
      status: 'pending',
      deposit_tx_hash: null,
      deposit_address: depositResult.depositAddress,
      unlocks_at: unlocksAt,
      created_at: now,
      updated_at: now,
    };

    return {
      position,
      deposit_address: depositResult.depositAddress,
      transaction_id: txId,
    };
  }

  /**
   * Withdraw from an earn position.
   */
  async withdraw(userId: UUID, request: EarnWithdrawRequest): Promise<EarnWithdrawResponse> {
    if (!request.idempotency_key) {
      throw new IdempotencyError();
    }

    const [dup] = await this.sql<{ id: string }[]>`
      SELECT id FROM transactions WHERE idempotency_key = ${request.idempotency_key}
    `;
    if (dup) {
      throw new DuplicateIdempotencyKeyError(dup.id);
    }

    const [row] = await this.sql<(DbEarnPosition & { provider_name: string })[]>`
      SELECT ep.*, p.name AS provider_name
      FROM earn_positions ep
      JOIN providers p ON p.id = ep.provider_id
      WHERE ep.id = ${request.position_id} AND ep.user_id = ${userId}
    `;
    if (!row) {
      throw new EarnPositionNotFoundError(request.position_id);
    }
    if (row.status === 'withdrawn') {
      throw new ValidationError('Position has already been withdrawn');
    }
    if (row.unlocks_at && row.unlocks_at > new Date()) {
      throw new EarnPositionLockedError(row.unlocks_at.toISOString());
    }

    const adapter = this.providers.get(row.provider_name);
    if (!adapter) {
      throw new ValidationError(`Earn provider ${row.provider_name} is not available`);
    }
    if (!row.provider_position_id) {
      throw new ValidationError('Position has no provider_position_id — still pending');
    }

    const withdrawResult = await adapter.withdraw({
      providerPositionId: row.provider_position_id,
      toAddress: request.to_address,
    });

    const txId = generateUUID();
    const now = nowISO();

    await this.sql`
      INSERT INTO transactions (
        id, type, domain, status, user_id,
        from_asset, to_asset, amount,
        provider_id, provider_tx_id,
        idempotency_key, affiliate_id,
        metadata, created_at, updated_at
      ) VALUES (
        ${txId}, 'earn_withdraw', 'earn', ${withdrawResult.status},
        ${userId}, ${row.asset}, ${null},
        ${withdrawResult.withdrawnAmount ?? row.current_value},
        ${row.provider_id}, ${withdrawResult.txHash},
        ${request.idempotency_key},
        ${request.affiliate_id ?? null},
        ${JSON.stringify({
          earn: {
            position_id: request.position_id,
            provider_position_id: row.provider_position_id,
            to_address: request.to_address,
            tx_hash: withdrawResult.txHash,
          },
        })},
        ${now}, ${now}
      )
    `;

    await this.sql`
      UPDATE earn_positions
      SET status = 'withdrawn', updated_at = NOW()
      WHERE id = ${request.position_id}
    `;

    logger.info('Earn withdraw executed', {
      txId,
      positionId: request.position_id,
      provider: row.provider_name,
    });

    const position = await this.buildPositionFromRow(
      { ...row, status: 'withdrawn', updated_at: new Date(now) },
      adapter
    );

    return {
      position,
      tx_hash: withdrawResult.txHash,
      transaction_id: txId,
    };
  }

  /**
   * List a user's earn positions. Refreshes current_value from providers for active positions.
   */
  async listPositions(userId: UUID): Promise<EarnPositionsResponse> {
    const rows = await this.sql<(DbEarnPosition & { provider_name: string })[]>`
      SELECT ep.*, p.name AS provider_name
      FROM earn_positions ep
      JOIN providers p ON p.id = ep.provider_id
      WHERE ep.user_id = ${userId}
      ORDER BY ep.created_at DESC
    `;

    const positions = await Promise.all(
      rows.map(async (row) => {
        const adapter = this.providers.get(row.provider_name);
        return this.buildPositionFromRow(row, adapter);
      })
    );

    return { positions };
  }

  /**
   * Get a single position with fresh current_value.
   */
  async getPosition(userId: UUID, positionId: UUID): Promise<EarnPosition> {
    const [row] = await this.sql<(DbEarnPosition & { provider_name: string })[]>`
      SELECT ep.*, p.name AS provider_name
      FROM earn_positions ep
      JOIN providers p ON p.id = ep.provider_id
      WHERE ep.id = ${positionId} AND ep.user_id = ${userId}
    `;
    if (!row) {
      throw new EarnPositionNotFoundError(positionId);
    }
    const adapter = this.providers.get(row.provider_name);
    return this.buildPositionFromRow(row, adapter);
  }

  private parseStrategyId(id: string): { providerId: string; providerStrategyId: string } {
    const idx = id.indexOf(':');
    if (idx <= 0) {
      throw new ValidationError(
        'strategy_id must be formatted as "<provider_id>:<provider_strategy_id>"'
      );
    }
    return { providerId: id.slice(0, idx), providerStrategyId: id.slice(idx + 1) };
  }

  private toApiStrategy(
    s: EarnStrategyResult,
    providerId: string,
    providerName: string
  ): EarnStrategy {
    return {
      id: `${providerId}:${s.providerStrategyId}`,
      provider_id: providerId,
      provider_name: providerName,
      asset: s.asset,
      network: s.network,
      apy: s.apy,
      apy_30d: s.apy30d,
      risk_level: s.riskLevel,
      min_deposit: s.minDeposit,
      max_deposit: s.maxDeposit ?? null,
      lock_period_days: s.lockPeriodDays,
      is_active: true,
      description: s.description,
      protocol: s.protocol,
    };
  }

  private async buildPositionFromRow(
    row: DbEarnPosition & { provider_name: string },
    adapter?: IEarnProviderAdapter
  ): Promise<EarnPosition> {
    let currentValue = row.current_value;
    let earnedYield = row.earned_yield;
    let status = row.status;

    // Refresh live value for active positions if adapter available.
    if (adapter && row.provider_position_id && status === 'active') {
      try {
        const live = await adapter.getPosition(row.provider_position_id);
        currentValue = live.currentValue;
        earnedYield = live.earnedYield;
        status = live.status;

        await this.sql`
          UPDATE earn_positions
          SET current_value = ${currentValue},
              earned_yield  = ${earnedYield},
              status        = ${status},
              updated_at    = NOW()
          WHERE id = ${row.id}
        `;
      } catch (err) {
        logger.warn('Failed to refresh earn position', { positionId: row.id, error: String(err) });
      }
    }

    let apiStrategy: EarnStrategy;
    if (adapter) {
      const s = await adapter.getStrategy(row.provider_strategy_id);
      apiStrategy = s
        ? this.toApiStrategy(s, row.provider_id, row.provider_name)
        : this.strategyStub(row);
    } else {
      apiStrategy = this.strategyStub(row);
    }

    return {
      id: row.id,
      strategy: apiStrategy,
      deposited_amount: row.deposited_amount,
      current_value: currentValue,
      earned_yield: earnedYield,
      status,
      deposit_tx_hash: row.deposit_tx_hash,
      deposit_address: null,
      unlocks_at: row.unlocks_at ? row.unlocks_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  private strategyStub(row: DbEarnPosition & { provider_name: string }): EarnStrategy {
    return {
      id: `${row.provider_id}:${row.provider_strategy_id}`,
      provider_id: row.provider_id,
      provider_name: row.provider_name,
      asset: row.asset,
      network: row.network,
      apy: '0',
      apy_30d: '0',
      risk_level: 'medium',
      min_deposit: '0',
      max_deposit: null,
      lock_period_days: 0,
      is_active: true,
      description: '',
      protocol: row.provider_name,
    };
  }
}
