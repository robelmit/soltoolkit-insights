/**
 * Copy-score tests.
 *
 * The thesis being tested is that PnL is the wrong sort key. Several of these
 * assert that a wallet with excellent returns scores *below* a steadier one,
 * which is the behaviour a naive implementation gets backwards.
 */

import { describe, expect, it } from 'vitest';
import {
  expectedDragPct,
  rankWalletsForCopying,
  recordFromPerformance,
  scoreWalletForCopying,
  type WalletRecord,
} from '../src/copy-score';
import { computeWalletPerformance, type WalletTrade } from '../src/pnl';

const DAY = 24 * 60 * 60 * 1000;

/** One closed position: bought for `cost`, sold for `proceeds` a minute later. */
function roundTrip(token: string, day: number, cost: number, proceeds: number): WalletTrade[] {
  return [
    { ts: day * DAY, token, side: 'buy', amount: 100, valueUsd: cost },
    { ts: day * DAY + 60_000, token, side: 'sell', amount: 100, valueUsd: proceeds },
  ];
}

describe('recordFromPerformance', () => {
  it('reads discipline, median profit and pace from the closed positions', () => {
    const trades = [
      ...roundTrip('win-small', 0, 100, 150), // +50
      ...roundTrip('win-mid', 1, 100, 300), // +200
      ...roundTrip('win-big', 2, 100, 1_000), // +900
      ...roundTrip('cut-early', 3, 100, 80), // -20, bounded
      ...roundTrip('rode-down', 14, 100, 10), // -90, not bounded
    ];
    const record = recordFromPerformance(computeWalletPerformance(trades));
    expect(record.realisedPnlUsd).toBeCloseTo(1_040);
    expect(record.winRate).toBeCloseTo(0.6);
    expect(record.tradeCount).toBe(10);
    expect(record.stopLossDiscipline).toBeCloseTo(0.5);
    expect(record.medianProfitUsd).toBeCloseTo(200);
    // Ten trades over fourteen days and a minute: five a week.
    expect(record.tradesPerWeek).toBeCloseTo(5, 2);
    // Not in a trade list, so not invented.
    expect(record).not.toHaveProperty('medianEntryMarketCapUsd');
    expect(record).not.toHaveProperty('selfDealingRatio');
    expect(record).not.toHaveProperty('observedLatencySeconds');
  });

  it('takes the mean of the middle two profits when the count is even', () => {
    const trades = [...roundTrip('a', 0, 100, 110), ...roundTrip('b', 1, 100, 130)];
    expect(recordFromPerformance(computeWalletPerformance(trades)).medianProfitUsd).toBeCloseTo(20);
  });

  it('moves the bounded-loss line when asked', () => {
    const trades = [...roundTrip('cut-early', 0, 100, 80), ...roundTrip('rode-down', 1, 100, 10)];
    const performance = computeWalletPerformance(trades);
    expect(recordFromPerformance(performance, { boundedLossShare: 0.1 }).stopLossDiscipline).toBe(0);
    expect(recordFromPerformance(performance, { boundedLossShare: 0.95 }).stopLossDiscipline).toBe(1);
  });

  it('leaves out what it has no evidence for', () => {
    // No losing position: discipline is unknown, not perfect.
    const winner = recordFromPerformance(computeWalletPerformance(roundTrip('a', 0, 100, 150)));
    expect(winner).not.toHaveProperty('stopLossDiscipline');
    expect(scoreWalletForCopying(winner).notes).toContain('No stop-loss discipline data; scored conservatively.');

    // No winning position: no median profit. Open positions do not count either way.
    const open = recordFromPerformance(computeWalletPerformance([{ ts: 0, token: 'held', side: 'buy', amount: 1, valueUsd: 50 }]));
    expect(open).toEqual({ realisedPnlUsd: 0, winRate: 0, tradeCount: 1 });

    expect(recordFromPerformance(computeWalletPerformance([]))).toEqual({ realisedPnlUsd: 0, winRate: 0, tradeCount: 0 });
  });
});

/** Profitable, disciplined, enters at sizes a copy can follow. */
const solid: WalletRecord = {
  realisedPnlUsd: 80_000,
  winRate: 0.55,
  tradeCount: 60,
  stopLossDiscipline: 0.8,
  medianEntryMarketCapUsd: 2_000_000,
  medianProfitUsd: 1_200,
  tradesPerWeek: 40,
  selfDealingRatio: 0,
  observedLatencySeconds: 1.5,
};

describe('scoreWalletForCopying', () => {
  it('scores a disciplined, copyable wallet well', () => {
    const score = scoreWalletForCopying(solid);
    expect(score.score).toBeGreaterThan(30);
    expect(score.tier).not.toBe('avoid');
  });

  it('keeps the three components separate', () => {
    const score = scoreWalletForCopying(solid);
    expect(score.trackRecord).toBeGreaterThan(0);
    expect(score.copyability).toBeGreaterThan(0);
    expect(score.devReputation).toBe(100);
  });

  it('weights stop-loss discipline above win rate', () => {
    // A wallet that cuts losers is survivable to copy; a high win rate with
    // unbounded losses is a martingale.
    const disciplined = scoreWalletForCopying({
      ...solid,
      stopLossDiscipline: 0.9,
      winRate: 0.3,
    });
    const luckyButLoose = scoreWalletForCopying({
      ...solid,
      stopLossDiscipline: 0.1,
      winRate: 0.9,
    });
    expect(disciplined.score).toBeGreaterThan(luckyButLoose.score);
  });

  it('scores a missing discipline figure conservatively rather than generously', () => {
    const unknown = scoreWalletForCopying({ ...solid, stopLossDiscipline: undefined });
    const known = scoreWalletForCopying({ ...solid, stopLossDiscipline: 0.8 });
    expect(unknown.score).toBeLessThan(known.score);
    expect(unknown.notes.join(' ')).toContain('No stop-loss discipline data');
  });

  describe('the central case: high PnL that does not survive copying', () => {
    it('ranks a micro-cap sniper below a steadier wallet', () => {
      // The most profitable wallets are often the least copyable, because
      // their edge is being first into tiny launches.
      const sniperRecord = {
        ...solid,
        realisedPnlUsd: 500_000,
        medianEntryMarketCapUsd: 40_000,
        observedLatencySeconds: 3,
      };
      const sniper = scoreWalletForCopying(sniperRecord);
      const steady = scoreWalletForCopying(solid);

      // Six times the profit, and still the worse wallet to copy.
      expect(sniperRecord.realisedPnlUsd).toBeGreaterThan(solid.realisedPnlUsd);
      expect(sniper.score).toBeLessThan(steady.score);
      expect(sniper.notes.join(' ')).toContain('a copy lands after the move');
    });

    it('penalises profits too small to survive fees', () => {
      const thin = scoreWalletForCopying({ ...solid, medianProfitUsd: 20 });
      expect(thin.copyability).toBeLessThan(scoreWalletForCopying(solid).copyability);
      expect(thin.notes.join(' ')).toContain('fees erase most of it');
    });

    it('penalises a speed edge that cannot transfer', () => {
      const hft = scoreWalletForCopying({ ...solid, tradesPerWeek: 5_000 });
      expect(hft.notes.join(' ')).toContain('not a copyable one');
      expect(hft.copyability).toBeLessThan(100);
    });
  });

  describe('dev reputation', () => {
    it('discounts a wallet trading its own deployments', () => {
      // Marking its own homework: the profit is real but the skill is not
      // demonstrated.
      const selfDealer = scoreWalletForCopying({ ...solid, selfDealingRatio: 0.8 });
      expect(selfDealer.devReputation).toBeLessThan(100);
      expect(selfDealer.score).toBeLessThan(scoreWalletForCopying(solid).score);
      expect(selfDealer.notes.join(' ')).toContain('self-deployed');
    });

    it('leaves a clean wallet undiscounted', () => {
      expect(scoreWalletForCopying({ ...solid, selfDealingRatio: 0 }).devReputation).toBe(100);
    });
  });

  describe('profitability', () => {
    it('scores an unprofitable wallet poorly and says so', () => {
      const loser = scoreWalletForCopying({ ...solid, realisedPnlUsd: -20_000 });
      expect(loser.score).toBeLessThan(scoreWalletForCopying(solid).score);
      expect(loser.notes.join(' ')).toContain('Not profitable');
    });

    it('flags a thin sample', () => {
      const thin = scoreWalletForCopying({ ...solid, tradeCount: 4 });
      expect(thin.notes.join(' ')).toContain('sample is thin');
    });
  });

  it('multiplies rather than averages the components', () => {
    // An excellent record that cannot be copied is not a good copy target.
    // Averaging would let a strong track record hide zero copyability.
    const uncopyable = scoreWalletForCopying({
      ...solid,
      medianEntryMarketCapUsd: 30_000,
      medianProfitUsd: 10,
      tradesPerWeek: 5_000,
      observedLatencySeconds: 5,
    });
    expect(uncopyable.trackRecord).toBeGreaterThan(20);
    expect(uncopyable.score).toBeLessThan(20);
  });

  it('never returns a score outside 0-100', () => {
    const extremes: WalletRecord[] = [
      { realisedPnlUsd: 1e12, winRate: 1, tradeCount: 1e6, stopLossDiscipline: 1 },
      { realisedPnlUsd: -1e12, winRate: 0, tradeCount: 0 },
      { realisedPnlUsd: Number.NaN, winRate: Number.NaN, tradeCount: 0 },
    ];
    for (const record of extremes) {
      const score = scoreWalletForCopying(record);
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('expectedDragPct', () => {
  it('costs more on a low entry market cap', () => {
    const low = expectedDragPct({ ...solid, medianEntryMarketCapUsd: 50_000 });
    const high = expectedDragPct({ ...solid, medianEntryMarketCapUsd: 10_000_000 });
    expect(low).toBeGreaterThan(high);
  });

  it('grows with observed latency', () => {
    const fast = expectedDragPct({ ...solid, observedLatencySeconds: 0.5 });
    const slow = expectedDragPct({ ...solid, observedLatencySeconds: 5 });
    expect(slow).toBeGreaterThan(fast);
  });

  it('always includes round-trip cost, even at zero latency', () => {
    // Fees and slippage do not vanish just because the copy was instant.
    expect(expectedDragPct({ ...solid, observedLatencySeconds: 0 })).toBeGreaterThan(1);
  });
});

describe('rankWalletsForCopying', () => {
  it('sorts on copy score rather than PnL', () => {
    // The whole point of the module, stated as a test.
    const wallets = [
      {
        address: 'micro-sniper',
        record: { ...solid, realisedPnlUsd: 900_000, medianEntryMarketCapUsd: 30_000, medianProfitUsd: 15 },
      },
      { address: 'steady', record: solid },
    ];
    const ranked = rankWalletsForCopying(wallets);
    expect(ranked[0]!.address).toBe('steady');
    // Confirms the sniper really did have far more profit.
    expect(wallets[0]!.record.realisedPnlUsd).toBeGreaterThan(
      wallets[1]!.record.realisedPnlUsd,
    );
  });

  it('attaches the score to each wallet', () => {
    const ranked = rankWalletsForCopying([{ address: 'a', record: solid }]);
    expect(ranked[0]!.copyScore.tier).toBeDefined();
  });

  it('handles an empty list', () => {
    expect(rankWalletsForCopying([])).toEqual([]);
  });
});
