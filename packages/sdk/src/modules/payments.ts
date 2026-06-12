/**
 * FinLayer SDK — Payments Module
 * Fiat on-ramp and crypto-invoice aggregation.
 */

import type {
  Invoice,
  InvoiceCreateRequest,
  InvoiceResponse,
  InvoiceStatusResponse,
  Provider,
} from '@finlayer/types';
import type { FinLayerClient } from '../client.js';

export class PaymentsModule {
  constructor(private readonly client: FinLayerClient) {}

  /**
   * Create a new invoice.
   *
   * @example
   * const { invoice } = await finlayer.payments.createInvoice({
   *   asset: 'USDC',
   *   amount: '100',
   *   idempotency_key: crypto.randomUUID(),
   * });
   * console.log('Pay at:', invoice.payment_address);
   */
  async createInvoice(params: InvoiceCreateRequest): Promise<InvoiceResponse> {
    return this.client.request<InvoiceResponse>(
      'POST',
      '/v1/payments/invoice',
      this.client['withAffiliate'](params),
      { idempotencyKey: params.idempotency_key }
    );
  }

  /**
   * Fetch an invoice. Refreshes from the provider if not terminal.
   *
   * @example
   * const { invoice } = await finlayer.payments.getInvoice(invoiceId);
   * console.log('Status:', invoice.status);
   */
  async getInvoice(invoiceId: string): Promise<InvoiceStatusResponse> {
    return this.client.request<InvoiceStatusResponse>('GET', `/v1/payments/invoice/${invoiceId}`);
  }

  /**
   * List active payment providers.
   */
  async providers(): Promise<Provider[]> {
    return this.client.request<Provider[]>('GET', '/v1/payments/providers');
  }

  /**
   * Poll invoice status until terminal (paid / overpaid / expired) or timeout.
   *
   * @example
   * const final = await finlayer.payments.waitForPayment(invoiceId, {
   *   timeoutMs: 60 * 60 * 1000,
   *   pollIntervalMs: 10_000,
   * });
   */
  async waitForPayment(
    invoiceId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<Invoice> {
    const { timeoutMs = 60 * 60 * 1000, pollIntervalMs = 15_000 } = options;
    const start = Date.now();
    const terminal = new Set(['paid', 'expired', 'overpaid']);

    while (Date.now() - start < timeoutMs) {
      const { invoice } = await this.getInvoice(invoiceId);
      if (terminal.has(invoice.status)) return invoice;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Invoice ${invoiceId} did not settle within ${timeoutMs}ms`);
  }
}
