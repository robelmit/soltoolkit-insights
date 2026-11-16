import { describe, expect, it } from 'vitest';
import { SAFETY_THRESHOLDS, evaluateSafety } from '../src/safety';

/** A token passing everything, used as the baseline to break one check at a time. */
const cleanToken = {
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  lpBurnedPct: 100,
  metadataMutable: false,
  top10Pct: 12,
  devHoldingPct: 1.5,
  sellSimulationPassed: true,
  bundlerPct: 5,
};

describe('safety scoring', () => {
  it('gives a clean token full marks', () => {
    const report = evaluateSafety(cleanToken);
    expect(report.score).toBe(8);
    expect(report.maxScore).toBe(8);
    expect(report.grade).toBe('safe');
    expect(report.cappedBy).toBeUndefined();
  });

  it('scores an empty input zero rather than assuming the best', () => {
    // An unverified token is not a safe one.
    const report = evaluateSafety({});
    expect(report.score).toBe(0);
    expect(report.checks.every((check) => !check.passed)).toBe(true);
    expect(report.checks.every((check) => check.detail === 'Not verified')).toBe(true);
  });

  it('fails a check whose input is missing, even alongside passes', () => {
    const { top10Pct: _omitted, ...withoutTop10 } = cleanToken;
    const report = evaluateSafety(withoutTop10);
    expect(report.score).toBe(7);
    const top10 = report.checks.find((check) => check.id === 'top10_concentration');
    expect(top10?.passed).toBe(false);
  });

  it('caps the score when minting is still possible', () => {
    // Seven checks pass, but the supply can be inflated at will.
    const report = evaluateSafety({ ...cleanToken, mintAuthorityRevoked: false });
    expect(report.score).toBeLessThanOrEqual(3);
    expect(report.grade).toBe('dangerous');
    expect(report.cappedBy).toBe('mint_authority_revoked');
  });

  it('caps the score for a honeypot', () => {
    const report = evaluateSafety({ ...cleanToken, sellSimulationPassed: false });
    expect(report.score).toBeLessThanOrEqual(3);
    expect(report.grade).toBe('dangerous');
  });

  it('caps the score when liquidity can still be pulled', () => {
    const report = evaluateSafety({ ...cleanToken, lpBurnedPct: 10 });
    expect(report.grade).toBe('dangerous');
    expect(report.cappedBy).toBe('lp_burned_or_locked');
  });

  it('treats a live freeze authority as critical', () => {
    const report = evaluateSafety({ ...cleanToken, freezeAuthorityRevoked: false });
    expect(report.grade).toBe('dangerous');
  });

  it('does not cap for non-critical failures', () => {
    // High dev holdings are a real warning, but not the same class of risk as
    // a mintable supply, and the score should still distinguish degrees.
    const report = evaluateSafety({ ...cleanToken, devHoldingPct: 40, top10Pct: 60 });
    expect(report.score).toBe(6);
    expect(report.grade).toBe('caution');
    expect(report.cappedBy).toBeUndefined();
  });

  it('applies the documented thresholds exactly', () => {
    const atLimit = evaluateSafety({ ...cleanToken, top10Pct: SAFETY_THRESHOLDS.top10MaxPct });
    expect(atLimit.checks.find((c) => c.id === 'top10_concentration')?.passed).toBe(true);

    const overLimit = evaluateSafety({
      ...cleanToken,
      top10Pct: SAFETY_THRESHOLDS.top10MaxPct + 0.1,
    });
    expect(overLimit.checks.find((c) => c.id === 'top10_concentration')?.passed).toBe(false);
  });

  it('explains each failure in terms a trader can act on', () => {
    const report = evaluateSafety({ ...cleanToken, mintAuthorityRevoked: false });
    const mint = report.checks.find((check) => check.id === 'mint_authority_revoked');
    expect(mint?.detail).toMatch(/mint more supply/i);
  });

  it('does not grade a token dangerous merely for being unverified', () => {
    // Only mint and freeze authority are knowable from a bare RPC read. That
    // is the common real case, and calling it "dangerous" would train users
    // to ignore the badge.
    const report = evaluateSafety({
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
    });

    expect(report.grade).toBe('unknown');
    expect(report.incomplete).toBe(true);
    expect(report.unverifiedCount).toBe(6);
    expect(report.cappedBy).toBeUndefined();
  });

  it('still caps for a real critical failure among unverified checks', () => {
    const report = evaluateSafety({
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: true,
    });

    // An active mint authority is a fact, not an absence of one.
    expect(report.grade).toBe('dangerous');
    expect(report.cappedBy).toBe('mint_authority_revoked');
  });

  it('grades against the checks that actually ran', () => {
    // Five checks run and all pass; the grade should reflect that rather than
    // being dragged down by three that could not run.
    const report = evaluateSafety({
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedPct: 100,
      top10Pct: 10,
      sellSimulationPassed: true,
    });

    expect(report.incomplete).toBe(false);
    expect(report.grade).toBe('safe');
    expect(report.unverifiedCount).toBe(3);
  });

  it('refuses to grade a minutes-old token "safe" on half the evidence', () => {
    /**
     * Exactly what the live providers return for a token three minutes old:
     * both authorities, metadata and the sell simulation resolve, while
     * holder, LP and launch-block data do not exist yet at any source.
     *
     * Four passes out of four that ran, and four unknowns. The grade must not
     * be "safe" — that is the least-known and highest-risk token on the
     * market, and a green badge on it is exactly the misuse this engine is
     * built to prevent.
     */
    const report = evaluateSafety({
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      metadataMutable: false,
      sellSimulationPassed: true,
    });

    expect(report.unverifiedCount).toBe(4);
    expect(report.incomplete).toBe(true);
    expect(report.grade).toBe('unknown');
    // The passes are still real and still counted; only the grade withholds.
    expect(report.score).toBe(4);
  });

  it('marks unverified checks distinctly from failed ones', () => {
    const report = evaluateSafety({ ...cleanToken, devHoldingPct: 50 });

    const failed = report.checks.find((check) => check.id === 'dev_holding');
    expect(failed?.passed).toBe(false);
    expect(failed?.unverified).toBe(false);

    const unknown = evaluateSafety({}).checks[0];
    expect(unknown?.passed).toBe(false);
    expect(unknown?.unverified).toBe(true);
  });

  it('rejects a non-finite numeric input', () => {
    const report = evaluateSafety({ ...cleanToken, lpBurnedPct: Number.NaN });
    expect(report.checks.find((c) => c.id === 'lp_burned_or_locked')?.passed).toBe(false);
  });
});

