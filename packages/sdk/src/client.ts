/**
 * FinLayer SDK Base Client
 * Handles HTTP transport, authentication, and error parsing.
 */

import type { ApiErrorResponse, ApiSuccessResponse } from '@finlayer/types';

export interface FinLayerClientConfig {
  /** API key (fl_live_... or fl_test_...) */
  apiKey: string;
  /** Base URL (default: https://api.finlayer.io) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Default affiliate ID to attach to all requests */
  affiliateId?: string;
  /** Default affiliate link ID to attach to revenue-bearing requests */
  affiliateLinkId?: string;
}

export class FinLayerApiError extends Error {
  public readonly code: string;
  public readonly domain: string;
  public readonly retryable: boolean;
  public readonly retry_after_ms?: number;
  public readonly suggestion?: string;

  constructor(error: ApiErrorResponse['error']) {
    super(error.message);
    this.name = 'FinLayerApiError';
    this.code = error.code;
    this.domain = error.domain;
    this.retryable = error.retryable;
    this.retry_after_ms = error.retry_after_ms;
    this.suggestion = error.suggestion;
  }
}

export class FinLayerClient {
  public readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly affiliateId?: string;
  private readonly affiliateLinkId?: string;

  constructor(config: FinLayerClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.finlayer.io').replace(/\/$/, '');
    this.timeout = config.timeout ?? 30000;
    this.affiliateId = config.affiliateId;
    this.affiliateLinkId = config.affiliateLinkId;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': '@finlayer/sdk/0.1.0-beta.1',
    };

    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const json = await res.json() as ApiSuccessResponse<T> | ApiErrorResponse;

      if ('error' in json) {
        throw new FinLayerApiError(json.error);
      }

      return json.data;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof FinLayerApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FinLayerApiError({
          code: 'REQUEST_TIMEOUT',
          message: `Request timed out after ${this.timeout}ms`,
          domain: 'general',
          retryable: true,
          retry_after_ms: 1000,
          suggestion: 'Check your network connection and retry',
        });
      }
      throw err;
    }
  }

  /** Merge request body with default affiliate attribution if set */
  protected withAffiliate<T extends object>(body: T): T & { affiliate_id?: string; affiliate_link_id?: string } {
    if (this.affiliateId || this.affiliateLinkId) {
      return {
        ...body,
        ...(this.affiliateId ? { affiliate_id: this.affiliateId } : {}),
        ...(this.affiliateLinkId ? { affiliate_link_id: this.affiliateLinkId } : {}),
      };
    }
    return body;
  }
}
