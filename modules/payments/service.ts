/**
 * modules/payments/service.ts
 * Payment orchestration: create invoices, process provider webhooks
 * (idempotent), update ledger, emit revenue events.
 */

import type { Sql } from 'postgres';
import { generateUUID, isValidAmount, nowISO } from '@finlayer/utils';
import type {
  UUID,
  Invoice,
  InvoiceCreateRequest,
  InvoiceStatus,
  TransactionStatus,
} from '@finlayer/types';
import type {
  InvoiceCreateParams,
  IPaymentProviderAdapter,
  WebhookVerifyResult,
} from '../shared/types/index.js';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyError,
  InvalidWebhookSignatureError,
  InvoiceExpiredError,
  InvoiceNotFoundError,
  PaymentProviderUnavailableError,
  ValidationError,
} from '../shared/errors/index.js';
import { RevenueService } from '../swap/revenue.js';
import { DEFAULT_REVENUE_CONFIG } from '../shared/types/index.js';
import { logger } from '../shared/utils/logger.js';

interface DbInvoice {
  id: string;
  transaction_id: string;
  user_id: string;
  provider_id: string;
  provider_name?: string;
  provider_invoice_id: string;
  asset: string;
  amount: string;
  network: string;
  payment_address: string;
  description: string | null;
  callback_url: string | null;
  status: InvoiceStatus;
  paid_amount: string | null;
  tx_hash: string | null;
  expires_at: Date;
  paid_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  affiliate_id?: string | null;
  affiliate_link_id?: string | null;
  revenue_event_id?: string | null;
}

// Map invoice.status → transactions.status so the unified ledger stays
// consistent with the domain-specific view.
const INVOICE_TO_TX_STATUS: Record<InvoiceStatus, TransactionStatus> = {
  pending: 'pending',
  paid: 'completed',
  expired: 'expired',
  overpaid: 'completed',
  underpaid: 'processing',
};

const PAID_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set(['paid', 'overpaid']);
const TERMINAL_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  'paid',
  'overpaid',
  'expired',
]);

const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  pending: ['pending', 'underpaid', 'paid', 'overpaid', 'expired'],
  underpaid: ['underpaid', 'paid', 'overpaid', 'expired'],
  paid: ['paid'],
  overpaid: ['overpaid'],
  expired: ['expired'],
};

function canTransitionInvoiceStatus(current: InvoiceStatus, next: InvoiceStatus): boolean {
  return INVOICE_STATUS_TRANSITIONS[current].includes(next);
}

interface StatusUpdateResult {
  applied: boolean;
  status: InvoiceStatus | null;
  becamePaid: boolean;
}

export class PaymentsService {
  private readonly revenueService: RevenueService;

  constructor(
    private readonly sql: Sql,
    private readonly providers: Map<string, IPaymentProviderAdapter>,
    private readonly baseUrl: string = process.env['API_BASE_URL'] ?? 'http://localhost:3000'
  ) {
    this.revenueService = new RevenueService(sql, DEFAULT_REVENUE_CONFIG);
  }

  /**
   * Create a new invoice. The request must carry an idempotency_key.
   * Picks the first healthy payments provider, or the one requested explicitly
   * via `metadata.provider`.
   */
  async createInvoice(userId: UUID, request: InvoiceCreateRequest): Promise<Invoice> {
    if (!request.idempotency_key) {
      throw new IdempotencyError();
    }
    if (!request.asset || request.asset.length < 2 || request.asset.length > 20) {
      throw new ValidationError(`Invalid asset: ${request.asset}`);
    }
    if (!request.amount || !isValidAmount(request.amount)) {
      throw new ValidationError(`Invalid amount: ${request.amount}`);
    }

    const preferred = (request.metadata?.['provider'] as string | undefined) ?? undefined;
    const provider = this.pickProvider(preferred);

    // Resolve provider DB id.
    const [providerRow] = await this.sql<{ id: string }[]>`
      SELECT id FROM providers WHERE name = ${provider.name} AND is_active = TRUE LIMIT 1
    `;
    if (!providerRow) {
      throw new PaymentProviderUnavailableError(provider.name);
    }

    const attribution = await this.revenueService.validateRevenueAttribution(
      request.affiliate_id,
      userId,
      request.affiliate_link_id
    );
    const affiliateId = attribution.affiliateId;
    const affiliateLinkId = attribution.affiliateLinkId;

    const txId = generateUUID();
    const invoiceId = generateUUID();
    const now = nowISO();
    const network = request.network ?? '';
    const asset = request.asset.toUpperCase();
    const platformFee = this.revenueService.calculatePlatformFee(request.amount);
    const webhookUrl = this.providerWebhookUrl(provider.name);

    // Reserve the idempotency key *before* calling the provider (issue #15).
    // The atomic `ON CONFLICT DO NOTHING` ensures two concurrent requests with
    // the same key produce exactly one provider invoice. The loser short-circuits
    // here, before any external side effect.
    const reserved = await this.sql<{ id: string }[]>`
      INSERT INTO transactions (
        id, type, domain, status, user_id,
        from_asset, to_asset, amount,
        fee_amount, fee_asset,
        provider_id, idempotency_key, affiliate_id, affiliate_link_id,
        metadata, created_at, updated_at
      ) VALUES (
        ${txId}, 'payment', 'payments', 'pending',
        ${userId}, ${asset}, ${null}, ${request.amount},
        ${platformFee}, ${asset},
        ${providerRow.id}, ${request.idempotency_key},
        ${affiliateId}, ${affiliateLinkId},
        ${JSON.stringify({
          payment: {
            invoice_id: invoiceId,
            description: request.description ?? null,
            callback_url: request.callback_url ?? null,
            network,
            ...(request.metadata ?? {}),
          },
        })},
        ${now}, ${now}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `;
    if (reserved.length === 0) {
      const [existing] = await this.sql<{ id: string }[]>`
        SELECT id FROM transactions WHERE idempotency_key = ${request.idempotency_key}
      `;
      throw new DuplicateIdempotencyKeyError(existing?.id ?? request.idempotency_key);
    }

    // Call provider only after the key is reserved.
    let providerResult;
    try {
      const providerParams = {
        asset,
        amount: request.amount,
        correlationId: invoiceId,
        webhookUrl,
        ...(request.network !== undefined ? { network: request.network } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.expires_in_seconds !== undefined
          ? { expiresInSeconds: request.expires_in_seconds }
          : {}),
      } satisfies InvoiceCreateParams;

      providerResult = await provider.createInvoice(providerParams);
    } catch (err) {
      // Release the reservation so a genuine failure can be retried.
      await this.sql`DELETE FROM transactions WHERE id = ${txId}`;
      throw err;
    }

    // Finalise the reserved transaction and create the invoice atomically.
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE transactions
        SET provider_tx_id = ${providerResult.providerInvoiceId},
            metadata = ${JSON.stringify({
              payment: {
                invoice_id: invoiceId,
                provider_invoice_id: providerResult.providerInvoiceId,
                payment_address: providerResult.paymentAddress,
                expires_at: providerResult.expiresAt,
                description: request.description ?? null,
                callback_url: request.callback_url ?? null,
                network,
                ...(request.metadata ?? {}),
              },
            })},
            updated_at = ${now}
        WHERE id = ${txId}
      `;

      await tx`
        INSERT INTO invoices (
          id, transaction_id, user_id, provider_id, provider_invoice_id,
          asset, amount, network, payment_address,
          description, callback_url,
          status, expires_at,
          metadata, created_at, updated_at
        ) VALUES (
          ${invoiceId}, ${txId}, ${userId}, ${providerRow.id}, ${providerResult.providerInvoiceId},
          ${asset}, ${request.amount}, ${network}, ${providerResult.paymentAddress},
          ${request.description ?? null}, ${request.callback_url ?? null},
          'pending', ${providerResult.expiresAt},
          ${JSON.stringify(request.metadata ?? {})}, ${now}, ${now}
        )
      `;
    });

    logger.info('Invoice created', {
      invoiceId,
      txId,
      asset,
      amount: request.amount,
      provider: provider.name,
    });

    return this.buildInvoice({
      id: invoiceId,
      transaction_id: txId,
      user_id: userId,
      provider_id: providerRow.id,
      provider_name: provider.name,
      provider_invoice_id: providerResult.providerInvoiceId,
      asset,
      amount: request.amount,
      network,
      payment_address: providerResult.paymentAddress,
      description: request.description ?? null,
      callback_url: request.callback_url ?? null,
      status: 'pending',
      paid_amount: null,
      tx_hash: null,
      expires_at: new Date(providerResult.expiresAt),
      paid_at: null,
      metadata: request.metadata ?? {},
      created_at: new Date(now),
      updated_at: new Date(now),
      affiliate_id: affiliateId,
      revenue_event_id: null,
    });
  }

  /**
   * Fetch invoice by ID, scoped to the owning user.
   * Optionally refreshes status from the provider while the invoice can still
   * transition to another state.
   */
  async getInvoice(invoiceId: UUID, userId: UUID): Promise<Invoice> {
    const [row] = await this.sql<DbInvoice[]>`
      SELECT i.*, p.name AS provider_name, t.affiliate_id AS affiliate_id, t.revenue_event_id AS revenue_event_id
      FROM invoices i
      JOIN providers p ON p.id = i.provider_id
      JOIN transactions t ON t.id = i.transaction_id
      WHERE i.id = ${invoiceId} AND i.user_id = ${userId}
    `;
    if (!row) {
      throw new InvoiceNotFoundError(invoiceId);
    }

    // If not terminal, try to refresh from provider (best-effort).
    if (!TERMINAL_INVOICE_STATUSES.has(row.status) && row.provider_name) {
      const provider = this.providers.get(row.provider_name);
      if (provider) {
        try {
          const res = await provider.getInvoiceStatus(row.provider_invoice_id);
          if (res.status !== row.status) {
            const update = await this.applyStatusUpdate({
              invoiceId: row.id,
              transactionId: row.transaction_id,
              providerInvoiceId: row.provider_invoice_id,
              providerId: row.provider_id,
              providerName: row.provider_name,
              newStatus: res.status,
              paidAmount: res.paidAmount ?? null,
              txHash: res.txHash ?? null,
              paidAt: res.paidAt ?? null,
            });
            if (update.applied && update.status) {
              row.status = update.status;
              row.paid_amount = res.paidAmount ?? row.paid_amount;
              row.tx_hash = res.txHash ?? row.tx_hash;
              row.paid_at = res.paidAt ? new Date(res.paidAt) : row.paid_at;
            }
          }
        } catch (err) {
          logger.warn('Failed to refresh invoice from provider', {
            invoiceId,
            error: String(err),
          });
        }
      }
    }

    return this.buildInvoice(row);
  }

  /**
   * Process an inbound provider webhook.
   *
   * Idempotency strategy:
   *  - Look up adapter by provider id.
   *  - Parse + verify signature.
   *  - Insert into payment_webhook_events with a UNIQUE (provider_id, provider_event_id).
   *    Duplicates are detected via ON CONFLICT and short-circuit as no-ops.
   *  - Only on first successful insert do we mutate the invoice/transaction
   *    and emit revenue events.
   *
   * Returns an object describing whether the event was newly processed.
   */
  async handleWebhook(params: {
    providerName: string;
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
  }): Promise<{ processed: boolean; duplicate: boolean; invoiceId: string | null; status: InvoiceStatus | null }> {
    const provider = this.providers.get(params.providerName);
    if (!provider) {
      throw new PaymentProviderUnavailableError(params.providerName);
    }

    const parsed = provider.verifyWebhook({
      rawBody: params.rawBody,
      headers: params.headers,
      secret: params.secret,
    });
    if (!parsed) {
      throw new ValidationError(`Malformed webhook payload from ${params.providerName}`);
    }
    if (!parsed.signatureValid) {
      // Record the rejected delivery so operators can audit replay/forgery.
      await this.recordWebhookEvent({ parsed, providerName: params.providerName, signatureValid: false, rawBody: params.rawBody });
      throw new InvalidWebhookSignatureError(params.providerName);
    }

    // Dedup insert + process transactionally.
    const result = await this.recordAndProcessWebhook({
      parsed,
      providerName: params.providerName,
      rawBody: params.rawBody,
    });
    return result;
  }

  private async recordWebhookEvent(params: {
    parsed: WebhookVerifyResult;
    providerName: string;
    signatureValid: boolean;
    rawBody: string;
  }): Promise<void> {
    const [providerRow] = await this.sql<{ id: string }[]>`
      SELECT id FROM providers WHERE name = ${params.providerName} LIMIT 1
    `;
    if (!providerRow) return;

    await this.sql`
      INSERT INTO payment_webhook_events (
        id, provider_id, provider_event_id, provider_invoice_id,
        event_type, signature_valid, payload, received_at
      ) VALUES (
        ${generateUUID()}, ${providerRow.id}, ${params.parsed.providerEventId},
        ${params.parsed.providerInvoiceId}, ${params.parsed.eventType},
        ${params.signatureValid}, ${JSON.stringify(safeParse(params.rawBody))}, NOW()
      )
      ON CONFLICT (provider_id, provider_event_id) DO NOTHING
    `;
  }

  private async recordAndProcessWebhook(params: {
    parsed: WebhookVerifyResult;
    providerName: string;
    rawBody: string;
  }): Promise<{ processed: boolean; duplicate: boolean; invoiceId: string | null; status: InvoiceStatus | null }> {
    const [providerRow] = await this.sql<{ id: string }[]>`
      SELECT id FROM providers WHERE name = ${params.providerName} LIMIT 1
    `;
    if (!providerRow) {
      throw new PaymentProviderUnavailableError(params.providerName);
    }

    // Look up the invoice for this provider event.
    const [invoiceRow] = await this.sql<DbInvoice[]>`
      SELECT * FROM invoices
      WHERE provider_id = ${providerRow.id}
        AND provider_invoice_id = ${params.parsed.providerInvoiceId}
      LIMIT 1
    `;

    // Attempt to insert event — duplicates are no-ops.
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO payment_webhook_events (
        id, provider_id, provider_event_id, provider_invoice_id, invoice_id,
        event_type, signature_valid, payload, received_at, processed
      ) VALUES (
        ${generateUUID()}, ${providerRow.id}, ${params.parsed.providerEventId},
        ${params.parsed.providerInvoiceId}, ${invoiceRow?.id ?? null},
        ${params.parsed.eventType}, TRUE,
        ${JSON.stringify(safeParse(params.rawBody))}, NOW(), FALSE
      )
      ON CONFLICT (provider_id, provider_event_id) DO NOTHING
      RETURNING id
    `;

    if (inserted.length === 0) {
      // Duplicate delivery — already processed.
      logger.info('Duplicate payment webhook ignored', {
        provider: params.providerName,
        providerEventId: params.parsed.providerEventId,
      });
      return {
        processed: false,
        duplicate: true,
        invoiceId: invoiceRow?.id ?? null,
        status: invoiceRow?.status ?? null,
      };
    }

    if (!invoiceRow) {
      // Unknown invoice — mark the event but don't error (avoid provider retry storm).
      await this.sql`
        UPDATE payment_webhook_events
        SET processed = TRUE, processed_at = NOW(), error = 'invoice_not_found'
        WHERE id = ${inserted[0]!.id}
      `;
      logger.warn('Webhook for unknown invoice', {
        provider: params.providerName,
        providerInvoiceId: params.parsed.providerInvoiceId,
      });
      return { processed: true, duplicate: false, invoiceId: null, status: null };
    }

    // Apply the status update.
    const update = await this.applyStatusUpdate({
      invoiceId: invoiceRow.id,
      transactionId: invoiceRow.transaction_id,
      providerInvoiceId: invoiceRow.provider_invoice_id,
      providerId: invoiceRow.provider_id,
      providerName: params.providerName,
      newStatus: params.parsed.status,
      paidAmount: params.parsed.paidAmount ?? null,
      txHash: params.parsed.txHash ?? null,
      paidAt: params.parsed.paidAt ?? null,
    });
    const finalStatus = update.status ?? invoiceRow.status;

    await this.sql`
      UPDATE payment_webhook_events
      SET processed = TRUE, processed_at = NOW()
      WHERE id = ${inserted[0]!.id}
    `;

    logger.info('Payment webhook processed', {
      provider: params.providerName,
      invoiceId: invoiceRow.id,
      newStatus: params.parsed.status,
      finalStatus,
      applied: update.applied,
    });

    return {
      processed: true,
      duplicate: false,
      invoiceId: invoiceRow.id,
      status: finalStatus,
    };
  }

  /**
   * Update invoice + transaction status. On transition to a paid state, emit a
   * revenue event (if one hasn't been emitted yet).
   */
  private async applyStatusUpdate(params: {
    invoiceId: string;
    transactionId: string;
    providerInvoiceId: string;
    providerId: string;
    providerName: string;
    newStatus: InvoiceStatus;
    paidAmount: string | null;
    txHash: string | null;
    paidAt: string | null;
  }): Promise<StatusUpdateResult> {
    let result: StatusUpdateResult = {
      applied: false,
      status: null,
      becamePaid: false,
    };

    await this.sql.begin(async (tx) => {
      const [invoiceState] = await tx<{ status: InvoiceStatus }[]>`
        SELECT status FROM invoices
        WHERE id = ${params.invoiceId}
        FOR UPDATE
      `;

      if (!invoiceState) {
        return;
      }

      const currentStatus = invoiceState.status;
      if (TERMINAL_INVOICE_STATUSES.has(currentStatus)) {
        if (currentStatus !== params.newStatus) {
          logger.warn('Payment invoice status transition ignored', {
            provider: params.providerName,
            providerId: params.providerId,
            invoiceId: params.invoiceId,
            providerInvoiceId: params.providerInvoiceId,
            currentStatus,
            requestedStatus: params.newStatus,
          });
        }
        result = {
          applied: false,
          status: currentStatus,
          becamePaid: false,
        };
        return;
      }

      if (!canTransitionInvoiceStatus(currentStatus, params.newStatus)) {
        logger.warn('Payment invoice status transition ignored', {
          provider: params.providerName,
          providerId: params.providerId,
          invoiceId: params.invoiceId,
          providerInvoiceId: params.providerInvoiceId,
          currentStatus,
          requestedStatus: params.newStatus,
        });
        result = {
          applied: false,
          status: currentStatus,
          becamePaid: false,
        };
        return;
      }

      await tx`
        UPDATE invoices
        SET status = ${params.newStatus},
            paid_amount = COALESCE(${params.paidAmount}, paid_amount),
            tx_hash = COALESCE(${params.txHash}, tx_hash),
            paid_at = COALESCE(${params.paidAt}, paid_at),
            updated_at = NOW()
        WHERE id = ${params.invoiceId}
      `;

      const txStatus = INVOICE_TO_TX_STATUS[params.newStatus];
      await tx`
        UPDATE transactions
        SET status = ${txStatus},
            result_amount = COALESCE(${params.paidAmount}, result_amount),
            updated_at = NOW()
        WHERE id = ${params.transactionId}
      `;

      result = {
        applied: currentStatus !== params.newStatus,
        status: params.newStatus,
        becamePaid:
          !PAID_INVOICE_STATUSES.has(currentStatus) &&
          PAID_INVOICE_STATUSES.has(params.newStatus),
      };
    });

    if (result.becamePaid) {
      // Emit revenue event if one doesn't already exist.
      const [txRow] = await this.sql<{
        revenue_event_id: string | null;
        amount: string;
        result_amount: string | null;
        from_asset: string;
        affiliate_id: string | null;
        affiliate_link_id: string | null;
        user_id: string;
      }[]>`
        SELECT revenue_event_id, amount, result_amount, from_asset, affiliate_id, affiliate_link_id, user_id
        FROM transactions WHERE id = ${params.transactionId}
      `;
      if (txRow && !txRow.revenue_event_id) {
        const paidAmount = params.paidAmount ?? txRow.result_amount ?? txRow.amount;
        const totalFee = this.revenueService.calculatePlatformFee(paidAmount);
        const revenueEventId = await this.revenueService.createRevenueEvent({
          transactionId: params.transactionId,
          domain: 'payments',
          totalFee,
          feeAsset: txRow.from_asset,
          affiliateId: txRow.affiliate_id,
          affiliateLinkId: txRow.affiliate_link_id,
          payerUserId: txRow.user_id,
        });
        await this.sql`
          UPDATE transactions SET revenue_event_id = ${revenueEventId} WHERE id = ${params.transactionId}
        `;
      }
    }

    return result;
  }

  private pickProvider(preferred?: string): IPaymentProviderAdapter {
    if (this.providers.size === 0) {
      throw new PaymentProviderUnavailableError();
    }
    if (preferred) {
      const p = this.providers.get(preferred);
      if (!p) throw new PaymentProviderUnavailableError(preferred);
      return p;
    }
    const first = this.providers.values().next();
    if (first.done || !first.value) throw new PaymentProviderUnavailableError();
    return first.value;
  }

  private buildInvoice(row: DbInvoice): Invoice {
    const expires = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    const updated = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
    const paid = row.paid_at instanceof Date ? row.paid_at : row.paid_at ? new Date(row.paid_at) : null;
    const webhookUrl = this.providerWebhookUrl(row.provider_name ?? 'unknown');

    return {
      id: row.id,
      transaction_id: row.transaction_id,
      provider_id: row.provider_id,
      provider_name: row.provider_name ?? 'Unknown',
      asset: row.asset,
      amount: row.amount,
      network: row.network ?? '',
      payment_address: row.payment_address,
      status: row.status,
      description: row.description,
      callback_url: row.callback_url,
      expires_at: expires.toISOString(),
      paid_at: paid ? paid.toISOString() : null,
      paid_amount: row.paid_amount,
      tx_hash: row.tx_hash,
      affiliate_id: row.affiliate_id ?? null,
      revenue_event_id: row.revenue_event_id ?? null,
      webhook_url: webhookUrl,
      created_at: created.toISOString(),
      updated_at: updated.toISOString(),
    };
  }

  private providerWebhookUrl(providerName: string): string {
    return `${this.baseUrl}/v1/payments/webhook/${providerName}`;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** Convenience: throw InvoiceExpiredError if a pending invoice is past its TTL. */
export function assertNotExpired(invoice: Pick<Invoice, 'status' | 'expires_at'>): void {
  if (invoice.status === 'pending' && new Date(invoice.expires_at).getTime() < Date.now()) {
    throw new InvoiceExpiredError();
  }
}
