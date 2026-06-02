/**
 * E2E tests for earn flow (mock provider).
 * Tests: list strategies → deposit → position refresh → withdraw
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { EarnService } from '../../../../modules/earn/service.js';
import { AaveV3Adapter, aaveLiquidityRateToApy, type AaveRpcClient } from '../../../../modules/providers/aave/adapter.js';
import { CompoundV3Adapter, type CompoundRpcClient } from '../../../../modules/providers/compound/adapter.js';
import { MockEarnProvider } from './mock-earn-provider.js';
import { createMockSql, createTestUserId } from './setup.js';
import { generateUUID } from '@finlayer/utils';
import type { IEarnProviderAdapter } from '../../../../modules/shared/types/index.js';
import {
  ValidationError,
  IdempotencyError,
  DuplicateIdempotencyKeyError,
  EarnStrategyNotFoundError,
  EarnPositionNotFoundError,
  EarnDepositBelowMinimumError,
  EarnPositionLockedError,
} from '../../../../modules/shared/errors/index.js';

describe('Earn Service — Strategies', () => {
  let service: EarnService;
  let mockProvider: MockEarnProvider;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockProvider = new MockEarnProvider();
    mockSql = createMockSql();
    const adapters = new Map<string, IEarnProviderAdapter>([
      ['MockEarnProvider', mockProvider],
    ]);
    service = new EarnService(mockSql as never, adapters);
  });

  test('listStrategies returns strategies from all earn providers', async () => {
    const { strategies } = await service.listStrategies();
    expect(strategies.length).toBeGreaterThanOrEqual(3);
    const usdc = strategies.find((s) => s.asset === 'USDC');
    expect(usdc).toBeDefined();
    expect(parseFloat(usdc!.apy)).toBeGreaterThan(0);
    expect(usdc!.protocol).toBe('MockProtocol');
    expect(usdc!.id).toContain(':mock-usdc-strategy');
  });

  test('listStrategies filters by asset', async () => {
    const { strategies } = await service.listStrategies({ asset: 'USDC' });
    expect(strategies.length).toBe(1);
    expect(strategies[0]!.asset).toBe('USDC');
  });

  test('listStrategies filter is case-insensitive', async () => {
    const { strategies } = await service.listStrategies({ asset: 'usdc' });
    expect(strategies.length).toBe(1);
  });
});

describe('Earn Service — Deposit', () => {
  let service: EarnService;
  let mockProvider: MockEarnProvider;
  let userId: string;
  let mockSql: ReturnType<typeof createMockSql>;
  let usdcStrategyId: string;
  let lockedStrategyId: string;

  beforeEach(async () => {
    mockProvider = new MockEarnProvider();
    mockSql = createMockSql();
    const adapters = new Map<string, IEarnProviderAdapter>([
      ['MockEarnProvider', mockProvider],
    ]);
    service = new EarnService(mockSql as never, adapters);
    userId = createTestUserId();

    const { strategies } = await service.listStrategies();
    usdcStrategyId = strategies.find((s) => s.asset === 'USDC')!.id;
    lockedStrategyId = strategies.find((s) => s.lock_period_days > 0)!.id;
  });

  test('deposit creates a pending earn position and transaction', async () => {
    const result = await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });

    expect(result.position.id).toBeDefined();
    expect(result.position.status).toBe('pending');
    expect(result.position.deposited_amount).toBe('100');
    expect(result.position.strategy.asset).toBe('USDC');
    expect(result.deposit_address.startsWith('mock_deposit_')).toBe(true);
    expect(result.transaction_id).toBeDefined();

    // Transaction stored in mock DB
    const txs = mockSql._tables.get('transactions') ?? [];
    const tx = txs.find((t) => t['id'] === result.transaction_id);
    expect(tx).toBeDefined();
    expect(tx!['type']).toBe('earn_deposit');
    expect(tx!['domain']).toBe('earn');

    // Position stored
    const positions = mockSql._tables.get('earn_positions') ?? [];
    const pos = positions.find((p) => p['id'] === result.position.id);
    expect(pos).toBeDefined();
    expect(pos!['provider_position_id']).toBeTruthy();
  });

  test('deposit creates a revenue event with earn domain', async () => {
    const result = await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '1000',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });

    const events = mockSql._tables.get('revenue_events') ?? [];
    const event = events.find((e) => e['transaction_id'] === result.transaction_id);
    expect(event).toBeDefined();
    expect(event!['source_domain']).toBe('earn');
    // 0.3% of 1000 = 3
    expect(parseFloat(String(event!['total_fee']))).toBeCloseTo(3.0, 5);
  });

  test('deposit without idempotency_key throws IdempotencyError', async () => {
    await expect(
      service.deposit(userId, {
        strategy_id: usdcStrategyId,
        amount: '100',
        from_address: '0xAliceAddress',
        idempotency_key: '',
      })
    ).rejects.toBeInstanceOf(IdempotencyError);
  });

  test('duplicate idempotency_key throws DuplicateIdempotencyKeyError', async () => {
    const key = generateUUID();
    await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: key,
    });
    await expect(
      service.deposit(userId, {
        strategy_id: usdcStrategyId,
        amount: '100',
        from_address: '0xAliceAddress',
        idempotency_key: key,
      })
    ).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
  });

  test('invalid amount throws ValidationError', async () => {
    await expect(
      service.deposit(userId, {
        strategy_id: usdcStrategyId,
        amount: '-1',
        from_address: '0xAliceAddress',
        idempotency_key: generateUUID(),
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('below-minimum amount throws EarnDepositBelowMinimumError', async () => {
    // USDC min is 1; try 0.5
    await expect(
      service.deposit(userId, {
        strategy_id: usdcStrategyId,
        amount: '0.5',
        from_address: '0xAliceAddress',
        idempotency_key: generateUUID(),
      })
    ).rejects.toBeInstanceOf(EarnDepositBelowMinimumError);
  });

  test('unknown strategy_id throws EarnStrategyNotFoundError', async () => {
    // Build an id with a valid provider but bogus strategy path.
    const providerId = usdcStrategyId.split(':')[0]!;
    await expect(
      service.deposit(userId, {
        strategy_id: `${providerId}:does-not-exist`,
        amount: '100',
        from_address: '0xAliceAddress',
        idempotency_key: generateUUID(),
      })
    ).rejects.toBeInstanceOf(EarnStrategyNotFoundError);
  });

  test('locked strategy sets unlocks_at in the future', async () => {
    const result = await service.deposit(userId, {
      strategy_id: lockedStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });
    expect(result.position.unlocks_at).toBeTruthy();
    expect(new Date(result.position.unlocks_at!).getTime()).toBeGreaterThan(Date.now());
  });

  test('concurrent deposits with the same key call the provider exactly once (issue #15)', async () => {
    const key = generateUUID();
    // Widen the race window so both requests overlap inside deposit().
    mockProvider.depositDelayMs = 25;

    const results = await Promise.allSettled([
      service.deposit(userId, {
        strategy_id: usdcStrategyId,
        amount: '100',
        from_address: '0xAliceAddress',
        idempotency_key: key,
      }),
      service.deposit(userId, {
        strategy_id: usdcStrategyId,
        amount: '100',
        from_address: '0xAliceAddress',
        idempotency_key: key,
      }),
    ]);

    // Exactly one provider call — the core acceptance criterion.
    expect(mockProvider.depositCalls).toBe(1);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DuplicateIdempotencyKeyError
    );

    const txs = (mockSql._tables.get('transactions') ?? []).filter(
      (t) => t['idempotency_key'] === key
    );
    expect(txs.length).toBe(1);
  });

  test('deposit provider failure releases the reservation so the key can be retried (issue #15)', async () => {
    const key = generateUUID();

    // First attempt: provider throws — reservation must be rolled back.
    mockProvider.forceDepositError = true;
    await expect(
      service.deposit(userId, {
        strategy_id: usdcStrategyId,
        amount: '100',
        from_address: '0xAliceAddress',
        idempotency_key: key,
      })
    ).rejects.toThrow();

    let txs = (mockSql._tables.get('transactions') ?? []).filter(
      (t) => t['idempotency_key'] === key
    );
    expect(txs.length).toBe(0);

    // Retry with the same key now succeeds.
    mockProvider.forceDepositError = false;
    const result = await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: key,
    });
    expect(result.transaction_id).toBeDefined();
    expect(mockProvider.depositCalls).toBe(2);

    txs = (mockSql._tables.get('transactions') ?? []).filter(
      (t) => t['idempotency_key'] === key
    );
    expect(txs.length).toBe(1);
  });
});

describe('Earn Service — Positions & Withdraw', () => {
  let service: EarnService;
  let mockProvider: MockEarnProvider;
  let userId: string;
  let mockSql: ReturnType<typeof createMockSql>;
  let usdcStrategyId: string;
  let lockedStrategyId: string;

  beforeEach(async () => {
    mockProvider = new MockEarnProvider();
    mockSql = createMockSql();
    const adapters = new Map<string, IEarnProviderAdapter>([
      ['MockEarnProvider', mockProvider],
    ]);
    service = new EarnService(mockSql as never, adapters);
    userId = createTestUserId();
    const { strategies } = await service.listStrategies();
    usdcStrategyId = strategies.find((s) => s.asset === 'USDC')!.id;
    lockedStrategyId = strategies.find((s) => s.lock_period_days > 0)!.id;
  });

  test('listPositions returns positions for the user', async () => {
    await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });
    const { positions } = await service.listPositions(userId);
    expect(positions.length).toBe(1);
    expect(positions[0]!.deposited_amount).toBe('100');
  });

  test('getPosition refreshes current_value from adapter when active', async () => {
    const dep = await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });
    // Flip row to active so refresh logic runs.
    const positions = mockSql._tables.get('earn_positions') ?? [];
    const posRow = positions.find((p) => p['id'] === dep.position.id)!;
    posRow['status'] = 'active';

    mockProvider.simulateYield(posRow['provider_position_id'] as string, '5');

    const position = await service.getPosition(userId, dep.position.id);
    expect(position.status).toBe('active');
    expect(parseFloat(position.current_value)).toBeCloseTo(105, 5);
    expect(parseFloat(position.earned_yield)).toBeCloseTo(5, 5);
  });

  test('getPosition throws EarnPositionNotFoundError for unknown id', async () => {
    await expect(service.getPosition(userId, generateUUID())).rejects.toBeInstanceOf(
      EarnPositionNotFoundError
    );
  });

  test('withdraw marks position withdrawn and records transaction', async () => {
    const dep = await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });
    const positions = mockSql._tables.get('earn_positions') ?? [];
    const posRow = positions.find((p) => p['id'] === dep.position.id)!;
    posRow['status'] = 'active';

    const res = await service.withdraw(userId, {
      position_id: dep.position.id,
      to_address: '0xReceiver',
      idempotency_key: generateUUID(),
    });

    expect(res.tx_hash).toMatch(/^0xmock_withdraw_/);
    expect(res.position.status).toBe('withdrawn');
    expect(posRow['status']).toBe('withdrawn');

    const txs = mockSql._tables.get('transactions') ?? [];
    const wTx = txs.find((t) => t['id'] === res.transaction_id);
    expect(wTx!['type']).toBe('earn_withdraw');
  });

  test('withdraw on locked position throws EarnPositionLockedError', async () => {
    const dep = await service.deposit(userId, {
      strategy_id: lockedStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });
    const positions = mockSql._tables.get('earn_positions') ?? [];
    const posRow = positions.find((p) => p['id'] === dep.position.id)!;
    posRow['status'] = 'active';

    await expect(
      service.withdraw(userId, {
        position_id: dep.position.id,
        to_address: '0xReceiver',
        idempotency_key: generateUUID(),
      })
    ).rejects.toBeInstanceOf(EarnPositionLockedError);
  });

  test('concurrent withdrawals with the same key call the provider exactly once (issue #15)', async () => {
    const dep = await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });
    const positions = mockSql._tables.get('earn_positions') ?? [];
    const posRow = positions.find((p) => p['id'] === dep.position.id)!;
    posRow['status'] = 'active';

    const key = generateUUID();
    // Widen the race window so both requests overlap inside withdraw().
    mockProvider.withdrawDelayMs = 25;

    const results = await Promise.allSettled([
      service.withdraw(userId, {
        position_id: dep.position.id,
        to_address: '0xReceiver',
        idempotency_key: key,
      }),
      service.withdraw(userId, {
        position_id: dep.position.id,
        to_address: '0xReceiver',
        idempotency_key: key,
      }),
    ]);

    // Exactly one provider call — the core acceptance criterion.
    expect(mockProvider.withdrawCalls).toBe(1);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DuplicateIdempotencyKeyError
    );

    const txs = (mockSql._tables.get('transactions') ?? []).filter(
      (t) => t['idempotency_key'] === key
    );
    expect(txs.length).toBe(1);
  });

  test('withdraw provider failure releases the reservation so the key can be retried (issue #15)', async () => {
    const dep = await service.deposit(userId, {
      strategy_id: usdcStrategyId,
      amount: '100',
      from_address: '0xAliceAddress',
      idempotency_key: generateUUID(),
    });
    const positions = mockSql._tables.get('earn_positions') ?? [];
    const posRow = positions.find((p) => p['id'] === dep.position.id)!;
    posRow['status'] = 'active';

    const key = generateUUID();

    // First attempt: provider throws — reservation must be rolled back.
    mockProvider.forceWithdrawError = true;
    await expect(
      service.withdraw(userId, {
        position_id: dep.position.id,
        to_address: '0xReceiver',
        idempotency_key: key,
      })
    ).rejects.toThrow();

    let txs = (mockSql._tables.get('transactions') ?? []).filter(
      (t) => t['idempotency_key'] === key
    );
    expect(txs.length).toBe(0);

    // Retry with the same key now succeeds.
    mockProvider.forceWithdrawError = false;
    const res = await service.withdraw(userId, {
      position_id: dep.position.id,
      to_address: '0xReceiver',
      idempotency_key: key,
    });
    expect(res.transaction_id).toBeDefined();
    expect(mockProvider.withdrawCalls).toBe(2);

    txs = (mockSql._tables.get('transactions') ?? []).filter(
      (t) => t['idempotency_key'] === key
    );
    expect(txs.length).toBe(1);
  });
});

describe('Aave V3 Adapter', () => {
  test('aaveLiquidityRateToApy converts ray rate to APY percentage', () => {
    // 1e26 ray/s ≈ ~315% APY; test a realistic rate
    // 3% APY target: rate = 0.03 / SECONDS_PER_YEAR * 1e27
    const targetApy = 3;
    const rate = ((targetApy / 100) / 31_536_000) * 1e27;
    const apy = parseFloat(aaveLiquidityRateToApy(rate.toString()));
    expect(apy).toBeCloseTo(3, 3);
  });

  test('adapter lists strategies from Aave API and filters by supported assets', async () => {
    const rpcClient: AaveRpcClient = {
      deposit: async () => ({ txHash: '0x', depositAddress: '0x', providerPositionId: 'p' }),
      withdraw: async () => ({ txHash: '0x', withdrawnAmount: '0' }),
      getPosition: async () => ({
        status: 'active',
        depositedAmount: '0',
        currentValue: '0',
        asset: 'USDC',
        network: 'ethereum',
      }),
    };
    const rate3Pct = (((3 / 100) / 31_536_000) * 1e27).toString();
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          reserves: [
            { symbol: 'USDC', liquidityRate: rate3Pct, aTokenAddress: '0xA', underlyingAsset: '0xu' },
            { symbol: 'FOO', liquidityRate: rate3Pct, aTokenAddress: '0xB', underlyingAsset: '0xu' },
          ],
        }),
        { status: 200 }
      );
    const adapter = new AaveV3Adapter({ rpcClient, fetchFn });
    const strategies = await adapter.getStrategies();
    expect(strategies.length).toBe(1);
    expect(strategies[0]!.asset).toBe('USDC');
    expect(strategies[0]!.protocol).toBe('Aave V3');
    expect(parseFloat(strategies[0]!.apy)).toBeCloseTo(3, 3);
  });

  test('adapter.deposit delegates to rpcClient and returns provider position id', async () => {
    const rate = (((1 / 100) / 31_536_000) * 1e27).toString();
    const rpcClient: AaveRpcClient = {
      deposit: async (input) => ({
        txHash: '0xdep',
        depositAddress: '0xPool',
        providerPositionId: `pos_${input.asset}`,
      }),
      withdraw: async () => ({ txHash: '0xw', withdrawnAmount: '0' }),
      getPosition: async () => ({
        status: 'active',
        depositedAmount: '10',
        currentValue: '10.5',
        asset: 'USDC',
        network: 'ethereum',
      }),
    };
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          reserves: [
            { symbol: 'USDC', liquidityRate: rate, aTokenAddress: '0xA', underlyingAsset: '0xu' },
          ],
        }),
        { status: 200 }
      );
    const adapter = new AaveV3Adapter({ rpcClient, fetchFn });
    const res = await adapter.deposit({ strategyId: '0xA', amount: '10', fromAddress: '0xUser' });
    expect(res.providerPositionId).toBe('pos_USDC');
    expect(res.status).toBe('processing');
  });
});

describe('Compound V3 Adapter', () => {
  test('adapter lists markets from Compound API and filters by supported assets', async () => {
    const rpcClient: CompoundRpcClient = {
      deposit: async () => ({ txHash: '0x', depositAddress: '0x', providerPositionId: 'p' }),
      withdraw: async () => ({ txHash: '0x', withdrawnAmount: '0' }),
      getPosition: async () => ({
        status: 'active',
        depositedAmount: '0',
        currentValue: '0',
        asset: 'USDC',
        network: 'ethereum',
      }),
    };
    const fetchFn: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          markets: [
            {
              cometAddress: '0xC',
              baseAsset: { symbol: 'USDC', decimals: 6 },
              supplyApr: '0.0412',
              chain: 'ethereum',
            },
            {
              cometAddress: '0xD',
              baseAsset: { symbol: 'FOO', decimals: 6 },
              supplyApr: '0.02',
              chain: 'ethereum',
            },
          ],
        }),
        { status: 200 }
      );
    const adapter = new CompoundV3Adapter({ rpcClient, fetchFn });
    const strategies = await adapter.getStrategies();
    expect(strategies.length).toBe(1);
    expect(strategies[0]!.asset).toBe('USDC');
    expect(strategies[0]!.protocol).toBe('Compound V3');
    expect(parseFloat(strategies[0]!.apy)).toBeCloseTo(4.12, 2);
  });
});
