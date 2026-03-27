# FinLayer Integration Guide for AI Agents

This guide explains how to integrate FinLayer into an AI agent workflow using the `@finlayer/sdk`.

## Core Principles for Agents

### 1. Always Use Idempotency Keys

Every state-changing operation (swap, payment, deposit) requires an `idempotency_key`. This prevents accidental double-execution when retrying after network failures.

```typescript
// Good: unique per operation
const idempotencyKey = crypto.randomUUID();

// Also good: deterministic from operation context
const idempotencyKey = `swap-${userId}-${fromAsset}-${toAsset}-${Date.now()}`;
```

### 2. Handle Retryable Errors

```typescript
import { HiveFinance, FinLayerApiError } from '@finlayer/sdk';

async function executeWithRetry(fn: () => Promise<unknown>, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FinLayerApiError && err.retryable) {
        const delay = err.retry_after_ms ?? 5000 * (attempt + 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}
```

### 3. Check Quote Expiry Before Execute

Quotes expire in 5 minutes. Always check `expires_at` before executing:

```typescript
const { quotes, best_quote_id } = await finlayer.swap.quote({ ... });
const bestQuote = quotes.find(q => q.id === best_quote_id)!;

// Check expiry
if (new Date(bestQuote.expires_at) < new Date()) {
  // Re-request quote
  throw new Error('Quote expired — re-request before executing');
}
```

### 4. Track Revenue with Affiliate ID

If you're a Hive Mind agent, attach your affiliate ID to earn revenue share:

```typescript
const finlayer = new HiveFinance({
  apiKey: 'fl_live_...',
  affiliateId: 'your-affiliate-uuid', // Set once, applied to all requests
});
```

---

## Full Agent Workflow Example

```typescript
import { HiveFinance, FinLayerApiError } from '@finlayer/sdk';

const finlayer = new HiveFinance({
  apiKey: process.env.FINLAYER_API_KEY!,
  affiliateId: process.env.FINLAYER_AFFILIATE_ID,
});

async function swapCrypto(params: {
  fromAsset: string;
  toAsset: string;
  amount: string;
  recipientAddress: string;
}) {
  const { fromAsset, toAsset, amount, recipientAddress } = params;

  // 1. Get quote
  console.log(`Getting quote: ${amount} ${fromAsset} → ${toAsset}`);
  const { quotes, best_quote_id } = await finlayer.swap.quote({
    from_asset: fromAsset,
    to_asset: toAsset,
    amount,
  });

  const bestQuote = quotes.find(q => q.id === best_quote_id)!;
  console.log(`Best rate: ${bestQuote.rate} ${toAsset}/${fromAsset}`);
  console.log(`Expected output: ${bestQuote.to_amount} ${toAsset}`);

  // 2. Execute swap
  const tx = await finlayer.swap.execute({
    quote_id: best_quote_id,
    recipient_address: recipientAddress,
    idempotency_key: `swap-${Date.now()}-${crypto.randomUUID()}`,
  });

  console.log(`Send ${amount} ${fromAsset} to: ${tx.deposit_address}`);
  console.log(`Transaction ID: ${tx.id}`);

  // 3. Wait for completion (up to 1 hour)
  const completed = await finlayer.swap.waitForCompletion(tx.id, {
    timeoutMs: 3_600_000,
    pollIntervalMs: 30_000,
  });

  if (completed.status === 'completed') {
    console.log(`Swap complete!`);
    return completed;
  } else {
    throw new Error(`Swap ${completed.status}: ${tx.id}`);
  }
}
```

---

## Error Reference

| Code | Domain | Retryable | Description |
|------|--------|-----------|-------------|
| `UNAUTHORIZED` | auth | false | Missing or invalid API key |
| `FORBIDDEN` | auth | false | API key lacks required scope |
| `RATE_LIMIT_EXCEEDED` | auth | true | Too many requests |
| `VALIDATION_ERROR` | general | false | Invalid request body |
| `IDEMPOTENCY_KEY_REQUIRED` | general | false | Missing idempotency_key |
| `DUPLICATE_IDEMPOTENCY_KEY` | general | false | Transaction already exists |
| `QUOTE_NOT_FOUND` | swap | false | Quote ID not found |
| `QUOTE_EXPIRED` | swap | true | Quote has expired |
| `PROVIDER_ERROR` | swap | true | External provider error |
| `PROVIDER_RATE_LIMIT` | swap | true | Provider rate limited |
| `INSUFFICIENT_LIQUIDITY` | swap | false | Not enough liquidity |
| `TRANSACTION_NOT_FOUND` | general | false | TX ID not found |
