/**
 * FinLayer SDK — Swap Module
 * Crypto exchange aggregation.
 */

import type {
  SwapQuoteRequest,
  SwapQuoteResponse,
  SwapExecuteRequest,
  SwapTransaction,
  SwapStatusResponse,
  Provider,
} from '@finlayer/types';
import type { FinLayerClient } from '../client.js';

export class SwapModule {
  constructor(private readonly client: FinLayerClient) {}

  /**
   * Get the best swap quote for an asset pair.
   *
   * @example
   * const { quotes, best_quote_id } = await finlayer.swap.quote({
   *   from_asset: 'BTC',
   *   to_asset: 'ETH',
   *   amount: '0.1',
   * });
   */
  async quote(params: Omit<SwapQuoteRequest, 'idempotency_key'>): Promise<SwapQuoteResponse> {
    return this.client.request<SwapQuoteResponse>(
      'POST',
      '/v1/swap/quote',
      this.client['withAffiliate'](params)
    );
  }

  /**
   * Execute a swap using a quote from `quote()`.
   *
   * @example
   * const tx = await finlayer.swap.execute({
   *   quote_id: best_quote_id,
   *   recipient_address: '0xYourEthAddress',
   *   idempotency_key: 'unique-key-123',
   * });
   * console.log('Send BTC to:', tx.deposit_address);
   * console.log('Monitor at:', tx.webhook_url);
   */
  async execute(params: SwapExecuteRequest): Promise<SwapTransaction> {
    return this.client.request<SwapTransaction>(
      'POST',
      '/v1/swap/execute',
      this.client['withAffiliate'](params),
      { idempotencyKey: params.idempotency_key }
    );
  }

  /**
   * Get swap transaction status.
   *
   * @example
   * const { transaction } = await finlayer.swap.status(txId);
   * console.log('Status:', transaction.status); // 'pending' | 'completed' | ...
   */
  async status(txId: string): Promise<SwapStatusResponse> {
    return this.client.request<SwapStatusResponse>('GET', `/v1/swap/tx/${txId}`);
  }

  /**
   * List available swap providers.
   */
  async providers(): Promise<Provider[]> {
    return this.client.request<Provider[]>('GET', '/v1/swap/providers');
  }

  /**
   * Convenience: get quote + execute in one call.
   * Automatically picks the best quote.
   *
   * @example
   * const tx = await finlayer.swap.quoteAndExecute({
   *   from_asset: 'BTC',
   *   to_asset: 'ETH',
   *   amount: '0.1',
   *   recipient_address: '0xYourEthAddress',
   *   idempotency_key: 'unique-key-456',
   * });
   */
  async quoteAndExecute(params: {
    from_asset: string;
    to_asset: string;
    amount: string;
    recipient_address: string;
    refund_address?: string;
    affiliate_id?: string;
    idempotency_key: string;
    from_network?: string;
    to_network?: string;
  }): Promise<SwapTransaction> {
    const { best_quote_id } = await this.quote({
      from_asset: params.from_asset,
      to_asset: params.to_asset,
      amount: params.amount,
      from_network: params.from_network,
      to_network: params.to_network,
      affiliate_id: params.affiliate_id,
    });

    return this.execute({
      quote_id: best_quote_id,
      recipient_address: params.recipient_address,
      refund_address: params.refund_address,
      affiliate_id: params.affiliate_id,
      idempotency_key: params.idempotency_key,
    });
  }

  /**
   * Poll transaction status until completion or timeout.
   *
   * @example
   * const tx = await finlayer.swap.waitForCompletion(txId, {
   *   timeoutMs: 3600000, // 1 hour
   *   pollIntervalMs: 15000, // 15 seconds
   * });
   */
  async waitForCompletion(
    txId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<SwapTransaction> {
    const { timeoutMs = 3_600_000, pollIntervalMs = 15_000 } = options;
    const startTime = Date.now();
    const terminalStatuses = new Set(['completed', 'failed', 'refunded', 'expired']);

    while (Date.now() - startTime < timeoutMs) {
      const { transaction } = await this.status(txId);
      if (terminalStatuses.has(transaction.status)) {
        return transaction;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Swap ${txId} did not complete within ${timeoutMs}ms`);
  }
}
