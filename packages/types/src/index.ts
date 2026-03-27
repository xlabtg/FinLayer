/**
 * @finlayer/types
 * Shared TypeScript type definitions for FinLayer multi-domain financial API.
 */

// ─── Common ─────────────────────────────────────────────────────────────────

export type UUID = string;
export type ISO8601 = string;
export type Numeric = string; // Use string to preserve decimal precision

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

// ─── Agent-Friendly Error ────────────────────────────────────────────────────

export type ErrorDomain = 'swap' | 'payments' | 'earn' | 'wallet' | 'auth' | 'affiliate' | 'general';

export interface ApiError {
  code: string;
  message: string;
  domain: ErrorDomain;
  retryable: boolean;
  retry_after_ms?: number;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export interface ApiSuccessResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

// ─── Auth & API Keys ─────────────────────────────────────────────────────────

export type ApiKeyScope =
  | 'swap:read'
  | 'swap:write'
  | 'payments:read'
  | 'payments:write'
  | 'earn:read'
  | 'earn:write'
  | 'wallet:read'
  | 'wallet:write'
  | 'affiliate:read'
  | 'affiliate:write'
  | 'admin';

export interface ApiKey {
  id: UUID;
  user_id: UUID;
  name: string;
  key_prefix: string; // e.g. "fl_live_"
  scopes: ApiKeyScope[];
  rate_limit: number; // requests per minute
  created_at: ISO8601;
  last_used_at: ISO8601 | null;
  expires_at: ISO8601 | null;
}

export interface ApiKeyCreateRequest {
  name: string;
  scopes: ApiKeyScope[];
  rate_limit?: number;
  expires_at?: ISO8601;
}

export interface ApiKeyCreateResponse {
  api_key: ApiKey;
  secret: string; // Only returned once on creation
}

export interface MeResponse {
  api_key: ApiKey;
  user: {
    id: UUID;
    email: string;
    created_at: ISO8601;
  };
}

// ─── Providers ───────────────────────────────────────────────────────────────

export type ProviderDomain = 'swap' | 'payments' | 'earn';

export interface Provider {
  id: UUID;
  name: string;
  domain: ProviderDomain;
  is_active: boolean;
  priority: number;
  supported_assets?: string[];
  supported_networks?: string[];
  min_amount?: Numeric;
  max_amount?: Numeric;
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export type TransactionType = 'swap' | 'payment' | 'earn_deposit' | 'earn_withdraw';
export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'expired';

export interface Transaction {
  id: UUID;
  type: TransactionType;
  domain: ProviderDomain;
  status: TransactionStatus;

  // Asset flow
  from_asset: string;
  to_asset: string | null;
  amount: Numeric;
  result_amount: Numeric | null;
  fee_amount: Numeric | null;
  fee_asset: string | null;

  // Provider & routing
  provider_id: UUID;
  provider_tx_id: string | null;

  // Affiliate & revenue
  affiliate_id: UUID | null;
  revenue_event_id: UUID | null;

  // Domain metadata (flexible)
  metadata: Record<string, unknown>;

  created_at: ISO8601;
  updated_at: ISO8601;
}

// ─── Swap ────────────────────────────────────────────────────────────────────

export interface SwapQuoteRequest {
  from_asset: string;       // e.g. "BTC"
  to_asset: string;         // e.g. "ETH"
  amount: Numeric;          // Amount of from_asset
  from_network?: string;    // e.g. "bitcoin"
  to_network?: string;      // e.g. "ethereum"
  affiliate_id?: UUID;
  idempotency_key?: string;
}

export interface SwapQuote {
  id: UUID;
  provider_id: UUID;
  provider_name: string;
  from_asset: string;
  to_asset: string;
  from_amount: Numeric;
  to_amount: Numeric;         // Estimated output
  rate: Numeric;              // Exchange rate
  fee_amount: Numeric;
  fee_asset: string;
  platform_fee: Numeric;      // FinLayer fee on top
  network_fee: Numeric;       // Blockchain gas
  estimated_duration_seconds: number;
  expires_at: ISO8601;
  min_amount: Numeric;
  max_amount: Numeric;
}

export interface SwapQuoteResponse {
  quotes: SwapQuote[];
  best_quote_id: UUID;
}

export interface SwapExecuteRequest {
  quote_id: UUID;
  recipient_address: string;
  refund_address?: string;
  affiliate_id?: UUID;
  idempotency_key: string;    // Required for all state-changing ops
}

export interface SwapTransaction {
  id: UUID;
  quote: SwapQuote;
  status: TransactionStatus;
  recipient_address: string;
  refund_address: string | null;
  deposit_address: string;    // Where to send from_asset
  provider_tx_id: string | null;
  affiliate_id: UUID | null;
  revenue_event_id: UUID | null;
  webhook_url: string;        // For async status updates
  created_at: ISO8601;
  updated_at: ISO8601;
}

export interface SwapStatusResponse {
  transaction: SwapTransaction;
}

// ─── Payments ────────────────────────────────────────────────────────────────

export interface InvoiceCreateRequest {
  asset: string;              // e.g. "USDC"
  amount: Numeric;
  network?: string;
  description?: string;
  expires_in_seconds?: number;
  callback_url?: string;
  affiliate_id?: UUID;
  idempotency_key: string;
  metadata?: Record<string, unknown>;
}

export interface Invoice {
  id: UUID;
  asset: string;
  amount: Numeric;
  network: string;
  payment_address: string;
  status: 'pending' | 'paid' | 'expired' | 'overpaid' | 'underpaid';
  description: string | null;
  expires_at: ISO8601;
  paid_at: ISO8601 | null;
  paid_amount: Numeric | null;
  tx_hash: string | null;
  affiliate_id: UUID | null;
  created_at: ISO8601;
  updated_at: ISO8601;
}

// ─── Earn ─────────────────────────────────────────────────────────────────────

export interface EarnStrategy {
  id: UUID;
  provider_id: UUID;
  provider_name: string;
  asset: string;
  network: string;
  apy: Numeric;             // Annual percentage yield
  apy_30d: Numeric;         // 30-day average APY
  risk_level: 'low' | 'medium' | 'high';
  min_deposit: Numeric;
  max_deposit: Numeric | null;
  lock_period_days: number; // 0 = no lock
  is_active: boolean;
  description: string;
  protocol: string;         // e.g. "Aave V3"
}

export interface EarnDepositRequest {
  strategy_id: UUID;
  amount: Numeric;
  from_address: string;
  affiliate_id?: UUID;
  idempotency_key: string;
}

export interface EarnPosition {
  id: UUID;
  strategy: EarnStrategy;
  deposited_amount: Numeric;
  current_value: Numeric;
  earned_yield: Numeric;
  status: 'active' | 'withdrawn' | 'pending';
  deposit_tx_hash: string | null;
  unlocks_at: ISO8601 | null;
  created_at: ISO8601;
  updated_at: ISO8601;
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

export interface WalletAddressRequest {
  asset: string;
  network: string;
  label?: string;
}

export interface WalletAddress {
  id: UUID;
  asset: string;
  network: string;
  address: string;
  label: string | null;
  qr_code_url: string | null;
  created_at: ISO8601;
}

export interface AssetBalance {
  asset: string;
  network: string;
  address: string;
  balance: Numeric;
  balance_usd: Numeric | null;
  updated_at: ISO8601;
}

// ─── Affiliate ────────────────────────────────────────────────────────────────

export interface Affiliate {
  id: UUID;
  user_id: UUID;
  code: string;
  commission_rate: Numeric;   // e.g. "0.40" = 40%
  payout_address: string | null;
  total_earned: Numeric;
  total_paid_out: Numeric;
  created_at: ISO8601;
}

export interface AffiliateLinkCreateRequest {
  target_url: string;
  label?: string;
}

export interface AffiliateLink {
  id: UUID;
  affiliate_id: UUID;
  target_url: string;
  short_url: string;
  label: string | null;
  clicks: number;
  conversions: number;
  created_at: ISO8601;
}

export interface AffiliateStats {
  affiliate: Affiliate;
  links: AffiliateLink[];
  total_clicks: number;
  total_conversions: number;
  pending_revenue: Numeric;
  revenue_by_domain: Record<ProviderDomain, Numeric>;
  recent_events: RevenueEvent[];
}

// ─── Revenue ──────────────────────────────────────────────────────────────────

export interface RevenueEvent {
  id: UUID;
  transaction_id: UUID;
  source_domain: ProviderDomain;
  total_fee: Numeric;
  platform_share: Numeric;    // e.g. "0.60" = 60%
  affiliate_share: Numeric;   // e.g. "0.40" = 40%
  affiliate_id: UUID | null;
  distributed_at: ISO8601 | null;
  created_at: ISO8601;
}
