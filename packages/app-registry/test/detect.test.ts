import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_INDEX,
  BUILT_IN_PLATFORMS,
  PlatformIndex,
  attributePlatform,
  decodeErc8021,
  detectPlatform,
  mergePlatformRegistries,
  parsePlatformRegistry,
  platformIndexWith,
  solanaTxFacts,
  type EvmTxFacts,
  type SolanaTxFacts,
} from '../src';

/**
 * Recorded 2026-10-03, read-only: Solana `getTransaction` answers (jsonParsed, maxSupportedTransactionVersion 1) and
 * EVM transactions with their receipts. Each file names the platform the transaction was placed through (`expect`)
 * and the evidence the detector found when it was recorded.
 */
interface SolanaFixture { signature: string; version: unknown; expect: string | null; evidence: string | null; result: unknown }
interface EvmFixture { chain: string; expect: string | null; evidence: string | null; tx: { hash: string; from: string; to: string | null; input: string }; receipt: { status: string; logs: { address: string; topics: string[]; data: string }[] } }

const dir = (kind: 'solana' | 'evm') => new URL(`./fixtures/${kind}/`, import.meta.url);
const read = <T>(kind: 'solana' | 'evm', name: string): T => JSON.parse(readFileSync(new URL(name, dir(kind)), 'utf8')) as T;
const solanaFixtures = readdirSync(dir('solana')).filter((f) => f.endsWith('.json'));
const evmFixtures = readdirSync(dir('evm')).filter((f) => f.endsWith('.json'));
const facts = (name: string): SolanaTxFacts => solanaTxFacts(read<SolanaFixture>('solana', name).result)!;
const evmFacts = (fx: EvmFixture): EvmTxFacts => ({ chain: fx.chain, hash: fx.tx.hash, from: fx.tx.from, to: fx.tx.to, input: fx.tx.input, logs: fx.receipt.logs, failed: fx.receipt.status !== '0x1' });

/** The transaction with `wallet`'s credit cut to `lamports` and every token credit to it (or its token accounts) removed. */
function squash(tx: SolanaTxFacts, wallet: string, lamports = 1n): SolanaTxFacts {
  const at = tx.accountKeys.indexOf(wallet);
  const postLamports = tx.postLamports.map((v, i) => (i === at && v > (tx.preLamports[i] ?? 0n) ? (tx.preLamports[i] ?? 0n) + lamports : v));
  const owned = (b: { accountIndex: number; owner: string | null }) => b.owner === wallet || b.accountIndex === at;
  const postTokenBalances = tx.postTokenBalances.map((b) => {
    if (!owned(b)) return b;
    const pre = tx.preTokenBalances.find((p) => p.accountIndex === b.accountIndex && p.mint === b.mint)?.amount ?? 0n;
    return b.amount > pre ? { ...b, amount: pre } : b;
  });
  return { ...tx, postLamports, postTokenBalances };
}

describe('recorded Solana transactions', () => {
  it('has a fixture for every file it expects', () => {
    expect(solanaFixtures.length).toBe(20);
    expect(evmFixtures.length).toBe(11);
  });

  it.each(solanaFixtures)('%s', (name) => {
    const fx = read<SolanaFixture>('solana', name);
    const tx = solanaTxFacts(fx.result);
    expect(tx).not.toBeNull();
    const got = attributePlatform(tx!);
    expect(got?.platform ?? null).toBe(fx.expect);
    expect(got ? `${got.by} ${got.evidence}` : null).toBe(fx.evidence);
  });

  it('reads v1 transactions like v0 and legacy ones', () => {
    for (const name of ['axiom-flashx-v1.json', 'padre-v1.json', 'bonkbot-bbrouter-v1.json', 'maestro-v1.json', 'banana-v1.json']) {
      expect(read<SolanaFixture>('solana', name).version).toBe(1);
    }
    expect(facts('axiom-flashx-v1.json').outerPrograms).toContain('FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9');
  });

  it('reads the json encoding, lookup-table keys after the static ones', () => {
    const fx = read<SolanaFixture & { result: { transaction: { message: { accountKeys: string[] } }; meta: { loadedAddresses: { writable: string[]; readonly: string[] } } } }>('solana', 'trojan-v0-encoding-json.json');
    const tx = solanaTxFacts(fx.result)!;
    const loaded = fx.result.meta.loadedAddresses;
    expect(tx.accountKeys).toEqual([...fx.result.transaction.message.accountKeys, ...loaded.writable, ...loaded.readonly]);
    expect(tx.preLamports.length).toBe(tx.accountKeys.length);
    expect(detectPlatform(tx)).toBe('trojan');
  });

  it('carries the signature and the network fee when the answer has them', () => {
    const fx = read<SolanaFixture>('solana', 'photon.json');
    const tx = solanaTxFacts(fx.result)!;
    expect(tx.signature).toBe(fx.signature);
    expect(tx.fee).toBeGreaterThan(0n);
    expect(tx.failed).toBe(false);
  });

  it('counts a fee credit only from 0.1 % of the leg: dust falls back to the router, or to nothing on a shared one', () => {
    const photon = facts('photon.json');
    const photonFee = read<SolanaFixture>('solana', 'photon.json').evidence!.split(' ')[1]!;
    expect(attributePlatform(squash(photon, photonFee))).toEqual({ platform: 'photon', by: 'program', evidence: 'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW' });
    // BONKbot's routers are shared with Telemetry: without its fee the router says nothing.
    const bonk = facts('bonkbot-bbrouter-v1.json');
    const bonkFee = read<SolanaFixture>('solana', 'bonkbot-bbrouter-v1.json').evidence!.split(' ')[1]!;
    const owner = bonk.postTokenBalances.find((b) => bonk.accountKeys[b.accountIndex] === bonkFee)?.owner;
    expect(attributePlatform(squash(squash(bonk, bonkFee), owner ?? bonkFee))).toBeNull();
  });

  it('tells the platforms of a shared router apart by their fee wallets', () => {
    expect(detectPlatform(facts('bonkbot-cxvks-v1.json'))).toBe('bonkbot');
    expect(detectPlatform(facts('telemetry-shared-router-v1.json'))).toBe('telemetry');
  });

  it("takes a 38-lamport fee on a dust sell as the platform's: the leg is the pool's 3,868 lamports, not the tip beside it", () => {
    expect(attributePlatform(facts('gmgn-dust-sell-pumpswap.json'))?.by).toBe('fee-wallet');
  });

  it('never takes a signer for a fee wallet', () => {
    const tx = facts('photon.json');
    const fee = read<SolanaFixture>('solana', 'photon.json').evidence!.split(' ')[1]!;
    expect(attributePlatform({ ...tx, signers: [...tx.signers, fee] })?.by).toBe('program');
  });

  it("names a relayer's platform when its fee is not in the transaction", () => {
    const tx = facts('fomo-fee.json');
    const fee = read<SolanaFixture>('solana', 'fomo-fee.json').evidence!.split(' ')[1]!;
    expect(attributePlatform(squash(tx, fee))).toEqual({ platform: 'fomo', by: 'fee-payer', evidence: 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51' });
  });

  it('ignores excluded addresses even when an override lists one as a fee wallet', () => {
    const tx = facts('photon.json');
    const fee = read<SolanaFixture>('solana', 'photon.json').evidence!.split(' ')[1]!;
    const override = parsePlatformRegistry({ platforms: [{ id: 'photon', name: 'Photon', short: 'PH', kind: 'terminal', confidence: 'high', solana: { programs: ['BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW'], feeWallets: [fee] } }], exclusions: { solana: [fee] } });
    const index = new PlatformIndex(mergePlatformRegistries(BUILT_IN_PLATFORMS, override));
    expect(index.solanaFeeWallet(fee)).toBeNull();
    // Only the router is left to say it.
    expect(attributePlatform(tx, { index })?.by).toBe('program');
  });

  it('reports a failed transaction and an unknown shape as nothing', () => {
    expect(detectPlatform({ ...facts('axiom-flashx-v1.json'), failed: true })).toBeNull();
    expect(solanaTxFacts(null)).toBeNull();
    expect(solanaTxFacts({ transaction: ['AAAA', 'base64'], meta: {} })).toBeNull();
    expect(solanaTxFacts({ transaction: { message: { accountKeys: [] } }, meta: null })).toBeNull();
  });

  it('uses the built-in registry when it is given no index', () => {
    const tx = facts('axiom-flashx-v1.json');
    expect(attributePlatform(tx)).toEqual(attributePlatform(tx, { index: BUILT_IN_INDEX }));
    // With an empty registry nothing is known, so nothing is named.
    const empty = new PlatformIndex(parsePlatformRegistry({ platforms: [] }).registry);
    expect(attributePlatform(tx, { index: empty })).toBeNull();
  });
});

describe('a platform of your own (Solana)', () => {
  const TRADER = 'Trader1111111111111111111111111111111111111';
  const POOL = 'Poo1111111111111111111111111111111111111111';
  const FEE = 'MineFee111111111111111111111111111111111111';
  const REFERRAL = 'MineRef111111111111111111111111111111111111';
  const REF_TOKEN_ACCOUNT = 'RefTok11111111111111111111111111111111111111';
  const RELAYER = 'MineRe1ay1111111111111111111111111111111111';
  const ROUTER = 'MineRouter111111111111111111111111111111111';
  const AGGREGATOR = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const WSOL = 'So11111111111111111111111111111111111111112';
  const MINT = 'Mint111111111111111111111111111111111111111';
  const { index: mine, issues } = platformIndexWith({
    platforms: [{ id: 'mine', name: 'Mine', kind: 'terminal', chains: ['sol'], solana: { programs: [ROUTER], feeWallets: [FEE, REFERRAL], feePayers: [RELAYER] }, confidence: 'high' }],
  });
  const base = (fee: bigint): SolanaTxFacts => ({
    chain: 'sol',
    accountKeys: [TRADER, POOL, FEE, REF_TOKEN_ACCOUNT, 'TraderTok111111111111111111111111111111111'],
    signers: [TRADER],
    outerPrograms: [AGGREGATOR],
    preLamports: [10_000_000_000n, 50_000_000_000n, 1_000_000n, 2_039_280n, 2_039_280n],
    postLamports: [9_000_000_000n - fee, 51_000_000_000n, 1_000_000n + fee, 2_039_280n, 2_039_280n],
    preTokenBalances: [{ accountIndex: 4, mint: MINT, owner: TRADER, amount: 0n }],
    postTokenBalances: [{ accountIndex: 4, mint: MINT, owner: TRADER, amount: 5_000_000n }],
    failed: false,
  });

  it('accepts the entry whole', () => {
    expect(issues).toEqual([]);
  });

  it('knows the fee wallet from 0.1 % of the trade, and not from dust', () => {
    expect(attributePlatform(base(5_000_000n), { index: mine })).toEqual({ platform: 'mine', by: 'fee-wallet', evidence: FEE });
    expect(attributePlatform(base(1n), { index: mine })).toBeNull();
    // The built-in registry has never heard of it.
    expect(attributePlatform(base(5_000_000n))).toBeNull();
  });

  it('caps the SOL minimum at 10,000 lamports, however large the trade', () => {
    // A 1 SOL trade: 0.1 % would be 1,000,000 lamports; the cap makes 10,000 enough and 9,999 too little.
    expect(attributePlatform(base(10_000n), { index: mine })?.by).toBe('fee-wallet');
    expect(attributePlatform(base(9_999n), { index: mine })).toBeNull();
  });

  it('knows a token account owned by a listed wallet', () => {
    const tx: SolanaTxFacts = {
      ...base(0n),
      preTokenBalances: [...base(0n).preTokenBalances, { accountIndex: 3, mint: WSOL, owner: REFERRAL, amount: 0n }],
      postTokenBalances: [...base(0n).postTokenBalances, { accountIndex: 3, mint: WSOL, owner: REFERRAL, amount: 2_000_000n }],
    };
    expect(attributePlatform(tx, { index: mine })).toEqual({ platform: 'mine', by: 'fee-wallet', evidence: REFERRAL });
  });

  it('does not take a credit in a token the trade never moved for a fee', () => {
    const OTHER = 'Extra11111111111111111111111111111111111111';
    const tx: SolanaTxFacts = {
      ...base(0n),
      preTokenBalances: [...base(0n).preTokenBalances, { accountIndex: 3, mint: OTHER, owner: REFERRAL, amount: 0n }],
      postTokenBalances: [...base(0n).postTokenBalances, { accountIndex: 3, mint: OTHER, owner: REFERRAL, amount: 9_000_000_000n }],
    };
    expect(attributePlatform(tx, { index: mine })).toBeNull();
  });

  it('falls back to the relayer, then to the router, in that order', () => {
    const relayed: SolanaTxFacts = { ...base(0n), accountKeys: [RELAYER, ...base(0n).accountKeys], signers: [RELAYER, TRADER], preLamports: [1_000_000n, ...base(0n).preLamports], postLamports: [995_000n, ...base(0n).postLamports], preTokenBalances: [], postTokenBalances: [] };
    expect(attributePlatform(relayed, { index: mine })).toEqual({ platform: 'mine', by: 'fee-payer', evidence: RELAYER });
    expect(attributePlatform({ ...base(0n), outerPrograms: [AGGREGATOR, ROUTER] }, { index: mine })).toEqual({ platform: 'mine', by: 'program', evidence: ROUTER });
    expect(attributePlatform({ ...base(5_000_000n), outerPrograms: [ROUTER] }, { index: mine })?.by).toBe('fee-wallet');
  });

  it('measures the fee against the named trader when one is given', () => {
    // The fee wallet co-signs here, so by default it is never a fee receiver; naming the trader does not change that.
    const cosigned: SolanaTxFacts = { ...base(5_000_000n), signers: [TRADER, FEE] };
    expect(attributePlatform(cosigned, { index: mine })).toBeNull();
    expect(attributePlatform(cosigned, { index: mine, trader: TRADER })).toBeNull();
    expect(attributePlatform(base(5_000_000n), { index: mine, trader: TRADER })?.platform).toBe('mine');
  });

  it('names nothing for a failed transaction', () => {
    expect(attributePlatform({ ...base(5_000_000n), failed: true }, { index: mine })).toBeNull();
  });
});

describe('recorded EVM transactions', () => {
  it.each(evmFixtures)('%s', (name) => {
    const fx = read<EvmFixture>('evm', name);
    const got = attributePlatform(evmFacts(fx));
    expect(got?.platform ?? null).toBe(fx.expect);
    expect(got ? `${got.by} ${got.evidence}` : null).toBe(fx.evidence);
  });

  it('decodes ERC-8021 builder codes and attributes by them when the router is not listed', () => {
    const fx = read<EvmFixture>('evm', 'gmgn-base-router.json');
    expect(decodeErc8021(fx.tx.input)).toEqual(['bc_ipu1jetp']);
    expect(attributePlatform({ ...evmFacts(fx), to: '0x000000000000000000000000000000000000dead' })).toEqual({ platform: 'gmgn', by: 'builder-code', evidence: 'bc_ipu1jetp' });
    expect(decodeErc8021(read<EvmFixture>('evm', 'sigma-base.json').tx.input)).toEqual(['bc_01u2zjcc']);
    expect(decodeErc8021(read<EvmFixture>('evm', 'gmgn-eth-router.json').tx.input)).toBeNull();
    expect(decodeErc8021('0x1234')).toBeNull();
    expect(decodeErc8021(null)).toBeNull();
  });

  it('decodes a suffix with several codes, and refuses one that is not text', () => {
    const marker = '80218021802180218021802180218021';
    const hex = (text: string) => [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const suffix = (codes: string) => `${hex(codes)}${(codes.length).toString(16).padStart(2, '0')}00${marker}`;
    expect(decodeErc8021(`0xabcdef12${suffix('one,Two')}`)).toEqual(['one', 'two']);
    expect(decodeErc8021(`0xabcdef12${'0001'}${'02'}00${marker}`)).toBeNull();
    // Another schema byte is not schema 0.
    expect(decodeErc8021(`0xabcdef12${hex('one')}0301${marker}`)).toBeNull();
  });

  it('attributes rotating routers by the selector', () => {
    const fx = read<EvmFixture>('evm', 'sigma-eth.json');
    expect(attributePlatform({ ...evmFacts(fx), to: '0x000000000000000000000000000000000000beef' })).toEqual({ platform: 'sigma', by: 'selector', evidence: '0x08c1284c' });
  });
});

describe('a platform of your own (EVM)', () => {
  const FEE = '0x00000000000000000000000000000000000000aa';
  const SENDER = '0x00000000000000000000000000000000000000bb';
  const ROUTER = '0x00000000000000000000000000000000000000cc';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const { index: mine } = platformIndexWith({
    platforms: [{ id: 'mine', name: 'Mine', kind: 'terminal', chains: ['base'], evm: { feeWallets: [FEE], routers: { base: [ROUTER] }, builderCodes: ['mine_code'], selectors: { base: ['0x12345678'] } }, confidence: 'high' }],
  });
  const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
  const transfer = (to: string, value: bigint) => ({ address: USDC, topics: [TRANSFER, topic('0x0000000000000000000000000000000000000001'), topic(to)], data: `0x${value.toString(16).padStart(64, '0')}` });
  const tx: EvmTxFacts = { chain: 'base', from: SENDER, to: '0x0000000000001ff3684f28c67538d4d072c22734', input: '0x2213bc0b', logs: [transfer(SENDER, 1_000_000_000n), transfer(FEE, 5_000_000n)] };

  it('knows the fee recipient in a swap through an aggregator, and not the sender paying itself', () => {
    expect(attributePlatform(tx, { index: mine })).toEqual({ platform: 'mine', by: 'fee-wallet', evidence: FEE });
    expect(attributePlatform({ ...tx, from: FEE }, { index: mine })).toBeNull();
    expect(attributePlatform({ ...tx, failed: true }, { index: mine })).toBeNull();
    expect(attributePlatform(tx)).toBeNull();
  });

  it('counts a fee from 0.001 % of the largest transfer of that token', () => {
    const at = (fee: bigint): EvmTxFacts => ({ ...tx, logs: [transfer(SENDER, 1_000_000_000n), transfer(FEE, fee)] });
    expect(attributePlatform(at(10_000n), { index: mine })?.by).toBe('fee-wallet');
    expect(attributePlatform(at(9_999n), { index: mine })).toBeNull();
  });

  it('falls back to the router, the builder code, then the selector', () => {
    const bare: EvmTxFacts = { chain: 'base', from: SENDER, to: ROUTER, input: '0x2213bc0b' };
    expect(attributePlatform(bare, { index: mine })).toEqual({ platform: 'mine', by: 'router', evidence: ROUTER });
    // The same router address on another chain is another contract.
    expect(attributePlatform({ ...bare, chain: 'eth' }, { index: mine })).toBeNull();
    const code = [...'mine_code'].map((c) => c.charCodeAt(0).toString(16)).join('');
    const coded = `0x2213bc0b${code}0900${'80218021802180218021802180218021'}`;
    expect(attributePlatform({ ...bare, to: SENDER, input: coded }, { index: mine })).toEqual({ platform: 'mine', by: 'builder-code', evidence: 'mine_code' });
    expect(attributePlatform({ ...bare, to: SENDER, input: '0x12345678ff' }, { index: mine })).toEqual({ platform: 'mine', by: 'selector', evidence: '0x12345678' });
    expect(attributePlatform({ ...bare, to: null, input: null }, { index: mine })).toBeNull();
  });
});
