/**
 * Token safety scoring: a count of passed checks out of eight, with a grade.
 *
 * Eight checks against the specific ways a memecoin takes your money. The
 * output is deliberately a count of passed checks plus the individual results,
 * not a single opaque number: "6/8, and the two failures are mint authority
 * and dev holdings" is actionable, while "75% safe" is not.
 *
 * Three design rules, all learned from how these scores get misused:
 *
 *   Unknown is never a pass. A check whose input is missing does not count
 *   toward the score, because a trader reading 8/8 must be able to trust it.
 *   Optimistic defaults turn the badge into decoration.
 *
 *   Unknown is not the same as failed. "We have not checked for a honeypot" is
 *   not evidence of one. Only an actively failed critical check caps the score;
 *   grading every unverified token "dangerous" would train users to ignore the
 *   badge, which is worse than having none.
 *
 *   Critical failures cap the score. A token that can still be minted or whose
 *   liquidity can be pulled is not "6/8 good" — it is unsafe regardless of what
 *   else passes, and the score must say so.
 */

/** The eight checks, in the order they are reported. */
export const SAFETY_CHECK_IDS = [
  'mint_authority_revoked',
  'freeze_authority_revoked',
  'lp_burned_or_locked',
  'not_mutable',
  'top10_concentration',
  'dev_holding',
  'no_honeypot',
  'no_bundler_cluster',
] as const;

export type SafetyCheckId = (typeof SAFETY_CHECK_IDS)[number];

export interface SafetyInputs {
  /** Solana: mint authority is null. EVM: no mint function reachable by owner. */
  readonly mintAuthorityRevoked?: boolean;
  /** Solana: freeze authority is null. A live freeze authority can trap holders. */
  readonly freezeAuthorityRevoked?: boolean;
  /** Percent of LP tokens burned or time-locked. */
  readonly lpBurnedPct?: number;
  /** Whether token metadata can still be changed by the creator. */
  readonly metadataMutable?: boolean;
  /** Combined share held by the top ten non-pool, non-burn addresses. */
  readonly top10Pct?: number;
  /** Share held by the deployer and known-linked wallets. */
  readonly devHoldingPct?: number;
  /** Whether a simulated sell succeeded. */
  readonly sellSimulationPassed?: boolean;
  /** Share bought in the launch block by bundled wallets. */
  readonly bundlerPct?: number;
}

export interface SafetyCheckResult {
  readonly id: SafetyCheckId;
  readonly passed: boolean;
  readonly label: string;
  readonly detail: string;
  /** A failure here caps the overall score regardless of other passes. */
  readonly critical: boolean;
  /**
   * True when the input was missing rather than bad.
   *
   * Unverified still does not pass — a trader reading 8/8 must be able to
   * trust it. But it is not the same as *failing*: a token whose sell
   * simulation has not run yet is unknown, not proven to be a honeypot, and
   * grading it "dangerous" on that basis would teach users to ignore the
   * badge entirely.
   */
  readonly unverified: boolean;
}

export interface SafetyReport {
  readonly score: number;
  readonly maxScore: number;
  readonly checks: readonly SafetyCheckResult[];
  readonly grade: SafetyGrade;
  /** Set when a check actively failed and capped the score. */
  readonly cappedBy?: SafetyCheckId;
  /** How many checks could not be run. */
  readonly unverifiedCount: number;
  /** True when too little is known to grade the token at all. */
  readonly incomplete: boolean;
}

/**
 * `unknown` is distinct from the risk grades: it means the checks did not run,
 * not that the token is safe or unsafe. The UI must say so rather than showing
 * a number.
 */
export type SafetyGrade = 'safe' | 'caution' | 'risky' | 'dangerous' | 'unknown';

/** Thresholds, kept together so the policy is visible in one place. */
export const SAFETY_THRESHOLDS = {
  /** Above this, the top ten can exit into any realistic bid. */
  top10MaxPct: 30,
  /** Above this, the deployer alone can break the price. */
  devHoldingMaxPct: 5,
  /** Below this, liquidity can still be pulled. */
  lpBurnedMinPct: 90,
  /** Above this, the launch was effectively pre-allocated. */
  bundlerMaxPct: 25,
} as const;

/** A critical failure cannot score above this, however many checks pass. */
const CRITICAL_FAILURE_CAP = 3;

export function evaluateSafety(inputs: SafetyInputs): SafetyReport {
  const checks: SafetyCheckResult[] = [
    check(
      'mint_authority_revoked',
      'Mint authority',
      inputs.mintAuthorityRevoked,
      'Revoked — supply is fixed',
      'Active — the creator can mint more supply at any time',
      true,
    ),
    check(
      'freeze_authority_revoked',
      'Freeze authority',
      inputs.freezeAuthorityRevoked,
      'Revoked — balances cannot be frozen',
      'Active — the creator can freeze your tokens',
      true,
    ),
    numericCheck(
      'lp_burned_or_locked',
      'Liquidity',
      inputs.lpBurnedPct,
      (value) => value >= SAFETY_THRESHOLDS.lpBurnedMinPct,
      (value) => `${value.toFixed(0)}% burned or locked`,
      (value) => `Only ${value.toFixed(0)}% locked — liquidity can be pulled`,
      true,
    ),
    check(
      'not_mutable',
      'Metadata',
      inputs.metadataMutable === undefined ? undefined : !inputs.metadataMutable,
      'Immutable',
      'Mutable — name, symbol and image can be changed after you buy',
      false,
    ),
    numericCheck(
      'top10_concentration',
      'Top 10 holders',
      inputs.top10Pct,
      (value) => value <= SAFETY_THRESHOLDS.top10MaxPct,
      (value) => `${value.toFixed(1)}% held by the top ten`,
      (value) => `${value.toFixed(1)}% concentrated in ten wallets`,
      false,
    ),
    numericCheck(
      'dev_holding',
      'Dev holdings',
      inputs.devHoldingPct,
      (value) => value <= SAFETY_THRESHOLDS.devHoldingMaxPct,
      (value) => `Deployer holds ${value.toFixed(1)}%`,
      (value) => `Deployer holds ${value.toFixed(1)}% — enough to break the price`,
      false,
    ),
    check(
      'no_honeypot',
      'Sell simulation',
      inputs.sellSimulationPassed,
      'A sell succeeded in simulation',
      'A sell failed in simulation — this may be a honeypot',
      true,
    ),
    numericCheck(
      'no_bundler_cluster',
      'Launch distribution',
      inputs.bundlerPct,
      (value) => value <= SAFETY_THRESHOLDS.bundlerMaxPct,
      (value) => `${value.toFixed(1)}% bought in the launch block`,
      (value) => `${value.toFixed(1)}% bundled at launch — supply was pre-allocated`,
      false,
    ),
  ];

  const passed = checks.filter((result) => result.passed).length;
  const unverifiedCount = checks.filter((result) => result.unverified).length;

  /**
   * Only an *actively failed* critical check caps the score. An unverified one
   * cannot: "we did not check" is not evidence of a honeypot, and treating it
   * as one would grade every established token dangerous and train users to
   * ignore the badge.
   */
  const criticalFailure = checks.find(
    (result) => result.critical && !result.passed && !result.unverified,
  );

  const score = criticalFailure ? Math.min(passed, CRITICAL_FAILURE_CAP) : passed;

  /**
   * With half the checks or more unrun, no positive grade is honest.
   *
   * The boundary is inclusive for a specific reason. A token minutes old
   * resolves exactly four of eight — the two authorities, metadata, and the
   * sell simulation — while holder, LP and launch data do not exist yet at any
   * source. A strictly-greater test grades that "safe", which is the worst
   * possible label for the least-known and highest-risk kind of token there is.
   * Four unknowns out of eight is not a clean bill of health.
   */
  const incomplete = unverifiedCount >= checks.length / 2;

  /**
   * A proven danger outranks incompleteness. If the mint authority is live we
   * know the token is unsafe, however many other checks could not run — saying
   * "unknown" there would hide the one fact we actually established.
   */
  const grade: SafetyGrade = criticalFailure
    ? 'dangerous'
    : incomplete
      ? 'unknown'
      : gradeFor(score, checks.length - unverifiedCount, false);

  return {
    score,
    maxScore: checks.length,
    checks,
    grade,
    unverifiedCount,
    incomplete,
    ...(criticalFailure ? { cappedBy: criticalFailure.id } : {}),
  };
}

/** Graded against the checks that actually ran, not the full set. */
function gradeFor(score: number, verifiedCount: number, hasCriticalFailure: boolean): SafetyGrade {
  if (hasCriticalFailure) return 'dangerous';
  if (verifiedCount <= 0) return 'unknown';
  const ratio = score / verifiedCount;
  if (ratio >= 0.875) return 'safe';
  if (ratio >= 0.625) return 'caution';
  return 'risky';
}

function check(
  id: SafetyCheckId,
  label: string,
  value: boolean | undefined,
  passDetail: string,
  failDetail: string,
  critical: boolean,
): SafetyCheckResult {
  // Unknown does not pass: a badge a trader cannot trust is worse than none.
  if (value === undefined) {
    return { id, label, passed: false, detail: 'Not verified', critical, unverified: true };
  }
  return {
    id,
    label,
    passed: value,
    detail: value ? passDetail : failDetail,
    critical,
    unverified: false,
  };
}

function numericCheck(
  id: SafetyCheckId,
  label: string,
  value: number | undefined,
  passes: (value: number) => boolean,
  passDetail: (value: number) => string,
  failDetail: (value: number) => string,
  critical: boolean,
): SafetyCheckResult {
  if (value === undefined || !Number.isFinite(value)) {
    return { id, label, passed: false, detail: 'Not verified', critical, unverified: true };
  }
  const ok = passes(value);
  return {
    id,
    label,
    passed: ok,
    detail: ok ? passDetail(value) : failDetail(value),
    critical,
    unverified: false,
  };
}
