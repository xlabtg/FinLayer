/**
 * @finlayer/agent-plugin
 *
 * Hive Mind plugin that lets an agent solve financial tasks through FinLayer
 * with a single call. The plugin exposes a `solve` method that routes to the
 * appropriate domain (swap, payment, earn) based on the task kind, using the
 * underlying SDK for transport and the server's smart routing for provider
 * selection.
 *
 * The plugin is transport-agnostic — it only depends on the public SDK so it
 * can be registered into any agent framework (Hive Mind, custom orchestrator,
 * MCP server) via a tiny manifest.
 */

import { HiveFinance, type FinLayerClientConfig } from '@finlayer/sdk';
import type {
  Invoice,
  InvoiceCreateRequest,
  SwapTransaction,
  UUID,
} from '@finlayer/types';

export interface FinancialTaskSwap {
  kind: 'swap';
  from_asset: string;
  to_asset: string;
  amount: string;
  recipient_address: string;
  refund_address?: string;
  idempotency_key?: string;
}

export interface FinancialTaskPayment {
  kind: 'payment';
  asset: string;
  amount: string;
  description?: string;
  network?: string;
  callback_url?: string;
  idempotency_key?: string;
}

export interface FinancialTaskQuote {
  kind: 'quote';
  from_asset: string;
  to_asset: string;
  amount: string;
}

export type FinancialTask = FinancialTaskSwap | FinancialTaskPayment | FinancialTaskQuote;

export interface FinancialTaskResult {
  kind: FinancialTask['kind'];
  /** True when the task executed and produced a tracking artifact. */
  executed: boolean;
  /** Completed swap transaction (for swap tasks). */
  swap?: SwapTransaction;
  /** Invoice (for payment tasks). */
  invoice?: Invoice;
  /** Quote preview (for quote tasks). */
  quote?: { best_quote_id: UUID; to_amount: string; rate: string; provider: string };
  /** Canonical tracking URL for the action. */
  tracking_url: string | null;
  /** Suggested next step the agent can take. */
  next_action: string;
}

/**
 * Manifest shape expected by the Hive Mind plugin loader. Agent frameworks
 * that implement a different convention can wrap this manifest.
 */
export interface HiveMindPluginManifest {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  commands: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}

export const HIVE_MIND_MANIFEST: HiveMindPluginManifest = {
  name: 'finlayer',
  version: '0.1.0',
  description: 'Multi-domain financial tasks (crypto swap, payments, earn) via FinLayer.',
  capabilities: ['solve:financial-task'],
  commands: [
    {
      name: 'solve financial-task',
      description:
        'Execute a single financial task — swap, payment invoice, or quote preview — ' +
        'with affiliate attribution automatically applied.',
      input_schema: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['swap', 'payment', 'quote'] },
          from_asset: { type: 'string' },
          to_asset: { type: 'string' },
          amount: { type: 'string' },
          recipient_address: { type: 'string' },
          asset: { type: 'string' },
          description: { type: 'string' },
          network: { type: 'string' },
          callback_url: { type: 'string' },
          idempotency_key: { type: 'string' },
        },
      },
    },
  ],
};

export interface FinLayerAgentPluginConfig extends FinLayerClientConfig {
  /**
   * Override the SDK client for testing or to share a client across plugins.
   */
  client?: HiveFinance;
}

/**
 * Plugin implementation. A Hive Mind agent instantiates this once per
 * workspace, then forwards task specs to `solve`. Every task is a single
 * end-to-end call — the SDK handles quote routing, idempotency, and webhook
 * plumbing under the hood.
 */
export class FinLayerAgentPlugin {
  public readonly manifest = HIVE_MIND_MANIFEST;
  public readonly client: HiveFinance;

  constructor(config: FinLayerAgentPluginConfig) {
    this.client = config.client ?? new HiveFinance(config);
  }

  async solve(task: FinancialTask): Promise<FinancialTaskResult> {
    switch (task.kind) {
      case 'swap':
        return this.solveSwap(task);
      case 'payment':
        return this.solvePayment(task);
      case 'quote':
        return this.solveQuote(task);
      default: {
        const exhaustive: never = task;
        throw new Error(`Unsupported financial task kind: ${String((exhaustive as { kind: string }).kind)}`);
      }
    }
  }

  private async solveSwap(task: FinancialTaskSwap): Promise<FinancialTaskResult> {
    const tx = await this.client.swap.quoteAndExecute({
      from_asset: task.from_asset,
      to_asset: task.to_asset,
      amount: task.amount,
      recipient_address: task.recipient_address,
      ...(task.refund_address !== undefined ? { refund_address: task.refund_address } : {}),
      idempotency_key: task.idempotency_key ?? randomKey(),
    });

    return {
      kind: 'swap',
      executed: true,
      swap: tx,
      tracking_url: tx.webhook_url ?? null,
      next_action: `Send ${task.amount} ${task.from_asset} to ${tx.deposit_address}, then poll ${tx.webhook_url ?? 'the tx endpoint'} until status is completed.`,
    };
  }

  private async solvePayment(task: FinancialTaskPayment): Promise<FinancialTaskResult> {
    const req: InvoiceCreateRequest = {
      asset: task.asset,
      amount: task.amount,
      idempotency_key: task.idempotency_key ?? randomKey(),
      ...(task.description !== undefined ? { description: task.description } : {}),
      ...(task.network !== undefined ? { network: task.network } : {}),
      ...(task.callback_url !== undefined ? { callback_url: task.callback_url } : {}),
    };
    const response = await this.client.payments.createInvoice(req);
    const invoice = response.invoice;

    return {
      kind: 'payment',
      executed: true,
      invoice,
      tracking_url: invoice.webhook_url ?? null,
      next_action: `Share ${invoice.payment_address} with the payer. Poll /v1/payments/invoice/${invoice.id} for status, or subscribe to the webhook at ${invoice.webhook_url}.`,
    };
  }

  private async solveQuote(task: FinancialTaskQuote): Promise<FinancialTaskResult> {
    const response = await this.client.swap.quote({
      from_asset: task.from_asset,
      to_asset: task.to_asset,
      amount: task.amount,
    });
    const best = response.quotes.find((q) => q.id === response.best_quote_id);
    if (!best) {
      throw new Error('Quote response missing best_quote_id entry');
    }

    return {
      kind: 'quote',
      executed: false,
      quote: {
        best_quote_id: best.id,
        to_amount: best.to_amount,
        rate: best.rate,
        provider: best.provider_name,
      },
      tracking_url: null,
      next_action: `Call solve { kind: 'swap' } with the same parameters to execute, or pass quote_id=${best.id} to POST /v1/swap/execute directly.`,
    };
  }
}

function randomKey(): string {
  // Use WebCrypto when available (Bun, modern Node); fall back to a
  // timestamp + random string so the plugin remains usable in constrained
  // runtimes. Callers should still pass their own idempotency_key in
  // production to get end-to-end dedup guarantees.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `fl-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
