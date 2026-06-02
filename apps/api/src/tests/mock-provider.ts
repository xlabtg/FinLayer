/**
 * Mock swap provider for testing.
 * Simulates the ChangeNOW adapter without real API calls.
 */

import type {
  ISwapProviderAdapter,
  SwapQuoteParams,
  SwapQuoteResult,
  SwapExecuteParams,
  SwapExecuteResult,
  SwapStatusResult,
  SwapWebhookVerifyParams,
  SwapWebhookVerifyResult,
} from '../../../../modules/shared/types/index.js';
import { futureISO } from '@finlayer/utils';

export class MockSwapProvider implements ISwapProviderAdapter {
  public readonly name = 'MockProvider';
  public readonly domain = 'swap' as const;
  public readonly supportedAssets = ['BTC', 'ETH', 'USDC', 'BNB'];

  /** Toggle to force signature verification to fail for testing. */
  public forceInvalidSignature = false;

  /** Number of times executeSwap has been invoked (idempotency tests). */
  public executeSwapCalls = 0;

  /** Optional artificial delay (ms) before executeSwap resolves, to widen the concurrency race window. */
  public executeDelayMs = 0;

  /** Toggle to force executeSwap to throw, to test reservation rollback. */
  public forceExecuteError = false;

  private txStatuses = new Map<string, SwapStatusResult['status']>();

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    const { fromAsset, toAsset, amount } = params;
    const amountNum = parseFloat(amount);

    // Simulate realistic exchange rates
    const rates: Record<string, number> = {
      'BTC_ETH': 16.5,
      'ETH_BTC': 0.0606,
      'BTC_USDC': 65000,
      'USDC_BTC': 0.0000154,
      'ETH_USDC': 3500,
      'USDC_ETH': 0.000286,
    };

    const key = `${fromAsset}_${toAsset}`;
    const rate = rates[key] ?? 1.0;
    const toAmount = (amountNum * rate * 0.995).toFixed(8); // 0.5% spread

    return {
      providerQuoteId: `mock_${fromAsset}_${toAsset}_${Date.now()}`,
      fromAsset,
      toAsset,
      fromAmount: amount,
      toAmount,
      rate: rate.toFixed(8),
      networkFee: '0.0001',
      feeAsset: toAsset,
      estimatedDurationSeconds: 600,
      expiresAt: futureISO(300),
      minAmount: '0.001',
      maxAmount: '10000',
    };
  }

  async executeSwap(params: SwapExecuteParams): Promise<SwapExecuteResult> {
    this.executeSwapCalls += 1;
    if (this.executeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.executeDelayMs));
    }
    if (this.forceExecuteError) {
      throw new Error('provider execute failure');
    }
    const txId = `mock_tx_${Date.now()}`;
    this.txStatuses.set(txId, 'pending');

    // Simulate async progression
    setTimeout(() => this.txStatuses.set(txId, 'processing'), 100);
    setTimeout(() => this.txStatuses.set(txId, 'completed'), 500);

    return {
      providerTxId: txId,
      depositAddress: `mock_deposit_${Math.random().toString(36).substring(7)}`,
      status: 'pending',
    };
  }

  async getTransactionStatus(providerTxId: string): Promise<SwapStatusResult> {
    return {
      providerTxId,
      status: this.txStatuses.get(providerTxId) ?? 'pending',
    };
  }

  verifyWebhook(params: SwapWebhookVerifyParams): SwapWebhookVerifyResult | null {
    try {
      const body = JSON.parse(params.rawBody) as {
        id?: string;
        provider_tx_id?: string;
        status?: SwapStatusResult['status'];
        tx_hash?: string;
      };
      const providerTxId = body.provider_tx_id ?? body.id ?? '';
      return {
        providerTxId,
        status: body.status ?? 'pending',
        txHash: body.tx_hash,
        signatureValid: !this.forceInvalidSignature,
      };
    } catch {
      return null;
    }
  }

  /** Test helper: set transaction to a specific status */
  setTxStatus(providerTxId: string, status: SwapStatusResult['status']): void {
    this.txStatuses.set(providerTxId, status);
  }
}
