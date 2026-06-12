/**
 * modules/providers/nowpayments/adapter.ts
 * NowPayments crypto-invoice provider adapter.
 *
 * API Reference: https://documenter.getpostman.com/view/7907941/S1a32n38
 * Implements IPaymentProviderAdapter.
 *
 * NowPayments returns a real deposit address for each invoice, which we expose
 * as `paymentAddress`. Webhook ("IPN") deliveries are signed with HMAC-SHA512.
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

const NOWPAYMENTS_API_URL = 'https://api.nowpayments.io/v1';
const INVOICE_TTL_SECONDS = 24 * 60 * 60;

interface NowPaymentsPaymentResponse {
  payment_id: number | string;
  payment_status:
    | 'waiting'
    | 'confirming'
    | 'confirmed'
    | 'sending'
    | 'partially_paid'
    | 'finished'
    | 'failed'
    | 'refunded'
    | 'expired';
  pay_address: string;
  pay_amount: number;
  pay_currency: string;
  price_amount: number;
  price_currency: string;
  actually_paid?: number;
  order_id?: string;
  created_at: string;
  updated_at: string;
  outcome_amount?: number;
  outcome_currency?: string;
  txid?: string;
}

const STATUS_MAP: Record<NowPaymentsPaymentResponse['payment_status'], InvoiceStatusResult['status']> = {
  waiting: 'pending',
  confirming: 'pending',
  confirmed: 'paid',
  sending: 'paid',
  finished: 'paid',
  partially_paid: 'underpaid',
  failed: 'expired',
  refunded: 'expired',
  expired: 'expired',
};

export class NowPaymentsAdapter implements IPaymentProviderAdapter {
  public readonly name = 'NowPayments';
  public readonly domain = 'payments' as const;
  public readonly supportedAssets: string[] = ['BTC', 'ETH', 'USDC', 'USDT', 'LTC', 'XMR', 'DOGE'];

  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret: string = '',
    private readonly apiUrl: string = NOWPAYMENTS_API_URL
  ) {}

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/status`, {
        headers: { 'x-api-key': this.apiKey },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createInvoice(params: InvoiceCreateParams): Promise<InvoiceResult> {
    const { asset, amount, network, description, webhookUrl, expiresInSeconds } = params;

    const body: Record<string, unknown> = {
      price_amount: amount,
      price_currency: 'usd',
      pay_currency: asset.toLowerCase(),
      order_description: description,
      ipn_callback_url: webhookUrl,
    };
    if (network) body['pay_network'] = network;

    const res = await this.request<NowPaymentsPaymentResponse>('/payment', 'POST', body);

    logger.debug('NowPayments invoice created', {
      providerInvoiceId: res.payment_id,
      asset,
      amount,
    });

    return {
      providerInvoiceId: String(res.payment_id),
      paymentAddress: res.pay_address,
      expiresAt: futureISO(expiresInSeconds ?? INVOICE_TTL_SECONDS),
    };
  }

  async getInvoiceStatus(providerInvoiceId: string): Promise<InvoiceStatusResult> {
    const res = await this.request<NowPaymentsPaymentResponse>(
      `/payment/${providerInvoiceId}`,
      'GET'
    );

    return {
      providerInvoiceId: String(res.payment_id),
      status: STATUS_MAP[res.payment_status] ?? 'pending',
      paidAmount: res.actually_paid != null ? String(res.actually_paid) : undefined,
      txHash: res.txid ?? undefined,
      paidAt:
        res.payment_status === 'finished' || res.payment_status === 'confirmed'
          ? res.updated_at
          : undefined,
    };
  }

  verifyWebhook(params: WebhookVerifyParams): WebhookVerifyResult | null {
    const secret = params.secret ?? this.webhookSecret;
    const signatureHeader = headerValue(params.headers, 'x-nowpayments-sig');
    const signatureValid = secret
      ? verifyHmacSha512(params.rawBody, secret, signatureHeader)
      : false;

    let payload: NowPaymentsPaymentResponse & { event?: string };
    try {
      payload = JSON.parse(params.rawBody) as typeof payload;
    } catch {
      return null;
    }

    const providerInvoiceId = String(payload.payment_id ?? '');
    if (!providerInvoiceId) return null;

    return {
      providerEventId: `${providerInvoiceId}:${payload.payment_status}:${payload.updated_at ?? ''}`,
      providerInvoiceId,
      eventType: payload.event ?? 'payment_updated',
      status: STATUS_MAP[payload.payment_status] ?? 'pending',
      paidAmount: payload.actually_paid != null ? String(payload.actually_paid) : undefined,
      txHash: payload.txid ?? undefined,
      paidAt:
        payload.payment_status === 'finished' || payload.payment_status === 'confirmed'
          ? payload.updated_at
          : undefined,
      signatureValid,
    };
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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

function verifyHmacSha512(body: string, secret: string, signature: string): boolean {
  if (!signature) return false;
  // NowPayments signs a canonicalized (keys sorted) JSON body.
  let canonical = body;
  try {
    canonical = canonicalJSON(JSON.parse(body));
  } catch {
    // fall back to raw body
  }
  const expected = createHmac('sha512', secret).update(canonical).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map(k => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${body}}`;
}
