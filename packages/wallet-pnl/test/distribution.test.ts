/**
 * Outcome distribution.
 *
 * Band boundaries are where a distribution goes quietly wrong: a position that
 * lands in two bands double-counts, and one that lands in none disappears. Both
 * produce a bar that still looks plausible, so the boundaries are tested
 * exhaustively rather than sampled.
 */

import { describe, expect, it } from 'vitest';
import {
  computePnlDistribution,
  computeWalletPerformance,
  extremePositions,
  PNL_BANDS,
  type WalletTrade,
} from '../src/pnl';

/** A closed round trip: buy `invested`, sell for `proceeds`. */
const roundTrip = (token: string, invested: number, proceeds: number): WalletTrade[] => [
  { ts: 1_000, token, side: 'buy', amount: 100, valueUsd: invested },
  { ts: 2_000, token, side: 'sell', amount: 100, valueUsd: proceeds },
];

const distributionOf = (trades: WalletTrade[]) =>
  computePnlDistribution(computeWalletPerformance(trades));

const countIn = (trades: WalletTrade[], id: string) =>
  distributionOf(trades).bands.find((band) => band.id === id)?.count ?? 0;

describe('computePnlDistribution', () => {
  it('reports every band even when empty', () => {
    const distribution = distributionOf([]);

    expect(distribution.bands).toHaveLength(PNL_BANDS.length);
    expect(distribution.total).toBe(0);
    expect(distribution.bands.every((band) => band.count === 0)).toBe(true);
  });

  it('places a 10x in the top band', () => {
    // 100 in, 1000 out = +900%.
    expect(countIn(roundTrip('A', 100, 1_000), 'moon')).toBe(1);
  });

  it('places a 3x in the 200-500% band', () => {
    // 100 in, 300 out = +200%.
    expect(countIn(roundTrip('A', 100, 300), 'strong')).toBe(1);
  });

  it('places a small gain in the 0-200% band', () => {
    expect(countIn(roundTrip('A', 100, 150), 'up')).toBe(1);
  });

  it('places a small loss in the 0 to -50% band', () => {
    expect(countIn(roundTrip('A', 100, 70), 'down')).toBe(1);
  });

  it('places a heavy loss in the bottom band', () => {
    expect(countIn(roundTrip('A', 100, 20), 'rekt')).toBe(1);
  });

  /**
   * The band is labelled `< -50%`, so exactly -50% belongs above it. Getting
   * this backwards would put every position that halved into the worst band
   * and overstate how badly the wallet does.
   */
  it('reads exactly -50% as the shallower band, matching the label', () => {
    expect(countIn(roundTrip('A', 100, 50), 'down')).toBe(1);
    expect(countIn(roundTrip('A', 100, 50), 'rekt')).toBe(0);
  });

  it('counts a total loss as the bottom band', () => {
    expect(countIn(roundTrip('A', 100, 0), 'rekt')).toBe(1);
  });

  /**
   * Break-even is not a loss. Putting it in the loss column would misreport
   * every scratched trade, which is a real and deliberate outcome.
   */
  it('counts break-even as a win band', () => {
    const distribution = distributionOf(roundTrip('A', 100, 100));

    expect(countIn(roundTrip('A', 100, 100), 'up')).toBe(1);
    expect(distribution.winCount).toBe(1);
    expect(distribution.lossCount).toBe(0);
    // The headline win count follows the same rule.
    const performance = computeWalletPerformance(roundTrip('A', 100, 100));
    expect(performance.winCount).toBe(1);
    expect(performance.lossCount).toBe(0);
  });

  /**
   * Found on a mainnet wallet: tokens sold that were bought before the trades
   * read. Their proceeds are not a return on what was bought later, so the
   * position's band and multiple come from realized PnL, and the bands agree
   * with the win and loss counts.
   */
  it('does not count a sale with no recorded buy as a gain', () => {
    const trades: WalletTrade[] = [
      { ts: 1_000, token: 'A', side: 'sell', amount: 100, valueUsd: 50 }, // bought before the list starts
      { ts: 2_000, token: 'A', side: 'buy', amount: 50, valueUsd: 20 },
      { ts: 3_000, token: 'A', side: 'sell', amount: 50, valueUsd: 10 }, // half lost
    ];
    const performance = computeWalletPerformance(trades);
    const distribution = computePnlDistribution(performance);

    expect(performance.realizedPnlUsd).toBeCloseTo(-10);
    expect(performance.lossCount).toBe(1);
    expect(performance.winCount).toBe(0);
    expect(distribution.lossCount).toBe(1);
    expect(distribution.winCount).toBe(0);
    expect(distribution.bands.find((band) => band.id === 'down')?.count).toBe(1);
    expect(performance.worstMultiple).toBeCloseTo(0.5);
    expect(performance.bestMultiple).toBeCloseTo(0.5);
  });

  it('does not turn a sale of more than was bought into a win', () => {
    // 100 bought for $100, 900 sold for $900: the 100 broke even, the other 800 were never bought here.
    const trades: WalletTrade[] = [
      { ts: 1_000, token: 'A', side: 'buy', amount: 100, valueUsd: 100 },
      { ts: 2_000, token: 'A', side: 'sell', amount: 900, valueUsd: 900 },
    ];
    const performance = computeWalletPerformance(trades);
    expect(countIn(trades, 'up')).toBe(1);
    expect(countIn(trades, 'moon')).toBe(0);
    expect(performance.bestMultiple).toBeCloseTo(1);
  });

  /**
   * Every position must land in exactly one band. A boundary that is inclusive
   * on both sides double-counts; one inclusive on neither loses the position
   * silently.
   */
  it('assigns each boundary value to exactly one band', () => {
    const boundaries: [number, string][] = [
      [600, 'moon'], // +500% exactly → the >500% band
      [300, 'strong'], // +200% exactly
      [100, 'up'], // 0% exactly
      [50, 'down'], // -50% exactly → above the `< -50%` band, per its label
    ];

    for (const [proceeds, expectedBand] of boundaries) {
      const distribution = distributionOf(roundTrip('A', 100, proceeds));
      const hits = distribution.bands.filter((band) => band.count > 0);

      expect(hits).toHaveLength(1);
      expect(hits[0]?.id).toBe(expectedBand);
    }
  });

  it('shares sum to one across all bands', () => {
    const trades = [
      ...roundTrip('A', 100, 1_000),
      ...roundTrip('B', 100, 300),
      ...roundTrip('C', 100, 150),
      ...roundTrip('D', 100, 70),
      ...roundTrip('E', 100, 10),
    ];

    const distribution = distributionOf(trades);
    const total = distribution.bands.reduce((sum, band) => sum + band.share, 0);

    expect(distribution.total).toBe(5);
    expect(total).toBeCloseTo(1, 10);
  });

  /**
   * The finding that makes this widget worth building: a wallet can have a high
   * win rate and still be dominated by small losses, and only the distribution
   * shows it.
   */
  it('separates a high win rate from a loss-heavy distribution', () => {
    const trades = [
      ...roundTrip('WIN', 10, 400), // one large win
      ...Array.from({ length: 9 }, (_, i) => roundTrip(`L${i}`, 100, 80)).flat(),
    ];

    const performance = computeWalletPerformance(trades);
    const distribution = computePnlDistribution(performance);

    // Profitable overall, but nine of ten trades were losses.
    expect(performance.realizedPnlUsd).toBeGreaterThan(0);
    expect(distribution.bands.find((b) => b.id === 'down')?.count).toBe(9);
    expect(distribution.bands.find((b) => b.id === 'down')?.share).toBeCloseTo(0.9, 10);
  });

  /**
   * An unrealised gain must not count. Otherwise a portfolio looks better
   * simply for refusing to sell.
   */
  it('excludes open positions', () => {
    const trades: WalletTrade[] = [
      { ts: 1_000, token: 'OPEN', side: 'buy', amount: 100, valueUsd: 100 },
      ...roundTrip('CLOSED', 100, 200),
    ];

    expect(distributionOf(trades).total).toBe(1);
  });

  it('excludes a partially closed position', () => {
    const trades: WalletTrade[] = [
      { ts: 1_000, token: 'A', side: 'buy', amount: 100, valueUsd: 100 },
      { ts: 2_000, token: 'A', side: 'sell', amount: 40, valueUsd: 80 },
    ];

    expect(distributionOf(trades).total).toBe(0);
  });

  it('counts wins and losses across bands', () => {
    const trades = [
      ...roundTrip('A', 100, 1_000),
      ...roundTrip('B', 100, 150),
      ...roundTrip('C', 100, 70),
    ];

    const distribution = distributionOf(trades);

    expect(distribution.winCount).toBe(2);
    expect(distribution.lossCount).toBe(1);
  });
});

describe('extremePositions', () => {
  it('returns nulls with no closed positions', () => {
    expect(extremePositions({ positions: [] })).toEqual({ best: null, worst: null });
  });

  /** The token is the point: a name is memorable where a number is not. */
  it('names the best and worst tokens', () => {
    const trades = [
      ...roundTrip('MYLO', 100, 7_700),
      ...roundTrip('MID', 100, 120),
      ...roundTrip('PNUT', 4_000, 200),
    ];

    const { best, worst } = extremePositions(computeWalletPerformance(trades));

    expect(best?.token).toBe('MYLO');
    expect(worst?.token).toBe('PNUT');
  });

  it('ranks by realised PnL rather than by multiple', () => {
    const trades = [
      // A 10x on a tiny position: the best multiple, but not the best result.
      ...roundTrip('SMALL', 1, 10),
      // A 2x on a large one: less impressive, more money.
      ...roundTrip('LARGE', 1_000, 2_000),
    ];

    expect(extremePositions(computeWalletPerformance(trades)).best?.token).toBe('LARGE');
  });

  it('ignores open positions', () => {
    const trades: WalletTrade[] = [
      { ts: 1_000, token: 'OPEN', side: 'buy', amount: 100, valueUsd: 100_000 },
      ...roundTrip('CLOSED', 100, 200),
    ];

    expect(extremePositions(computeWalletPerformance(trades)).best?.token).toBe('CLOSED');
  });
});
