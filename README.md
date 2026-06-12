# FinLayer

**Multi-domain financial API platform for AI agents.** Unified access to crypto swaps, payments, and yield with built-in monetization, provider abstraction, and affiliate revenue tracking.

---

## 5-Minute Quickstart for AI Agents

### 1. Install the SDK

```bash
npm install @finlayer/sdk
# or
bun add @finlayer/sdk
```

### 2. Initialize the client

```typescript
import { HiveFinance } from '@finlayer/sdk';

const finlayer = new HiveFinance({
  apiKey: 'fl_live_your_api_key',
  // Optional: attach affiliate ID to all requests
  affiliateId: 'your-affiliate-uuid',
});
```

### 3. Execute a Crypto Swap

```typescript
// Option A: One-call swap (recommended for agents)
const tx = await finlayer.swap.quoteAndExecute({
  from_asset: 'BTC',
  to_asset: 'ETH',
  amount: '0.1',
  recipient_address: '0xYourEthAddress',
  idempotency_key: crypto.randomUUID(), // Required — prevents duplicates
});

console.log('Send BTC to:', tx.deposit_address);
console.log('Track at:', tx.webhook_url);

// Option B: Explicit quote + execute
const { quotes, best_quote_id } = await finlayer.swap.quote({
  from_asset: 'BTC',
  to_asset: 'ETH',
  amount: '0.1',
});

console.log(`Best rate: ${quotes[0].rate} ETH/BTC`);

const tx = await finlayer.swap.execute({
  quote_id: best_quote_id,
  recipient_address: '0xYourEthAddress',
  idempotency_key: crypto.randomUUID(),
});
```

### 4. Poll for Completion

```typescript
const completedTx = await finlayer.swap.waitForCompletion(tx.id, {
  timeoutMs: 3_600_000,  // 1 hour
  pollIntervalMs: 15_000, // 15 seconds
});

if (completedTx.status === 'completed') {
  console.log('Swap complete!');
} else {
  console.log('Swap failed:', completedTx.status);
}
```

### 5. Handle Agent-Friendly Errors

```typescript
import { FinLayerApiError } from '@finlayer/sdk';

try {
  const tx = await finlayer.swap.execute({ ... });
} catch (err) {
  if (err instanceof FinLayerApiError) {
    console.log('Error code:', err.code);        // e.g. "PROVIDER_RATE_LIMIT"
    console.log('Domain:', err.domain);          // e.g. "swap"
    console.log('Retryable:', err.retryable);    // true/false
    console.log('Retry after:', err.retry_after_ms, 'ms');
    console.log('Suggestion:', err.suggestion);
  }
}
```

---

## Local Development

### Prerequisites

- [Docker](https://docker.com) + Docker Compose
- [Bun](https://bun.sh) (for local development without Docker)

### Start with Docker Compose

```bash
# Copy and configure environment
cp .env.example .env.local

# Edit .env.local with your API keys
nano .env.local

# Start all services (PostgreSQL + Redis + API + Migrations)
docker-compose up

# API is now running at http://localhost:3000
# Swagger docs at http://localhost:3000/docs
```

### Start without Docker (development)

```bash
# Install dependencies
bun install

# Set up local PostgreSQL
export DATABASE_URL=postgresql://finlayer:password@localhost:5432/finlayer

# Run migrations
bun db:migrate

# Start API server (hot reload)
bun dev:api
```

---

## API Reference

Interactive documentation: **`http://localhost:3000/docs`** (Swagger UI)

### Authentication

All API endpoints require an API key:

```
Authorization: Bearer fl_live_your_api_key
```

### Create an API Key

```bash
curl -X POST http://localhost:3000/v1/auth/api-keys \
  -H "Authorization: Bearer fl_live_existing_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My AI Agent Key",
    "scopes": ["swap:read", "swap:write", "affiliate:read"],
    "rate_limit": 100
  }'
```

### Swap Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/swap/providers` | List active exchange providers |
| `POST` | `/v1/swap/quote` | Get swap quotes (requires `swap:read`) |
| `POST` | `/v1/swap/execute` | Execute a swap (requires `swap:write`) |
| `GET` | `/v1/swap/tx/:id` | Get transaction status |

### Earn Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/v1/earn/strategies` | List yield strategies (Aave V3, Compound V3) |
| `POST` | `/v1/earn/deposit` | Deposit into a strategy (requires `earn:write`) |
| `POST` | `/v1/earn/withdraw` | Withdraw from a position (requires `earn:write`) |
| `GET`  | `/v1/earn/positions` | List user positions (requires `earn:read`) |
| `GET`  | `/v1/earn/positions/:id` | Get one position with fresh on-chain value |

```typescript
// SDK usage
const { strategies } = await finlayer.earn.listStrategies({ asset: 'USDC' });
const best = strategies.sort((a, b) => parseFloat(b.apy) - parseFloat(a.apy))[0];

const { position } = await finlayer.earn.deposit({
  strategy_id: best.id,
  amount: '100',
  from_address: '0xYourWallet',
  idempotency_key: crypto.randomUUID(),
});
```

### Affiliate Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/affiliate/link` | Create tracking link |
| `GET` | `/v1/affiliate/stats` | Revenue dashboard |

### Analytics Endpoints (Phase 5)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/analytics/revenue` | Cross-domain revenue dashboard (admin scope) |
| `GET` | `/v1/analytics/affiliate` | Per-affiliate revenue dashboard (`affiliate:read`) |

### Marketplace Endpoints (Phase 5)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/marketplace/link` | Generate an affiliate deep-link for swap, payment, or earn (`affiliate:write`) |

---

## Architecture

```
/
├── apps/
│   └── api/                    # Fastify API server
│       └── src/
│           ├── index.ts        # Entry point, plugin registration
│           ├── db/             # PostgreSQL client + migrations
│           ├── plugins/        # Fastify plugins (DB, error handler)
│           └── tests/          # E2E tests with mock provider
├── modules/
│   ├── swap/                   # [PHASE 1] Crypto exchange aggregation
│   │   ├── service.ts          # Business logic, quote routing
│   │   ├── revenue.ts          # Revenue calculation middleware
│   │   └── routes.ts           # Fastify route handlers
│   ├── auth/                   # API keys, scopes, rate limiting
│   ├── affiliate/              # Revenue sharing & tracking
│   ├── providers/
│   │   └── changenow/          # ChangeNOW adapter (ISwapProviderAdapter)
│   └── shared/                 # Common types, errors, logger
├── packages/
│   ├── sdk/                    # TypeScript SDK (@finlayer/sdk)
│   ├── types/                  # Shared types (@finlayer/types)
│   └── utils/                  # Utilities (@finlayer/utils)
├── infra/
│   └── docker/                 # Dockerfile
├── docker-compose.yml          # Full local stack
└── docs/
    ├── guides/                 # Integration guides
    └── architecture/           # ADRs
```

### Key Design Decisions

- **Fastify** over NestJS: Lower overhead, better streaming support, plugin-based
- **PostgreSQL** over CockroachDB: Simpler ops for Phase 1; CockroachDB for Phase 4+ scaling
- **Bun** runtime: 3x faster cold starts than Node.js, native TypeScript
- **Single `transactions` table**: Unified ledger enables cross-domain analytics
- **IProviderAdapter interface**: Plug in any provider without changing business logic
- **Webhook-first async**: `POST /execute` returns `202 Accepted` immediately

---

## Revenue Model

Every transaction automatically tracks revenue:

- **Platform fee**: 0.3% of swap amount
- **Revenue split** (when affiliate is present):
  - 60% → Platform
  - 40% → Affiliate
- **Without affiliate**: 100% → Platform

---

## Implementation Phases

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ **Complete** | Core foundation + Swap module (ChangeNOW) |
| Phase 2 | ✅ **Complete** | Payments module (MoonPay/Transak/NowPayments) |
| Phase 3 | ✅ **Complete** | Earn/Lending module (Aave V3, Compound V3) |
| Phase 4 | ✅ **Complete** | HD wallets (BIP39/BIP44), affiliate payout scheduler, Prometheus + Sentry |
| Phase 5 | ✅ **Complete** | Growth & Ecosystem (smart routing, Redis cache, analytics, marketplace, agent plugin) |

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for detailed roadmap.

---

## Running Tests

```bash
# Unit + E2E tests (uses mock provider, no DB required)
bun test

# Watch mode during development
bun test --watch

# Run specific test file
bun test apps/api/src/tests/swap.test.ts
```

---

## Security

- API keys hashed with bcrypt (never stored in plaintext)
- Authorization headers never logged
- Rate limiting per API key (configurable per-key limit)
- Input validation with Zod on all endpoints
- Helmet.js security headers
- Idempotency keys required for all state-changing operations

---

## License

See [LICENSE](LICENSE)
