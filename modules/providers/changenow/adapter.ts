/**
 * modules/providers/changenow/adapter.ts
 * ChangeNOW crypto exchange provider adapter.
 *
 * API Reference: https://api.changenow.io/v2
 * Implements ISwapProviderAdapter for quote + execute + status.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type {
  ISwapProviderAdapter,
  SwapQuoteParams,
  SwapQuoteResult,
  SwapExecuteParams,
  SwapExecuteResult,
  SwapStatusResult,
  SwapWebhookVerifyParams,
  SwapWebhookVerifyResult,
} from '../../shared/types/index.js';
import { ProviderError, ProviderRateLimitError, InsufficientLiquidityError } from '../../shared/errors/index.js';
import { compareNumericStrings, futureISO } from '@finlayer/utils';
import { logger } from '../../shared/utils/logger.js';

const CHANGENOW_API_URL = 'https://api.changenow.io/v2';
const QUOTE_TTL_SECONDS = 300; // 5 minutes

interface ChangeNOWMinAmountResponse {
  minAmount: number | string;
  maxAmount: number | string | null;
}

interface ChangeNOWEstimatedResponse {
  fromAmount: number | string;
  toAmount: number | string;
  flow: string;
  type: string;
  validUntil: string | null;
  transactionSpeedForecast: string | null;
  networkFee?: number | string | null;
  withdrawalFee?: number | string | null;
  rateId?: string | null;
}

interface ChangeNOWExchangeResponse {
  id: string;
  type: string;
  status: string;
  validUntil: string | null;
  payinAddress: string;
  payoutAddress: string;
  fromAmount: number | string;
  toAmount: number | string;
  fromCurrency: string;
  toCurrency: string;
}

interface ChangeNOWStatusResponse {
  id: string;
  status:
    | 'new'
    | 'waiting'
    | 'confirming'
    | 'exchanging'
    | 'sending'
    | 'finished'
    | 'failed'
    | 'refunded'
    | 'verifying';
  payinHash: string | null;
  payoutHash: string | null;
}

// Status mapping from ChangeNOW → FinLayer
const STATUS_MAP: Record<ChangeNOWStatusResponse['status'], SwapStatusResult['status']> = {
  new: 'pending',
  waiting: 'pending',
  confirming: 'processing',
  exchanging: 'processing',
  sending: 'processing',
  finished: 'completed',
  failed: 'failed',
  refunded: 'refunded',
  verifying: 'processing',
};

export class ChangeNOWAdapter implements ISwapProviderAdapter {
  public readonly name = 'ChangeNOW';
  public readonly domain = 'swap' as const;
  public readonly supportedAssets: string[] = []; // Populated on first call

  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly webhookSecret: string;

  constructor(apiKey: string, webhookSecret: string = '', apiUrl: string = CHANGENOW_API_URL) {
    this.apiKey = apiKey;
    this.webhookSecret = webhookSecret;
    this.apiUrl = apiUrl;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.request<{ result: boolean }>('/market-info/available-pairs', 'GET', undefined, false);
      return Array.isArray(res);
    } catch {
      return false;
    }
  }

  async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    const { fromAsset, toAsset, amount, fromNetwork, toNetwork } = params;
    const fromCurrency = fromAsset.toLowerCase();
    const toCurrency = toAsset.toLowerCase();

    // 1. Get min/max amounts
    let minAmount = '0.001';
    let maxAmount = '999999';
    try {
      const minQuery = new URLSearchParams({
        fromCurrency,
        toCurrency,
        flow: 'fixed-rate',
      });
      if (fromNetwork) minQuery.set('fromNetwork', fromNetwork.toLowerCase());
      if (toNetwork) minQuery.set('toNetwork', toNetwork.toLowerCase());

      const minRes = await this.request<ChangeNOWMinAmountResponse>(
        `/exchange/min-amount?${minQuery.toString()}`,
        'GET'
      );
      minAmount = String(minRes.minAmount);
      maxAmount = minRes.maxAmount !== null && minRes.maxAmount !== undefined
        ? String(minRes.maxAmount)
        : '999999';
    } catch (err) {
      logger.warn('ChangeNOW: failed to get min amount', { error: String(err) });
    }

    // Validate amount is within range
    if (compareNumericStrings(amount, minAmount) < 0) {
      throw new InsufficientLiquidityError(fromAsset, toAsset);
    }

    // 2. Get estimated exchange amount
    const estimateQuery = new URLSearchParams({
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      flow: 'fixed-rate',
      type: 'direct',
      useRateId: 'true',
    });
    if (fromNetwork) estimateQuery.set('fromNetwork', fromNetwork.toLowerCase());
    if (toNetwork) estimateQuery.set('toNetwork', toNetwork.toLowerCase());

    const estimated = await this.request<ChangeNOWEstimatedResponse>(
      `/exchange/estimated-amount?${estimateQuery.toString()}`,
      'GET'
    );

    const estimatedFromAmount = String(estimated.fromAmount);
    const estimatedToAmount = String(estimated.toAmount);
    if (compareNumericStrings(estimatedToAmount, '0') <= 0) {
      throw new InsufficientLiquidityError(fromAsset, toAsset);
    }

    if (!estimated.rateId) {
      throw new ProviderError(this.name, 'fixed-rate quote did not include rateId');
    }

    // Calculate exchange rate
    const rate = (Number(estimated.toAmount) / Number(estimated.fromAmount)).toFixed(8);
    const networkFee = estimated.networkFee ?? estimated.withdrawalFee ?? '0';

    logger.debug('ChangeNOW quote obtained', {
      fromAsset,
      toAsset,
      fromAmount: amount,
      toAmount: estimated.toAmount,
      rate,
      providerQuoteId: estimated.rateId,
    });

    return {
      providerQuoteId: estimated.rateId,
      fromAsset: fromAsset.toUpperCase(),
      toAsset: toAsset.toUpperCase(),
      fromAmount: estimatedFromAmount,
      toAmount: estimatedToAmount,
      rate,
      networkFee: String(networkFee),
      feeAsset: toAsset.toUpperCase(),
      estimatedDurationSeconds: this.parseDuration(estimated.transactionSpeedForecast),
      expiresAt: estimated.validUntil ?? futureISO(QUOTE_TTL_SECONDS),
      minAmount,
      maxAmount,
    };
  }

  async executeSwap(params: SwapExecuteParams): Promise<SwapExecuteResult> {
    const fromCurrency = params.fromAsset.toLowerCase();
    const toCurrency = params.toAsset.toLowerCase();

    const body: Record<string, string> = {
      fromCurrency,
      toCurrency,
      fromAmount: params.fromAmount,
      address: params.recipientAddress,
      flow: 'fixed-rate',
      type: 'direct',
      rateId: params.providerQuoteId,
    };
    if (params.refundAddress) {
      body['refundAddress'] = params.refundAddress;
    }

    const response = await this.request<ChangeNOWExchangeResponse>('/exchange', 'POST', body);
    if (
      response.fromCurrency.toLowerCase() !== fromCurrency ||
      response.toCurrency.toLowerCase() !== toCurrency
    ) {
      throw new ProviderError(this.name, 'fixed-rate execution currency pair does not match saved quote');
    }

    if (
      compareNumericStrings(String(response.fromAmount), params.fromAmount) !== 0 ||
      compareNumericStrings(String(response.toAmount), params.toAmount) !== 0
    ) {
      throw new ProviderError(this.name, 'fixed-rate execution amount does not match saved quote');
    }

    return {
      providerTxId: response.id,
      depositAddress: response.payinAddress,
      status: 'pending',
      fromAmount: String(response.fromAmount),
      toAmount: String(response.toAmount),
    };
  }

  async getTransactionStatus(providerTxId: string): Promise<SwapStatusResult> {
    const response = await this.request<ChangeNOWStatusResponse>(`/exchange/by-id?id=${providerTxId}`, 'GET');

    return {
      providerTxId: response.id,
      status: STATUS_MAP[response.status] ?? 'pending',
      ...(response.payoutHash ? { txHash: response.payoutHash } : {}),
    };
  }

  /**
   * Verify a ChangeNOW webhook delivery.
   *
   * ChangeNOW signs the raw request body with HMAC-SHA256 using the secret
   * configured in the merchant dashboard, delivered in the
   * `x-changenow-signature` header. We fail closed: when no secret is
   * configured the signature can never be considered valid.
   */
  verifyWebhook(params: SwapWebhookVerifyParams): SwapWebhookVerifyResult | null {
    const secret = params.secret ?? this.webhookSecret;
    const signatureHeader = headerValue(params.headers, 'x-changenow-signature');
    const signatureValid = secret
      ? verifyHmacSha256(params.rawBody, secret, signatureHeader)
      : false;

    let payload: ChangeNOWStatusResponse;
    try {
      payload = JSON.parse(params.rawBody) as ChangeNOWStatusResponse;
    } catch {
      return null;
    }

    const providerTxId = String(payload.id ?? '');
    if (!providerTxId) return null;

    return {
      providerTxId,
      status: STATUS_MAP[payload.status] ?? 'pending',
      signatureValid,
      ...(payload.payoutHash ? { txHash: payload.payoutHash } : {}),
    };
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    requiresAuth = true
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-changenow-api-key': this.apiKey,
    };

    const url = `${this.apiUrl}${path}`;

    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name);
    }

    if (!res.ok) {
      const errorText = await res.text();
      let errorMsg = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(errorText) as { message?: string; error?: string };
        errorMsg = errJson.message ?? errJson.error ?? errorMsg;
      } catch {
        errorMsg = errorText || errorMsg;
      }
      throw new ProviderError(this.name, errorMsg);
    }

    return res.json() as Promise<T>;
  }

  private parseDuration(forecast: string | null): number {
    // e.g. "5-10" minutes → average in seconds
    if (!forecast) return 600;
    const match = forecast.match(/(\d+)(?:-(\d+))?/);
    if (!match) return 600;
    const min = parseInt(match[1] ?? '5', 10);
    const max = match[2] ? parseInt(match[2], 10) : min;
    return Math.round(((min + max) / 2) * 60);
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const raw = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

function verifyHmacSha256(body: string, secret: string, signature: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
