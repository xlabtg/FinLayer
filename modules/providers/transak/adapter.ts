/**
 * modules/providers/transak/adapter.ts
 * Transak fiat on-ramp provider adapter.
 *
 * API Reference: https://docs.transak.com/
 * Implements IPaymentProviderAdapter.
 *
 * Like MoonPay, Transak's buyer flow is widget-based — the adapter returns
 * the hosted widget URL in `paymentAddress`. The webhook delivery carries
 * payment confirmation.
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

const TRANSAK_API_URL = 'https://api.transak.com';
const TRANSAK_WIDGET_URL = 'https://global.transak.com';
const INVOICE_TTL_SECONDS = 24 * 60 * 60;

interface TransakOrder {
  id: string;
  status:
    | 'AWAITING_PAYMENT_FROM_USER'
    | 'PAYMENT_DONE_MARKED_BY_USER'
    | 'PROCESSING'
    | 'PENDING_DELIVERY_FROM_TRANSAK'
    | 'ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'FAILED'
    | 'REFUNDED'
    | 'EXPIRED';
  fiatAmount: number;
  cryptoAmount: number | null;
  transactionHash: string | null;
  walletAddress: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_MAP: Record<TransakOrder['status'], InvoiceStatusResult['status']> = {
  AWAITING_PAYMENT_FROM_USER: 'pending',
  PAYMENT_DONE_MARKED_BY_USER: 'pending',
  PROCESSING: 'pending',
  PENDING_DELIVERY_FROM_TRANSAK: 'pending',
  ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK: 'pending',
  COMPLETED: 'paid',
  CANCELLED: 'expired',
  FAILED: 'expired',
  REFUNDED: 'expired',
  EXPIRED: 'expired',
};

export class TransakAdapter implements IPaymentProviderAdapter {
  public readonly name = 'Transak';
  public readonly domain = 'payments' as const;
  public readonly supportedAssets: string[] = ['BTC', 'ETH', 'USDC', 'USDT', 'MATIC'];

  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret: string = '',
    private readonly apiUrl: string = TRANSAK_API_URL
  ) {}

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v2/currencies/crypto-currencies`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async createInvoice(params: InvoiceCreateParams): Promise<InvoiceResult> {
    const { asset, amount, network, webhookUrl } = params;
    const query = new URLSearchParams({
      apiKey: this.apiKey,
      cryptoCurrencyCode: asset.toUpperCase(),
      fiatAmount: String(amount),
      fiatCurrency: 'USD',
    });
    if (network) query.set('network', network);
    query.set('redirectURL', webhookUrl);

    const widgetUrl = `${TRANSAK_WIDGET_URL}?${query.toString()}`;
    const providerInvoiceId = `tk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    logger.debug('Transak invoice created', { providerInvoiceId, asset, amount });

    return {
      providerInvoiceId,
      paymentAddress: widgetUrl,
      expiresAt: futureISO(params.expiresInSeconds ?? INVOICE_TTL_SECONDS),
    };
  }

  async getInvoiceStatus(providerInvoiceId: string): Promise<InvoiceStatusResult> {
    const res = await this.request<{ response: TransakOrder }>(
      `/api/v2/orders/${providerInvoiceId}`
    );
    const order = res.response;

    return {
      providerInvoiceId: order.id,
      status: STATUS_MAP[order.status] ?? 'pending',
      paidAmount: order.cryptoAmount != null ? String(order.cryptoAmount) : undefined,
      txHash: order.transactionHash ?? undefined,
      paidAt: order.status === 'COMPLETED' ? order.updatedAt : undefined,
    };
  }

  verifyWebhook(params: WebhookVerifyParams): WebhookVerifyResult | null {
    const secret = params.secret ?? this.webhookSecret;
    const signatureHeader = headerValue(params.headers, 'x-transak-signature');
    const signatureValid = secret
      ? verifyHmacSha256(params.rawBody, secret, signatureHeader)
      : false;

    let payload: {
      eventID?: string;
      webhookData?: TransakOrder;
      eventName?: string;
      status?: { id?: string; status?: TransakOrder['status'] };
    };
    try {
      payload = JSON.parse(params.rawBody) as typeof payload;
    } catch {
      return null;
    }

    const order = payload.webhookData ?? (payload.status as TransakOrder | undefined);
    const providerInvoiceId = order?.id ?? '';
    if (!providerInvoiceId) return null;

    const status = order?.status as TransakOrder['status'] | undefined;

    return {
      providerEventId: payload.eventID ?? `${providerInvoiceId}:${status ?? 'unknown'}`,
      providerInvoiceId,
      eventType: payload.eventName ?? 'order_updated',
      status: status ? STATUS_MAP[status] ?? 'pending' : 'pending',
      paidAmount:
        order && 'cryptoAmount' in order && order.cryptoAmount != null
          ? String(order.cryptoAmount)
          : undefined,
      txHash: order?.transactionHash ?? undefined,
      paidAt: status === 'COMPLETED' ? order?.updatedAt : undefined,
      signatureValid,
    };
  }

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'api-secret': this.apiKey,
      },
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
