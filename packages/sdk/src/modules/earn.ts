/**
 * FinLayer SDK — Earn Module
 * Yield strategy aggregation (Aave V3, Compound V3, …).
 */

import type {
  EarnStrategiesResponse,
  EarnDepositRequest,
  EarnDepositResponse,
  EarnWithdrawRequest,
  EarnWithdrawResponse,
  EarnPositionsResponse,
  EarnPosition,
} from '@finlayer/types';
import type { FinLayerClient } from '../client.js';

export class EarnModule {
  constructor(private readonly client: FinLayerClient) {}

  /**
   * List available yield strategies across providers. Optionally filter by asset.
   *
   * @example
   * const { strategies } = await finlayer.earn.listStrategies({ asset: 'USDC' });
   * console.log(strategies[0].apy, strategies[0].protocol);
   */
  async listStrategies(filter: { asset?: string } = {}): Promise<EarnStrategiesResponse> {
    const qs = filter.asset ? `?asset=${encodeURIComponent(filter.asset)}` : '';
    return this.client.request<EarnStrategiesResponse>('GET', `/v1/earn/strategies${qs}`);
  }

  /**
   * Deposit into an earn strategy.
   *
   * @example
   * const { position } = await finlayer.earn.deposit({
   *   strategy_id: bestStrategy.id,
   *   amount: '100',
   *   from_address: '0xYourWallet',
   *   idempotency_key: crypto.randomUUID(),
   * });
   */
  async deposit(params: EarnDepositRequest): Promise<EarnDepositResponse> {
    return this.client.request<EarnDepositResponse>(
      'POST',
      '/v1/earn/deposit',
      this.client['withAffiliate'](params)
    );
  }

  /**
   * Withdraw an earn position.
   */
  async withdraw(params: EarnWithdrawRequest): Promise<EarnWithdrawResponse> {
    return this.client.request<EarnWithdrawResponse>(
      'POST',
      '/v1/earn/withdraw',
      this.client['withAffiliate'](params)
    );
  }

  /**
   * List the current user's earn positions.
   */
  async listPositions(): Promise<EarnPositionsResponse> {
    return this.client.request<EarnPositionsResponse>('GET', '/v1/earn/positions');
  }

  /**
   * Get a single position with the latest on-chain value.
   */
  async getPosition(positionId: string): Promise<{ position: EarnPosition }> {
    return this.client.request<{ position: EarnPosition }>(
      'GET',
      `/v1/earn/positions/${positionId}`
    );
  }
}
