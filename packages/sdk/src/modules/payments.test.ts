import { describe, expect, test } from 'bun:test';

import type { FinLayerClient } from '../client.js';
import { PaymentsModule } from './payments.js';
import type { Invoice, InvoiceStatus } from '@finlayer/types';

class SequenceClient {
  public readonly calls: Array<{
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
  }> = [];

  constructor(private readonly statuses: InvoiceStatus[]) {}

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string
  ): Promise<T> {
    this.calls.push({ method, path });
    const status = this.statuses[Math.min(this.calls.length - 1, this.statuses.length - 1)]!;
    return { invoice: buildInvoice(status) } as T;
  }
}

describe('PaymentsModule', () => {
  test('waitForPayment continues polling after underpaid until paid', async () => {
    const client = new SequenceClient(['underpaid', 'paid']);
    const payments = new PaymentsModule(client as unknown as FinLayerClient);

    const invoice = await payments.waitForPayment('invoice-1', {
      timeoutMs: 1000,
      pollIntervalMs: 0,
    });

    expect(invoice.status).toBe('paid');
    expect(client.calls).toEqual([
      { method: 'GET', path: '/v1/payments/invoice/invoice-1' },
      { method: 'GET', path: '/v1/payments/invoice/invoice-1' },
    ]);
  });
});

function buildInvoice(status: InvoiceStatus): Invoice {
  return {
    id: 'invoice-1',
    transaction_id: 'transaction-1',
    provider_id: 'provider-1',
    provider_name: 'MockPayments',
    asset: 'USDC',
    amount: '100',
    network: 'ethereum',
    payment_address: 'mock-address',
    status,
    description: null,
    callback_url: null,
    expires_at: '2026-06-12T13:00:00.000Z',
    paid_at: status === 'paid' ? '2026-06-12T12:00:00.000Z' : null,
    paid_amount: status === 'paid' ? '100' : status === 'underpaid' ? '40' : null,
    tx_hash: status === 'paid' ? '0xpaid' : status === 'underpaid' ? '0xpartial' : null,
    affiliate_id: null,
    webhook_url: 'http://test.local/v1/payments/webhook/MockPayments',
    revenue_event_id: null,
    created_at: '2026-06-12T11:00:00.000Z',
    updated_at: '2026-06-12T12:00:00.000Z',
  };
}
