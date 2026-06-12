/**
 * modules/shared/types
 * Internal types for module-to-module communication.
 */

import type { UUID, Numeric, ISO8601, ApiKeyScope, ProviderDomain, TransactionStatus } from '@finlayer/types';

// ─── Provider Adapter Interface ────────────────────────────────────────────────

/**
 * Universal interface all provider adapters must implement.
 * Providers are plug-in adapters for external financial services.
 */
export interface IProviderAdapter {
  readonly name: string;
  readonly domain: ProviderDomain;
  readonly supportedAssets: string[];

  isHealthy(): Promise<boolean>;
}

export interface ISwapProviderAdapter extends IProviderAdapter {
  readonly domain: 'swap';

  getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult>;
  executeSwap(params: SwapExecuteParams): Promise<SwapExecuteResult>;
  getTransactionStatus(providerTxId: string): Promise<SwapStatusResult>;
  /**
   * Verify a webhook signature and parse the status update.
   * Returns a normalized event, or `null` if the payload is malformed.
   */
  verifyWebhook(params: SwapWebhookVerifyParams): SwapWebhookVerifyResult | null;
}

export interface IPaymentProviderAdapter extends IProviderAdapter {
  readonly domain: 'payments';

  createInvoice(params: InvoiceCreateParams): Promise<InvoiceResult>;
  getInvoiceStatus(providerInvoiceId: string): Promise<InvoiceStatusResult>;
  /**
   * Verify a webhook signature and parse the event.
   * Returns a normalized event or `null` if the signature is invalid.
   */
  verifyWebhook(params: WebhookVerifyParams): WebhookVerifyResult | null;
}

export interface IEarnProviderAdapter extends IProviderAdapter {
  readonly domain: 'earn';

  /** List available yield strategies for this provider (with latest APY). */
  getStrategies(): Promise<EarnStrategyResult[]>;

  /** Look up a single strategy (used to validate min deposit, asset, etc). */
  getStrategy(providerStrategyId: string): Promise<EarnStrategyResult | null>;

  /** Initiate a deposit into a strategy. Returns the deposit address/tx info. */
  deposit(params: EarnDepositParams): Promise<EarnDepositResult>;

  /** Initiate a withdrawal from a position. */
  withdraw(params: EarnWithdrawParams): Promise<EarnWithdrawResult>;

  /** Query the current value & earned yield for a position. */
  getPosition(providerPositionId: string): Promise<EarnPositionResult>;
}

/**
 * Wallet balance provider (e.g., Alchemy, Moralis, Etherscan).
 * Providers are keyed by network and queried on demand.
 */
export interface IWalletBalanceProvider {
  readonly name: string;
  readonly supportedNetworks: string[];

  getNativeBalance(params: BalanceQueryParams): Promise<WalletBalanceResult>;
  getTokenBalances?(params: BalanceQueryParams): Promise<WalletBalanceResult[]>;
}

export interface BalanceQueryParams {
  network: string;
  address: string;
  /** Requested asset ticker for asset-aware balance queries. */
  asset?: string | undefined;
  /** Token contract address when the requested asset is non-native. */
  tokenContract?: string | undefined;
  /** Token decimals when the requested asset is non-native. */
  tokenDecimals?: number | undefined;
}

export interface WalletBalanceResult {
  network: string;
  address: string;
  asset: string;
  balance: Numeric;
  decimals: number;
  balanceUsd?: Numeric | undefined;
  updatedAt: ISO8601;
}

// ─── Swap Adapter Types ────────────────────────────────────────────────────────

export interface SwapQuoteParams {
  fromAsset: string;
  toAsset: string;
  amount: Numeric;
  fromNetwork?: string | undefined;
  toNetwork?: string | undefined;
}

export interface SwapQuoteResult {
  providerQuoteId: string;
  fromAsset: string;
  toAsset: string;
  fromAmount: Numeric;
  toAmount: Numeric;
  rate: Numeric;
  networkFee: Numeric;
  feeAsset: string;
  estimatedDurationSeconds: number;
  expiresAt: ISO8601;
  minAmount: Numeric;
  maxAmount: Numeric;
}

export interface SwapExecuteParams {
  providerQuoteId: string;
  fromAsset: string;
  toAsset: string;
  fromAmount: Numeric;
  toAmount: Numeric;
  rate: Numeric;
  recipientAddress: string;
  refundAddress?: string | undefined;
}

export interface SwapExecuteResult {
  providerTxId: string;
  depositAddress: string;
  status: TransactionStatus;
  fromAmount?: Numeric | undefined;
  toAmount?: Numeric | undefined;
}

export interface SwapStatusResult {
  providerTxId: string;
  status: TransactionStatus;
  txHash?: string | undefined;
  completedAt?: ISO8601 | undefined;
}

export interface SwapWebhookVerifyParams {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  /** Shared secret the provider uses to sign webhook deliveries. */
  secret?: string | undefined;
}

export interface SwapWebhookVerifyResult {
  /** Provider's own transaction id — cross-checked against the target row. */
  providerTxId: string;
  status: TransactionStatus;
  txHash?: string | undefined;
  /** True when the provider's signature header matched the shared secret. */
  signatureValid: boolean;
}

// ─── Payment Adapter Types ────────────────────────────────────────────────────

export interface InvoiceCreateParams {
  asset: string;
  amount: Numeric;
  network?: string | undefined;
  description?: string | undefined;
  expiresInSeconds?: number | undefined;
  /** Stable FinLayer id to pass into provider-supported external/order fields. */
  correlationId: string;
  /** Canonical FinLayer endpoint for provider status notifications. */
  webhookUrl: string;
}

export interface InvoiceResult {
  providerInvoiceId: string;
  paymentAddress: string;
  expiresAt: ISO8601;
}

export interface InvoiceStatusResult {
  providerInvoiceId: string;
  status: 'pending' | 'paid' | 'expired' | 'overpaid' | 'underpaid';
  paidAmount?: Numeric | undefined;
  txHash?: string | undefined;
  paidAt?: ISO8601 | undefined;
}

// ─── Webhook types ────────────────────────────────────────────────────────────

export interface WebhookVerifyParams {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  /** Shared secret the provider uses to sign webhook deliveries. */
  secret?: string | undefined;
}

export interface WebhookVerifyResult {
  /** Provider-specific event id — used to deduplicate replayed deliveries. */
  providerEventId: string;
  providerInvoiceId: string;
  eventType: string;
  status: InvoiceStatusResult['status'];
  paidAmount?: Numeric | undefined;
  txHash?: string | undefined;
  paidAt?: ISO8601 | undefined;
  /** True when the provider's signature header matched our shared secret. */
  signatureValid: boolean;
}

// ─── Earn Adapter Types ───────────────────────────────────────────────────────

export interface EarnStrategyResult {
  providerStrategyId: string;
  asset: string;
  network: string;
  apy: Numeric;
  apy30d: Numeric;
  riskLevel: 'low' | 'medium' | 'high';
  minDeposit: Numeric;
  maxDeposit?: Numeric | undefined;
  lockPeriodDays: number;
  protocol: string;
  description: string;
}

export interface EarnDepositParams {
  strategyId: string;
  amount: Numeric;
  fromAddress: string;
}

export interface EarnDepositResult {
  providerPositionId: string;
  depositAddress: string;
  status: TransactionStatus;
}

export interface EarnWithdrawParams {
  providerPositionId: string;
  toAddress: string;
}

export interface EarnWithdrawResult {
  txHash: string;
  status: TransactionStatus;
  withdrawnAmount?: Numeric | undefined;
}

export interface EarnPositionResult {
  providerPositionId: string;
  status: 'pending' | 'active' | 'withdrawn';
  depositedAmount: Numeric;
  currentValue: Numeric;
  earnedYield: Numeric;
  asset: string;
  network: string;
  unlocksAt?: ISO8601 | undefined;
}

// ─── Request Context ──────────────────────────────────────────────────────────

export interface RequestContext {
  requestId: UUID;
  apiKeyId: UUID;
  userId: UUID;
  scopes: ApiKeyScope[];
  affiliateId?: UUID | undefined;
  idempotencyKey?: string | undefined;
  timestamp: ISO8601;
}

// ─── Revenue Context ──────────────────────────────────────────────────────────

export interface RevenueConfig {
  platformShareRatio: number;    // e.g. 0.60 = 60%
  affiliateShareRatio: number;   // e.g. 0.40 = 40%
  platformFeePercent: number;    // e.g. 0.003 = 0.3% on top of provider fee
}

export const DEFAULT_REVENUE_CONFIG: RevenueConfig = {
  platformShareRatio: 0.6,
  affiliateShareRatio: 0.4,
  platformFeePercent: 0.003,
};
