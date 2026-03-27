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
} from '../shared/errors/index.js';
import { RevenueService } from './revenue.js';
import { logger } from '../shared/utils/logger.js';
import { DEFAULT_REVENUE_CONFIG } from '../shared/types/index.js';

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

export class SwapService {
  private readonly revenueService: RevenueService;

  constructor(
    private readonly sql: SQL,
    private readonly providers: Map<string, ISwapProviderAdapter>
  ) {
    this.revenueService = new RevenueService(sql, DEFAULT_REVENUE_CONFIG);
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

    // Get quotes from all available providers in parallel
    const providerList = Array.from(this.providers.values());
    const quotePromises = providerList.map(async (provider) => {
      try {
        const result = await provider.getQuote({
          fromAsset,
          toAsset,
          amount: request.amount,
          fromNetwork: request.from_network,
          toNetwork: request.to_network,
        });

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

        return { providerId: providerRow.id, result, quote, providerQuoteId: result.providerQuoteId };
      } catch (err) {
        logger.warn(`Provider ${provider.name} quote failed`, { error: String(err) });
        return null;
      }
    });

    const results = (await Promise.all(quotePromises)).filter(Boolean);
    if (results.length === 0) {
      throw new ValidationError(`No providers available for ${fromAsset} → ${toAsset}`);
    }

    // Store quotes in DB and return full objects
    const quotes: SwapQuote[] = [];
    for (const r of results) {
      if (!r) continue;
      const quoteId = generateUUID();

      // Store ephemeral quote data in DB for execute
      await this.sql`
        INSERT INTO swap_quotes (
          id, provider_id, provider_quote_id, user_id,
          from_asset, to_asset, from_amount, to_amount, rate,
          network_fee, fee_asset, platform_fee,
          estimated_duration_seconds, expires_at, min_amount, max_amount
        ) VALUES (
          ${quoteId}, ${r.providerId}, ${r.providerQuoteId}, ${userId},
          ${fromAsset}, ${toAsset}, ${r.result.fromAmount}, ${r.result.toAmount}, ${r.result.rate},
          ${r.result.networkFee}, ${r.result.feeAsset}, ${r.quote.platform_fee},
          ${r.result.estimatedDurationSeconds}, ${r.result.expiresAt},
          ${r.result.minAmount}, ${r.result.maxAmount}
        )
      `;

      quotes.push({ id: quoteId, ...r.quote });
    }

    // Select best quote by to_amount (most output)
    const bestQuote = quotes.reduce((best, q) =>
      parseFloat(q.to_amount) > parseFloat(best.to_amount) ? q : best
    );

    return { quotes, best_quote_id: bestQuote.id };
  }

  /**
   * Execute a swap using a previously obtained quote.
   */
  async executeSwap(userId: UUID, request: SwapExecuteRequest): Promise<SwapTransaction> {
    if (!request.idempotency_key) {
      throw new IdempotencyError();
    }

    // Check for duplicate idempotency key
    const [existing] = await this.sql<{ id: string }[]>`
      SELECT id FROM transactions WHERE idempotency_key = ${request.idempotency_key}
    `;
    if (existing) {
      throw new DuplicateIdempotencyKeyError(existing.id);
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

    // Execute with provider
    const executeResult = await provider.executeSwap({
      providerQuoteId: quoteRow.provider_quote_id,
      recipientAddress: request.recipient_address,
      refundAddress: request.refund_address,
    });

    // Create transaction record
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
        ${txId}, 'swap', 'swap', ${executeResult.status},
        ${userId}, ${quoteRow.from_asset}, ${quoteRow.to_asset},
        ${quoteRow.from_amount}, ${quoteRow.provider_id},
        ${executeResult.providerTxId},
        ${request.idempotency_key},
        ${request.affiliate_id ?? null},
        ${JSON.stringify({
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
        ${now}, ${now}
      )
    `;

    // Calculate and store revenue event
    const revenueEventId = await this.revenueService.createRevenueEvent({
      transactionId: txId,
      domain: 'swap',
      totalFee: quoteRow.platform_fee,
      feeAsset: quoteRow.from_asset,
      affiliateId: request.affiliate_id,
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
      now
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

  private buildSwapTransaction(
    txId: string,
    quote: DbSwapQuote,
    status: TransactionStatus,
    depositAddress: string,
    request: SwapExecuteRequest,
    revenueEventId: string,
    now: string
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
      affiliate_id: request.affiliate_id ?? null,
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
