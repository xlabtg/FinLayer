/**
 * @finlayer/sdk
 * TypeScript SDK for FinLayer financial API platform.
 *
 * Designed for AI agents — clean interface, structured errors, polling helpers.
 *
 * @example
 * ```typescript
 * import { HiveFinance } from '@finlayer/sdk';
 *
 * const finlayer = new HiveFinance({
 *   apiKey: 'fl_live_yourkey',
 * });
 *
 * // Get a swap quote
 * const { best_quote_id } = await finlayer.swap.quote({
 *   from_asset: 'BTC',
 *   to_asset: 'ETH',
 *   amount: '0.1',
 * });
 *
 * // Execute the swap
 * const tx = await finlayer.swap.execute({
 *   quote_id: best_quote_id,
 *   recipient_address: '0xYourEthAddress',
 *   idempotency_key: 'unique-key-123',
 * });
 * ```
 */

export { FinLayerClient, FinLayerApiError } from './client.js';
export type { FinLayerClientConfig } from './client.js';

export { SwapModule } from './modules/swap.js';
export { WalletModule } from './modules/wallet.js';
export type { WalletGenerateResponse, SupportedWalletPair } from './modules/wallet.js';

// Re-export all types for convenience
export type * from '@finlayer/types';

import { FinLayerClient } from './client.js';
import type { FinLayerClientConfig } from './client.js';
import { SwapModule } from './modules/swap.js';
import { WalletModule } from './modules/wallet.js';

/**
 * Main FinLayer SDK client.
 * Named HiveFinance for Hive Mind agent integration.
 *
 * @example
 * ```typescript
 * import { HiveFinance } from '@finlayer/sdk';
 *
 * const finlayer = new HiveFinance({ apiKey: 'fl_live_...' });
 *
 * // Swap BTC → ETH in one call
 * const tx = await finlayer.swap.quoteAndExecute({
 *   from_asset: 'BTC',
 *   to_asset: 'ETH',
 *   amount: '0.1',
 *   recipient_address: '0xYourEthAddress',
 *   idempotency_key: crypto.randomUUID(),
 * });
 * ```
 */
export class HiveFinance extends FinLayerClient {
  /** Crypto exchange aggregation */
  public readonly swap: SwapModule;
  /** Non-custodial HD wallet management (Phase 4) */
  public readonly wallet: WalletModule;

  constructor(config: FinLayerClientConfig) {
    super(config);
    this.swap = new SwapModule(this);
    this.wallet = new WalletModule(this);
  }
}

/** Alias for HiveFinance */
export const FinLayer = HiveFinance;
