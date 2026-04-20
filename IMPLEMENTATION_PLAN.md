# FinLayer Implementation Plan

> Generated: 2026-03-27
> Issue: xlabtg/FinLayer#1

---

## Tech Stack Decisions

| Concern | Choice | Rationale |
|---------|--------|-----------|
| **Runtime** | Bun | 3x Node.js speed, native TS, built-in test runner |
| **HTTP Framework** | Fastify | Plugin architecture, JSON schema, 2x Express perf |
| **Database** | PostgreSQL 16 | ACID transactions, JSONB metadata, proven at scale |
| **ORM/Query** | `postgres` tagged template | Type-safe, no magic, close to raw SQL |
| **Validation** | Zod | Runtime + compile-time type inference |
| **Auth** | bcrypt API keys | No JWT complexity; keys are stateless bearer tokens |
| **Logging** | Pino / structured JSON | Machine-readable, Datadog/Loki compatible |
| **API Docs** | OpenAPI 3 + Swagger UI | Auto-generated from route schemas |

**Rejected**: NestJS (too much boilerplate, DI overhead), CockroachDB (Phase 4+ if horizontal scale needed), Prisma (code generation friction in monorepo)

---

## Dependency Graph (Phase 1)

```
packages/types          ← Foundation (no deps)
       │
packages/utils          ← Depends on: types
       │
modules/shared          ← Depends on: types, utils
       │
modules/auth            ← Depends on: shared
modules/affiliate       ← Depends on: shared
       │
modules/providers/changenow ← Depends on: shared
       │
modules/swap            ← Depends on: shared, providers
       │
apps/api                ← Depends on: all modules
       │
packages/sdk            ← Depends on: types (HTTP client, no server code)
```

**Parallel development enabled**: SDK can be developed independently of server-side modules.

---

## Phase 1: Core Foundation + Swap Module (MVP)

### Story Points Estimation

| Task | SP | Status |
|------|----|--------|
| [ARCH] Monorepo structure | 2 | ✅ Done |
| [ARCH] Fastify app + plugin architecture | 3 | ✅ Done |
| [DB] PostgreSQL schema + migrations | 5 | ✅ Done |
| [AUTH] API key CRUD + bcrypt | 5 | ✅ Done |
| [AUTH] Scope middleware + rate limiting | 3 | ✅ Done |
| [SWAP] IProviderAdapter interface | 2 | ✅ Done |
| [PROVIDERS] ChangeNOW adapter (quote + execute) | 5 | ✅ Done |
| [SWAP] Quote routing (multi-provider best-rate) | 3 | ✅ Done |
| [SWAP] Execute + async webhook flow | 4 | ✅ Done |
| [REVENUE] Fee calculation middleware | 3 | ✅ Done |
| [AFFILIATE] Affiliate tracking + propagation | 4 | ✅ Done |
| [SDK] TypeScript SDK (HiveFinance class) | 3 | ✅ Done |
| [INFRA] Dockerfile + docker-compose | 2 | ✅ Done |
| [TEST] E2E tests with mock provider | 5 | ✅ Done |
| [DOCS] OpenAPI + README quickstart | 3 | ✅ Done |

**Total Phase 1**: ~52 story points

---

## Phase 2: Payments Module (Next)

**Goal**: Invoice creation + fiat on-ramp integration

| Task | SP | Risk |
|------|----|------|
| [PAYMENTS] MoonPay/Transak provider adapter | 5 | Medium (API docs quality) |
| [PAYMENTS] POST /v1/payments/invoice | 3 | Low |
| [PAYMENTS] Webhook handler for payment status | 4 | Medium (idempotent webhook handling) |
| [REVENUE] Extend revenue_events for payment fees | 2 | Low |
| [SDK] HiveFinance.payments module | 3 | Low |
| [DOCS] Payment integration guide | 2 | Low |

**Risk**: KYC/AML compliance requirements for fiat on-ramp vary by jurisdiction. MoonPay requires business verification.

---

## Phase 3: Earn/Lending Module

**Goal**: Yield strategy aggregation (Aave, Compound)

| Task | SP | Status |
|------|----|--------|
| [EARN] Strategy pattern + IEarnProviderAdapter | 3 | ✅ Done |
| [PROVIDERS] Aave V3 adapter (deposit/withdraw) | 8 | ✅ Done (RPC client injected; Alchemy/Infura wiring deferred) |
| [PROVIDERS] Compound adapter | 6 | ✅ Done (RPC client injected) |
| [EARN] Position tracking + earn_positions table | 4 | ✅ Done |
| [EARN] APY data feed + strategy listing | 3 | ✅ Done |
| [SDK] HiveFinance.earn module | 3 | ✅ Done |

**Risk**: Smart contract interactions require careful gas estimation and reorg handling. Consider using Alchemy/Infura for RPC reliability. The adapters ship with an injectable `RpcClient` interface so the production deployment can wire Alchemy/Infura without touching the business logic.

---

## Phase 4: Wallet + Advanced Features

**Goal**: Non-custodial key management, HD wallets

| Task | SP | Risk |
|------|----|------|
| [WALLET] HD wallet generation (BIP39/BIP44) | 5 | High (key security is critical) |
| [WALLET] Multi-chain address generation | 5 | High |
| [WALLET] Balance queries (Alchemy/Moralis) | 3 | Medium |
| [AFFILIATE] Payout scheduler (cron) | 5 | Medium |
| [OBS] Prometheus metrics | 3 | Low |
| [OBS] Sentry integration | 2 | Low |

**Risk**: Private key management is the highest-risk component. Must be audited before production. Consider MPC approach (Fireblocks/Lit Protocol) to eliminate single-point-of-failure.

---

## Phase 5: Growth & Ecosystem

| Task | SP | Risk |
|------|----|------|
| [ROUTING] Smart provider selection (best rate + fee) | 5 | Low |
| [CACHE] Redis quote cache (TTL-based) | 3 | Low |
| [ANALYTICS] Cross-domain revenue dashboard | 5 | Medium |
| [AGENT] Hive Mind plugin integration | 5 | Medium |
| [MARKETPLACE] Affiliate link generator | 3 | Low |

---

## Risk Assessment

### High Risk
1. **Private Key Security** (Phase 4): Single greatest attack surface. Mitigate with MPC, hardware HSMs, or custodial provider (Fireblocks) for Phase 1.
2. **Provider Outages**: ChangeNOW downtime = zero swap availability in Phase 1. Mitigate by adding DEX fallback (1inch, Uniswap) in Phase 2.
3. **Regulatory**: Fiat on/off-ramp (Phase 2) has jurisdiction-specific requirements. Engage legal counsel before launch.

### Medium Risk
4. **Rate Limiting**: In-memory rate limit store doesn't survive restarts or scale across instances. Replace with Redis in Phase 2 before multi-instance deployment.
5. **Quote Expiry Race**: User may execute a quote milliseconds after expiry. Current window is 300s — extend or add 30s grace period if user reports issues.
6. **Transaction Finality**: Blockchain reorgs can cause "completed" transactions to revert. Add confirmation count tracking in Phase 3.

### Low Risk
7. **Database Schema Evolution**: Single `transactions` table is extensible via JSONB `metadata`. Works for all planned phases.
8. **TypeScript Strict Mode**: Already enforced — eliminates common runtime errors.

---

## Quality Gates Checklist

- [x] TypeScript strict mode, no `any`
- [x] Input validation (Zod) on all endpoints
- [x] API keys hashed (bcrypt), never logged
- [x] Rate limiting per key
- [x] Structured JSON logging
- [x] Idempotency keys required for state changes
- [x] Agent-friendly errors (code, domain, retryable)
- [x] E2E tests for swap flow
- [x] OpenAPI docs at `/docs`
- [x] Docker + docker-compose for local dev
- [ ] Redis rate limiting (Phase 2 — currently in-memory)
- [ ] Prometheus metrics (Phase 4)
- [ ] Sentry error tracking (Phase 4)
- [ ] ≥80% test coverage (Phase 1 covers critical paths)

---

## Sub-Issues to Create (GitHub)

Based on the implementation phases above, the following sub-issues should be created:

1. **[Phase 2]** Payments module: MoonPay/Transak adapter + invoice endpoints
2. **[Phase 2]** Webhook handler for payment status with idempotent processing
3. **[Phase 3]** Earn module: Aave V3 adapter + strategy listing
4. **[Phase 3]** Position tracking for earn deposits
5. **[Phase 4]** HD wallet generation + multi-chain address support
6. **[Phase 4]** Redis migration for rate limiting and quote caching
7. **[Phase 4]** Prometheus metrics + Sentry integration
8. **[Phase 5]** Smart provider routing (best rate + lowest fee algorithm)
9. **[Phase 5]** Hive Mind agent plugin: `solve financial-task`
10. **[Phase 5]** Affiliate payout scheduler (cron job for crypto distributions)
