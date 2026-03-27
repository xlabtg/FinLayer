# Architecture Decision Records (ADRs)

## ADR-001: Fastify over NestJS

**Status**: Accepted

**Context**: Need an HTTP framework for the FinLayer API server.

**Decision**: Fastify with plugin architecture.

**Rationale**:
- 2x throughput vs Express, comparable to raw Node.js
- Plugin system maps cleanly to multi-domain module architecture
- JSON Schema validation built-in → auto-generates OpenAPI
- TypeScript support without DI container complexity
- NestJS DI overhead and decorator magic would slow cold starts (critical for serverless deployments in Phase 5)

---

## ADR-002: PostgreSQL over CockroachDB

**Status**: Accepted

**Context**: Database for unified transaction ledger + all module data.

**Decision**: PostgreSQL 16 with connection pooling.

**Rationale**:
- Phase 1 requirements don't need horizontal scaling
- PostgreSQL JSONB is perfect for `metadata` column (domain-specific tx data)
- pgcrypto for UUID generation server-side
- CockroachDB migration path available if Phase 4+ scale requires it
- Lower operational complexity for a startup

---

## ADR-003: Single `transactions` Table

**Status**: Accepted

**Context**: Multiple financial domains (swap, payments, earn) each have transactions.

**Decision**: One unified `transactions` table with `domain`/`type` discriminators and JSONB `metadata` for domain-specific fields.

**Rationale**:
- Unified accounting: total revenue calculated with one query
- Cross-domain analytics without JOINs across tables
- Revenue sharing calculation consistent for all domains
- `metadata` JSONB avoids schema migrations for domain-specific fields
- Simpler affiliate revenue tracking (one foreign key)

**Trade-offs**: Metadata is not strongly typed at DB level. Mitigated by TypeScript validation at service layer.

---

## ADR-004: In-Memory Rate Limiting (Phase 1)

**Status**: Accepted (temporary)

**Context**: Need rate limiting for API keys.

**Decision**: In-memory Map with sliding window counter.

**Rationale**:
- Sufficient for Phase 1 single-instance deployment
- Zero infrastructure dependency
- Redis migration planned for Phase 2 (before multi-instance)

**Action Item**: Replace with Redis (ioredis) before horizontal scaling.

---

## ADR-005: Idempotency Keys Required for All Mutations

**Status**: Accepted

**Context**: AI agents may retry failed requests, causing duplicate transactions.

**Decision**: All state-changing POST endpoints require `idempotency_key` in request body.

**Rationale**:
- Agents operate in unreliable network environments
- Duplicate swap executions cause real financial loss
- Unique constraint on `transactions.idempotency_key` provides database-level guarantee
- Follows Stripe's battle-tested pattern

---

## ADR-006: Webhook-First Async Pattern

**Status**: Accepted

**Context**: Blockchain transactions can take minutes to hours to complete.

**Decision**: `POST /execute` returns `202 Accepted` immediately with a `webhook_url` for status updates.

**Rationale**:
- HTTP connections cannot stay open for blockchain confirmation times
- Agents should not block while waiting for finality
- `GET /tx/:id` available for polling as fallback
- SDK `waitForCompletion()` abstracts the polling pattern

---

## ADR-007: Bun Runtime

**Status**: Accepted

**Context**: Need a JavaScript runtime for the API server.

**Decision**: Bun 1.1+ as runtime and package manager.

**Rationale**:
- 3x faster startup than Node.js (critical for serverless)
- Native TypeScript execution (no ts-node/tsx needed)
- Built-in test runner (no Jest/Vitest overhead)
- Compatible with Node.js APIs and npm packages
- Workspace support for monorepo
