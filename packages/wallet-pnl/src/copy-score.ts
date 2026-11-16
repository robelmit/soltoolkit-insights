/**
 * Scoring a wallet for copy-tradeability.
 *
 * Ranking wallets by profit is the obvious approach and it is wrong, because
 * the most profitable wallets are frequently the least copyable: their edge is
 * being first into tiny launches, and a copy that lands two seconds later is
 * buying their exit rather than their entry.
 *
 * So this scores three separate things, and keeps them separate:
 *
 *   **Track record** — did this wallet trade well? Weighted toward *risk
 *   discipline* rather than returns. Stop-loss discipline carries more weight
 *   than win rate, because a wallet that cuts losers is one whose bad trades
 *   you can survive copying, while a high win rate with unbounded losses is a
 *   martingale waiting to happen.
 *
 *   **Copy-tradeability** — can this record survive being copied? Penalises
 *   sub-$100k entries, tiny per-trade profits that fees would erase, and very
 *   high trade frequency, all of which are edges that do not transfer.
 *
 *   **Dev reputation** — is the profit real? A wallet trading tokens it
 *   deployed is marking its own homework, so its record is discounted heavily.
 *
 * The weights and the cost model are judgements, not measurements. They are
 * kept in named constants so a reader can see them and change them.
 */

import type { WalletPerformance } from './pnl';

export interface WalletRecord {
  /** Realised PnL over the window, USD. */
  readonly realisedPnlUsd: number;
  /** Proportion of closed trades in profit, 0-1. */
  readonly winRate: number;
  readonly tradeCount: number;
  /** Trades closed at a loss where the loss was bounded, 0-1. */
  readonly stopLossDiscipline?: number;
  /** Median entry market cap, USD. */
  readonly medianEntryMarketCapUsd?: number;
  /** Median profit per winning trade, USD. */
  readonly medianProfitUsd?: number;
  /** Trades per week. Very high frequency rarely survives copying. */
  readonly tradesPerWeek?: number;
  /** Proportion of volume in tokens this wallet deployed, 0-1. */
  readonly selfDealingRatio?: number;
  /** Delay from the wallet's fill to the moment a copier sees it, seconds. Assumed 2 when absent. */
  readonly observedLatencySeconds?: number;
}

export interface CopyScore {
  /** 0-100. What a leaderboard should sort on. */
  readonly score: number;
  readonly trackRecord: number;
  readonly copyability: number;
  readonly devReputation: number;
  /** Plain-language reasons, for display next to the number. */
  readonly notes: readonly string[];
  /** Estimated cost of copying this wallet, percent per trade. */
  readonly expectedDragPct: number;
  readonly tier: 'strong' | 'viable' | 'marginal' | 'avoid';
}

/**
 * Track-record weights.
 *
 * Note that win rate is the *smallest* component. A wallet can be right most
 * of the time and still ruin a copier if the losses are unbounded, so
 * discipline dominates.
 */
const TRACK_WEIGHTS = {
  stopLossDiscipline: 0.34,
  profitShare: 0.28,
  roi: 0.16,
  sampleSize: 0.12,
  winRate: 0.1,
} as const;

/** Maps a value onto 0-1 against a target, saturating at the target. */
function saturate(value: number | undefined, target: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / target);
}

/**
 * Expected drag from copying, percent per trade.
 *
 * Latency, slippage and fees all subtract from the copier's return. The
 * latency term is weighted by entry size: copying a wallet that enters at
 * $50k market cap costs far more than the same delay at $5M, because the copy
 * itself moves the price.
 */
export function expectedDragPct(record: WalletRecord): number {
  const latency = record.observedLatencySeconds ?? 2;
  const entryCap = record.medianEntryMarketCapUsd;

  const lowCapWeight =
    entryCap === undefined ? 0.5 : entryCap < 100_000 ? 1 : entryCap < 1_000_000 ? 0.5 : 0.1;

  const latencyDrift = latency * 1.5 * (0.3 + 0.7 * lowCapWeight);
  // Round-trip slippage and trading fees, which apply regardless of latency.
  const roundTripCost = 1.5;

  return latencyDrift + roundTripCost;
}

export function scoreWalletForCopying(record: WalletRecord): CopyScore {
  const notes: string[] = [];

  // --- Track record -------------------------------------------------------
  const discipline = record.stopLossDiscipline;
  if (discipline === undefined) {
    notes.push('No stop-loss discipline data; scored conservatively.');
  }

  const profitShare = record.realisedPnlUsd > 0 ? saturate(record.realisedPnlUsd, 100_000) : 0;
  const roi = record.realisedPnlUsd > 0 ? saturate(record.realisedPnlUsd / 10_000, 1) : 0;
  const sampleSize = saturate(record.tradeCount, 50);
  const winRate = Number.isFinite(record.winRate)
    ? Math.max(0, Math.min(1, record.winRate))
    : 0;

  const trackRecord =
    100 *
    (TRACK_WEIGHTS.stopLossDiscipline * (discipline ?? 0) +
      TRACK_WEIGHTS.profitShare * profitShare +
      TRACK_WEIGHTS.roi * roi +
      TRACK_WEIGHTS.sampleSize * sampleSize +
      TRACK_WEIGHTS.winRate * winRate);

  if (record.realisedPnlUsd <= 0) notes.push('Not profitable over the window.');
  if (record.tradeCount < 10) notes.push(`Only ${record.tradeCount} trades; sample is thin.`);

  // --- Copy-tradeability --------------------------------------------------
  let copyability = 100;

  if (record.medianEntryMarketCapUsd !== undefined && record.medianEntryMarketCapUsd < 100_000) {
    // The central insight: this is where the best raw returns live, and where
    // a copy is least likely to reproduce them.
    copyability -= 35;
    notes.push(
      `Enters around $${Math.round(record.medianEntryMarketCapUsd / 1_000)}k market cap; a copy lands after the move.`,
    );
  }

  if (record.medianProfitUsd !== undefined && record.medianProfitUsd < 80) {
    copyability -= 25;
    notes.push(`Median profit $${Math.round(record.medianProfitUsd)} per trade; fees erase most of it.`);
  }

  if (record.tradesPerWeek !== undefined && record.tradesPerWeek > 1_000) {
    copyability -= 30;
    notes.push(`${Math.round(record.tradesPerWeek)} trades a week is a speed edge, not a copyable one.`);
  }

  const drag = expectedDragPct(record);
  if (drag > 6) {
    copyability -= 20;
    notes.push(`Copying costs an estimated ${drag.toFixed(1)}% per trade.`);
  }

  copyability = Math.max(0, copyability);

  // --- Dev reputation ----------------------------------------------------
  const selfDealing = record.selfDealingRatio ?? 0;
  // A wallet trading its own deployments is not demonstrating skill, so the
  // discount is severe rather than proportional.
  const devReputation = selfDealing > 0 ? Math.max(0, 100 * (1 - selfDealing) * 0.45 + 55) : 100;
  if (selfDealing > 0.2) {
    notes.push(
      `${Math.round(selfDealing * 100)}% of volume is in self-deployed tokens; record discounted.`,
    );
  }

  // Track record and copyability are both necessary, so they are multiplied
  // rather than averaged: an excellent record that cannot be copied is not a
  // good copy target, and averaging would hide that.
  const combined = (trackRecord / 100) * (copyability / 100) * (devReputation / 100);
  const score = Math.round(Math.max(0, Math.min(100, combined * 100)));

  return {
    score,
    trackRecord: Math.round(trackRecord),
    copyability: Math.round(copyability),
    devReputation: Math.round(devReputation),
    notes,
    expectedDragPct: drag,
    tier: score >= 65 ? 'strong' : score >= 40 ? 'viable' : score >= 20 ? 'marginal' : 'avoid',
  };
}

export interface RecordOptions {
  /**
   * A losing position counts as bounded when it lost less than this share of
   * what was put in, 0-1. Default 0.5, the line between the two loss bands.
   */
  readonly boundedLossShare?: number;
}

/**
 * The part of a `WalletRecord` that a trade list can give.
 *
 * Reads the closed positions of the whole trade list, so compute the
 * performance without `since` for the period you mean. Entry market cap,
 * self-dealing and latency are not in a trade list and stay absent; add them
 * when you have them. A field with nothing to measure it from stays absent
 * too: no losing position means no evidence of discipline, not perfect
 * discipline.
 */
export function recordFromPerformance(performance: WalletPerformance, options: RecordOptions = {}): WalletRecord {
  const boundedLossShare = options.boundedLossShare ?? 0.5;
  const closed = performance.positions.filter((position) => position.amount === 0 && position.investedUsd > 0);
  const losers = closed.filter((position) => position.realizedPnlUsd < 0);
  const bounded = losers.filter((position) => -position.realizedPnlUsd < position.investedUsd * boundedLossShare);
  const profits = closed
    .filter((position) => position.realizedPnlUsd > 0)
    .map((position) => position.realizedPnlUsd)
    .sort((a, b) => a - b);

  const times = performance.positions.flatMap((position) => [position.firstBuyTs, position.lastTradeTs]).filter((ts): ts is number => ts !== null);
  const spanMs = times.length > 0 ? Math.max(...times) - Math.min(...times) : 0;
  const week = 7 * 24 * 60 * 60 * 1000;

  return {
    realisedPnlUsd: performance.realizedPnlUsd,
    winRate: performance.winRate,
    tradeCount: performance.tradeCount,
    ...(losers.length > 0 ? { stopLossDiscipline: bounded.length / losers.length } : {}),
    ...(profits.length > 0 ? { medianProfitUsd: median(profits) } : {}),
    ...(spanMs > 0 ? { tradesPerWeek: performance.tradeCount / (spanMs / week) } : {}),
  };
}

/** The middle of a sorted list; the mean of the middle two when the count is even. */
function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Ranks wallets for a leaderboard.
 *
 * Sorts on the composite rather than PnL, which is the whole point: the
 * highest-PnL wallet is often not the one worth copying.
 */
export function rankWalletsForCopying<T extends { readonly record: WalletRecord }>(
  wallets: readonly T[],
): readonly (T & { readonly copyScore: CopyScore })[] {
  return wallets
    .map((wallet) => ({ ...wallet, copyScore: scoreWalletForCopying(wallet.record) }))
    .sort((a, b) => b.copyScore.score - a.copyScore.score);
}
