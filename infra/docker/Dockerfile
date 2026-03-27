# FinLayer API — Multi-stage Dockerfile
# Uses Bun for fast builds and startup

# ─── Build Stage ─────────────────────────────────────────────────────────────
FROM oven/bun:1.1-slim AS builder

WORKDIR /app

# Copy workspace manifests first (layer caching)
COPY package.json bun.lockb* ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/
COPY packages/utils/package.json ./packages/utils/
COPY packages/sdk/package.json ./packages/sdk/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY apps/ ./apps/
COPY modules/ ./modules/
COPY packages/ ./packages/

# Build API
WORKDIR /app/apps/api
RUN bun build src/index.ts --outdir dist --target bun --minify

# ─── Production Stage ─────────────────────────────────────────────────────────
FROM oven/bun:1.1-slim AS production

WORKDIR /app

# Install only production deps
COPY package.json bun.lockb* ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/
COPY packages/utils/package.json ./packages/utils/
COPY packages/sdk/package.json ./packages/sdk/
RUN bun install --frozen-lockfile --production

# Copy built artifacts
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Copy migrations (not bundled)
COPY apps/api/src/db/migrations/ ./apps/api/src/db/migrations/

# Non-root user for security
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["bun", "run", "apps/api/dist/index.js"]
