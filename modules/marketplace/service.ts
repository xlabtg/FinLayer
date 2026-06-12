/**
 * modules/marketplace/service.ts
 * Affiliate marketplace link generator.
 *
 * Purpose: let affiliates create rich deep links that pre-fill a specific
 * domain action (swap, payment invoice, or earn strategy) and carry their
 * attribution automatically. Every generated link resolves to an
 * `affiliate_links` row so clicks/conversions flow through the existing
 * tracking pipeline.
 *
 * Each deep link encodes its parameters into the query string and is
 * rendered against a configurable marketplace base URL (typically the
 * FinLayer hosted web widget). For first-party agents, the API also returns
 * the equivalent SDK snippet so the flow can be embedded directly.
 */

import type { Sql } from 'postgres';
import type { AffiliateLink, UUID } from '@finlayer/types';
import { isValidAmount } from '@finlayer/utils';
import { AffiliateService } from '../affiliate/service.js';
import { ValidationError } from '../shared/errors/index.js';

export type MarketplaceProductKind = 'swap' | 'payment' | 'earn';

interface BaseLinkParams {
  label?: string;
  /** Optional UTM-style campaign tag stored in the link label for analytics. */
  campaign?: string;
}

export interface SwapLinkParams extends BaseLinkParams {
  kind: 'swap';
  from_asset: string;
  to_asset: string;
  amount?: string;
  recipient_address?: string;
}

export interface PaymentLinkParams extends BaseLinkParams {
  kind: 'payment';
  asset: string;
  amount: string;
  network?: string;
  description?: string;
}

export interface EarnLinkParams extends BaseLinkParams {
  kind: 'earn';
  strategy_id: UUID;
  amount?: string;
}

export type MarketplaceLinkParams = SwapLinkParams | PaymentLinkParams | EarnLinkParams;

export interface GeneratedLink {
  link: AffiliateLink;
  product: MarketplaceProductKind;
  deep_link: string;
  web_widget_url: string;
  sdk_snippet: string;
}

export class MarketplaceService {
  private readonly affiliates: AffiliateService;
  private readonly marketplaceBaseUrl: string;

  constructor(
    private readonly sql: Sql,
    marketplaceBaseUrl: string = process.env['MARKETPLACE_BASE_URL'] ?? 'https://app.finlayer.io'
  ) {
    this.affiliates = new AffiliateService(sql);
    this.marketplaceBaseUrl = marketplaceBaseUrl.replace(/\/$/, '');
  }

  async generate(userId: UUID, params: MarketplaceLinkParams): Promise<GeneratedLink> {
    const affiliate = await this.affiliates.getOrCreateAffiliate(userId);

    const deepLink = this.buildDeepLink(affiliate.code, params);
    const label = params.campaign ? `${params.label ?? params.kind}:${params.campaign}` : (params.label ?? params.kind);

    const link = await this.affiliates.createLink(affiliate.id, {
      target_url: deepLink,
      label,
    });

    return {
      link,
      product: params.kind,
      deep_link: deepLink,
      web_widget_url: deepLink,
      sdk_snippet: buildSdkSnippet(params, affiliate.id, link.id),
    };
  }

  /**
   * Build the URL a generated link redirects to. Callers can use this to
   * construct copy-paste marketing links without persisting a row.
   */
  preview(affiliateCode: string, params: MarketplaceLinkParams): string {
    return this.buildDeepLink(affiliateCode, params);
  }

  private buildDeepLink(affiliateCode: string, params: MarketplaceLinkParams): string {
    const path = marketplacePath(params.kind);
    const query = new URLSearchParams();
    query.set('ref', affiliateCode);

    switch (params.kind) {
      case 'swap':
        requireAsset(params.from_asset, 'from_asset');
        requireAsset(params.to_asset, 'to_asset');
        query.set('from', params.from_asset.toUpperCase());
        query.set('to', params.to_asset.toUpperCase());
        if (params.amount) {
          requireAmount(params.amount);
          query.set('amount', params.amount);
        }
        if (params.recipient_address) query.set('recipient', params.recipient_address);
        break;
      case 'payment':
        requireAsset(params.asset, 'asset');
        requireAmount(params.amount);
        query.set('asset', params.asset.toUpperCase());
        query.set('amount', params.amount);
        if (params.network) query.set('network', params.network);
        if (params.description) query.set('description', params.description);
        break;
      case 'earn':
        if (!params.strategy_id) throw new ValidationError('strategy_id is required');
        query.set('strategy_id', params.strategy_id);
        if (params.amount) {
          requireAmount(params.amount);
          query.set('amount', params.amount);
        }
        break;
      default: {
        const exhaustive: never = params;
        throw new ValidationError(`Unknown marketplace product: ${String((exhaustive as { kind: string }).kind)}`);
      }
    }

    if (params.campaign) query.set('utm_campaign', params.campaign);
    return `${this.marketplaceBaseUrl}${path}?${query.toString()}`;
  }
}

function marketplacePath(kind: MarketplaceProductKind): string {
  switch (kind) {
    case 'swap':
      return '/swap';
    case 'payment':
      return '/pay';
    case 'earn':
      return '/earn';
  }
}

function requireAsset(value: string | undefined, field: string): void {
  if (!value || !/^[A-Za-z0-9]{2,10}$/.test(value)) {
    throw new ValidationError(`Invalid ${field}: ${value ?? '(missing)'}`);
  }
}

function requireAmount(value: string): void {
  if (!isValidAmount(value)) {
    throw new ValidationError(`Invalid amount: ${value}`);
  }
}

function buildSdkSnippet(params: MarketplaceLinkParams, affiliateId: UUID, affiliateLinkId: UUID): string {
  switch (params.kind) {
    case 'swap':
      return [
        `import { HiveFinance } from '@finlayer/sdk';`,
        `const fl = new HiveFinance({ apiKey: 'fl_live_...', affiliateId: '${affiliateId}', affiliateLinkId: '${affiliateLinkId}' });`,
        `const tx = await fl.swap.quoteAndExecute({`,
        `  from_asset: '${params.from_asset.toUpperCase()}',`,
        `  to_asset: '${params.to_asset.toUpperCase()}',`,
        `  amount: '${params.amount ?? '0.1'}',`,
        `  recipient_address: '${params.recipient_address ?? '0xYourAddress'}',`,
        `  idempotency_key: crypto.randomUUID(),`,
        `});`,
      ].join('\n');
    case 'payment':
      return [
        `import { HiveFinance } from '@finlayer/sdk';`,
        `const fl = new HiveFinance({ apiKey: 'fl_live_...', affiliateId: '${affiliateId}', affiliateLinkId: '${affiliateLinkId}' });`,
        `const invoice = await fl.payments.createInvoice({`,
        `  asset: '${params.asset.toUpperCase()}',`,
        `  amount: '${params.amount}',`,
        `  idempotency_key: crypto.randomUUID(),`,
        `});`,
      ].join('\n');
    case 'earn':
      return [
        `import { HiveFinance } from '@finlayer/sdk';`,
        `const fl = new HiveFinance({ apiKey: 'fl_live_...', affiliateId: '${affiliateId}', affiliateLinkId: '${affiliateLinkId}' });`,
        `// Earn deposit (Phase 3+)`,
        `// const position = await fl.earn.deposit({ strategy_id: '${params.strategy_id}', amount: '${params.amount ?? '100'}', from_address: '0x...', idempotency_key: crypto.randomUUID() });`,
      ].join('\n');
  }
}
