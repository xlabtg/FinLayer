/**
 * modules/swap/service.ts
 * Swap orchestration: route quotes, execute swaps, track revenue.
 */

import type { SQL } from 'postgres';
import { generateUUID, nowISO, futureISO, isValidAmount, isValidAssetTicker } from '@finlayer/utils';
import type {
  UUID,
  SwapQuote,
  SwapQuoteRequest,
  SwapQuoteResponse,
  SwapExecuteRequest,
  SwapTransaction,
  TransactionStatus,
} from '@finlayer/types';
import type { ISwapProviderAdapter } from '../shared/types/index.js';
import {
  ValidationError,
  QuoteExpiredError,
  QuoteNotFoundError,
  TransactionNotFoundError,
  DuplicateIdempotencyKeyError,
  IdempotencyError,
  InvalidWebhookSignatureError,
} from '../shared/errors/index.js';
import { RevenueService } from './revenue.js';
import { logger } from '../shared/utils/logger.js';
import { DEFAULT_REVENUE_CONFIG } from '../shared/types/index.js';
import {
  ProviderReliabilityTracker,
  rankCandidates,
  DEFAULT_WEIGHTS,
  type RoutingWeights,
} from '../shared/routing/index.js';
import {
  InMemoryCache,
  swapQuoteCacheKey,
  type ICacheBackend,
} from '../shared/cache/index.js';

interface MaterializedQuote {
  providerName: string;
  result: import('../shared/types/index.js').SwapQuoteResult;
  quote: SwapQuote;
}

interface ProviderQuoteSnapshot {
  providerName: string;
  result: import('../shared/types/index.js').SwapQuoteResult;
}

interface DbSwapQuote {
  id: string;
  provider_id: string;
  provider_name: string;
  provider_quote_id: string;
  from_asset: string;
  to_asset: string;
  from_amount: string;
  to_amount: string;
  rate: string;
  network_fee: string;
  fee_asset: string;
  platform_fee: string;
  estimated_duration_seconds: number;
  expires_at: Date;
  min_amount: string;
  max_amount: string;
  user_id: string;
  created_at: Date;
}

interface DbTransaction {
  id: string;
  status: TransactionStatus;
  from_asset: string;
  to_asset: string;
  amount: string;
  result_amount: string | null;
  fee_amount: string | null;
  fee_asset: string | null;
  provider_id: string;
  provider_tx_id: string | null;
  affiliate_id: string | null;
  revenue_event_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Allowed swap status transitions. Terminal states (completed, failed,
 * refunded, expired) accept no further transitions, so a forged webhook can't
 * resurrect or rewrite a settled transaction. Same-status deliveries are
 * treated as no-ops.
 */
const SWAP_STATUS_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
  pending: ['processing', 'completed', 'failed', 'refunded', 'expired'],
  processing: ['completed', 'failed', 'refunded', 'expired'],
  completed: [],
  failed: [],
  refunded: [],
  expired: [],
};

/** True when `to` is a permitted next status for a swap currently at `from`. */
export function isValidSwapStatusTransition(
  from: TransactionStatus,
  to: TransactionStatus
): boolean {
  return SWAP_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SwapServiceOptions {
  /** Persistent TTL cache for provider quotes. Defaults to in-memory. */
  cache?: ICacheBackend;
  /** Quote cache TTL in seconds. Defaults to 30 — long enough to dedupe
   *  bursty requests, short enough that rates stay fresh. */
  cacheTtlSeconds?: number;
  /** Reliability tracker; defaults to a fresh in-memory tracker. */
  reliability?: ProviderReliabilityTracker;
  /** Routing weights. Defaults to DEFAULT_WEIGHTS. */
  routingWeights?: RoutingWeights;
}

export class SwapService {
  private readonly revenueService: RevenueService;
  private readonly cache: ICacheBackend;
  private readonly cacheTtlSeconds: number;
  public readonly reliability: ProviderReliabilityTracker;
  private readonly routingWeights: RoutingWeights;

  constructor(
    private readonly sql: SQL,
    private readonly providers: Map<string, ISwapProviderAdapter>,
    options: SwapServiceOptions = {}
  ) {
    this.revenueService = new RevenueService(sql, DEFAULT_REVENUE_CONFIG);
    this.cache = options.cache ?? new InMemoryCache();
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 30;
    this.reliability = options.reliability ?? new ProviderReliabilityTracker();
    this.routingWeights = options.routingWeights ?? DEFAULT_WEIGHTS;
  }

  /**
   * Get swap quotes from all active providers.
   */
  async getQuote(userId: UUID, request: SwapQuoteRequest): Promise<SwapQuoteResponse> {
    // Validate inputs
    if (!isValidAssetTicker(request.from_asset.toUpperCase())) {
      throw new ValidationError(`Invalid from_asset: ${request.from_asset}`);
    }
    if (!isValidAssetTicker(request.to_asset.toUpperCase())) {
      throw new ValidationError(`Invalid to_asset: ${request.to_asset}`);
    }
    if (!isValidAmount(request.amount)) {
      throw new ValidationError(`Invalid amount: ${request.amount}`);
    }

    const fromAsset = request.from_asset.toUpperCase();
    const toAsset = request.to_asset.toUpperCase();

    const cacheKey = swapQuoteCacheKey({
      fromAsset,
      toAsset,
      amount: request.amount,
      fromNetwork: request.from_network,
      toNetwork: request.to_network,
    });

    // Try cache first. The cache holds the provider-level quote results,
    // but quote IDs (and their DB rows) are per-user, so we always refresh
    // the user-scoped rows below.
    const cached = await this.cache.get<ProviderQuoteSnapshot[]>(cacheKey);

    // Get quotes from all available providers in parallel
    const providerList = Array.from(this.providers.values());
    const quotePromises = providerList.map(async (provider) => {
      const cachedEntry = cached?.find((c) => c.providerName === provider.name);
      if (cachedEntry) {
        try {
          return await this.materializeQuote(userId, fromAsset, toAsset, request.amount, provider, cachedEntry.result);
        } catch (err) {
          logger.debug('Cached quote materialization failed, refetching', {
            provider: provider.name,
            error: String(err),
          });
        }
      }

      try {
        const result = await provider.getQuote({
          fromAsset,
          toAsset,
          amount: request.amount,
          fromNetwork: request.from_network,
          toNetwork: request.to_network,
        });
        this.reliability.recordSuccess(provider.name);

        // Calculate platform fee (0.3% of amount)
        const platformFee = (parseFloat(request.amount) * DEFAULT_REVENUE_CONFIG.platformFeePercent).toFixed(8);

        // Get provider DB record
        const [providerRow] = await this.sql<{ id: string }[]>`
          SELECT id FROM providers WHERE name = ${provider.name} AND is_active = TRUE LIMIT 1
        `;
        if (!providerRow) return null;

        const quote: Omit<SwapQuote, 'id'> = {
          provider_id: providerRow.id,
          provider_name: provider.name,
          from_asset: fromAsset,
          to_asset: toAsset,
          from_amount: result.fromAmount,
          to_amount: result.toAmount,
          rate: result.rate,
          fee_amount: result.networkFee,
          fee_asset: result.feeAsset,
          platform_fee: platformFee,
          network_fee: result.networkFee,
          estimated_duration_seconds: result.estimatedDurationSeconds,
          expires_at: result.expiresAt,
          min_amount: result.minAmount,
          max_amount: result.maxAmount,
        };

        return this.materializeQuote(userId, fromAsset, toAsset, request.amount, provider, result);
      } catch (err) {
        this.reliability.recordFailure(provider.name);
        logger.warn(`Provider ${provider.name} quote failed`, { error: String(err) });
        return null;
      }
    });

    const results = (await Promise.all(quotePromises)).filter(Boolean) as MaterializedQuote[];
    if (results.length === 0) {
      throw new ValidationError(`No providers available for ${fromAsset} → ${toAsset}`);
    }

    // Refresh the quote cache with the latest upstream snapshots. We cache
    // the raw provider result, not per-user quote rows.
    if (!cached) {
      const snapshot: ProviderQuoteSnapshot[] = results.map((r) => ({
        providerName: r.providerName,
        result: r.result,
      }));
      await this.cache.set(cacheKey, snapshot, this.cacheTtlSeconds);
    }

    const quotes = results.map((r) => r.quote);

    // Smart provider selection: prefer highest net output, factoring in
    // durations and provider reliability. Falls back to raw to_amount when
    // net calculation produces ties.
    const ranked = rankCandidates(
      quotes.map((q) => ({
        providerName: q.provider_name,
        toAmount: q.to_amount,
        platformFee: q.platform_fee,
        networkFee: q.network_fee,
        estimatedDurationSeconds: q.estimated_duration_seconds,
        quoteId: q.id,
      })),
      this.reliability,
      this.routingWeights
    );

    return { quotes, best_quote_id: ranked.best.quoteId };
  }

  /**
   * Convert a provider's quote result into our canonical `SwapQuote`,
   * persisting the user-scoped DB row required for `executeSwap`.
   */
  private async materializeQuote(
    userId: UUID,
    fromAsset: string,
    toAsset: string,
    requestAmount: string,
    provider: ISwapProviderAdapter,
    result: import('../shared/types/index.js').SwapQuoteResult
  ): Promise<MaterializedQuote | null> {
    const platformFee = (parseFloat(requestAmount) * DEFAULT_REVENUE_CONFIG.platformFeePercent).toFixed(8);

    const [providerRow] = await this.sql<{ id: string }[]>`
      SELECT id FROM providers WHERE name = ${provider.name} AND is_active = TRUE LIMIT 1
    `;
    if (!providerRow) return null;

    const quoteId = generateUUID();
    const quote: SwapQuote = {
      id: quoteId,
      provider_id: providerRow.id,
      provider_name: provider.name,
      from_asset: fromAsset,
      to_asset: toAsset,
      from_amount: result.fromAmount,
      to_amount: result.toAmount,
      rate: result.rate,
      fee_amount: result.networkFee,
      fee_asset: result.feeAsset,
      platform_fee: platformFee,
      network_fee: result.networkFee,
      estimated_duration_seconds: result.estimatedDurationSeconds,
      expires_at: result.expiresAt,
      min_amount: result.minAmount,
      max_amount: result.maxAmount,
    };

    await this.sql`
      INSERT INTO swap_quotes (
        id, provider_id, provider_quote_id, user_id,
        from_asset, to_asset, from_amount, to_amount, rate,
        network_fee, fee_asset, platform_fee,
        estimated_duration_seconds, expires_at, min_amount, max_amount
      ) VALUES (
        ${quoteId}, ${providerRow.id}, ${result.providerQuoteId}, ${userId},
        ${fromAsset}, ${toAsset}, ${result.fromAmount}, ${result.toAmount}, ${result.rate},
        ${result.networkFee}, ${result.feeAsset}, ${platformFee},
        ${result.estimatedDurationSeconds}, ${result.expiresAt},
        ${result.minAmount}, ${result.maxAmount}
      )
    `;

    return { providerName: provider.name, result, quote };
  }

  /**
   * Execute a swap using a previously obtained quote.
   */
  async executeSwap(userId: UUID, request: SwapExecuteRequest): Promise<SwapTransaction> {
    if (!request.idempotency_key) {
      throw new IdempotencyError();
    }

    // Fetch the quote
    const [quoteRow] = await this.sql<DbSwapQuote[]>`
      SELECT sq.*, p.name AS provider_name
      FROM swap_quotes sq
      JOIN providers p ON p.id = sq.provider_id
      WHERE sq.id = ${request.quote_id} AND sq.user_id = ${userId}
    `;
    if (!quoteRow) {
      throw new QuoteNotFoundError(request.quote_id);
    }

    // Check expiry
    if (new Date() > quoteRow.expires_at) {
      throw new QuoteExpiredError();
    }

    // Get the provider adapter
    const provider = this.providers.get(quoteRow.provider_name);
    if (!provider) {
      throw new ValidationError(`Provider ${quoteRow.provider_name} is not available`);
    }

    const affiliateId = await this.revenueService.validateAffiliateAttribution(
      request.affiliate_id,
      userId
    );

    const txId = generateUUID();
    const now = nowISO();

    // Reserve the idempotency key *before* touching the provider (issue #15).
    // `ON CONFLICT DO NOTHING` makes the reservation atomic: two concurrent
    // requests with the same key can't both pass — exactly one row is inserted,
    // so exactly one request reaches the provider. The loser short-circuits.
    const reserved = await this.sql<{ id: string }[]>`
      INSERT INTO transactions (
        id, type, domain, status, user_id,
        from_asset, to_asset, amount,
        provider_id, idempotency_key, affiliate_id,
        metadata, created_at, updated_at
      ) VALUES (
        ${txId}, 'swap', 'swap', 'pending', ${userId},
        ${quoteRow.from_asset}, ${quoteRow.to_asset}, ${quoteRow.from_amount},
        ${quoteRow.provider_id}, ${request.idempotency_key},
        ${affiliateId},
        ${JSON.stringify({
          swap: {
            quote_id: request.quote_id,
            provider_quote_id: quoteRow.provider_quote_id,
            to_amount: quoteRow.to_amount,
            rate: quoteRow.rate,
            recipient_address: request.recipient_address,
            refund_address: request.refund_address ?? null,
          },
        })},
        ${now}, ${now}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `;
    if (reserved.length === 0) {
      // Another request already holds this key — surface the existing tx id.
      const [existing] = await this.sql<{ id: string }[]>`
        SELECT id FROM transactions WHERE idempotency_key = ${request.idempotency_key}
      `;
      throw new DuplicateIdempotencyKeyError(existing?.id ?? request.idempotency_key);
    }

    // Execute with provider; record outcome for future routing decisions.
    let executeResult;
    try {
      executeResult = await provider.executeSwap({
        providerQuoteId: quoteRow.provider_quote_id,
        recipientAddress: request.recipient_address,
        refundAddress: request.refund_address,
      });
      this.reliability.recordSuccess(provider.name);
    } catch (err) {
      this.reliability.recordFailure(provider.name);
      // Release the reservation so a genuine failure can be retried with the
      // same key (the provider never performed an operation here).
      await this.sql`DELETE FROM transactions WHERE id = ${txId}`;
      throw err;
    }

    // Finalise the reserved transaction with the provider's result.
    await this.sql`
      UPDATE transactions
      SET status = ${executeResult.status},
          provider_tx_id = ${executeResult.providerTxId},
          metadata = ${JSON.stringify({
            swap: {
              quote_id: request.quote_id,
              provider_quote_id: quoteRow.provider_quote_id,
              to_amount: quoteRow.to_amount,
              rate: quoteRow.rate,
              recipient_address: request.recipient_address,
              refund_address: request.refund_address ?? null,
              deposit_address: executeResult.depositAddress,
            },
          })},
          updated_at = ${now}
      WHERE id = ${txId}
    `;

    // Calculate and store revenue event
    const revenueEventId = await this.revenueService.createRevenueEvent({
      transactionId: txId,
      domain: 'swap',
      totalFee: quoteRow.platform_fee,
      feeAsset: quoteRow.from_asset,
      affiliateId,
      payerUserId: userId,
    });

    // Link revenue event to transaction
    await this.sql`
      UPDATE transactions SET revenue_event_id = ${revenueEventId} WHERE id = ${txId}
    `;

    logger.info('Swap executed', {
      txId,
      from: quoteRow.from_asset,
      to: quoteRow.to_asset,
      amount: quoteRow.from_amount,
      provider: quoteRow.provider_name,
    });

    return this.buildSwapTransaction(
      txId,
      quoteRow,
      executeResult.status,
      executeResult.depositAddress,
      request,
      revenueEventId,
      now,
      affiliateId
    );
  }

  /**
   * Get swap transaction status.
   */
  async getSwapStatus(txId: UUID, userId: UUID): Promise<SwapTransaction> {
    const [row] = await this.sql<(DbTransaction & { provider_name: string; quote_data: string })[]>`
      SELECT t.*, p.name AS provider_name
      FROM transactions t
      JOIN providers p ON p.id = t.provider_id
      WHERE t.id = ${txId} AND t.user_id = ${userId} AND t.type = 'swap'
    `;

    if (!row) {
      throw new TransactionNotFoundError(txId);
    }

    // Optionally refresh status from provider
    if (row.status === 'pending' || row.status === 'processing') {
      const provider = this.providers.get(row.provider_name);
      if (provider && row.provider_tx_id) {
        try {
          const statusResult = await provider.getTransactionStatus(row.provider_tx_id);
          if (statusResult.status !== row.status) {
            await this.sql`
              UPDATE transactions
              SET status = ${statusResult.status}, updated_at = NOW()
              WHERE id = ${txId}
            `;
            row.status = statusResult.status;
          }
        } catch (err) {
          logger.warn('Failed to refresh status from provider', { txId, error: String(err) });
        }
      }
    }

    return this.buildSwapTransactionFromDb(row);
  }

  /**
   * Handle a provider status webhook for `POST /v1/swap/webhook/:id`.
   *
   * Security model (issue #13):
   *  - The `:id` is our internal transaction id and MUST be a UUID.
   *  - The lookup is scoped to `domain = 'swap'`, so a swap webhook can never
   *    touch a payments/earn row even if an attacker supplies a foreign id.
   *  - The provider that owns the row signs the body; we verify the HMAC
   *    signature with that provider's secret and fail closed when it doesn't
   *    match (no secret configured ⇒ never valid).
   *  - Status changes follow a state machine; terminal rows are immutable and
   *    invalid transitions are no-ops (we don't error, to avoid provider
   *    retry storms).
   */
  async handleWebhook(params: {
    txId: string;
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ processed: boolean; status: TransactionStatus; previousStatus: TransactionStatus }> {
    const { txId, rawBody, headers } = params;

    if (!UUID_RE.test(txId)) {
      throw new ValidationError('Transaction id must be a valid UUID');
    }

    // Domain-scoped lookup: a swap webhook can only ever resolve a swap row.
    const [row] = await this.sql<
      {
        id: string;
        status: TransactionStatus;
        provider_id: string;
        provider_tx_id: string | null;
        provider_name: string;
      }[]
    >`
      SELECT t.id, t.status, t.provider_id, t.provider_tx_id, p.name AS provider_name
      FROM transactions t
      JOIN providers p ON p.id = t.provider_id
      WHERE t.id = ${txId} AND t.domain = 'swap'
    `;

    if (!row) {
      throw new TransactionNotFoundError(txId);
    }

    const provider = this.providers.get(row.provider_name);
    if (!provider) {
      throw new ValidationError(`Provider ${row.provider_name} is not available`);
    }

    const parsed = provider.verifyWebhook({ rawBody, headers });
    if (!parsed) {
      throw new ValidationError('Malformed webhook payload');
    }

    if (!parsed.signatureValid) {
      logger.warn('Swap webhook rejected: invalid signature', {
        txId,
        provider: row.provider_name,
      });
      throw new InvalidWebhookSignatureError(row.provider_name, 'swap');
    }

    // Cross-check the provider's own tx id against the target row, so a valid
    // signature for one transaction can't be replayed against another.
    if (row.provider_tx_id && parsed.providerTxId && row.provider_tx_id !== parsed.providerTxId) {
      logger.warn('Swap webhook rejected: provider tx id mismatch', {
        txId,
        expected: row.provider_tx_id,
        received: parsed.providerTxId,
      });
      throw new ValidationError('Webhook does not match the target transaction');
    }

    const previousStatus = row.status;
    const nextStatus = parsed.status;

    if (nextStatus === previousStatus || !isValidSwapStatusTransition(previousStatus, nextStatus)) {
      logger.info('Swap webhook ignored: no valid transition', {
        txId,
        from: previousStatus,
        to: nextStatus,
      });
      return { processed: false, status: previousStatus, previousStatus };
    }

    await this.sql`
      UPDATE transactions
      SET status = ${nextStatus}, updated_at = NOW()
      WHERE id = ${txId} AND domain = 'swap'
    `;

    logger.info('Swap webhook applied', { txId, from: previousStatus, to: nextStatus });

    return { processed: true, status: nextStatus, previousStatus };
  }

  private buildSwapTransaction(
    txId: string,
    quote: DbSwapQuote,
    status: TransactionStatus,
    depositAddress: string,
    request: SwapExecuteRequest,
    revenueEventId: string,
    now: string,
    affiliateId: string | null
  ): SwapTransaction {
    const quoteObj: SwapQuote = {
      id: request.quote_id,
      provider_id: quote.provider_id,
      provider_name: quote.provider_name,
      from_asset: quote.from_asset,
      to_asset: quote.to_asset,
      from_amount: quote.from_amount,
      to_amount: quote.to_amount,
      rate: quote.rate,
      fee_amount: quote.network_fee,
      fee_asset: quote.fee_asset,
      platform_fee: quote.platform_fee,
      network_fee: quote.network_fee,
      estimated_duration_seconds: quote.estimated_duration_seconds,
      expires_at: quote.expires_at.toISOString(),
      min_amount: quote.min_amount,
      max_amount: quote.max_amount,
    };

    const webhookUrl = `${process.env['API_BASE_URL'] ?? 'http://localhost:3000'}/v1/swap/webhook/${txId}`;

    return {
      id: txId,
      quote: quoteObj,
      status,
      recipient_address: request.recipient_address,
      refund_address: request.refund_address ?? null,
      deposit_address: depositAddress,
      provider_tx_id: null,
      affiliate_id: affiliateId,
      revenue_event_id: revenueEventId,
      webhook_url: webhookUrl,
      created_at: now,
      updated_at: now,
    };
  }

  private buildSwapTransactionFromDb(row: DbTransaction & { provider_name: string }): SwapTransaction {
    const meta = row.metadata as {
      swap?: {
        quote_id?: string;
        provider_quote_id?: string;
        to_amount?: string;
        rate?: string;
        recipient_address?: string;
        refund_address?: string | null;
        deposit_address?: string;
      };
    };
    const swapMeta = meta.swap ?? {};

    const mockQuote: SwapQuote = {
      id: swapMeta.quote_id ?? '',
      provider_id: row.provider_id,
      provider_name: row.provider_name,
      from_asset: row.from_asset,
      to_asset: row.to_asset ?? '',
      from_amount: row.amount,
      to_amount: swapMeta.to_amount ?? '0',
      rate: swapMeta.rate ?? '0',
      fee_amount: row.fee_amount ?? '0',
      fee_asset: row.fee_asset ?? row.from_asset,
      platform_fee: '0',
      network_fee: row.fee_amount ?? '0',
      estimated_duration_seconds: 0,
      expires_at: row.created_at.toISOString(),
      min_amount: '0',
      max_amount: '999999',
    };

    const webhookUrl = `${process.env['API_BASE_URL'] ?? 'http://localhost:3000'}/v1/swap/webhook/${row.id}`;

    return {
      id: row.id,
      quote: mockQuote,
      status: row.status,
      recipient_address: swapMeta.recipient_address ?? '',
      refund_address: swapMeta.refund_address ?? null,
      deposit_address: swapMeta.deposit_address ?? '',
      provider_tx_id: row.provider_tx_id,
      affiliate_id: row.affiliate_id,
      revenue_event_id: row.revenue_event_id,
      webhook_url: webhookUrl,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
