/**
 * Which platform placed a transaction, from the transaction alone (pure).
 *
 * Solana (the approach of solana-dex-parser's bot detection, with a minimum
 * credit added so that presence alone never attributes):
 *  1. A fee wallet decides: a listed wallet, a listed token account, or a
 *     token account owned by a listed wallet GAINS in the transaction at least
 *     0.1 % of the trade's leg in that mint (SOL and WSOL: 0.1 % of the SOL
 *     leg, at most 10,000 lamports). Presence alone never counts, dust
 *     (address poisoning) does not reach the minimum, and the signers are
 *     never fee receivers. Shared routers (BONKbot / Telemetry) and
 *     aggregators wallets route through (OKX, Jupiter) are told apart here.
 *  2. A relayer that pays the network fee only for one platform's users.
 *  3. An outer instruction to a router program only one platform invokes.
 *  Addresses in the exclusions (protocol fee accounts, landing tips) never
 *  count. A failed transaction is not a trade: null.
 *
 * EVM: an ERC-20 transfer to a listed fee recipient inside the transaction,
 * then the router (`to`), then an ERC-8021 builder code at the end of the
 * calldata, then a listed function selector.
 *
 * Unknown is null, never a guess.
 */

import { BUILT_IN_INDEX, type PlatformIndex } from './registry';

const WSOL = 'So11111111111111111111111111111111111111112';
/** The most a SOL / WSOL fee credit must be to count, whatever the leg (solana-dex-parser's BotFeeMinLamports). */
export const PLATFORM_FEE_MIN_LAMPORTS = 10_000n;
/** A fee credit counts from 1 / this of the trade's leg in the same mint (0.1 %). */
export const PLATFORM_FEE_MIN_LEG_DIVISOR = 1_000n;
/** On EVM, from 1 / this of the largest transfer of the same token (0.001 %). */
export const EVM_FEE_MIN_LEG_DIVISOR = 100_000n;

export interface SolanaTokenBalanceFact {
  readonly accountIndex: number;
  readonly mint: string;
  /** The token account's owner; null when the node did not say. */
  readonly owner: string | null;
  /** Base units. */
  readonly amount: bigint;
}

/** What the detector reads from a Solana transaction; `solanaTxFacts` builds it from a `getTransaction` answer. */
export interface SolanaTxFacts {
  readonly chain: 'sol';
  readonly signature?: string;
  /** Every account key in position order (static keys, then lookup-table keys for v0; v1 has them all inline). */
  readonly accountKeys: readonly string[];
  /** The keys that signed; the first is the fee payer. */
  readonly signers: readonly string[];
  /** Program ids of the top-level instructions, in order. */
  readonly outerPrograms: readonly string[];
  readonly preLamports: readonly bigint[];
  readonly postLamports: readonly bigint[];
  readonly preTokenBalances: readonly SolanaTokenBalanceFact[];
  readonly postTokenBalances: readonly SolanaTokenBalanceFact[];
  /** The network fee in lamports, when known. */
  readonly fee?: bigint;
  readonly failed: boolean;
}

export interface EvmLogFact {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** What the detector reads from an EVM transaction (and its receipt's logs, when known). */
export interface EvmTxFacts {
  /** Chain id as the registry spells it: `eth`, `base`, `bsc`. */
  readonly chain: string;
  readonly hash?: string;
  readonly from?: string | null;
  readonly to: string | null;
  readonly input?: string | null;
  readonly logs?: readonly EvmLogFact[];
  readonly failed?: boolean;
}

export type PlatformTxFacts = SolanaTxFacts | EvmTxFacts;

export type PlatformEvidence = 'fee-wallet' | 'fee-payer' | 'program' | 'router' | 'builder-code' | 'selector';

export interface PlatformAttribution {
  readonly platform: string;
  readonly by: PlatformEvidence;
  /** The address, program, code or selector that decided. */
  readonly evidence: string;
}

export interface DetectOptions {
  readonly index?: PlatformIndex;
  /** The trader whose legs set the fee minimum; every signer when absent. */
  readonly trader?: string;
}

const isSolana = (tx: PlatformTxFacts): tx is SolanaTxFacts => tx.chain === 'sol';

/** The platform id that placed the transaction, or null. */
export function detectPlatform(tx: PlatformTxFacts, options: DetectOptions = {}): string | null {
  return attributePlatform(tx, options)?.platform ?? null;
}

/** The platform and what decided it, or null. */
export function attributePlatform(tx: PlatformTxFacts, options: DetectOptions = {}): PlatformAttribution | null {
  const index = options.index ?? BUILT_IN_INDEX;
  return isSolana(tx) ? attributeSolana(tx, index, options.trader) : attributeEvm(tx, index);
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

const big = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
};

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function attributeSolana(tx: SolanaTxFacts, index: PlatformIndex, traderHint: string | undefined): PlatformAttribution | null {
  if (tx.failed) return null;
  const keys = tx.accountKeys;
  // The trader: the one named, else every signer (a relayer may pay the fee while the user signs the swap).
  const traders = new Set<string>(traderHint ? [traderHint] : tx.signers);
  const excluded = new Set<string>([...tx.signers, ...traders]);

  // Token deltas per account index and mint; owners per account index.
  const owners = new Map<number, string>();
  const deltas = new Map<string, { index: number; mint: string; delta: bigint }>();
  const key = (i: number, mint: string) => `${i}:${mint}`;
  for (const b of tx.preTokenBalances) {
    if (b.owner) owners.set(b.accountIndex, b.owner);
    deltas.set(key(b.accountIndex, b.mint), { index: b.accountIndex, mint: b.mint, delta: -b.amount });
  }
  for (const b of tx.postTokenBalances) {
    if (b.owner) owners.set(b.accountIndex, b.owner);
    const seen = deltas.get(key(b.accountIndex, b.mint));
    deltas.set(key(b.accountIndex, b.mint), { index: b.accountIndex, mint: b.mint, delta: (seen?.delta ?? 0n) + b.amount });
  }
  const lamportDelta = (i: number): bigint => (tx.postLamports[i] ?? 0n) - (tx.preLamports[i] ?? 0n);

  // The trade's legs: the mints the trader's own token accounts moved (and SOL), each sized by the largest movement of
  // that mint in the transaction (a pool vault or the trader's account), so the tips and network fee paid beside the
  // trade do not inflate it (a 0.000004 SOL sell with a 0.001 SOL tip pays GMGN 38 lamports: that is its fee).
  const traderMints = new Set<string>([WSOL]);
  for (const d of deltas.values()) if (d.delta !== 0n && traders.has(owners.get(d.index) ?? '')) traderMints.add(d.mint);
  const legs = new Map<string, bigint>();
  for (const d of deltas.values()) {
    if (!traderMints.has(d.mint)) continue;
    const v = abs(d.delta);
    if (v > (legs.get(d.mint) ?? 0n)) legs.set(d.mint, v);
  }
  let solLeg = legs.get(WSOL) ?? 0n;
  if (solLeg === 0n && traders.size > 0) {
    // No WSOL moved (a bonding curve takes lamports): the traders' own lamport change, the network fee aside.
    let sol = 0n;
    keys.forEach((k, i) => {
      if (traders.has(k)) sol += lamportDelta(i);
    });
    if (sol < 0n) sol += tx.fee ?? 0n;
    solLeg = abs(sol);
  }
  const minSol = solLeg > 0n ? minOf(ceilDiv(solLeg, PLATFORM_FEE_MIN_LEG_DIVISOR), PLATFORM_FEE_MIN_LAMPORTS) : PLATFORM_FEE_MIN_LAMPORTS;
  /** The smallest credit in a mint that counts as a fee; null for a mint the trade did not move (not a fee). */
  const minFor = (mint: string): bigint | null => {
    if (mint === WSOL) return minSol;
    const leg = legs.get(mint);
    if (leg === undefined || leg <= 0n) return null;
    const min = ceilDiv(leg, PLATFORM_FEE_MIN_LEG_DIVISOR);
    return min > 0n ? min : 1n;
  };
  const tokenCredited = (accept: (index: number) => boolean): boolean => {
    for (const d of deltas.values()) {
      if (d.delta <= 0n || !accept(d.index)) continue;
      const min = minFor(d.mint);
      if (min !== null && d.delta >= min) return true;
    }
    return false;
  };

  // 1. A fee wallet credited, in account-key order (the first match wins).
  const checkedOwners = new Set<string>();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (!k || excluded.has(k) || index.isSolanaExcluded(k)) continue;
    const listed = index.solanaFeeWallet(k);
    if (listed) {
      checkedOwners.add(k);
      if (lamportDelta(i) >= minSol || tokenCredited((j) => j === i) || tokenCredited((j) => owners.get(j) === k)) {
        return { platform: listed.id, by: 'fee-wallet', evidence: k };
      }
    }
    const owner = owners.get(i);
    if (!owner || excluded.has(owner) || checkedOwners.has(owner) || index.isSolanaExcluded(owner)) continue;
    checkedOwners.add(owner);
    const byOwner = index.solanaFeeWallet(owner);
    if (byOwner && tokenCredited((j) => owners.get(j) === owner)) return { platform: byOwner.id, by: 'fee-wallet', evidence: owner };
  }

  // 2. A platform's own relayer paid the network fee.
  const payer = tx.signers[0];
  const relayed = payer ? index.solanaFeePayer(payer) : null;
  if (relayed && payer) return { platform: relayed.id, by: 'fee-payer', evidence: payer };

  // 3. A router program only one platform invokes.
  for (const program of tx.outerPrograms) {
    const hit = index.solanaProgram(program);
    if (hit && !hit.shared) return { platform: hit.platform.id, by: 'program', evidence: program };
  }
  return null;
}

const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);

interface RpcAccountKey {
  readonly pubkey?: unknown;
  readonly signer?: unknown;
}

interface RpcTokenBalance {
  readonly accountIndex?: unknown;
  readonly mint?: unknown;
  readonly owner?: unknown;
  readonly uiTokenAmount?: { readonly amount?: unknown } | null;
}

function tokenBalances(list: unknown): SolanaTokenBalanceFact[] {
  if (!Array.isArray(list)) return [];
  const out: SolanaTokenBalanceFact[] = [];
  for (const raw of list as RpcTokenBalance[]) {
    const amount = big(raw?.uiTokenAmount?.amount);
    if (typeof raw?.accountIndex !== 'number' || typeof raw.mint !== 'string' || amount === null) continue;
    out.push({ accountIndex: raw.accountIndex, mint: raw.mint, owner: typeof raw.owner === 'string' ? raw.owner : null, amount });
  }
  return out;
}

/**
 * The facts of a `getTransaction` answer, `jsonParsed` or `json` encoding,
 * legacy, v0 or v1 (ask with `maxSupportedTransactionVersion: 1`, or v1
 * transactions do not come back at all). Null for a shape it cannot read
 * (base58/base64 encodings, a missing meta).
 */
export function solanaTxFacts(result: unknown): SolanaTxFacts | null {
  const r = result as {
    transaction?: { signatures?: unknown; message?: { accountKeys?: unknown; header?: { numRequiredSignatures?: unknown }; instructions?: unknown } };
    meta?: { err?: unknown; fee?: unknown; preBalances?: unknown; postBalances?: unknown; preTokenBalances?: unknown; postTokenBalances?: unknown; loadedAddresses?: { writable?: unknown; readonly?: unknown } | null } | null;
  } | null;
  const message = r?.transaction?.message;
  const meta = r?.meta;
  if (!message || !meta || !Array.isArray(message.accountKeys)) return null;
  const rawKeys = message.accountKeys as unknown[];
  const parsed = rawKeys.length > 0 && typeof rawKeys[0] === 'object';
  let keys: string[];
  let signers: string[];
  if (parsed) {
    keys = (rawKeys as RpcAccountKey[]).map((k) => (typeof k?.pubkey === 'string' ? k.pubkey : ''));
    signers = (rawKeys as RpcAccountKey[]).filter((k) => k?.signer === true).map((k) => String(k.pubkey));
  } else {
    keys = rawKeys.map((k) => (typeof k === 'string' ? k : ''));
    const required = typeof message.header?.numRequiredSignatures === 'number' ? message.header.numRequiredSignatures : 1;
    signers = keys.slice(0, required);
    // `json` encoding lists the lookup-table keys apart: writable, then read-only, after the static keys.
    const loaded = meta.loadedAddresses;
    if (loaded) {
      for (const list of [loaded.writable, loaded.readonly]) if (Array.isArray(list)) for (const k of list) keys.push(typeof k === 'string' ? k : '');
    }
  }
  const outerPrograms: string[] = [];
  if (Array.isArray(message.instructions)) {
    for (const ix of message.instructions as { programId?: unknown; programIdIndex?: unknown }[]) {
      const program = typeof ix?.programId === 'string' ? ix.programId : typeof ix?.programIdIndex === 'number' ? keys[ix.programIdIndex] : undefined;
      if (program) outerPrograms.push(program);
    }
  }
  const lamports = (list: unknown): bigint[] => (Array.isArray(list) ? list.map((v) => big(v) ?? 0n) : []);
  const signatures = r?.transaction?.signatures;
  const signature = Array.isArray(signatures) && typeof signatures[0] === 'string' ? signatures[0] : undefined;
  return {
    chain: 'sol',
    ...(signature ? { signature } : {}),
    accountKeys: keys,
    signers,
    outerPrograms,
    preLamports: lamports(meta.preBalances),
    postLamports: lamports(meta.postBalances),
    preTokenBalances: tokenBalances(meta.preTokenBalances),
    postTokenBalances: tokenBalances(meta.postTokenBalances),
    ...(big(meta.fee) !== null ? { fee: big(meta.fee)! } : {}),
    failed: meta.err !== null && meta.err !== undefined,
  };
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** ERC-8021: the calldata ends with this marker (16 bytes). */
export const ERC8021_MARKER = '80218021802180218021802180218021';

const topicAddress = (topic: string | undefined): string | null => (topic && /^0x[0-9a-fA-F]{64}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null);

function wordValue(data: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(data)) return null;
  try {
    return BigInt(data);
  } catch {
    return null;
  }
}

/**
 * The builder codes an ERC-8021 suffix carries (schema 0: ASCII codes,
 * comma separated, then their length in one byte, then the schema byte 0x00,
 * then the 16-byte marker), or null when the calldata has none or another
 * schema.
 */
export function decodeErc8021(input: string | null | undefined): string[] | null {
  if (!input) return null;
  const hex = input.startsWith('0x') || input.startsWith('0X') ? input.slice(2) : input;
  if (hex.length < ERC8021_MARKER.length + 4 || hex.length % 2 !== 0) return null;
  if (hex.slice(-ERC8021_MARKER.length).toLowerCase() !== ERC8021_MARKER) return null;
  const body = hex.slice(0, -ERC8021_MARKER.length);
  if (body.slice(-2) !== '00') return null;
  const length = parseInt(body.slice(-4, -2), 16);
  if (!Number.isFinite(length) || length <= 0 || body.length < 4 + length * 2) return null;
  const codesHex = body.slice(-4 - length * 2, -4);
  let text = '';
  for (let i = 0; i < codesHex.length; i += 2) {
    const code = parseInt(codesHex.slice(i, i + 2), 16);
    if (code < 0x20 || code > 0x7e) return null;
    text += String.fromCharCode(code);
  }
  const codes = text.split(',').map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0);
  return codes.length > 0 ? codes : null;
}

function attributeEvm(tx: EvmTxFacts, index: PlatformIndex): PlatformAttribution | null {
  if (tx.failed) return null;
  const chain = tx.chain.toLowerCase();
  const from = tx.from?.toLowerCase() ?? null;

  // 1. A fee recipient credited inside the transaction: at least 0.001 % of the largest transfer of the same token
  // (a wallet's integrator fee can be a few hundredths of a percent; address poisoning happens in transactions of its own).
  const transfers: { token: string; to: string; value: bigint }[] = [];
  for (const log of tx.logs ?? []) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const to = topicAddress(log.topics[2]);
    const value = wordValue(log.data);
    if (!to || value === null) continue;
    transfers.push({ token: log.address.toLowerCase(), to, value });
  }
  for (const t of transfers) {
    if (t.value <= 0n || t.to === from || index.isEvmExcluded(t.to)) continue;
    const listed = index.evmFeeWallet(t.to);
    if (!listed) continue;
    const largest = transfers.filter((o) => o.token === t.token).reduce((m, o) => (o.value > m ? o.value : m), 0n);
    if (t.value * EVM_FEE_MIN_LEG_DIVISOR >= largest) return { platform: listed.id, by: 'fee-wallet', evidence: t.to };
  }

  // 2. The platform's router.
  const router = index.evmRouter(chain, tx.to);
  if (router && tx.to) return { platform: router.id, by: 'router', evidence: tx.to.toLowerCase() };

  // 3. An ERC-8021 builder code the platform registered.
  for (const code of decodeErc8021(tx.input) ?? []) {
    const coded = index.builderCode(code);
    if (coded) return { platform: coded.id, by: 'builder-code', evidence: code };
  }

  // 4. A selector only the platform's (rotating) routers expose.
  const input = tx.input ?? '';
  if (/^0x[0-9a-fA-F]{8}/.test(input)) {
    const selector = input.slice(0, 10).toLowerCase();
    const bySelector = index.evmSelector(chain, selector);
    if (bySelector) return { platform: bySelector.id, by: 'selector', evidence: selector };
  }
  return null;
}
