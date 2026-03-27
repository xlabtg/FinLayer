/**
 * E2E tests for swap flow (mock provider).
 * Tests: quote → execute → status
 *
 * These tests use mock DB and provider, no external dependencies required.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { SwapService } from '../../../../modules/swap/service.js';
import { MockSwapProvider } from './mock-provider.js';
import { createMockSql, createTestUserId } from './setup.js';
import { generateUUID } from '@finlayer/utils';
import { ValidationError, IdempotencyError, DuplicateIdempotencyKeyError } from '../../../../modules/shared/errors/index.js';
import type { ISwapProviderAdapter } from '../../../../modules/shared/types/index.js';

describe('Swap Flow', () => {
  let swapService: SwapService;
  let mockProvider: MockSwapProvider;
  let userId: string;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockProvider = new MockSwapProvider();
    const providers = new Map<string, ISwapProviderAdapter>([
      ['MockProvider', mockProvider],
    ]);
    mockSql = createMockSql();
    swapService = new SwapService(mockSql as never, providers);
    userId = createTestUserId();
  });

  describe('POST /v1/swap/quote', () => {
    test('returns quotes for valid asset pair', async () => {
      const response = await swapService.getQuote(userId, {
        from_asset: 'BTC',
        to_asset: 'ETH',
        amount: '0.1',
      });

      expect(response.quotes).toBeDefined();
      expect(response.quotes.length).toBeGreaterThan(0);
      expect(response.best_quote_id).toBeDefined();

      const quote = response.quotes[0]!;
      expect(quote.from_asset).toBe('BTC');
      expect(quote.to_asset).toBe('ETH');
      expect(parseFloat(quote.to_amount)).toBeGreaterThan(0);
      expect(quote.rate).toBeDefined();
      expect(quote.expires_at).toBeDefined();
      expect(quote.min_amount).toBeDefined();
      expect(quote.max_amount).toBeDefined();
    });

    test('normalizes asset tickers to uppercase', async () => {
      const response = await swapService.getQuote(userId, {
        from_asset: 'btc',
        to_asset: 'eth',
        amount: '0.1',
      });

      expect(response.quotes[0]!.from_asset).toBe('BTC');
      expect(response.quotes[0]!.to_asset).toBe('ETH');
    });

    test('throws ValidationError for invalid from_asset', async () => {
      await expect(swapService.getQuote(userId, {
        from_asset: 'INVALID_TICKER_TOO_LONG_123',
        to_asset: 'ETH',
        amount: '0.1',
      })).rejects.toBeInstanceOf(ValidationError);
    });

    test('throws ValidationError for invalid amount', async () => {
      await expect(swapService.getQuote(userId, {
        from_asset: 'BTC',
        to_asset: 'ETH',
        amount: '-1',
      })).rejects.toBeInstanceOf(ValidationError);
    });

    test('throws ValidationError for zero amount', async () => {
      await expect(swapService.getQuote(userId, {
        from_asset: 'BTC',
        to_asset: 'ETH',
        amount: '0',
      })).rejects.toBeInstanceOf(ValidationError);
    });

    test('best_quote_id references the highest to_amount', async () => {
      const response = await swapService.getQuote(userId, {
        from_asset: 'BTC',
        to_asset: 'ETH',
        amount: '1.0',
      });

      const bestQuote = response.quotes.find(q => q.id === response.best_quote_id);
      expect(bestQuote).toBeDefined();

      const maxToAmount = Math.max(...response.quotes.map(q => parseFloat(q.to_amount)));
      expect(parseFloat(bestQuote!.to_amount)).toBe(maxToAmount);
    });
  });

  describe('POST /v1/swap/execute', () => {
    let quoteId: string;

    beforeEach(async () => {
      const quoteResponse = await swapService.getQuote(userId, {
        from_asset: 'BTC',
        to_asset: 'ETH',
        amount: '0.1',
      });
      quoteId = quoteResponse.best_quote_id;
    });

    test('executes swap and returns transaction with deposit_address', async () => {
      const tx = await swapService.executeSwap(userId, {
        quote_id: quoteId,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        idempotency_key: generateUUID(),
      });

      expect(tx.id).toBeDefined();
      expect(tx.status).toBe('pending');
      expect(tx.deposit_address).toBeDefined();
      expect(tx.deposit_address.length).toBeGreaterThan(0);
      expect(tx.webhook_url).toBeDefined();
      expect(tx.webhook_url).toContain(tx.id);
      expect(tx.revenue_event_id).toBeDefined();
    });

    test('throws IdempotencyError when idempotency_key is missing', async () => {
      await expect(swapService.executeSwap(userId, {
        quote_id: quoteId,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        idempotency_key: '',
      })).rejects.toBeInstanceOf(IdempotencyError);
    });

    test('throws DuplicateIdempotencyKeyError on duplicate key', async () => {
      const idempotencyKey = generateUUID();

      // First execute — should succeed
      await swapService.executeSwap(userId, {
        quote_id: quoteId,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        idempotency_key: idempotencyKey,
      });

      // Get a new quote for second attempt
      const newQuote = await swapService.getQuote(userId, {
        from_asset: 'BTC',
        to_asset: 'ETH',
        amount: '0.1',
      });

      // Second execute with same idempotency_key — should throw
      await expect(swapService.executeSwap(userId, {
        quote_id: newQuote.best_quote_id,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        idempotency_key: idempotencyKey,
      })).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
    });

    test('stores affiliate_id in transaction', async () => {
      const affiliateId = generateUUID();
      const tx = await swapService.executeSwap(userId, {
        quote_id: quoteId,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        idempotency_key: generateUUID(),
        affiliate_id: affiliateId,
      });

      expect(tx.affiliate_id).toBe(affiliateId);
    });

    test('creates revenue event for each transaction', async () => {
      const tx = await swapService.executeSwap(userId, {
        quote_id: quoteId,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        idempotency_key: generateUUID(),
      });

      const revenueEvents = mockSql._tables.get('revenue_events') ?? [];
      const event = revenueEvents.find(e => e['transaction_id'] === tx.id);
      expect(event).toBeDefined();
      expect(event!['source_domain']).toBe('swap');
    });
  });

  describe('GET /v1/swap/tx/:id', () => {
    test('returns transaction status', async () => {
      const quoteResponse = await swapService.getQuote(userId, {
        from_asset: 'BTC',
        to_asset: 'ETH',
        amount: '0.5',
      });

      const tx = await swapService.executeSwap(userId, {
        quote_id: quoteResponse.best_quote_id,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        idempotency_key: generateUUID(),
      });

      const status = await swapService.getSwapStatus(tx.id, userId);
      expect(status.id).toBe(tx.id);
      expect(status.status).toBeDefined();
    });

    test('throws TransactionNotFoundError for unknown tx', async () => {
      const { TransactionNotFoundError } = await import('../../../../modules/shared/errors/index.js');
      await expect(swapService.getSwapStatus(generateUUID(), userId))
        .rejects.toBeInstanceOf(TransactionNotFoundError);
    });
  });

  describe('Full swap flow: quote → execute → status', () => {
    test('complete flow works end-to-end', async () => {
      // Step 1: Get quote
      const quoteResponse = await swapService.getQuote(userId, {
        from_asset: 'ETH',
        to_asset: 'USDC',
        amount: '1.0',
      });

      expect(quoteResponse.quotes.length).toBeGreaterThan(0);
      const quote = quoteResponse.quotes.find(q => q.id === quoteResponse.best_quote_id);
      expect(quote).toBeDefined();
      expect(parseFloat(quote!.to_amount)).toBeGreaterThan(0);

      // Step 2: Execute swap
      const tx = await swapService.executeSwap(userId, {
        quote_id: quoteResponse.best_quote_id,
        recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        refund_address: '0xSenderAddress',
        idempotency_key: `test-flow-${generateUUID()}`,
      });

      expect(tx.status).toBe('pending');
      expect(tx.deposit_address).toBeTruthy();
      expect(tx.quote.from_asset).toBe('ETH');
      expect(tx.quote.to_asset).toBe('USDC');

      // Step 3: Check status
      const statusResponse = await swapService.getSwapStatus(tx.id, userId);
      expect(statusResponse.id).toBe(tx.id);
    });
  });
});

describe('Revenue Tracking', () => {
  test('platform fee is calculated as 0.3% of amount', async () => {
    const { RevenueService } = await import('../../../../modules/swap/revenue.js');
    const mockSql = createMockSql();
    const revenueService = new RevenueService(mockSql as never, {
      platformShareRatio: 0.6,
      affiliateShareRatio: 0.4,
      platformFeePercent: 0.003,
    });

    const fee = revenueService.calculatePlatformFee('1000');
    expect(parseFloat(fee)).toBeCloseTo(3.0, 5);
  });

  test('affiliate share is 40% when affiliate is present', async () => {
    const { RevenueService } = await import('../../../../modules/swap/revenue.js');
    const mockSql = createMockSql();
    const revenueService = new RevenueService(mockSql as never, {
      platformShareRatio: 0.6,
      affiliateShareRatio: 0.4,
      platformFeePercent: 0.003,
    });

    const affiliateId = generateUUID();
    const eventId = await revenueService.createRevenueEvent({
      transactionId: generateUUID(),
      domain: 'swap',
      totalFee: '10',
      feeAsset: 'BTC',
      affiliateId,
    });

    expect(eventId).toBeDefined();
    const events = mockSql._tables.get('revenue_events') ?? [];
    const event = events.find(e => e['id'] === eventId);
    expect(event!['affiliate_share']).toBe(0.4);
    expect(event!['platform_share']).toBe(0.6);
  });

  test('platform gets 100% when no affiliate', async () => {
    const { RevenueService } = await import('../../../../modules/swap/revenue.js');
    const mockSql = createMockSql();
    const revenueService = new RevenueService(mockSql as never, {
      platformShareRatio: 0.6,
      affiliateShareRatio: 0.4,
      platformFeePercent: 0.003,
    });

    const eventId = await revenueService.createRevenueEvent({
      transactionId: generateUUID(),
      domain: 'swap',
      totalFee: '10',
      feeAsset: 'BTC',
      affiliateId: null,
    });

    const events = mockSql._tables.get('revenue_events') ?? [];
    const event = events.find(e => e['id'] === eventId);
    expect(event!['platform_share']).toBe(1.0);
    expect(event!['affiliate_share']).toBe(0);
  });
});

describe('Error Handling', () => {
  test('FinLayerError has correct agent-friendly structure', () => {
    const { ProviderRateLimitError } = require('../../../../modules/shared/errors/index.js');
    const error = new ProviderRateLimitError('ChangeNOW');
    const apiError = error.toApiError();

    expect(apiError.code).toBe('PROVIDER_RATE_LIMIT');
    expect(apiError.domain).toBe('swap');
    expect(apiError.retryable).toBe(true);
    expect(apiError.retry_after_ms).toBeDefined();
    expect(apiError.suggestion).toBeDefined();
  });
});
