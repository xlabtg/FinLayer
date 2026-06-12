/**
 * Mock payment provider for testing.
 * Simulates MoonPay/Transak/NowPayments without real API calls.
 */

import type {
  IPaymentProviderAdapter,
  InvoiceCreateParams,
  InvoiceResult,
  InvoiceStatusResult,
  WebhookVerifyParams,
  WebhookVerifyResult,
} from '../../../../modules/shared/types/index.js';
import { futureISO } from '@finlayer/utils';

export class MockPaymentProvider implements IPaymentProviderAdapter {
  public readonly name = 'MockPayments';
  public readonly domain = 'payments' as const;
  public readonly supportedAssets = ['BTC', 'ETH', 'USDC', 'USDT'];

  public invoices = new Map<string, InvoiceStatusResult>();
  /** Toggle to force signature verification to fail for testing. */
  public forceInvalidSignature = false;

  /** Number of times createInvoice has been invoked (idempotency tests). */
  public createInvoiceCalls = 0;

  /** Last create parameters, used by webhook routing tests. */
  public lastCreateInvoiceParams: InvoiceCreateParams | null = null;

  /** Optional artificial delay (ms) before createInvoice resolves, to widen the concurrency race window. */
  public createInvoiceDelayMs = 0;

  /** Toggle to force createInvoice to throw, to test reservation rollback. */
  public forceCreateError = false;

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async createInvoice(params: InvoiceCreateParams): Promise<InvoiceResult> {
    this.createInvoiceCalls += 1;
    this.lastCreateInvoiceParams = params;
    if (this.createInvoiceDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.createInvoiceDelayMs));
    }
    if (this.forceCreateError) {
      throw new Error('provider createInvoice failure');
    }
    const providerInvoiceId = `mock_inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const paymentAddress = `mock_addr_${Math.random().toString(36).slice(2, 16)}`;
    const expiresAt = futureISO(params.expiresInSeconds ?? 3600);
    this.invoices.set(providerInvoiceId, {
      providerInvoiceId,
      status: 'pending',
    });
    return { providerInvoiceId, paymentAddress, expiresAt };
  }

  async getInvoiceStatus(providerInvoiceId: string): Promise<InvoiceStatusResult> {
    return (
      this.invoices.get(providerInvoiceId) ?? {
        providerInvoiceId,
        status: 'pending',
      }
    );
  }

  verifyWebhook(params: WebhookVerifyParams): WebhookVerifyResult | null {
    try {
      const body = JSON.parse(params.rawBody) as {
        event_id?: string;
        invoice_id?: string;
        status?: InvoiceStatusResult['status'];
        paid_amount?: string;
        tx_hash?: string;
      };
      if (!body.invoice_id) return null;
      return {
        providerEventId: body.event_id ?? `${body.invoice_id}:${body.status ?? 'unknown'}`,
        providerInvoiceId: body.invoice_id,
        eventType: 'payment_updated',
        status: body.status ?? 'pending',
        paidAmount: body.paid_amount,
        txHash: body.tx_hash,
        paidAt: body.status === 'paid' ? new Date().toISOString() : undefined,
        signatureValid: !this.forceInvalidSignature,
      };
    } catch {
      return null;
    }
  }

  /** Test helper. */
  setInvoiceStatus(providerInvoiceId: string, update: Partial<InvoiceStatusResult>): void {
    const current = this.invoices.get(providerInvoiceId) ?? {
      providerInvoiceId,
      status: 'pending',
    };
    this.invoices.set(providerInvoiceId, { ...current, ...update });
  }
}
