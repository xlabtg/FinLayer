# Payments Integration Guide

FinLayer Phase 2 adds a `/v1/payments` domain that unifies three on/off-ramp providers — **MoonPay**, **Transak**, and **NowPayments** — behind a single invoice API. This guide covers the API, the SDK, webhook security, and provider onboarding.

## Overview

The payments module issues **invoices**: a user-facing record carrying an asset, an amount, a provider-owned payment address (or widget URL), and a webhook URL the provider calls when funds arrive. Each invoice is paired with a row in the unified `transactions` ledger (`domain='payments'`, `type='payment'`) so accounting and revenue share stay consistent with swaps.

Supported providers and their shape:

| Provider        | Mode             | `payment_address` returned     | Signature header            | HMAC     |
| --------------- | ---------------- | ------------------------------ | --------------------------- | -------- |
| MoonPay         | Fiat → crypto    | Hosted widget URL              | `moonpay-signature-v2`      | SHA-256  |
| Transak         | Fiat → crypto    | Hosted widget URL              | `x-transak-signature`       | SHA-256  |
| NowPayments     | Crypto → crypto  | On-chain deposit address       | `x-nowpayments-sig`         | SHA-512, canonical JSON |

## Environment

Set the provider credentials you want to enable in `.env.local`. Providers without an API key are skipped on boot.

```bash
MOONPAY_API_KEY=...
MOONPAY_WEBHOOK_SECRET=...
TRANSAK_API_KEY=...
TRANSAK_API_SECRET=...                 # used to refresh partner access token for status polling
TRANSAK_WEBHOOK_SECRET=...
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
API_BASE_URL=https://api.yourdomain.com   # used to build webhook_url
```

After adding credentials, run the Phase 2 migration:

```bash
bun run migrate
```

This creates `invoices`, `payment_webhook_events`, extends the `transactions.type` check to include `payment` / `payment_refund`, and seeds the three provider rows.

## Create an invoice

```http
POST /v1/payments/invoice
Authorization: Bearer fl_live_...
Content-Type: application/json

{
  "asset": "USDC",
  "amount": "100.00",
  "network": "ethereum",
  "description": "Order #1234",
  "callback_url": "https://yourapp.com/orders/1234",
  "expires_in_seconds": 3600,
  "idempotency_key": "order-1234",
  "metadata": { "provider": "NowPayments" }
}
```

Response (`201 Created`):

```json
{
  "invoice": {
    "id": "5c…",
    "transaction_id": "a8…",
    "provider_name": "NowPayments",
    "asset": "USDC",
    "amount": "100.00",
    "network": "ethereum",
    "payment_address": "0xabc…",
    "status": "pending",
    "expires_at": "2026-04-20T23:30:00.000Z",
    "webhook_url": "https://api.yourdomain.com/v1/payments/webhook/NowPayments",
    "created_at": "2026-04-20T22:30:00.000Z",
    "updated_at": "2026-04-20T22:30:00.000Z"
  }
}
```

- `idempotency_key` is **required**. Replaying the same key returns the original invoice (`409 Conflict` with `existing_transaction_id`).
- `metadata.provider` optionally pins a provider; otherwise the first healthy provider is selected.
- For fiat providers, `payment_address` is the widget URL you redirect the buyer to.

## Fetch an invoice

```http
GET /v1/payments/invoice/{id}
Authorization: Bearer fl_live_...
```

If the invoice is still `pending`, the service makes a best-effort status refresh against the provider — useful when a webhook delivery is delayed.

## List providers

```http
GET /v1/payments/providers
```

Returns the set of payment providers registered at boot, with `supportedAssets` for each.

## SDK usage

```typescript
import { HiveFinance } from '@finlayer/sdk';

const hive = new HiveFinance({ apiKey: process.env.FINLAYER_API_KEY! });

// 1. Create an invoice
const { id, payment_address, webhook_url } = await hive.payments.createInvoice({
  asset: 'USDC',
  amount: '100',
  network: 'ethereum',
  idempotency_key: crypto.randomUUID(),
});

// 2. Show payment_address to the user (or redirect to the widget URL)

// 3. Optionally poll until paid
const final = await hive.payments.waitForPayment(id, { timeoutMs: 15 * 60_000 });
if (final.status === 'paid') {
  // fulfill the order
}
```

`waitForPayment` polls `GET /invoice/{id}` with exponential backoff (default 5s → 30s) until a terminal status (`paid`, `overpaid`, `expired`) is reached or the timeout fires.

## Webhook handling

Every provider calls back to `POST /v1/payments/webhook/{ProviderName}` with a payload and a signature header. The service:

1. Reads the **raw** body (preserved by a custom Fastify content-type parser so the bytes hash byte-for-byte).
2. Delegates to the adapter's `verifyWebhook` for HMAC verification.
3. Inserts a row into `payment_webhook_events` with a `UNIQUE (provider_id, provider_event_id)` constraint — duplicate deliveries are no-ops.
4. Only on the first successful insert does it mutate the invoice and transaction, and emit a `revenue_event` (0.3% default, 60/40 platform/affiliate split).

Response contract:

- `202 Accepted` — event processed, or was a duplicate (`duplicate: true`).
- `401 Unauthorized` — signature verification failed.
- `400 Bad Request` — payload was malformed.

Implement your own callback by subscribing to the `callback_url` you set on the invoice; the service will POST when status transitions (same payload shape as the internal webhook result).

### Signature verification details

- **MoonPay / Transak** — HMAC-SHA256 over the raw body, hex digest, compared timing-safe to the header value.
- **NowPayments** — HMAC-SHA512 over a **canonicalised** JSON serialization (keys sorted at every level). The adapter normalises the payload before hashing; do not rely on the raw body matching.

### Local testing

For local development, use the `MockPaymentProvider` pattern from `apps/api/src/tests/mock-payment-provider.ts` or forward real provider webhooks with an HTTPS tunnel (ngrok, Cloudflare Tunnel). The route expects the raw body to be preserved; the project-level content-type parser already handles this.

## Provider setup

### MoonPay

1. Create a dashboard account at [dashboard.moonpay.com](https://dashboard.moonpay.com).
2. Generate a publishable key (`MOONPAY_API_KEY`) and a webhook secret (`MOONPAY_WEBHOOK_SECRET`).
3. Register the webhook URL shown on `GET /v1/payments/providers` as `webhook_url`.

### Transak

1. Apply for developer access at [transak.com/developer-portal](https://transak.com/developer-portal).
2. Copy the API key (`TRANSAK_API_KEY`) and webhook secret (`TRANSAK_WEBHOOK_SECRET`).
3. Whitelist the FinLayer webhook URL in your Transak dashboard.

### NowPayments

1. Sign up at [account.nowpayments.io](https://account.nowpayments.io).
2. Generate an API key (`NOWPAYMENTS_API_KEY`) and an IPN secret (`NOWPAYMENTS_IPN_SECRET`).
3. Set the IPN callback URL to the FinLayer webhook URL.

## Transaction & revenue ledger

Every paid invoice is represented once in the ledger:

- `transactions` — `type='payment'`, `domain='payments'`, `status` transitions from `pending` → `completed`. `result_amount` stores the paid amount once confirmed.
- `revenue_events` — emitted on paid/overpaid transitions only. Platform share and affiliate share respect the per-request `affiliate_id`.

You can query these tables exactly as you would swap rows — dashboards that already join on `transactions` keep working.

## Errors

All endpoints return FinLayer agent-friendly errors:

```json
{
  "error": {
    "code": "invalid_webhook_signature",
    "domain": "payments",
    "message": "Signature verification failed for provider NowPayments",
    "retryable": false,
    "suggestion": "Check NOWPAYMENTS_IPN_SECRET and that raw body is preserved"
  }
}
```

Common codes: `invoice_not_found`, `invoice_expired`, `payment_provider_unavailable`, `invalid_webhook_signature`, `duplicate_idempotency_key`, `validation_error`.
