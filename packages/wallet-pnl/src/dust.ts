/**
 * Finding positions that are not worth keeping.
 *
 * A portfolio accumulates remnants: a token bought for $200 now worth $1.40,
 * a rounding tail left after selling 99%, a position whose exit would cost
 * more in fees than it returns. They clutter the view and, worse, they each
 * carry a rent obligation on Solana — an open token account holds a small SOL
 * deposit that is only recoverable by closing it.
 *
 * The analysis is simple; what makes it useful is being honest about the
 * arithmetic.
 *
 * ## Why "worth less than the exit" is the real test
 *
 * The obvious rule is a dollar threshold — anything under $1 is dust. That is
 * wrong in both directions. A $5 position on a chain with negligible fees is
 * worth closing; a $50 position in a pool so thin that selling moves the price
 * 40% is not. What matters is whether the position returns more than it costs
 * to exit, which depends on fees, price impact and the rent that closing
 * recovers.
 *
 * ## Recovered rent is a real return
 *
 * On Solana an SPL token account holds roughly 0.00204 SOL of rent, refunded
 * when the account closes. At $100 SOL that is about 20 cents — larger than
 * many dust positions are worth, which means closing them is frequently
 * profitable even when the token itself is worthless. That inversion is the
 * insight the feature exists to surface.
 */

/** Rent held by an SPL token account, in SOL. Refunded on close. */
export const SOLANA_TOKEN_ACCOUNT_RENT_SOL = 0.00203928;

export interface DustPosition {
  readonly address: string;
  readonly symbol: string;
  /** Tokens held. */
  readonly amount: number;
  /** Current value of the holding, USD. */
  readonly valueUsd: number;
  /** What was paid for it, USD. */
  readonly costUsd: number;
  /** Pool liquidity, for estimating exit impact. */
  readonly liquidityUsd?: number;
}

export interface DustVerdict {
  readonly address: string;
  readonly symbol: string;
  readonly valueUsd: number;
  /** Estimated cost of selling: fees plus price impact. */
  readonly exitCostUsd: number;
  /** Rent refunded by closing the account, USD. */
  readonly rentRecoveryUsd: number;
  /** Value plus rent, less the cost of getting out. */
  readonly netRecoveryUsd: number;
  readonly action: 'close' | 'keep' | 'stuck';
  readonly reason: string;
}

export interface DustOptions {
  /** Native token price, for valuing recovered rent. */
  readonly nativePriceUsd: number;
  /** Trading fee plus network fee as a share of the trade, 0-1. */
  readonly feeRate?: number;
  /** Positions above this are never dust, whatever the arithmetic says. */
  readonly keepAboveUsd?: number;
}

/**
 * Estimated price impact of selling the whole position.
 *
 * A constant-product approximation: selling into a pool moves the price by
 * roughly the trade's share of liquidity. Rough, but the right shape — impact
 * grows faster than linearly as the position approaches pool size, which is
 * exactly the case where a naive dollar threshold gives the wrong answer.
 */
export function exitImpactPct(valueUsd: number, liquidityUsd?: number): number {
  if (!liquidityUsd || liquidityUsd <= 0) {
    // Unknown liquidity is not zero impact. Assuming a thin pool is the
    // conservative reading, and being wrong here means keeping a position
    // rather than selling into nothing.
    return 25;
  }
  const share = valueUsd / liquidityUsd;
  return Math.min(100, share * 100 * (1 + share));
}

/**
 * Decides what to do with one position.
 *
 * Three outcomes rather than two. `stuck` is the case a dollar threshold
 * misses entirely: a position worth more than the dust line but sitting in a
 * pool too thin to exit without losing most of it. Telling someone that is
 * dust would be wrong; telling them nothing would be worse.
 */
export function assessDust(position: DustPosition, options: DustOptions): DustVerdict {
  const feeRate = options.feeRate ?? 0.0075;
  const keepAbove = options.keepAboveUsd ?? 25;

  const rentRecoveryUsd =
    options.nativePriceUsd > 0 ? SOLANA_TOKEN_ACCOUNT_RENT_SOL * options.nativePriceUsd : 0;

  // An empty position is pure rent: nothing to sell, an account to close.
  if (position.amount <= 0 || position.valueUsd <= 0) {
    return {
      address: position.address,
      symbol: position.symbol,
      valueUsd: 0,
      exitCostUsd: 0,
      rentRecoveryUsd,
      netRecoveryUsd: rentRecoveryUsd,
      action: rentRecoveryUsd > 0 ? 'close' : 'keep',
      reason:
        rentRecoveryUsd > 0
          ? `Empty position. Closing the account refunds about ${rentRecoveryUsd.toFixed(2)} in rent.`
          : 'Empty position with no rent to recover.',
    };
  }

  const impactPct = exitImpactPct(position.valueUsd, position.liquidityUsd);
  const impactCost = position.valueUsd * (impactPct / 100);
  const feeCost = position.valueUsd * feeRate;
  const exitCostUsd = impactCost + feeCost;

  const netRecoveryUsd = position.valueUsd - exitCostUsd + rentRecoveryUsd;

  // Worth keeping on size alone, regardless of the arithmetic below.
  if (position.valueUsd >= keepAbove) {
    return {
      address: position.address,
      symbol: position.symbol,
      valueUsd: position.valueUsd,
      exitCostUsd,
      rentRecoveryUsd,
      netRecoveryUsd,
      action: 'keep',
      reason: `Worth ${position.valueUsd.toFixed(2)}, above the dust threshold.`,
    };
  }

  // Checked before `stuck`, because the two can both be true and only one is
  // worth saying. "Stuck" implies there is value waiting to be recovered once
  // liquidity improves; a position that nets negative has none, and telling
  // someone to wait for a better exit would be misleading.
  if (netRecoveryUsd <= 0) {
    return {
      address: position.address,
      symbol: position.symbol,
      valueUsd: position.valueUsd,
      exitCostUsd,
      rentRecoveryUsd,
      netRecoveryUsd,
      action: 'keep',
      reason:
        impactPct >= 30
          ? `Closing would cost more than it returns — selling moves the price about ${impactPct.toFixed(0)}%.`
          : 'Closing would cost more than it returns.',
    };
  }

  // Illiquid enough that exiting destroys most of the value, but still worth
  // something once it can be sold.
  if (impactPct >= 30 && position.valueUsd > rentRecoveryUsd * 2) {
    return {
      address: position.address,
      symbol: position.symbol,
      valueUsd: position.valueUsd,
      exitCostUsd,
      rentRecoveryUsd,
      netRecoveryUsd,
      action: 'stuck',
      reason: `Selling would move the price about ${impactPct.toFixed(0)}%. Worth ${position.valueUsd.toFixed(2)}, but the pool is too thin to exit cleanly.`,
    };
  }

  // The inversion worth surfacing: the token is worthless, and closing the
  // account is still profitable because of the rent.
  const rentDominates = rentRecoveryUsd > position.valueUsd;

  return {
    address: position.address,
    symbol: position.symbol,
    valueUsd: position.valueUsd,
    exitCostUsd,
    rentRecoveryUsd,
    netRecoveryUsd,
    action: 'close',
    reason: rentDominates
      ? `Worth only ${position.valueUsd.toFixed(2)}, but closing refunds ${rentRecoveryUsd.toFixed(2)} in rent — more than the tokens.`
      : `Recovers about ${netRecoveryUsd.toFixed(2)} after costs.`,
  };
}

export interface DustSummary {
  readonly verdicts: readonly DustVerdict[];
  /** Positions worth closing. */
  readonly closeable: readonly DustVerdict[];
  /** Held back by liquidity rather than by value. */
  readonly stuck: readonly DustVerdict[];
  /** Total recoverable by closing everything closeable. */
  readonly totalRecoveryUsd: number;
  /** Of that, how much is refunded rent rather than token value. */
  readonly rentPortionUsd: number;
}

/** Assesses a whole portfolio, sorted by what recovers most. */
export function summariseDust(
  positions: readonly DustPosition[],
  options: DustOptions,
): DustSummary {
  const verdicts = positions
    .map((position) => assessDust(position, options))
    .sort((a, b) => b.netRecoveryUsd - a.netRecoveryUsd);

  const closeable = verdicts.filter((verdict) => verdict.action === 'close');

  return {
    verdicts,
    closeable,
    stuck: verdicts.filter((verdict) => verdict.action === 'stuck'),
    totalRecoveryUsd: closeable.reduce((sum, verdict) => sum + verdict.netRecoveryUsd, 0),
    rentPortionUsd: closeable.reduce((sum, verdict) => sum + verdict.rentRecoveryUsd, 0),
  };
}
