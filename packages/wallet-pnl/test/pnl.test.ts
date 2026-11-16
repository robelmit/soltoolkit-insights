import { describe, expect, it } from 'vitest';
import { computeSmartScore, computeWalletPerformance, type WalletTrade } from '../src/pnl';

describe('wallet PnL', () => {
  const trade = (overrides: Partial<WalletTrade>): WalletTrade => ({
    ts: 1_000,
    token: 'TOK',
    side: 'buy',
    amount: 100,
    valueUsd: 100,
    ...overrides,
  });

  it("counts only the window's trades while the cost basis comes from before it", () => {
    const trades = [
      trade({ ts: 1_000, token: 'A', side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 2_000, token: 'A', side: 'sell', amount: 100, valueUsd: 300 }),
      trade({ ts: 3_000, token: 'B', side: 'buy', amount: 10, valueUsd: 50 }),
      trade({ ts: 9_000, token: 'B', side: 'sell', amount: 10, valueUsd: 20 }),
      trade({ ts: 9_500, token: 'C', side: 'buy', amount: 1, valueUsd: 10 }),
    ];
    const lifetime = computeWalletPerformance(trades);
    expect(lifetime).toMatchObject({ realizedPnlUsd: 170, tradeCount: 5, winCount: 1, lossCount: 1, totalVolumeUsd: 480 });
    // From 8_000: B's sale keeps the $50 cost of the buy at 3_000; A's round trip and C's open buy are outside or open.
    const window = computeWalletPerformance(trades, { since: 8_000 });
    expect(window).toMatchObject({ realizedPnlUsd: -30, tradeCount: 2, winCount: 0, lossCount: 1, totalVolumeUsd: 30, winRate: 0 });
    expect(window.positions).toHaveLength(3);
    // A window with no closes has no win rate and no realized figure.
    expect(computeWalletPerformance(trades, { since: 9_200 })).toMatchObject({ realizedPnlUsd: 0, tradeCount: 1, winCount: 0, lossCount: 0, totalVolumeUsd: 10 });
    // A window that starts before everything equals the lifetime figures.
    expect(computeWalletPerformance(trades, { since: 0 })).toEqual(lifetime);
  });

  it('computes a simple profitable round trip', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 2_000, side: 'sell', amount: 100, valueUsd: 300 }),
    ]);

    expect(result.realizedPnlUsd).toBeCloseTo(200, 6);
    expect(result.winRate).toBe(1);
    expect(result.tradeCount).toBe(2);
    expect(result.positions[0]?.amount).toBe(0);
  });

  it('computes a loss', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: 100, valueUsd: 1_000 }),
      trade({ ts: 2_000, side: 'sell', amount: 100, valueUsd: 250 }),
    ]);

    expect(result.realizedPnlUsd).toBeCloseTo(-750, 6);
    expect(result.winRate).toBe(0);
    expect(result.lossCount).toBe(1);
  });

  it('uses weighted-average cost across several buys', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: 100, valueUsd: 100 }), // $1.00 each
      trade({ ts: 2_000, side: 'buy', amount: 100, valueUsd: 300 }), // $3.00 each
      // Average cost is $2.00; selling half at $5.00 realizes $300.
      trade({ ts: 3_000, side: 'sell', amount: 100, valueUsd: 500 }),
    ]);

    expect(result.realizedPnlUsd).toBeCloseTo(300, 6);
    expect(result.positions[0]?.amount).toBe(100);
    expect(result.positions[0]?.avgCostUsd).toBeCloseTo(2, 6);
  });

  it('handles a partial exit and keeps the remainder open', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: 1_000, valueUsd: 1_000 }),
      trade({ ts: 2_000, side: 'sell', amount: 400, valueUsd: 800 }),
    ]);

    const position = result.positions[0]!;
    expect(position.amount).toBe(600);
    expect(position.realizedPnlUsd).toBeCloseTo(400, 6);
    // Still open, so it does not count toward the win rate yet.
    expect(result.winRate).toBe(0);
  });

  it('does not treat an unmatched sell as pure profit', () => {
    // An airdropped or transferred-in token has no recorded cost. Counting the
    // whole proceeds as profit would wildly overstate the wallet.
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'sell', amount: 500, valueUsd: 5_000 }),
    ]);

    expect(result.realizedPnlUsd).toBe(0);
    expect(result.positions[0]?.amount).toBe(0);
  });

  it('never lets a position go negative', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 2_000, side: 'sell', amount: 900, valueUsd: 900 }),
    ]);

    expect(result.positions[0]?.amount).toBe(0);
    expect(result.positions[0]!.amount).toBeGreaterThanOrEqual(0);
  });

  it('measures hold time from first buy to full exit', () => {
    const result = computeWalletPerformance([
      trade({ ts: 0, side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 3_600_000, side: 'sell', amount: 100, valueUsd: 200 }),
    ]);

    expect(result.positions[0]?.holdSeconds).toBe(3_600);
    expect(result.avgHoldSeconds).toBe(3_600);
  });

  it('processes trades in timestamp order regardless of input order', () => {
    const chronological = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 2_000, side: 'sell', amount: 100, valueUsd: 300 }),
    ]);
    const shuffled = computeWalletPerformance([
      trade({ ts: 2_000, side: 'sell', amount: 100, valueUsd: 300 }),
      trade({ ts: 1_000, side: 'buy', amount: 100, valueUsd: 100 }),
    ]);

    expect(shuffled.realizedPnlUsd).toBeCloseTo(chronological.realizedPnlUsd, 6);
  });

  it('tracks several tokens independently', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, token: 'A', side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 1_100, token: 'B', side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 2_000, token: 'A', side: 'sell', amount: 100, valueUsd: 500 }),
      trade({ ts: 2_100, token: 'B', side: 'sell', amount: 100, valueUsd: 50 }),
    ]);

    expect(result.realizedPnlUsd).toBeCloseTo(350, 6);
    expect(result.winCount).toBe(1);
    expect(result.lossCount).toBe(1);
    expect(result.winRate).toBeCloseTo(0.5, 6);
  });

  it('clears dust so a rounding residue does not distort the next entry', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: 1, valueUsd: 100 }),
      trade({ ts: 2_000, side: 'sell', amount: 0.9999999999, valueUsd: 200 }),
    ]);

    expect(result.positions[0]?.amount).toBe(0);
    expect(result.positions[0]?.avgCostUsd).toBe(0);
  });

  it('ignores malformed trades rather than producing NaN', () => {
    const result = computeWalletPerformance([
      trade({ ts: 1_000, side: 'buy', amount: Number.NaN, valueUsd: 100 }),
      trade({ ts: 1_500, side: 'buy', amount: -5, valueUsd: 100 }),
      trade({ ts: 2_000, side: 'buy', amount: 100, valueUsd: 100 }),
      trade({ ts: 3_000, side: 'sell', amount: 100, valueUsd: 150 }),
    ]);

    expect(Number.isFinite(result.realizedPnlUsd)).toBe(true);
    expect(result.realizedPnlUsd).toBeCloseTo(50, 6);
  });

  it('returns zeroes for an empty history', () => {
    const result = computeWalletPerformance([]);
    expect(result.realizedPnlUsd).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.positions).toEqual([]);
  });
});

describe('smart score', () => {
  const roundTrip = (token: string, cost: number, proceeds: number, ts = 1_000): WalletTrade[] => [
    { ts, token, side: 'buy', amount: 100, valueUsd: cost },
    { ts: ts + 1_000, token, side: 'sell', amount: 100, valueUsd: proceeds },
  ];

  it('scores a wallet with no closed positions at zero', () => {
    const performance = computeWalletPerformance([
      { ts: 1_000, token: 'A', side: 'buy', amount: 100, valueUsd: 100 },
    ]);
    expect(computeSmartScore(performance)).toBe(0);
  });

  it('ranks a consistent winner above a one-hit wonder', () => {
    // Twenty modest wins.
    const consistent = computeWalletPerformance(
      Array.from({ length: 20 }, (_, i) => roundTrip(`T${i}`, 1_000, 1_800, i * 10_000)).flat(),
    );

    // One enormous win and nineteen losses, for similar total profit.
    const lucky = computeWalletPerformance([
      ...roundTrip('MOON', 1_000, 17_000, 0),
      ...Array.from({ length: 19 }, (_, i) => roundTrip(`L${i}`, 1_000, 900, (i + 1) * 10_000)).flat(),
    ]);

    // Raw PnL ranks these similarly; only the first is worth copying.
    expect(computeSmartScore(consistent)).toBeGreaterThan(computeSmartScore(lucky));
  });

  it('does not reward a perfect record over a tiny sample', () => {
    const twoTrades = computeWalletPerformance([
      ...roundTrip('A', 100, 200, 0),
      ...roundTrip('B', 100, 200, 10_000),
    ]);
    const manyTrades = computeWalletPerformance(
      Array.from({ length: 40 }, (_, i) => roundTrip(`T${i}`, 100, 200, i * 10_000)).flat(),
    );

    // Both are 100% winners; only one has evidence behind it.
    expect(computeSmartScore(manyTrades)).toBeGreaterThan(computeSmartScore(twoTrades));
  });

  it('gives a losing wallet a low score', () => {
    const loser = computeWalletPerformance(
      Array.from({ length: 10 }, (_, i) => roundTrip(`T${i}`, 1_000, 300, i * 10_000)).flat(),
    );
    expect(computeSmartScore(loser)).toBeLessThan(30);
  });

  it('always returns a score within 0-100', () => {
    const extreme = computeWalletPerformance(
      Array.from({ length: 100 }, (_, i) => roundTrip(`T${i}`, 1, 1_000_000, i * 1_000)).flat(),
    );
    const score = computeSmartScore(extreme);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
