/**
 * modules/shared/errors
 * Structured error classes for agent-friendly error responses.
 */

import type { ApiError, ErrorDomain } from '@finlayer/types';

export class FinLayerError extends Error {
  public readonly code: string;
  public readonly domain: ErrorDomain;
  public readonly retryable: boolean;
  public readonly retry_after_ms?: number;
  public readonly suggestion?: string;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    domain: ErrorDomain,
    httpStatus: number = 400,
    options: {
      retryable?: boolean;
      retry_after_ms?: number;
      suggestion?: string;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = 'FinLayerError';
    this.code = code;
    this.domain = domain;
    this.httpStatus = httpStatus;
    this.retryable = options.retryable ?? false;
    this.retry_after_ms = options.retry_after_ms;
    this.suggestion = options.suggestion;
    this.details = options.details;
  }

  toApiError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      domain: this.domain,
      retryable: this.retryable,
      ...(this.retry_after_ms !== undefined && { retry_after_ms: this.retry_after_ms }),
      ...(this.suggestion !== undefined && { suggestion: this.suggestion }),
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

// ─── Auth Errors ──────────────────────────────────────────────────────────────

export class UnauthorizedError extends FinLayerError {
  constructor(message = 'Missing or invalid API key') {
    super('UNAUTHORIZED', message, 'auth', 401, {
      suggestion: 'Provide a valid API key in the Authorization header: Bearer fl_live_...',
    });
  }
}

export class ForbiddenError extends FinLayerError {
  constructor(requiredScope: string) {
    super('FORBIDDEN', `API key lacks required scope: ${requiredScope}`, 'auth', 403, {
      suggestion: `Create a new API key with the '${requiredScope}' scope`,
    });
  }
}

export class RateLimitError extends FinLayerError {
  constructor(retry_after_ms: number) {
    super('RATE_LIMIT_EXCEEDED', 'API key rate limit exceeded', 'auth', 429, {
      retryable: true,
      retry_after_ms,
      suggestion: 'Wait before retrying or upgrade your rate limit',
    });
  }
}

// ─── Validation Errors ────────────────────────────────────────────────────────

export class ValidationError extends FinLayerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 'general', 400, { details });
  }
}

export class IdempotencyError extends FinLayerError {
  constructor() {
    super('IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key is required for state-changing operations', 'general', 400, {
      suggestion: 'Provide a unique idempotency_key string (8-128 chars) in the request body',
    });
  }
}

// ─── Swap Errors ──────────────────────────────────────────────────────────────

export class QuoteExpiredError extends FinLayerError {
  constructor() {
    super('QUOTE_EXPIRED', 'Swap quote has expired', 'swap', 410, {
      retryable: true,
      suggestion: 'Request a new quote via POST /v1/swap/quote',
    });
  }
}

export class QuoteNotFoundError extends FinLayerError {
  constructor(quoteId: string) {
    super('QUOTE_NOT_FOUND', `Quote ${quoteId} not found`, 'swap', 404, {
      suggestion: 'Verify the quote_id and request a new quote if needed',
    });
  }
}

export class ProviderError extends FinLayerError {
  constructor(providerName: string, originalMessage: string, domain: ErrorDomain = 'swap') {
    super(
      'PROVIDER_ERROR',
      `${providerName} provider error: ${originalMessage}`,
      domain,
      502,
      {
        retryable: true,
        retry_after_ms: 5000,
        suggestion: 'Retry the request or try a different provider',
      }
    );
  }
}

export class ProviderRateLimitError extends FinLayerError {
  constructor(providerName: string) {
    super('PROVIDER_RATE_LIMIT', `${providerName} API rate limit exceeded`, 'swap', 502, {
      retryable: true,
      retry_after_ms: 5000,
      suggestion: 'Use cached quote or switch provider',
    });
  }
}

export class InsufficientLiquidityError extends FinLayerError {
  constructor(fromAsset: string, toAsset: string) {
    super(
      'INSUFFICIENT_LIQUIDITY',
      `Insufficient liquidity for ${fromAsset} → ${toAsset}`,
      'swap',
      422,
      {
        retryable: false,
        suggestion: 'Try a smaller amount or a different asset pair',
      }
    );
  }
}

// ─── Transaction Errors ───────────────────────────────────────────────────────

export class TransactionNotFoundError extends FinLayerError {
  constructor(txId: string) {
    super('TRANSACTION_NOT_FOUND', `Transaction ${txId} not found`, 'general', 404);
  }
}

export class DuplicateIdempotencyKeyError extends FinLayerError {
  constructor(existingTxId: string) {
    super(
      'DUPLICATE_IDEMPOTENCY_KEY',
      'A transaction with this idempotency_key already exists',
      'general',
      409,
      {
        details: { existing_transaction_id: existingTxId },
        suggestion: 'Use the existing transaction or provide a different idempotency_key',
      }
    );
  }
}

// ─── Wallet Errors ────────────────────────────────────────────────────────────

export class WalletNotFoundError extends FinLayerError {
  constructor() {
    super('WALLET_NOT_FOUND', 'No wallet exists for this user', 'wallet', 404, {
      suggestion: 'Create a wallet via POST /v1/wallet/generate',
    });
  }
}

export class UnsupportedAssetError extends FinLayerError {
  constructor(asset: string, network: string) {
    super(
      'UNSUPPORTED_ASSET',
      `Wallet generation is not supported for ${asset} on ${network}`,
      'wallet',
      400,
      {
        suggestion: 'See GET /v1/wallet/supported for supported asset/network pairs',
      }
    );
  }
}

export class WalletConfigError extends FinLayerError {
  constructor(message: string) {
    super('WALLET_CONFIG_ERROR', message, 'wallet', 500, {
      suggestion: 'Set WALLET_ENCRYPTION_KEY to a 32-byte base64 or hex string',
    });
  }
}

export class BalanceProviderError extends FinLayerError {
  constructor(providerName: string, originalMessage: string) {
    super(
      'BALANCE_PROVIDER_ERROR',
      `${providerName} balance lookup failed: ${originalMessage}`,
      'wallet',
      502,
      {
        retryable: true,
        retry_after_ms: 5000,
        suggestion: 'Retry after a short delay or query a different provider',
      }
    );
  }
}

// ─── Provider Adapter Interface ────────────────────────────────────────────────

export { FinLayerError as default };
