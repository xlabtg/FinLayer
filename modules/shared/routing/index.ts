/**
 * modules/shared/routing
 * Smart provider selection for multi-provider quote aggregation.
 *
 * Scores each candidate quote by:
 *  - Net output (to_amount - network_fee - platform_fee), weighted heavily.
 *  - Estimated completion time (shorter = better).
 *  - Provider reliability (prior success rate, tracked in memory).
 *
 * The router returns a ranked list; the highest-scoring entry is the
 * recommended provider. Callers can override weights per request if they
 * care more about speed than rate (e.g. a stablecoin payment).
 */

import type { Numeric } from '@finlayer/types';
import { compareNumericStrings, subtractNumericStrings } from '@finlayer/utils';

export interface RoutingCandidate {
  providerName: string;
  /** Amount of to_asset the user receives before the platform fee. */
  toAmount: Numeric;
  /** Platform fee (FinLayer take) in the same currency as `toAmount`. */
  platformFee: Numeric;
  /** Network fee (blockchain gas) in the same currency as `toAmount`. */
  networkFee: Numeric;
  /** Estimated time to completion, in seconds. */
  estimatedDurationSeconds: number;
}

export interface RoutingWeights {
  /** Weight on the net output. Higher = rate matters more. Default 1.0. */
  rate: number;
  /** Weight on the expected duration. Higher = speed matters more. Default 0.1. */
  speed: number;
  /** Weight on provider reliability. Default 0.2. */
  reliability: number;
}

export const DEFAULT_WEIGHTS: RoutingWeights = {
  rate: 1.0,
  speed: 0.1,
  reliability: 0.2,
};

export interface RoutingResult<T extends RoutingCandidate> {
  /** Winning candidate, the one callers should execute. */
  best: T;
  /** All candidates ordered by score descending. */
  ranked: Array<T & { score: number; netOutput: string }>;
}

/**
 * ProviderReliabilityTracker — tracks success/failure ratios per provider
 * and exposes a reliability score in [0, 1]. Defaults to 1.0 until we have
 * observations, so new providers aren't penalized unfairly on the first call.
 *
 * The tracker lives in memory and is scoped to a single process. For a
 * multi-instance deployment, back it with Redis via the same interface.
 */
export class ProviderReliabilityTracker {
  private readonly stats = new Map<string, { success: number; failure: number }>();

  recordSuccess(provider: string): void {
    const s = this.stats.get(provider) ?? { success: 0, failure: 0 };
    s.success += 1;
    this.stats.set(provider, s);
  }

  recordFailure(provider: string): void {
    const s = this.stats.get(provider) ?? { success: 0, failure: 0 };
    s.failure += 1;
    this.stats.set(provider, s);
  }

  /**
   * Reliability in [0, 1]. Returns 1.0 when there are no observations so
   * fresh providers are given a fair chance.
   */
  score(provider: string): number {
    const s = this.stats.get(provider);
    if (!s || s.success + s.failure === 0) return 1;
    return s.success / (s.success + s.failure);
  }

  snapshot(): Record<string, { success: number; failure: number; score: number }> {
    const out: Record<string, { success: number; failure: number; score: number }> = {};
    for (const [name, s] of this.stats) {
      out[name] = { ...s, score: this.score(name) };
    }
    return out;
  }
}

/**
 * Compute the net amount the recipient effectively receives. Returns a
 * string so we keep the same decimal-precision discipline as the rest of
 * the codebase (all monetary values are strings to avoid float rounding).
 */
export function netOutput(candidate: RoutingCandidate): string {
  return subtractNumericStrings(
    subtractNumericStrings(candidate.toAmount, candidate.platformFee),
    candidate.networkFee
  );
}

function numericToFiniteNumber(value: string): number {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return compareNumericStrings(value, '0') < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

/**
 * Rank a set of candidate quotes.
 *
 * Scoring: `score = rate*netOutputNorm + reliability*reliabilityNorm - speed*durationNorm`
 *
 *   - `netOutputNorm` is the candidate's net output divided by the max net
 *     output in the set — always in [0, 1].
 *   - `durationNorm` is the candidate's duration divided by the max duration
 *     — also [0, 1]. We subtract it so longer completion times reduce score.
 *   - `reliabilityNorm` is directly the reliability score (already [0, 1]).
 *
 * Ties break by `toAmount`, then by reliability, then by provider name so the
 * ordering is deterministic across test runs.
 */
export function rankCandidates<T extends RoutingCandidate>(
  candidates: T[],
  reliability: ProviderReliabilityTracker,
  weights: RoutingWeights = DEFAULT_WEIGHTS
): RoutingResult<T> {
  if (candidates.length === 0) {
    throw new Error('rankCandidates requires at least one candidate');
  }

  const nets = candidates.map(netOutput);
  const maxNet = nets.reduce((max, net) => (
    compareNumericStrings(net, max) > 0 ? net : max
  ), '0.0000000001');
  const maxDuration = Math.max(...candidates.map(c => c.estimatedDurationSeconds), 1);

  const scored = candidates.map((c, i) => {
    const netStr = nets[i] ?? '0';
    const netNorm = numericToFiniteNumber(netStr) / numericToFiniteNumber(maxNet);
    const durationNorm = c.estimatedDurationSeconds / maxDuration;
    const relScore = reliability.score(c.providerName);

    const score =
      weights.rate * netNorm +
      weights.reliability * relScore -
      weights.speed * durationNorm;

    return { ...c, score, netOutput: netStr };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const amountOrder = compareNumericStrings(b.toAmount, a.toAmount);
    if (amountOrder !== 0) return amountOrder;
    const relA = reliability.score(a.providerName);
    const relB = reliability.score(b.providerName);
    if (relB !== relA) return relB - relA;
    return a.providerName.localeCompare(b.providerName);
  });

  return { best: scored[0]!, ranked: scored };
}
