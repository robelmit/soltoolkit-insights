/**
 * Impersonation detection.
 *
 * The most common scam on a launchpad is not a clever contract — it is a
 * copied identity. A token reuses a successful coin's name, ticker or image,
 * collects buys from people who think they are early to the real thing, and
 * disappears. Contract-level safety checks pass cleanly on these, because
 * nothing about the contract is wrong; what is wrong is the claim it makes
 * about itself.
 *
 * Three signals, in rough order of how damning they are:
 *
 *   **Avatar reuse** — the same image as an existing token. Almost never
 *   innocent when the other token is older and larger.
 *
 *   **Name or symbol collision** — shared with an established token. Sometimes
 *   coincidence on short tickers, so weighted by the other token's size.
 *
 *   **Homoglyph and near-miss naming** — visually confusable substitutions
 *   (`0` for `O`, Cyrillic `а` for Latin `a`) or a one-character edit from a
 *   known name. This is the deliberate version of a collision, and the one a
 *   plain string comparison misses entirely.
 */

export interface TokenIdentity {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  /** Content hash of the avatar, when available. */
  readonly imageHash?: string;
  readonly marketCapUsd?: number;
  readonly createdAt?: number;
}

export interface ImpersonationMatch {
  readonly kind: 'avatar-reuse' | 'name-collision' | 'symbol-collision' | 'homoglyph' | 'near-miss';
  readonly otherAddress: string;
  readonly otherName: string;
  readonly otherMarketCapUsd?: number;
  /** True when the other token predates this one. */
  readonly otherIsOlder: boolean;
  readonly detail: string;
}

export interface ImpersonationReport {
  /** 0-100. Higher means more likely to be impersonating something. */
  readonly risk: number;
  readonly matches: readonly ImpersonationMatch[];
  readonly summary: string;
}

/**
 * Characters that render alike. Used to normalise before comparison so a
 * substitution does not evade a name check.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  '0': 'o',
  // `1`, `l` and `i` are mutually confusable — in most sans-serif fonts the
  // digit one and lowercase L are near-identical, and both pass for an i. A
  // single mapping cannot express a three-way ambiguity, so all three fold to
  // one representative and the class collapses. Without this, `F4rtc01n`
  // normalises to `fartcoln` and misses `fartcoin` by one character.
  '1': 'i',
  l: 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  $: 's',
  '@': 'a',
  // Cyrillic lookalikes, the most common non-ASCII trick.
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'i',
  Ι: 'i',
  ѕ: 's',
};

/** Lowercases, strips non-alphanumerics, and folds lookalike characters. */
export function normaliseIdentity(value: string): string {
  return [...value.toLowerCase()]
    .map((char) => HOMOGLYPHS[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

/** Levenshtein distance, capped for early exit. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    // Whole row already past the cap; the final distance cannot come back.
    if (rowMin > cap) return cap + 1;
    previous = current;
  }

  return previous[b.length]!;
}

/**
 * Compares a token against known ones.
 *
 * `known` should be the established tokens worth impersonating — by market cap
 * or reputation — not every token in existence. Comparing against everything
 * produces collisions on short tickers that mean nothing.
 */
export function detectImpersonation(
  subject: TokenIdentity,
  known: readonly TokenIdentity[],
): ImpersonationReport {
  const matches: ImpersonationMatch[] = [];
  const subjectName = normaliseIdentity(subject.name);
  const subjectSymbol = normaliseIdentity(subject.symbol);

  for (const other of known) {
    if (other.address.toLowerCase() === subject.address.toLowerCase()) continue;

    const otherIsOlder =
      subject.createdAt !== undefined && other.createdAt !== undefined
        ? other.createdAt < subject.createdAt
        : false;

    const base = {
      otherAddress: other.address,
      otherName: other.name,
      ...(other.marketCapUsd !== undefined ? { otherMarketCapUsd: other.marketCapUsd } : {}),
      otherIsOlder,
    };

    // Avatar reuse is the strongest signal, so it is checked first and
    // reported even when the names differ.
    if (subject.imageHash && other.imageHash && subject.imageHash === other.imageHash) {
      matches.push({
        ...base,
        kind: 'avatar-reuse',
        detail: `Uses the same image as ${other.symbol}${
          other.marketCapUsd ? ` ($${formatCompact(other.marketCapUsd)})` : ''
        }.`,
      });
      continue;
    }

    const otherName = normaliseIdentity(other.name);
    const otherSymbol = normaliseIdentity(other.symbol);

    if (subjectName.length > 0 && subjectName === otherName) {
      // An exact match after folding means the raw strings differed only by
      // lookalike characters — that is deliberate, not coincidence.
      const exact = subject.name.toLowerCase() === other.name.toLowerCase();
      matches.push({
        ...base,
        kind: exact ? 'name-collision' : 'homoglyph',
        detail: exact
          ? `Shares the name "${other.name}".`
          : `Name "${subject.name}" is a lookalike of "${other.name}".`,
      });
      continue;
    }

    if (subjectSymbol.length > 1 && subjectSymbol === otherSymbol) {
      matches.push({
        ...base,
        kind: 'symbol-collision',
        detail: `Shares the ticker ${other.symbol}.`,
      });
      continue;
    }

    // Near-misses only matter on names long enough for an edit to be a choice.
    if (subjectName.length >= 5 && otherName.length >= 5) {
      const distance = editDistance(subjectName, otherName, 2);
      if (distance > 0 && distance <= 2) {
        matches.push({
          ...base,
          kind: 'near-miss',
          detail: `Name is ${distance} character${distance === 1 ? '' : 's'} from "${other.name}".`,
        });
      }
    }
  }

  return { risk: scoreImpersonation(matches), matches, summary: summarise(matches) };
}

/**
 * Converts matches to a risk score.
 *
 * Weighted by kind and by the impersonated token's size — copying something
 * large and established is worth more than colliding with something obscure.
 * An older counterpart is what makes a match suspicious at all; if the other
 * token is newer, it may be the impersonator.
 */
function scoreImpersonation(matches: readonly ImpersonationMatch[]): number {
  let risk = 0;

  for (const match of matches) {
    const base =
      match.kind === 'avatar-reuse'
        ? 45
        : match.kind === 'homoglyph'
          ? 40
          : match.kind === 'name-collision'
            ? 30
            : match.kind === 'symbol-collision'
              ? 18
              : 12;

    const sizeWeight =
      match.otherMarketCapUsd === undefined
        ? 1
        : match.otherMarketCapUsd > 10_000_000
          ? 1.5
          : match.otherMarketCapUsd > 1_000_000
            ? 1.25
            : 1;

    // Only an older counterpart implies copying.
    const ageWeight = match.otherIsOlder ? 1 : 0.5;

    risk += base * sizeWeight * ageWeight;
  }

  return Math.min(100, Math.round(risk));
}

function summarise(matches: readonly ImpersonationMatch[]): string {
  if (matches.length === 0) return 'No impersonation signals found.';

  const avatar = matches.filter((m) => m.kind === 'avatar-reuse').length;
  const homoglyph = matches.filter((m) => m.kind === 'homoglyph').length;
  const names = matches.filter(
    (m) => m.kind === 'name-collision' || m.kind === 'symbol-collision',
  ).length;

  const parts: string[] = [];
  if (avatar > 0) parts.push(`${avatar} token${avatar === 1 ? '' : 's'} share this image`);
  if (homoglyph > 0) parts.push(`${homoglyph} lookalike name${homoglyph === 1 ? '' : 's'}`);
  if (names > 0) parts.push(`${names} name or ticker collision${names === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push(`${matches.length} near-miss name${matches.length === 1 ? '' : 's'}`);

  return `${parts.join(', ')}.`;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}
