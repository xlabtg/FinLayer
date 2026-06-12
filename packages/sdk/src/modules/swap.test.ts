import { describe, expect, test } from 'bun:test';

import type { FinLayerClient } from '../client.js';
import { SwapModule } from './swap.js';

class RecordingClient {
  public readonly calls: Array<{
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body: unknown;
    options: { idempotencyKey?: string };
  }> = [];

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {}
  ): Promise<T> {
    this.calls.push({ method, path, body, options });
    return {} as T;
  }

  withAffiliate<T extends object>(body: T): T & { affiliate_id?: string } {
    return body;
  }
}

describe('SwapModule', () => {
  test('sends Idempotency-Key header option when executing a swap', async () => {
    const client = new RecordingClient();
    const swap = new SwapModule(client as unknown as FinLayerClient);
    const idempotencyKey = 'swap-test-key-123';

    await swap.execute({
      quote_id: '11111111-1111-4111-8111-111111111111',
      recipient_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      idempotency_key: idempotencyKey,
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual(expect.objectContaining({
      method: 'POST',
      path: '/v1/swap/execute',
      options: { idempotencyKey },
    }));
    expect(client.calls[0]!.body).toEqual(expect.objectContaining({
      idempotency_key: idempotencyKey,
    }));
  });
});
