import { afterEach, describe, expect, test } from 'bun:test';
import { ChangeNOWAdapter } from '../../../../modules/providers/changenow/adapter.js';

describe('ChangeNOWAdapter fixed-rate execution (issues #23, #27)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('uses rateId and saved quote amount when creating an exchange', async () => {
    const requests: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    const validUntil = new Date(Date.now() + 10 * 60_000).toISOString();

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      requests.push({ url, method: init?.method ?? 'GET', body });

      if (url.includes('/exchange/min-amount')) {
        return new Response(JSON.stringify({
          minAmount: '0.001',
          maxAmount: '10',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/exchange/estimated-amount')) {
        return new Response(JSON.stringify({
          fromCurrency: 'btc',
          toCurrency: 'eth',
          fromAmount: 0.1,
          toAmount: 1.2345,
          flow: 'fixed-rate',
          type: 'direct',
          rateId: 'rate-id-123',
          validUntil,
          transactionSpeedForecast: '5-10',
          withdrawalFee: '0.0001',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/exchange') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          id: 'cn_tx_123',
          type: 'direct',
          status: 'waiting',
          validUntil,
          payinAddress: 'bc1deposit',
          payoutAddress: body?.['address'],
          fromAmount: 0.1,
          toAmount: 1.2345,
          fromCurrency: 'btc',
          toCurrency: 'eth',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: `Unexpected URL: ${url}` }), { status: 500 });
    }) as typeof fetch;

    const adapter = new ChangeNOWAdapter('api-key', '', 'https://example.test');
    const quote = await adapter.getQuote({
      fromAsset: 'BTC',
      toAsset: 'ETH',
      amount: '0.1',
    });

    expect(quote.providerQuoteId).toBe('rate-id-123');
    expect(quote.fromAmount).toBe('0.1');
    expect(quote.toAmount).toBe('1.2345');
    expect(quote.expiresAt).toBe(validUntil);

    const executeResult = await adapter.executeSwap({
      providerQuoteId: quote.providerQuoteId,
      fromAsset: quote.fromAsset,
      toAsset: quote.toAsset,
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      rate: quote.rate,
      recipientAddress: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      refundAddress: 'bc1refund',
    });

    const minAmountUrl = requests.find((request) => request.url.includes('/exchange/min-amount'))!.url;
    expect(minAmountUrl).toContain('flow=fixed-rate');

    const estimateUrl = requests.find((request) => request.url.includes('/exchange/estimated-amount'))!.url;
    expect(estimateUrl).toContain('flow=fixed-rate');
    expect(estimateUrl).toContain('type=direct');
    expect(estimateUrl).toContain('useRateId=true');

    const exchangeBody = requests.find((request) => request.url.endsWith('/exchange'))!.body!;
    expect(exchangeBody).toEqual({
      fromCurrency: 'btc',
      toCurrency: 'eth',
      fromAmount: '0.1',
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      refundAddress: 'bc1refund',
      flow: 'fixed-rate',
      type: 'direct',
      rateId: 'rate-id-123',
    });
    expect(exchangeBody['toAmount']).toBeUndefined();
    expect(executeResult.providerTxId).toBe('cn_tx_123');
    expect(executeResult.depositAddress).toBe('bc1deposit');
  });

  test('uses saved quote currencies instead of parsing an opaque providerQuoteId', async () => {
    const requests: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      requests.push({ url, method: init?.method ?? 'GET', body });

      if (url.endsWith('/exchange') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          id: 'cn_tx_opaque',
          type: 'direct',
          status: 'waiting',
          validUntil: null,
          payinAddress: 'usdc-deposit',
          payoutAddress: body?.['address'],
          fromAmount: '25',
          toAmount: '0.05',
          fromCurrency: 'usdc',
          toCurrency: 'bnb',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: `Unexpected URL: ${url}` }), { status: 500 });
    }) as typeof fetch;

    const adapter = new ChangeNOWAdapter('api-key', '', 'https://example.test');

    await adapter.executeSwap({
      providerQuoteId: 'opaque-rate-id',
      fromAsset: 'USDC',
      toAsset: 'BNB',
      fromAmount: '25',
      toAmount: '0.05',
      rate: '0.002',
      recipientAddress: 'bnb-recipient',
    });

    const exchangeBody = requests.find((request) => request.url.endsWith('/exchange'))!.body!;
    expect(exchangeBody).toEqual({
      fromCurrency: 'usdc',
      toCurrency: 'bnb',
      fromAmount: '25',
      address: 'bnb-recipient',
      flow: 'fixed-rate',
      type: 'direct',
      rateId: 'opaque-rate-id',
    });
    expect(exchangeBody['fromCurrency']).not.toBe('btc');
    expect(exchangeBody['toCurrency']).not.toBe('eth');
  });

  test('rejects a ChangeNOW exchange response for a different currency pair', async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith('/exchange') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          id: 'cn_tx_wrong_pair',
          type: 'direct',
          status: 'waiting',
          validUntil: null,
          payinAddress: 'wrong-deposit',
          payoutAddress: 'wrong-recipient',
          fromAmount: '25',
          toAmount: '0.05',
          fromCurrency: 'btc',
          toCurrency: 'eth',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ message: `Unexpected URL: ${url}` }), { status: 500 });
    }) as typeof fetch;

    const adapter = new ChangeNOWAdapter('api-key', '', 'https://example.test');

    await expect(adapter.executeSwap({
      providerQuoteId: 'opaque-rate-id',
      fromAsset: 'USDC',
      toAsset: 'BNB',
      fromAmount: '25',
      toAmount: '0.05',
      rate: '0.002',
      recipientAddress: 'bnb-recipient',
    })).rejects.toThrow('fixed-rate execution currency pair does not match saved quote');
  });
});
