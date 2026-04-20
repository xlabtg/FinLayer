/**
 * modules/providers/moonpay/adapter.ts
 * MoonPay fiat on-ramp provider adapter.
 *
 * API Reference: https://dev.moonpay.com/
 * Implements IPaymentProviderAdapter for fiat → crypto invoicing.
 *
 * MoonPay's "invoice" concept maps to a widget URL the buyer opens to
 * complete a fiat purchase. The adapter returns that URL as the
 * `paymentAddress` so the unified invoice API stays consistent across
 * fiat on-ramp (MoonPay/Transak) and pure-crypto invoicing (NowPayments).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type {
  IPaymentProviderAdapter,
  InvoiceCreateParams,
  InvoiceResult,
  InvoiceStatusResult,
  WebhookVerifyParams,
  WebhookVerifyResult,
} from '../../shared/types/index.js';
import { ProviderError, ProviderRateLimitError } from '../../shared/errors/index.js';
import { futureISO } from '@finlayer/utils';
import { logger } from '../../shared/utils/logger.js';

const MOONPAY_API_URL = 'https://api.moonpay.com';
const MOONPAY_WIDGET_URL = 'https://buy.moonpay.com';
const INVOICE_TTL_SECONDS = 24 * 60 * 60;

interface MoonPayTransaction {
  id: string;
  status:
    | 'waitingPayment'
    | 'pending'
    | 'waitingAuthorization'
    | 'failed'
    | 'completed';
  baseCurrencyAmount: number;
  quoteCurrencyAmount: number | null;
  cryptoTransactionId: string | null;
  walletAddress: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_MAP: Record<MoonPayTransaction['status'], InvoiceStatusResult['status']> = {
  waitingPayment: 'pending',
  pending: 'pending',
  waitingAuthorization: 'pending',
  completed: 'paid',
  failed: 'expired',
};

export class MoonPayAdapter implements IPaymentProviderAdapter {
  public readonly name = 'MoonPay';
  public readonly domain = 'payments' as const;
  public readonly supportedAssets: string[] = ['BTC', 'ETH', 'USDC', 'USDT', 'SOL'];

  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret: string = '',
    private readonly apiUrl: string = MOONPAY_API_URL
  ) {}

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/v3/currencies?apiKey=${this.apiKey}`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async createInvoice(params: InvoiceCreateParams): Promise<InvoiceResult> {
    const { asset, amount, network, callbackUrl } = params;

    // MoonPay uses widget-based flow: we build a signed widget URL that the
    // buyer opens. The webhook delivery confirms payment.
    const query = new URLSearchParams({
      apiKey: this.apiKey,
      currencyCode: asset.toLowerCase(),
      baseCurrencyAmount: String(amount),
    });
    if (network) query.set('network', network);
    if (callbackUrl) query.set('redirectURL', callbackUrl);

    const widgetUrl = `${MOONPAY_WIDGET_URL}?${query.toString()}`;
    const providerInvoiceId = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    logger.debug('MoonPay invoice created', { providerInvoiceId, asset, amount });

    return {
      providerInvoiceId,
      paymentAddress: widgetUrl,
      expiresAt: futureISO(params.expiresInSeconds ?? INVOICE_TTL_SECONDS),
    };
  }

  async getInvoiceStatus(providerInvoiceId: string): Promise<InvoiceStatusResult> {
    const res = await this.request<MoonPayTransaction>(`/v1/transactions/${providerInvoiceId}`);

    return {
      providerInvoiceId: res.id,
      status: STATUS_MAP[res.status] ?? 'pending',
      paidAmount: res.quoteCurrencyAmount != null ? String(res.quoteCurrencyAmount) : undefined,
      txHash: res.cryptoTransactionId ?? undefined,
      paidAt: res.status === 'completed' ? res.updatedAt : undefined,
    };
  }

  verifyWebhook(params: WebhookVerifyParams): WebhookVerifyResult | null {
    const secret = params.secret ?? this.webhookSecret;
    const signatureHeader = headerValue(params.headers, 'moonpay-signature-v2');
    const signatureValid = secret
      ? verifyHmacSha256(params.rawBody, secret, signatureHeader)
      : false;

    let payload: {
      type?: string;
      data?: {
        id?: string;
        status?: MoonPayTransaction['status'];
        cryptoTransactionId?: string | null;
        quoteCurrencyAmount?: number | null;
        updatedAt?: string;
      };
      object?: string;
    };
    try {
      payload = JSON.parse(params.rawBody) as typeof payload;
    } catch {
      return null;
    }

    const data = payload.data ?? {};
    const providerInvoiceId = data.id ?? '';
    if (!providerInvoiceId) return null;

    return {
      providerEventId: `${providerInvoiceId}:${data.status ?? 'unknown'}`,
      providerInvoiceId,
      eventType: payload.type ?? 'transaction_updated',
      status: data.status ? STATUS_MAP[data.status] ?? 'pending' : 'pending',
      paidAmount:
        data.quoteCurrencyAmount != null ? String(data.quoteCurrencyAmount) : undefined,
      txHash: data.cryptoTransactionId ?? undefined,
      paidAt: data.status === 'completed' ? data.updatedAt : undefined,
      signatureValid,
    };
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.apiUrl}${path}?apiKey=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 429) {
      throw new ProviderRateLimitError(this.name);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new ProviderError(this.name, text || `HTTP ${res.status}`, 'payments');
    }
    return res.json() as Promise<T>;
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
