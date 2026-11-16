/**
 * Wallet PnL and smart-money scoring.
 *
 * Realized PnL uses weighted-average cost basis rather than FIFO. Both are
 * defensible; average cost is chosen because it is what a trader sees in every
 * exchange UI, and because FIFO would report a different number than the
 * holdings view for the same position, a discrepancy that reads as a bug.
 *
 * Everything here is a pure function over a trade list so it can be tested
 * exhaustively and recomputed deterministically from the event stream.
 */

export interface WalletTrade {
  readonly ts: number;
  readonly token: string;
  readonly side: 'buy' | 'sell';
  /** Token quantity, already decimal-adjusted. */
  readonly amount: number;
  /** USD value of the whole trade. */
  readonly valueUsd: number;
}

export interface TokenPosition {
  readonly token: string;
  /** Quantity still held. */
  readonly amount: number;
  readonly avgCostUsd: number;
  /** Proceeds less the average cost of what was sold. A sale with no recorded buy adds nothing here. */
  readonly realizedPnlUsd: number;
  /** Everything paid in buys. */
  readonly investedUsd: number;
  /** Everything received in sales, sales with no recorded buy included; so not a measure of return. */
  readonly proceedsUsd: number;
  readonly firstBuyTs: number | null;
  readonly lastTradeTs: number | null;
  /** Seconds between first buy and full exit; null while still open. */
  readonly holdSeconds: number | null;
}

export interface WalletPerformance {
  readonly realizedPnlUsd: number;
  readonly totalVolumeUsd: number;
  readonly tradeCount: number;
  /** Positions closed without a loss, over positions closed at all. Break-even is not a loss. */
  readonly winRate: number;
  readonly winCount: number;
  readonly lossCount: number;
  readonly avgHoldSeconds: number;
  /** The best and worst closed position as a multiple of what was put in: 2 doubled it, 0 lost it all. */
  readonly bestMultiple: number;
  readonly worstMultiple: number;
  readonly positions: readonly TokenPosition[];
}

/** Below this quantity a position is treated as closed, not dust. */
const DUST_THRESHOLD = 1e-9;

export interface PerformanceOptions {
  /**
   * Count only trades at or after this time (ms). Earlier trades still build
   * the positions, so a sale inside the window keeps the cost of the buy that
   * came before it; volume, trade count, realized PnL, wins and losses are
   * the window's own (for a 1-day, 7-day or 30-day view).
   */
  readonly since?: number;
}

export function computeWalletPerformance(trades: readonly WalletTrade[], options: PerformanceOptions = {}): WalletPerformance {
  const ordered = [...trades].sort((a, b) => a.ts - b.ts);
  const positions = new Map<string, MutablePosition>();
  const since = options.since;
  const counts = (ts: number): boolean => since === undefined || ts >= since;

  let totalVolumeUsd = 0;
  let tradeCount = 0;

  for (const trade of ordered) {
    if (!Number.isFinite(trade.amount) || !Number.isFinite(trade.valueUsd)) continue;
    if (trade.amount <= 0) continue;

    const counted = counts(trade.ts);
    if (counted) {
      totalVolumeUsd += trade.valueUsd;
      tradeCount += 1;
    }

    const position = positions.get(trade.token) ?? newPosition(trade.token);
    positions.set(trade.token, position);
    position.lastTradeTs = trade.ts;

    if (trade.side === 'buy') {
      position.firstBuyTs ??= trade.ts;
      position.amount += trade.amount;
      position.costBasisUsd += trade.valueUsd;
      position.investedUsd += trade.valueUsd;
      continue;
    }

    // A sell with no recorded buy means the wallet acquired the token outside
    // the observed window (airdrop, transfer, earlier history). Counting the
    // whole proceeds as profit would wildly overstate performance, so the
    // unmatched part adds to proceeds and to nothing else: no profit, no loss,
    // and the position cannot go negative.
    const sold = Math.min(trade.amount, position.amount);
    const unmatched = trade.amount - sold;

    if (sold > 0) {
      const avgCost = position.amount > 0 ? position.costBasisUsd / position.amount : 0;
      const costOfSold = avgCost * sold;
      // Attribute proceeds proportionally when part of the sale is unmatched.
      const proceeds = trade.valueUsd * (sold / trade.amount);

      position.realizedPnlUsd += proceeds - costOfSold;
      if (counted) position.windowRealizedUsd += proceeds - costOfSold;
      position.proceedsUsd += proceeds;
      position.costBasisUsd -= costOfSold;
      position.amount -= sold;
    }

    if (unmatched > 0) {
      position.unmatchedSells += unmatched;
      position.proceedsUsd += trade.valueUsd * (unmatched / trade.amount);
    }

    if (position.amount <= DUST_THRESHOLD) {
      position.amount = 0;
      // Floating-point residue in the basis would distort the next entry.
      position.costBasisUsd = 0;
      if (position.firstBuyTs !== null && position.closedTs === null) {
        position.closedTs = trade.ts;
        position.closedInWindow = counted;
      }
    }
  }

  const all = [...positions.values()];
  const finalized = all.map(finalize);

  // A position counts as closed for the window when its exit fell inside it; its win or loss is the window's realized part.
  const closed = all.filter((position) => position.amount === 0 && position.investedUsd > 0 && (since === undefined || position.closedInWindow));
  // Break-even is not a loss, here and in the outcome bands, so the two always agree.
  const winCount = closed.filter((position) => position.windowRealizedUsd >= 0).length;
  const lossCount = closed.length - winCount;

  const holds = closed
    .map(finalize)
    .map((position) => position.holdSeconds)
    .filter((value): value is number => value !== null);

  // From realized PnL, not from proceeds: proceeds include sales of tokens that were never bought here,
  // which would turn a transfer in into a winning trade.
  const multiples = closed
    .filter((position) => position.investedUsd > 0)
    .map((position) => 1 + position.realizedPnlUsd / position.investedUsd);

  return {
    realizedPnlUsd: sum(all.map((position) => position.windowRealizedUsd)),
    totalVolumeUsd,
    tradeCount,
    winRate: closed.length > 0 ? winCount / closed.length : 0,
    winCount,
    lossCount,
    avgHoldSeconds: holds.length > 0 ? sum(holds) / holds.length : 0,
    bestMultiple: multiples.length > 0 ? Math.max(...multiples) : 0,
    worstMultiple: multiples.length > 0 ? Math.min(...multiples) : 0,
    positions: finalized,
  };
}

/**
 * Composite 0-100 ranking for the smart-money leaderboard.
 *
 * Blended rather than sorted by PnL, because raw PnL ranks one lucky trade
 * above a wallet that is consistently profitable across hundreds — and only
 * the second is worth copying. Sample size is an explicit factor for the same
 * reason: a 100% win rate over two trades is noise.
 */
export function computeSmartScore(performance: WalletPerformance): number {
  const { realizedPnlUsd, winRate, positions } = performance;

  const closed = positions.filter((position) => position.amount === 0 && position.investedUsd > 0);
  if (closed.length === 0) return 0;

  // Log scale: the difference between $1k and $10k profit matters more than
  // between $1M and $1.01M.
  const pnlScore =
    realizedPnlUsd <= 0 ? 0 : Math.min(1, Math.log10(realizedPnlUsd + 1) / 6);

  const winScore = winRate;

  // Confidence grows with sample size and saturates around 50 closed trades.
  const sampleScore = Math.min(1, Math.log10(closed.length + 1) / Math.log10(51));

  // Consistency: heavy reliance on a single position is penalised.
  const profits = closed.map((position) => Math.max(0, position.realizedPnlUsd));
  const totalProfit = sum(profits);
  const largestShare = totalProfit > 0 ? Math.max(...profits) / totalProfit : 1;
  const consistencyScore = totalProfit > 0 ? 1 - largestShare : 0;

  const weighted =
    pnlScore * 0.35 + winScore * 0.3 + sampleScore * 0.2 + consistencyScore * 0.15;

  const score = Math.round(weighted * 100);
  return Math.max(0, Math.min(100, score));
}

interface MutablePosition {
  token: string;
  amount: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  investedUsd: number;
  proceedsUsd: number;
  unmatchedSells: number;
  firstBuyTs: number | null;
  lastTradeTs: number | null;
  closedTs: number | null;
  /** Realized inside the counted window (all of it without a window). */
  windowRealizedUsd: number;
  /** Whether the position's exit fell inside the counted window. */
  closedInWindow: boolean;
}

function newPosition(token: string): MutablePosition {
  return {
    token,
    amount: 0,
    costBasisUsd: 0,
    realizedPnlUsd: 0,
    investedUsd: 0,
    proceedsUsd: 0,
    unmatchedSells: 0,
    firstBuyTs: null,
    lastTradeTs: null,
    closedTs: null,
    windowRealizedUsd: 0,
    closedInWindow: false,
  };
}

function finalize(position: MutablePosition): TokenPosition {
  const holdSeconds =
    position.firstBuyTs !== null && position.closedTs !== null
      ? Math.max(0, (position.closedTs - position.firstBuyTs) / 1000)
      : null;

  return {
    token: position.token,
    amount: position.amount,
    avgCostUsd: position.amount > 0 ? position.costBasisUsd / position.amount : 0,
    realizedPnlUsd: position.realizedPnlUsd,
    investedUsd: position.investedUsd,
    proceedsUsd: position.proceedsUsd,
    firstBuyTs: position.firstBuyTs,
    lastTradeTs: position.lastTradeTs,
    holdSeconds,
  };
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

// ---------------------------------------------------------------------------
// Outcome distribution
// ---------------------------------------------------------------------------

/**
 * Bands a closed position's return can fall into.
 *
 * Deliberately asymmetric: three bands above break-even and two below. A
 * memecoin portfolio's losses cluster tightly (most are small, because
 * position sizing limits them) while its wins have a very long tail, so equal
 * bands would put nearly every trade in one bucket and tell nobody anything.
 *
 * `-100%` is its own boundary rather than an open end because a total loss is
 * a different event from a bad exit, and traders count them separately.
 */
export const PNL_BANDS = [
  { id: 'moon', label: '>500%', min: 5, max: Infinity, direction: 'win' },
  { id: 'strong', label: '200% ~ 500%', min: 2, max: 5, direction: 'win' },
  { id: 'up', label: '0% ~ 200%', min: 0, max: 2, direction: 'win' },
  { id: 'down', label: '0% ~ -50%', min: -0.5, max: 0, direction: 'loss' },
  { id: 'rekt', label: '< -50%', min: -1, max: -0.5, direction: 'loss' },
] as const;

export type PnlBandId = (typeof PNL_BANDS)[number]['id'];

export interface PnlBand {
  readonly id: PnlBandId;
  readonly label: string;
  readonly direction: 'win' | 'loss';
  readonly count: number;
  /** Share of closed positions, 0-1. */
  readonly share: number;
}

export interface PnlDistribution {
  readonly bands: readonly PnlBand[];
  /** Closed positions the distribution was computed over. */
  readonly total: number;
  readonly winCount: number;
  readonly lossCount: number;
}

/**
 * How a wallet's closed positions are distributed across outcome bands.
 *
 * Why it is worth showing: a wallet can win most of its trades and still
 * shrink, when the wins are small and the losses sit in `< -50%`. A single
 * headline percentage cannot say that; the bands do.
 *
 * Open positions are excluded. Their return has not happened yet, and counting
 * an unrealised gain beside realised ones would let a portfolio look better
 * simply for refusing to sell.
 */
export function computePnlDistribution(
  performance: Pick<WalletPerformance, 'positions'>,
): PnlDistribution {
  const closed = performance.positions.filter(
    (position) => position.amount === 0 && position.investedUsd > 0,
  );

  const counts = new Map<PnlBandId, number>(PNL_BANDS.map((band) => [band.id, 0]));

  for (const position of closed) {
    // Return relative to cost: 0 is break-even, -1 is a total loss. From realized PnL, so a sale of
    // tokens with no recorded buy does not count as a gain (the same rule as the win count).
    const ret = position.realizedPnlUsd / position.investedUsd;

    /**
     * Upper bound exclusive, lower inclusive, so a position lands in exactly
     * one band. Break-even counts as a win: it is not a loss, and putting it
     * in the loss column would misreport every scratched trade.
     */
    const band =
      PNL_BANDS.find((candidate) => ret >= candidate.min && ret < candidate.max) ??
      // Beyond the last band's ceiling, or below -100% through bad data.
      (ret >= 0 ? PNL_BANDS[0] : PNL_BANDS[PNL_BANDS.length - 1]);

    if (band) counts.set(band.id, (counts.get(band.id) ?? 0) + 1);
  }

  const total = closed.length;

  const bands = PNL_BANDS.map((band) => {
    const count = counts.get(band.id) ?? 0;
    return {
      id: band.id,
      label: band.label,
      direction: band.direction,
      count,
      share: total > 0 ? count / total : 0,
    };
  });

  return {
    bands,
    total,
    winCount: bands
      .filter((band) => band.direction === 'win')
      .reduce((sum, band) => sum + band.count, 0),
    lossCount: bands
      .filter((band) => band.direction === 'loss')
      .reduce((sum, band) => sum + band.count, 0),
  };
}

/**
 * The single best and worst closed positions, for the headline stats.
 *
 * Returns the position rather than just a number so the UI can show the token
 * — "my worst trade" is a story, "-$3,800" is a statistic, and the token is
 * what makes it the first.
 */
export function extremePositions(
  performance: Pick<WalletPerformance, 'positions'>,
): { best: TokenPosition | null; worst: TokenPosition | null } {
  const closed = performance.positions.filter(
    (position) => position.amount === 0 && position.investedUsd > 0,
  );

  if (closed.length === 0) return { best: null, worst: null };

  let best = closed[0]!;
  let worst = closed[0]!;
  for (const position of closed) {
    if (position.realizedPnlUsd > best.realizedPnlUsd) best = position;
    if (position.realizedPnlUsd < worst.realizedPnlUsd) worst = position;
  }

  return { best, worst };
}
