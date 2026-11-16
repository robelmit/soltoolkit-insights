import { describe, expect, it } from 'vitest';
import {
  assessDust,
  exitImpactPct,
  SOLANA_TOKEN_ACCOUNT_RENT_SOL,
  summariseDust,
  type DustPosition,
} from '../src/dust';

const SOL_PRICE = 100;
const options = { nativePriceUsd: SOL_PRICE };

/** Rent is worth about 20 cents at $100 SOL. */
const RENT_USD = SOLANA_TOKEN_ACCOUNT_RENT_SOL * SOL_PRICE;

const position = (patch: Partial<DustPosition> = {}): DustPosition => ({
  address: 'DezXAZ8z7Pnr',
  symbol: 'BONK',
  amount: 1_000,
  valueUsd: 2,
  costUsd: 200,
  liquidityUsd: 500_000,
  ...patch,
});

describe('exitImpactPct', () => {
  it('is negligible for a small position in a deep pool', () => {
    expect(exitImpactPct(10, 1_000_000)).toBeLessThan(0.1);
  });

  it('grows faster than linearly as the position approaches pool size', () => {
    // The reason a flat dollar threshold gives wrong answers: a position worth
    // a tenth of the pool costs far more than ten times one worth a hundredth.
    const small = exitImpactPct(1_000, 100_000);
    const large = exitImpactPct(10_000, 100_000);
    expect(large).toBeGreaterThan(small * 10);
  });

  it('caps at 100%', () => {
    expect(exitImpactPct(1_000_000, 1_000)).toBe(100);
  });

  it('assumes a thin pool when liquidity is unknown', () => {
    // Unknown is not zero. Being wrong here means keeping a position rather
    // than selling into nothing, which is the safer error.
    expect(exitImpactPct(10, undefined)).toBe(25);
    expect(exitImpactPct(10, 0)).toBe(25);
  });
});

describe('assessDust', () => {
  it('closes a small position in a liquid pool', () => {
    const verdict = assessDust(position({ valueUsd: 2 }), options);
    expect(verdict.action).toBe('close');
    expect(verdict.netRecoveryUsd).toBeGreaterThan(0);
  });

  it('keeps a position above the threshold', () => {
    const verdict = assessDust(position({ valueUsd: 120 }), options);
    expect(verdict.action).toBe('keep');
    expect(verdict.reason).toContain('above the dust threshold');
  });

  describe('rent', () => {
    it('recovers rent even when the tokens are worthless', () => {
      // The inversion this feature exists to surface: closing is profitable
      // because of the deposit, not the token.
      const verdict = assessDust(position({ valueUsd: 0.02 }), options);
      expect(verdict.action).toBe('close');
      expect(verdict.rentRecoveryUsd).toBeCloseTo(RENT_USD, 5);
      expect(verdict.reason).toContain('more than the tokens');
    });

    it('closes an empty position for the rent alone', () => {
      const verdict = assessDust(position({ amount: 0, valueUsd: 0 }), options);
      expect(verdict.action).toBe('close');
      expect(verdict.netRecoveryUsd).toBeCloseTo(RENT_USD, 5);
    });

    it('keeps an empty position when there is no rent to recover', () => {
      // On a chain without rent, an empty position is simply nothing.
      const verdict = assessDust(position({ amount: 0, valueUsd: 0 }), { nativePriceUsd: 0 });
      expect(verdict.action).toBe('keep');
      expect(verdict.netRecoveryUsd).toBe(0);
    });
  });

  describe('stuck positions', () => {
    it('reports a position too illiquid to exit as stuck, not dust', () => {
      // Worth more than dust, but the pool cannot absorb it. Calling this
      // dust would be wrong; saying nothing would be worse.
      const verdict = assessDust(
        position({ valueUsd: 15, liquidityUsd: 20 }),
        options,
      );
      expect(verdict.action).toBe('stuck');
      expect(verdict.reason).toContain('too thin to exit');
    });

    it('still closes a tiny position in a thin pool, where rent dominates', () => {
      // Below twice the rent, the deposit is the whole reason to act and
      // liquidity stops mattering.
      const verdict = assessDust(
        position({ valueUsd: 0.05, liquidityUsd: 10 }),
        options,
      );
      expect(verdict.action).toBe('close');
    });
  });

  it('keeps a position whose exit costs more than it returns', () => {
    // Needs a position that is most of its own pool: at that size the impact
    // consumes the whole value, and with no rent to offset the fee the net is
    // negative. A small position in a deep pool is cheap to exit and should
    // close, which is what an earlier version of this test got wrong.
    const verdict = assessDust(
      position({ valueUsd: 0.05, liquidityUsd: 0.06 }),
      { nativePriceUsd: 0 },
    );
    expect(verdict.action).toBe('keep');
    expect(verdict.reason).toContain('cost more than it returns');
  });

  it('counts both fees and impact in the exit cost', () => {
    const verdict = assessDust(position({ valueUsd: 10, liquidityUsd: 1_000 }), options);
    // 1% of a $1,000 pool is real impact, and the fee applies on top.
    expect(verdict.exitCostUsd).toBeGreaterThan(10 * 0.0075);
  });

  it('respects a custom keep threshold', () => {
    const verdict = assessDust(position({ valueUsd: 30 }), { ...options, keepAboveUsd: 10 });
    expect(verdict.action).toBe('keep');
  });
});

describe('summariseDust', () => {
  const portfolio: DustPosition[] = [
    position({ address: 'a', symbol: 'DUST1', valueUsd: 0.5 }),
    position({ address: 'b', symbol: 'DUST2', valueUsd: 1.2 }),
    position({ address: 'c', symbol: 'REAL', valueUsd: 500 }),
    position({ address: 'd', symbol: 'STUCK', valueUsd: 15, liquidityUsd: 20 }),
  ];

  it('separates closeable from stuck and kept', () => {
    const summary = summariseDust(portfolio, options);
    expect(summary.closeable.map((v) => v.symbol)).toEqual(['DUST2', 'DUST1']);
    expect(summary.stuck.map((v) => v.symbol)).toEqual(['STUCK']);
  });

  it('totals what closing everything recovers', () => {
    const summary = summariseDust(portfolio, options);
    expect(summary.totalRecoveryUsd).toBeGreaterThan(0);
    expect(summary.totalRecoveryUsd).toBeCloseTo(
      summary.closeable.reduce((sum, v) => sum + v.netRecoveryUsd, 0),
      10,
    );
  });

  it('says how much of the recovery is rent rather than token value', () => {
    // Two closeable accounts, so twice the rent — and on a dusty portfolio
    // that is most of the total.
    const summary = summariseDust(portfolio, options);
    expect(summary.rentPortionUsd).toBeCloseTo(RENT_USD * 2, 5);
  });

  it('sorts by what recovers most', () => {
    const summary = summariseDust(portfolio, options);
    const recoveries = summary.verdicts.map((v) => v.netRecoveryUsd);
    expect([...recoveries].sort((a, b) => b - a)).toEqual(recoveries);
  });

  it('handles an empty portfolio', () => {
    const summary = summariseDust([], options);
    expect(summary).toMatchObject({ totalRecoveryUsd: 0, rentPortionUsd: 0 });
    expect(summary.closeable).toEqual([]);
  });
});
