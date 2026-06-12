/**
 * E2E tests for payments flow (mock provider).
 * Tests: create invoice → webhook processing (idempotent) → status lookup
 *
 * Uses mock DB and mock provider — no external dependencies.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'crypto';
import { PaymentsService } from '../../../../modules/payments/service.js';
import { MockPaymentProvider } from './mock-payment-provider.js';
import { createMockSql, createTestUserId } from './setup.js';
import { generateUUID } from '@finlayer/utils';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyError,
  InvalidWebhookSignatureError,
  InvoiceNotFoundError,
  PaymentProviderUnavailableError,
  ValidationError,
} from '../../../../modules/shared/errors/index.js';
import type { IPaymentProviderAdapter } from '../../../../modules/shared/types/index.js';
import { MoonPayAdapter } from '../../../../modules/providers/moonpay/adapter.js';
import { TransakAdapter } from '../../../../modules/providers/transak/adapter.js';
import { NowPaymentsAdapter } from '../../../../modules/providers/nowpayments/adapter.js';

describe('Payments Flow', () => {
  let paymentsService: PaymentsService;
  let mockProvider: MockPaymentProvider;
  let userId: string;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockProvider = new MockPaymentProvider();
    const providers = new Map<string, IPaymentProviderAdapter>([
      [mockProvider.name, mockProvider],
    ]);
    mockSql = createMockSql();
    paymentsService = new PaymentsService(mockSql as never, providers, 'http://test.local');
    userId = createTestUserId();
  });

  describe('POST /v1/payments/invoice', () => {
    test('creates an invoice and persists it', async () => {
      const invoice = await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: `inv-${generateUUID()}`,
      });

      expect(invoice.id).toBeDefined();
      expect(invoice.transaction_id).toBeDefined();
      expect(invoice.status).toBe('pending');
      expect(invoice.payment_address).toBeDefined();
      expect(invoice.payment_address.length).toBeGreaterThan(0);
      expect(invoice.asset).toBe('USDC');
      expect(invoice.amount).toBe('100');
      expect(invoice.webhook_url).toContain('/v1/payments/webhook/');
      expect(new Date(invoice.expires_at).getTime()).toBeGreaterThan(Date.now());

      // Check persistence
      const invoices = mockSql._tables.get('invoices') ?? [];
      expect(invoices.length).toBe(1);

      const txs = mockSql._tables.get('transactions') ?? [];
      expect(txs.length).toBe(1);
      expect(txs[0]!['type']).toBe('payment');
      expect(txs[0]!['domain']).toBe('payments');
    });

    test('passes the internal webhook URL to provider while preserving user callback_url', async () => {
      const userCallbackUrl = 'https://client.example/payments/return';

      const invoice = await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        callback_url: userCallbackUrl,
        idempotency_key: `inv-${generateUUID()}`,
      });

      expect(mockProvider.lastCreateInvoiceParams?.webhookUrl).toBe(
        'http://test.local/v1/payments/webhook/MockPayments'
      );
      expect(invoice.webhook_url).toBe('http://test.local/v1/payments/webhook/MockPayments');
      expect(invoice.callback_url).toBe(userCallbackUrl);
    });

    test('throws IdempotencyError when idempotency_key is missing', async () => {
      await expect(
        paymentsService.createInvoice(userId, {
          asset: 'USDC',
          amount: '100',
          idempotency_key: '',
        })
      ).rejects.toBeInstanceOf(IdempotencyError);
    });

    test('throws DuplicateIdempotencyKeyError on reuse', async () => {
      const key = `inv-${generateUUID()}`;
      await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: key,
      });

      await expect(
        paymentsService.createInvoice(userId, {
          asset: 'USDC',
          amount: '200',
          idempotency_key: key,
        })
      ).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
    });

    test('throws ValidationError for invalid amount', async () => {
      await expect(
        paymentsService.createInvoice(userId, {
          asset: 'USDC',
          amount: '-10',
          idempotency_key: generateUUID(),
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test('throws PaymentProviderUnavailableError when no providers configured', async () => {
      const emptyService = new PaymentsService(
        mockSql as never,
        new Map<string, IPaymentProviderAdapter>(),
        'http://test.local'
      );
      await expect(
        emptyService.createInvoice(userId, {
          asset: 'USDC',
          amount: '100',
          idempotency_key: generateUUID(),
        })
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    });
  });

  describe('Idempotency under concurrency (issue #15)', () => {
    test('concurrent requests with the same key call the provider exactly once', async () => {
      const key = `inv-${generateUUID()}`;
      // Widen the race window so both requests overlap inside createInvoice.
      mockProvider.createInvoiceDelayMs = 25;

      const results = await Promise.allSettled([
        paymentsService.createInvoice(userId, {
          asset: 'USDC',
          amount: '100',
          idempotency_key: key,
        }),
        paymentsService.createInvoice(userId, {
          asset: 'USDC',
          amount: '100',
          idempotency_key: key,
        }),
      ]);

      // Exactly one provider call — the core acceptance criterion.
      expect(mockProvider.createInvoiceCalls).toBe(1);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        DuplicateIdempotencyKeyError
      );

      // Only one transaction row and one invoice persisted for the key.
      const txs = (mockSql._tables.get('transactions') ?? []).filter(
        (t) => t['idempotency_key'] === key
      );
      expect(txs.length).toBe(1);
      const invoices = mockSql._tables.get('invoices') ?? [];
      expect(invoices.length).toBe(1);
    });

    test('provider failure releases the reservation so the key can be retried', async () => {
      const key = `inv-${generateUUID()}`;

      // First attempt: provider throws — reservation must be rolled back.
      mockProvider.forceCreateError = true;
      await expect(
        paymentsService.createInvoice(userId, {
          asset: 'USDC',
          amount: '100',
          idempotency_key: key,
        })
      ).rejects.toThrow();

      let txs = (mockSql._tables.get('transactions') ?? []).filter(
        (t) => t['idempotency_key'] === key
      );
      expect(txs.length).toBe(0);

      // Retry with the same key now succeeds.
      mockProvider.forceCreateError = false;
      const invoice = await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: key,
      });
      expect(invoice.id).toBeDefined();
      expect(mockProvider.createInvoiceCalls).toBe(2);

      txs = (mockSql._tables.get('transactions') ?? []).filter(
        (t) => t['idempotency_key'] === key
      );
      expect(txs.length).toBe(1);
    });
  });

  describe('GET /v1/payments/invoice/:id', () => {
    test('returns invoice for owning user', async () => {
      const created = await paymentsService.createInvoice(userId, {
        asset: 'BTC',
        amount: '0.01',
        idempotency_key: generateUUID(),
      });

      const fetched = await paymentsService.getInvoice(created.id, userId);
      expect(fetched.id).toBe(created.id);
      expect(fetched.asset).toBe('BTC');
    });

    test('throws InvoiceNotFoundError for unknown id', async () => {
      await expect(
        paymentsService.getInvoice(generateUUID(), userId)
      ).rejects.toBeInstanceOf(InvoiceNotFoundError);
    });
  });

  describe('POST /v1/payments/webhook/:provider', () => {
    test('updates invoice status to paid and emits revenue_event', async () => {
      const invoice = await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: generateUUID(),
      });

      // Extract the provider invoice id from the mock provider state.
      const providerInvoiceIds = [...mockProvider.invoices.keys()];
      expect(providerInvoiceIds.length).toBe(1);
      const providerInvoiceId = providerInvoiceIds[0]!;

      const payload = {
        event_id: `evt-${generateUUID()}`,
        invoice_id: providerInvoiceId,
        status: 'paid' as const,
        paid_amount: '100',
        tx_hash: '0xabcd',
      };

      const res = await paymentsService.handleWebhook({
        providerName: mockProvider.name,
        rawBody: JSON.stringify(payload),
        headers: {},
      });

      expect(res.processed).toBe(true);
      expect(res.duplicate).toBe(false);
      expect(res.invoiceId).toBe(invoice.id);
      expect(res.status).toBe('paid');

      // Invoice updated
      const refreshed = await paymentsService.getInvoice(invoice.id, userId);
      expect(refreshed.status).toBe('paid');
      expect(refreshed.paid_amount).toBe('100');
      expect(refreshed.tx_hash).toBe('0xabcd');

      // Transaction updated
      const txs = mockSql._tables.get('transactions') ?? [];
      expect(txs[0]!['status']).toBe('completed');

      // Revenue event created
      const revenueEvents = mockSql._tables.get('revenue_events') ?? [];
      expect(revenueEvents.length).toBe(1);
      expect(revenueEvents[0]!['source_domain']).toBe('payments');
    });

    test('does not downgrade a terminal paid invoice from a stale webhook', async () => {
      const invoice = await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: generateUUID(),
      });

      const providerInvoiceId = [...mockProvider.invoices.keys()][0]!;

      await paymentsService.handleWebhook({
        providerName: mockProvider.name,
        rawBody: JSON.stringify({
          event_id: `evt-paid-${generateUUID()}`,
          invoice_id: providerInvoiceId,
          status: 'paid',
          paid_amount: '100',
          tx_hash: '0xpaid',
        }),
        headers: {},
      });

      const stale = await paymentsService.handleWebhook({
        providerName: mockProvider.name,
        rawBody: JSON.stringify({
          event_id: `evt-stale-${generateUUID()}`,
          invoice_id: providerInvoiceId,
          status: 'pending',
        }),
        headers: {},
      });

      expect(stale.processed).toBe(true);
      expect(stale.duplicate).toBe(false);
      expect(stale.status).toBe('paid');

      const repeatedTerminal = await paymentsService.handleWebhook({
        providerName: mockProvider.name,
        rawBody: JSON.stringify({
          event_id: `evt-repeat-paid-${generateUUID()}`,
          invoice_id: providerInvoiceId,
          status: 'paid',
          paid_amount: '10',
          tx_hash: '0xlate',
        }),
        headers: {},
      });
      expect(repeatedTerminal.status).toBe('paid');

      const refreshed = await paymentsService.getInvoice(invoice.id, userId);
      expect(refreshed.status).toBe('paid');
      expect(refreshed.paid_amount).toBe('100');
      expect(refreshed.tx_hash).toBe('0xpaid');

      const txs = mockSql._tables.get('transactions') ?? [];
      expect(txs[0]!['status']).toBe('completed');
      expect(txs[0]!['result_amount']).toBe('100');

      const revenueEvents = mockSql._tables.get('revenue_events') ?? [];
      expect(revenueEvents.length).toBe(1);
    });

    test('calculates payment revenue from actual paid amount', async () => {
      await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: generateUUID(),
      });

      const providerInvoiceId = [...mockProvider.invoices.keys()][0]!;

      await paymentsService.handleWebhook({
        providerName: mockProvider.name,
        rawBody: JSON.stringify({
          event_id: `evt-partial-${generateUUID()}`,
          invoice_id: providerInvoiceId,
          status: 'paid',
          paid_amount: '40',
        }),
        headers: {},
      });

      const txs = mockSql._tables.get('transactions') ?? [];
      expect(txs[0]!['result_amount']).toBe('40');

      const revenueEvents = mockSql._tables.get('revenue_events') ?? [];
      expect(revenueEvents.length).toBe(1);
      expect(revenueEvents[0]!['total_fee']).toBe('0.12');
    });

    test('is idempotent: duplicate event ids are no-ops', async () => {
      const invoice = await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '50',
        idempotency_key: generateUUID(),
      });

      const providerInvoiceId = [...mockProvider.invoices.keys()][0]!;
      const eventId = `evt-${generateUUID()}`;

      const body = JSON.stringify({
        event_id: eventId,
        invoice_id: providerInvoiceId,
        status: 'paid',
        paid_amount: '50',
      });

      const first = await paymentsService.handleWebhook({
        providerName: mockProvider.name,
        rawBody: body,
        headers: {},
      });
      expect(first.processed).toBe(true);
      expect(first.duplicate).toBe(false);

      const second = await paymentsService.handleWebhook({
        providerName: mockProvider.name,
        rawBody: body,
        headers: {},
      });
      expect(second.processed).toBe(false);
      expect(second.duplicate).toBe(true);

      // Only one revenue event despite two deliveries
      const revenueEvents = mockSql._tables.get('revenue_events') ?? [];
      expect(revenueEvents.length).toBe(1);

      // Only one webhook row recorded
      const events = mockSql._tables.get('payment_webhook_events') ?? [];
      expect(events.length).toBe(1);
      expect(events[0]!['processed']).toBe(true);
      void invoice;
    });

    test('rejects webhook with invalid signature', async () => {
      mockProvider.forceInvalidSignature = true;
      await paymentsService.createInvoice(userId, {
        asset: 'USDC',
        amount: '25',
        idempotency_key: generateUUID(),
      });

      const providerInvoiceId = [...mockProvider.invoices.keys()][0]!;

      await expect(
        paymentsService.handleWebhook({
          providerName: mockProvider.name,
          rawBody: JSON.stringify({
            event_id: 'evt-1',
            invoice_id: providerInvoiceId,
            status: 'paid',
          }),
          headers: {},
        })
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);
    });

    test('rejects unknown provider', async () => {
      await expect(
        paymentsService.handleWebhook({
          providerName: 'DoesNotExist',
          rawBody: '{}',
          headers: {},
        })
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
    });

    test('rejects malformed payload', async () => {
      await expect(
        paymentsService.handleWebhook({
          providerName: mockProvider.name,
          rawBody: 'not-json',
          headers: {},
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test('MoonPay webhook with real transaction id updates invoice through externalTransactionId', async () => {
      const secret = 'moonpay-webhook-secret';
      const moonPay = new MoonPayAdapter('moonpay-api-key', secret);
      const service = new PaymentsService(
        mockSql as never,
        new Map<string, IPaymentProviderAdapter>([[moonPay.name, moonPay]]),
        'http://test.local'
      );
      mockSql._tables.get('providers')!.push({
        id: generateUUID(),
        name: moonPay.name,
        domain: 'payments',
        config: {},
        is_active: true,
        priority: 100,
      });

      const invoice = await service.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: generateUUID(),
        metadata: { provider: moonPay.name },
      });

      const payload = {
        type: 'transaction_updated',
        data: {
          id: 'mp_real_tx_123',
          externalTransactionId: invoice.id,
          status: 'completed',
          quoteCurrencyAmount: 100,
          cryptoTransactionId: '0xmoonpay',
          updatedAt: '2026-06-12T12:00:00.000Z',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

      const result = await service.handleWebhook({
        providerName: moonPay.name,
        rawBody,
        headers: { 'moonpay-signature-v2': signature },
      });

      expect(result.invoiceId).toBe(invoice.id);
      expect(result.status).toBe('paid');
      const refreshed = await service.getInvoice(invoice.id, userId);
      expect(refreshed.status).toBe('paid');
      expect(refreshed.tx_hash).toBe('0xmoonpay');
    });

    test('Transak webhook with real order id updates invoice through partnerOrderId', async () => {
      const secret = 'transak-webhook-secret';
      const transak = new TransakAdapter('transak-api-key', secret);
      const service = new PaymentsService(
        mockSql as never,
        new Map<string, IPaymentProviderAdapter>([[transak.name, transak]]),
        'http://test.local'
      );
      mockSql._tables.get('providers')!.push({
        id: generateUUID(),
        name: transak.name,
        domain: 'payments',
        config: {},
        is_active: true,
        priority: 100,
      });

      const invoice = await service.createInvoice(userId, {
        asset: 'USDC',
        amount: '100',
        idempotency_key: generateUUID(),
        metadata: { provider: transak.name },
      });

      const payload = {
        eventID: 'ORDER_COMPLETED',
        eventName: 'ORDER_COMPLETED',
        webhookData: {
          id: 'tk_real_order_123',
          partnerOrderId: invoice.id,
          status: 'COMPLETED',
          cryptoAmount: 98.5,
          transactionHash: '0xtransak',
          updatedAt: '2026-06-12T12:00:00.000Z',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

      const result = await service.handleWebhook({
        providerName: transak.name,
        rawBody,
        headers: { 'x-transak-signature': signature },
      });

      expect(result.invoiceId).toBe(invoice.id);
      expect(result.status).toBe('paid');
      const refreshed = await service.getInvoice(invoice.id, userId);
      expect(refreshed.status).toBe('paid');
      expect(refreshed.paid_amount).toBe('98.5');
      expect(refreshed.tx_hash).toBe('0xtransak');
    });
  });
});

describe('Provider adapter behavior', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('MoonPay: polls by externalTransactionId correlation id', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requests.push(url);

      return new Response(
        JSON.stringify([
          {
            id: 'mp_real_tx_123',
            externalTransactionId: 'inv_123',
            status: 'completed',
            quoteCurrencyAmount: 100,
            cryptoTransactionId: '0xmoonpay',
            walletAddress: null,
            createdAt: '2026-06-12T11:00:00.000Z',
            updatedAt: '2026-06-12T12:00:00.000Z',
          },
        ]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }) as typeof fetch;

    const adapter = new MoonPayAdapter('test-api-key');
    const status = await adapter.getInvoiceStatus('inv_123');

    const requestUrl = new URL(requests[0]!);
    expect(requestUrl.pathname).toBe('/v1/transactions/ext/inv_123');
    expect(requestUrl.searchParams.get('apiKey')).toBe('test-api-key');
    expect(status.providerInvoiceId).toBe('inv_123');
    expect(status.status).toBe('paid');
    expect(status.paidAmount).toBe('100');
    expect(status.txHash).toBe('0xmoonpay');
  });

  test('Transak: polls partner orders by partnerOrderId correlation id', async () => {
    const requests: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      requests.push({ url, method: init?.method ?? 'GET', body });

      if (url.endsWith('/partners/api/v2/refresh-token')) {
        return new Response(
          JSON.stringify({
            data: {
              accessToken: 'partner-access-token',
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      if (url.startsWith('https://transak.test/partners/api/v2/orders?')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'tk_real_order_123',
                partnerOrderId: 'inv_123',
                status: 'COMPLETED',
                cryptoAmount: 98.5,
                transactionHash: '0xtransak',
                walletAddress: '0xwallet',
                createdAt: '2026-06-12T11:00:00.000Z',
                updatedAt: '2026-06-12T12:00:00.000Z',
                completedAt: '2026-06-12T12:00:00.000Z',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response(JSON.stringify({ message: `Unexpected URL: ${url}` }), { status: 500 });
    }) as typeof fetch;

    const adapter = new TransakAdapter(
      'test-api-key',
      'test-webhook-secret',
      'https://transak.test',
      'test-api-secret'
    );
    const status = await adapter.getInvoiceStatus('inv_123');

    const refreshRequest = requests[0]!;
    expect(refreshRequest.url).toBe('https://transak.test/partners/api/v2/refresh-token');
    expect(refreshRequest.method).toBe('POST');
    expect(refreshRequest.body).toEqual({ apiKey: 'test-api-key' });

    const ordersRequest = requests[1]!;
    const ordersUrl = new URL(ordersRequest.url);
    expect(ordersUrl.pathname).toBe('/partners/api/v2/orders');
    expect(ordersUrl.searchParams.get('filter[partnerOrderId]')).toBe('inv_123');
    expect(ordersUrl.searchParams.get('filter[productsAvailed]')).toBe(JSON.stringify(['BUY']));

    expect(status.providerInvoiceId).toBe('inv_123');
    expect(status.status).toBe('paid');
    expect(status.paidAmount).toBe('98.5');
    expect(status.txHash).toBe('0xtransak');
  });

  test('MoonPay: verifies HMAC-SHA256 signature', () => {
    const secret = 'test_moonpay_secret';
    const adapter = new MoonPayAdapter('test-api-key', secret);

    const body = JSON.stringify({
      type: 'transaction_updated',
      data: { id: 'mp_tx_123', status: 'completed', quoteCurrencyAmount: 10, updatedAt: '2026-01-01T00:00:00Z' },
    });

    const sig = createHmac('sha256', secret).update(body).digest('hex');

    const result = adapter.verifyWebhook({ rawBody: body, headers: { 'moonpay-signature-v2': sig } });
    expect(result).not.toBeNull();
    expect(result!.signatureValid).toBe(true);
    expect(result!.providerInvoiceId).toBe('mp_tx_123');
    expect(result!.status).toBe('paid');
  });

  test('MoonPay: flags invalid signature', () => {
    const adapter = new MoonPayAdapter('test-api-key', 'test_secret');
    const body = JSON.stringify({ type: 'transaction_updated', data: { id: 'mp_tx_999', status: 'pending' } });
    const result = adapter.verifyWebhook({ rawBody: body, headers: { 'moonpay-signature-v2': 'bogus' } });
    expect(result).not.toBeNull();
    expect(result!.signatureValid).toBe(false);
  });

  test('Transak: verifies HMAC-SHA256 signature', () => {
    const secret = 'test_transak_secret';
    const adapter = new TransakAdapter('test-api-key', secret);

    const body = JSON.stringify({
      eventID: 'tk_evt_1',
      eventName: 'ORDER_COMPLETED',
      webhookData: { id: 'tk_order_1', status: 'COMPLETED', cryptoAmount: 5, transactionHash: '0xdead', updatedAt: '2026-01-01T00:00:00Z' },
    });

    const sig = createHmac('sha256', secret).update(body).digest('hex');

    const result = adapter.verifyWebhook({ rawBody: body, headers: { 'x-transak-signature': sig } });
    expect(result).not.toBeNull();
    expect(result!.signatureValid).toBe(true);
    expect(result!.providerInvoiceId).toBe('tk_order_1');
    expect(result!.status).toBe('paid');
  });

  test('NowPayments: verifies HMAC-SHA512 signature over canonical JSON', () => {
    const secret = 'test_nowpayments_secret';
    const adapter = new NowPaymentsAdapter('test-api-key', secret);

    const payload = {
      payment_id: 12345,
      payment_status: 'finished' as const,
      pay_address: 'bc1qtest',
      pay_amount: 0.001,
      pay_currency: 'btc',
      price_amount: 65,
      price_currency: 'usd',
      actually_paid: 0.001,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:05:00Z',
      txid: '0xfeed',
    };

    const body = JSON.stringify(payload);
    // Canonical (sorted keys) form for signing:
    const canonical = JSON.stringify(
      Object.keys(payload).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (payload as Record<string, unknown>)[k];
        return acc;
      }, {})
    );
    const sig = createHmac('sha512', secret).update(canonical).digest('hex');

    const result = adapter.verifyWebhook({ rawBody: body, headers: { 'x-nowpayments-sig': sig } });
    expect(result).not.toBeNull();
    expect(result!.signatureValid).toBe(true);
    expect(result!.providerInvoiceId).toBe('12345');
    expect(result!.status).toBe('paid');
  });

  test('NowPayments: rejects forged signature', () => {
    const adapter = new NowPaymentsAdapter('test-api-key', 'real_secret');
    const body = JSON.stringify({ payment_id: 1, payment_status: 'finished', updated_at: '2026-01-01T00:00:00Z' });
    const result = adapter.verifyWebhook({ rawBody: body, headers: { 'x-nowpayments-sig': 'forged' } });
    expect(result).not.toBeNull();
    expect(result!.signatureValid).toBe(false);
  });
});
