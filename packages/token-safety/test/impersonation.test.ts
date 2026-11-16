import { describe, expect, it } from 'vitest';
import {
  detectImpersonation,
  editDistance,
  normaliseIdentity,
  type TokenIdentity,
} from '../src/impersonation';

const established: TokenIdentity = {
  address: 'Est4b1ished111111111111111111111111111111111',
  name: 'Fartcoin',
  symbol: 'FARTCOIN',
  imageHash: 'hash-abc',
  marketCapUsd: 146_000_000,
  createdAt: 1_700_000_000_000,
};

/** A newer token, for comparison against the established one. */
const newcomer = (patch: Partial<TokenIdentity>): TokenIdentity => ({
  address: 'NewC0mer1111111111111111111111111111111111',
  name: 'Something Else',
  symbol: 'ELSE',
  createdAt: 1_800_000_000_000,
  marketCapUsd: 5_000,
  ...patch,
});

describe('normaliseIdentity', () => {
  it('folds case, punctuation and spacing', () => {
    expect(normaliseIdentity('Fart Coin!')).toBe('fartcoin');
  });

  it('folds digits used as letters', () => {
    // The oldest trick in the book.
    expect(normaliseIdentity('F4rtc01n')).toBe('fartcoin');
  });

  it('folds Cyrillic lookalikes', () => {
    // Renders identically in most fonts; a plain comparison never matches.
    expect(normaliseIdentity('Fаrtcоin')).toBe('fartcoin');
  });
});

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    expect(editDistance('fartcoin', 'fartcoin')).toBe(0);
  });

  it('counts single edits', () => {
    expect(editDistance('fartcoin', 'fartcoins')).toBe(1);
    expect(editDistance('fartcoin', 'fartco1n')).toBe(1);
  });

  it('exits early past the cap', () => {
    expect(editDistance('abc', 'xyzxyzxyz', 2)).toBeGreaterThan(2);
  });
});

describe('detectImpersonation', () => {
  it('finds nothing for an unrelated token', () => {
    const report = detectImpersonation(newcomer({}), [established]);
    expect(report.matches).toHaveLength(0);
    expect(report.risk).toBe(0);
    expect(report.summary).toContain('No impersonation');
  });

  it('flags a reused avatar as the strongest signal', () => {
    // Almost never innocent when the other token is older and larger.
    const report = detectImpersonation(newcomer({ imageHash: 'hash-abc' }), [established]);
    expect(report.matches[0]).toMatchObject({ kind: 'avatar-reuse', otherIsOlder: true });
    expect(report.risk).toBeGreaterThan(50);
    expect(report.summary).toContain('share this image');
  });

  it('flags an exact name collision', () => {
    const report = detectImpersonation(newcomer({ name: 'Fartcoin' }), [established]);
    expect(report.matches[0]?.kind).toBe('name-collision');
  });

  it('flags a homoglyph name above a plain collision', () => {
    // Substituting lookalike characters is deliberate in a way that sharing a
    // common word is not, so it scores higher.
    const homoglyph = detectImpersonation(newcomer({ name: 'F4rtc01n' }), [established]);
    const plain = detectImpersonation(newcomer({ name: 'Fartcoin' }), [established]);
    expect(homoglyph.matches[0]?.kind).toBe('homoglyph');
    expect(homoglyph.risk).toBeGreaterThan(plain.risk);
  });

  it('flags a ticker collision', () => {
    const report = detectImpersonation(newcomer({ symbol: 'FARTCOIN' }), [established]);
    expect(report.matches[0]?.kind).toBe('symbol-collision');
  });

  it('flags a near-miss name', () => {
    const report = detectImpersonation(newcomer({ name: 'Fartcoinn' }), [established]);
    expect(report.matches[0]).toMatchObject({ kind: 'near-miss' });
  });

  it('ignores near-misses on short names, where collisions are coincidence', () => {
    const short: TokenIdentity = { address: 'A', name: 'Doge', symbol: 'DOGE', createdAt: 1 };
    const report = detectImpersonation(newcomer({ name: 'Dose' }), [short]);
    expect(report.matches).toHaveLength(0);
  });

  it('ignores single-character tickers', () => {
    const one: TokenIdentity = { address: 'A', name: 'Alpha', symbol: 'A', createdAt: 1 };
    const report = detectImpersonation(newcomer({ symbol: 'A' }), [one]);
    expect(report.matches).toHaveLength(0);
  });

  it('never compares a token against itself', () => {
    const report = detectImpersonation(established, [established]);
    expect(report.matches).toHaveLength(0);
  });

  it('weights a match against a larger token more heavily', () => {
    const small: TokenIdentity = { ...established, address: 'Sm4ll', marketCapUsd: 5_000 };
    const big = detectImpersonation(newcomer({ imageHash: 'hash-abc' }), [established]);
    const tiny = detectImpersonation(newcomer({ imageHash: 'hash-abc' }), [small]);
    expect(big.risk).toBeGreaterThan(tiny.risk);
  });

  it('discounts a match against a newer token', () => {
    // If the other token came second, it may be the impersonator.
    const newer: TokenIdentity = { ...established, createdAt: 1_900_000_000_000 };
    const older = detectImpersonation(newcomer({ imageHash: 'hash-abc' }), [established]);
    const reversed = detectImpersonation(newcomer({ imageHash: 'hash-abc' }), [newer]);
    expect(older.risk).toBeGreaterThan(reversed.risk);
  });

  it('accumulates risk across several impersonated tokens', () => {
    const second: TokenIdentity = { ...established, address: 'Second11', name: 'Fartcoin' };
    const report = detectImpersonation(newcomer({ name: 'Fartcoin' }), [established, second]);
    expect(report.matches).toHaveLength(2);
  });

  it('caps risk at 100', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...established,
      address: `Addr${i}`,
    }));
    const report = detectImpersonation(newcomer({ imageHash: 'hash-abc' }), many);
    expect(report.risk).toBe(100);
  });

  it('does not match on an absent image hash', () => {
    // Two tokens with no avatar are not sharing one.
    const noImage: TokenIdentity = { ...established, imageHash: undefined };
    const report = detectImpersonation(newcomer({ imageHash: undefined }), [noImage]);
    expect(report.matches.some((m) => m.kind === 'avatar-reuse')).toBe(false);
  });
});
