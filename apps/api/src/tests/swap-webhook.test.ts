/**
 * Security regression tests for POST /v1/swap/webhook/:id (issue #13).
 *
 * The webhook is unauthenticated by design (providers call it directly), so
 * authenticity must come from the provider's signature. These tests pin the
 * fixes required by the issue:
 *   - unsigned / forged deliveries are rejected (signature verification),
 *   - the `:id` must be a UUID,
 *   - the update is scoped to `domain = 'swap'` so a swap webhook can't touch a
 *     payments/earn transaction,
 *   - status changes follow a valid state machine.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { createHmac } from 'crypto';
import { SwapService, isValidSwapStatusTransition } from '../../../../modules/swap/service.js';
import { MockSwapProvider } from './mock-provider.js';
import { createMockSql, createTestUserId } from './setup.js';
import { generateUUID } from '@finlayer/utils';
import {
  ValidationError,
  InvalidWebhookSignatureError,
  TransactionNotFoundError,
} from '../../../../modules/shared/errors/index.js';
import type { ISwapProviderAdapter } from '../../../../modules/shared/types/index.js';

describe('POST /v1/swap/webhook/:id — security (issue #13)', () => {
  let swapService: SwapService;
  let mockProvider: MockSwapProvider;
  let userId: string;
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockProvider = new MockSwapProvider();
    const providers = new Map<string, ISwapProviderAdapter>([['MockProvider', mockProvider]]);
    mockSql = createMockSql();
    swapService = new SwapService(mockSql as never, providers);
    userId = createTestUserId();
  });

  /** Create a swap transaction and return its id + provider tx id. */
  async function createSwapTx(): Promise<{ txId: string; providerTxId: string }> {
    const quote = await swapService.getQuote(userId, {
      from_asset: 'BTC',
      to_asset: 'ETH',
      amount: '0.1',
    });
    const tx = await swapService.executeSwap(userId, {
      quote_id: quote.best_quote_id,
      recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      idempotency_key: generateUUID(),
    });
    const row = (mockSql._tables.get('transactions') ?? []).find(r => r['id'] === tx.id)!;
    return { txId: tx.id, providerTxId: String(row['provider_tx_id']) };
  }

  function body(providerTxId: string, status: string): string {
    return JSON.stringify({ provider_tx_id: providerTxId, status });
  }

  describe('signature verification', () => {
    test('rejects an unsigned / forged delivery with InvalidWebhookSignatureError', async () => {
      const { txId, providerTxId } = await createSwapTx();
      mockProvider.forceInvalidSignature = true;

      await expect(
        swapService.handleWebhook({
          txId,
          rawBody: body(providerTxId, 'completed'),
          headers: {},
        })
      ).rejects.toBeInstanceOf(InvalidWebhookSignatureError);

      // Status must be unchanged after a rejected delivery.
      const row = (mockSql._tables.get('transactions') ?? []).find(r => r['id'] === txId)!;
      expect(row['status']).toBe('pending');
    });

    test('accepts a valid signed delivery and advances status', async () => {
      const { txId, providerTxId } = await createSwapTx();

      const result = await swapService.handleWebhook({
        txId,
        rawBody: body(providerTxId, 'processing'),
        headers: {},
      });

      expect(result.processed).toBe(true);
      expect(result.status).toBe('processing');
      const row = (mockSql._tables.get('transactions') ?? []).find(r => r['id'] === txId)!;
      expect(row['status']).toBe('processing');
    });

    test('rejects malformed JSON payloads with ValidationError', async () => {
      const { txId } = await createSwapTx();
      await expect(
        swapService.handleWebhook({ txId, rawBody: 'not-json', headers: {} })
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('id validation', () => {
    test('rejects a non-UUID :id with ValidationError', async () => {
      await expect(
        swapService.handleWebhook({
          txId: 'not-a-uuid',
          rawBody: body('x', 'completed'),
          headers: {},
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('domain scoping', () => {
    test('cannot change the status of a payments transaction', async () => {
      // Seed a foreign (payments) transaction directly into the registry.
      const foreignId = generateUUID();
      const paymentsProvider = (mockSql._tables.get('providers') ?? []).find(
        p => p['domain'] === 'payments'
      )!;
      if (!mockSql._tables.has('transactions')) mockSql._tables.set('transactions', []);
      mockSql._tables.get('transactions')!.push({
        id: foreignId,
        type: 'payment',
        domain: 'payments',
        status: 'pending',
        user_id: userId,
        from_asset: 'USDC',
        to_asset: null,
        amount: '100',
        provider_id: paymentsProvider['id'],
        provider_tx_id: 'pay_123',
        created_at: new Date(),
        updated_at: new Date(),
      });

      // A swap webhook targeting the payments row must not resolve it.
      await expect(
        swapService.handleWebhook({
          txId: foreignId,
          rawBody: body('pay_123', 'completed'),
          headers: {},
        })
      ).rejects.toBeInstanceOf(TransactionNotFoundError);

      // The payments transaction is untouched.
      const row = (mockSql._tables.get('transactions') ?? []).find(r => r['id'] === foreignId)!;
      expect(row['status']).toBe('pending');
    });

    test('throws TransactionNotFoundError for an unknown id', async () => {
      await expect(
        swapService.handleWebhook({
          txId: generateUUID(),
          rawBody: body('x', 'completed'),
          headers: {},
        })
      ).rejects.toBeInstanceOf(TransactionNotFoundError);
    });
  });

  describe('provider tx id cross-check', () => {
    test('rejects a delivery whose provider tx id does not match the row', async () => {
      const { txId } = await createSwapTx();
      await expect(
        swapService.handleWebhook({
          txId,
          rawBody: body('some_other_provider_tx', 'completed'),
          headers: {},
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('status state machine', () => {
    test('ignores a transition out of a terminal state (no-op)', async () => {
      const { txId, providerTxId } = await createSwapTx();

      // Move to a terminal state first.
      await swapService.handleWebhook({
        txId,
        rawBody: body(providerTxId, 'completed'),
        headers: {},
      });

      // A later "refunded" delivery must not rewrite a settled transaction.
      const result = await swapService.handleWebhook({
        txId,
        rawBody: body(providerTxId, 'refunded'),
        headers: {},
      });

      expect(result.processed).toBe(false);
      const row = (mockSql._tables.get('transactions') ?? []).find(r => r['id'] === txId)!;
      expect(row['status']).toBe('completed');
    });

    test('treats a same-status delivery as a no-op', async () => {
      const { txId, providerTxId } = await createSwapTx();
      const result = await swapService.handleWebhook({
        txId,
        rawBody: body(providerTxId, 'pending'),
        headers: {},
      });
      expect(result.processed).toBe(false);
      expect(result.status).toBe('pending');
    });

    test('isValidSwapStatusTransition enforces the lifecycle', () => {
      expect(isValidSwapStatusTransition('pending', 'processing')).toBe(true);
      expect(isValidSwapStatusTransition('pending', 'completed')).toBe(true);
      expect(isValidSwapStatusTransition('processing', 'completed')).toBe(true);
      expect(isValidSwapStatusTransition('completed', 'refunded')).toBe(false);
      expect(isValidSwapStatusTransition('failed', 'completed')).toBe(false);
      expect(isValidSwapStatusTransition('expired', 'processing')).toBe(false);
    });
  });
});

describe('ChangeNOWAdapter.verifyWebhook — HMAC-SHA256', () => {
  const secret = 'super-secret-shared-key';

  function sign(body: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  test('accepts a correctly signed body', async () => {
    const { ChangeNOWAdapter } = await import('../../../../modules/providers/changenow/adapter.js');
    const adapter = new ChangeNOWAdapter('api-key', secret);
    const rawBody = JSON.stringify({ id: 'cn_tx_1', status: 'finished', payoutHash: '0xabc' });

    const result = adapter.verifyWebhook({
      rawBody,
      headers: { 'x-changenow-signature': sign(rawBody) },
    });

    expect(result).not.toBeNull();
    expect(result!.signatureValid).toBe(true);
    expect(result!.providerTxId).toBe('cn_tx_1');
    expect(result!.status).toBe('completed');
    expect(result!.txHash).toBe('0xabc');
  });

  test('rejects a tampered body (wrong signature)', async () => {
    const { ChangeNOWAdapter } = await import('../../../../modules/providers/changenow/adapter.js');
    const adapter = new ChangeNOWAdapter('api-key', secret);
    const rawBody = JSON.stringify({ id: 'cn_tx_1', status: 'finished' });

    const result = adapter.verifyWebhook({
      rawBody,
      headers: { 'x-changenow-signature': sign('{"id":"cn_tx_1","status":"failed"}') },
    });

    expect(result).not.toBeNull();
    expect(result!.signatureValid).toBe(false);
  });

  test('fails closed when no secret is configured', async () => {
    const { ChangeNOWAdapter } = await import('../../../../modules/providers/changenow/adapter.js');
    const adapter = new ChangeNOWAdapter('api-key'); // no webhook secret
    const rawBody = JSON.stringify({ id: 'cn_tx_1', status: 'finished' });

    const result = adapter.verifyWebhook({
      rawBody,
      headers: { 'x-changenow-signature': sign(rawBody) },
    });

    expect(result!.signatureValid).toBe(false);
  });

  test('returns null for a malformed payload', async () => {
    const { ChangeNOWAdapter } = await import('../../../../modules/providers/changenow/adapter.js');
    const adapter = new ChangeNOWAdapter('api-key', secret);
    expect(adapter.verifyWebhook({ rawBody: 'not-json', headers: {} })).toBeNull();
  });
});
