/**
 * A token's holders, read from a plain RPC endpoint.
 *
 * There are two ways to ask a node who holds a token, and neither is served
 * everywhere:
 *
 * - **A scan** (`getProgramAccounts` on the token program, filtered by mint)
 *   returns every token account of the mint. It gives every holder and a real
 *   holder count, in one call. Its answer grows with the number of holders, so
 *   a node refuses it, or the answer passes the client's size cap, for a
 *   widely held token.
 * - **The largest accounts** (`getTokenLargestAccounts`) returns twenty
 *   accounts at most, whatever the token's size. Many public endpoints refuse
 *   the call.
 *
 * `readHolders` tries the scan first and falls back to the largest accounts.
 * When neither is served it throws `HoldersUnavailable` with both reasons: a
 * failed read is never an empty holder list.
 *
 * Only the owner and the amount of each account are asked for (40 bytes an
 * account), which is what keeps a scan small enough to be served at all.
 */

import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, base58Encode, isAddress, type Rpc } from '@soltoolkit/rpc';
import { classifyOwner, readTokenFacts, type HolderKind, type TokenFacts } from '@soltoolkit/token-safety';

/** Where the holder list came from, or which way to read it. */
export type HolderSource = 'auto' | 'scan' | 'largest';

export interface MapHolder {
  /** The address that owns the token accounts. */
  readonly owner: string;
  /** Raw token units, summed over the owner's accounts. */
  readonly amount: bigint;
  /** Share of the supply in percent; `null` when the supply is zero. */
  readonly pct: number | null;
  /** `wallet`, `pda`, `program`, `pool` or `burn`. */
  readonly kind: HolderKind;
  /** For `program`: the program the owner belongs to. For `pool`: the pool program's name. */
  readonly label?: string;
  /** How many of the token accounts that were read belong to this owner. */
  readonly accounts: number;
}

export interface HolderList {
  readonly mint: string;
  readonly tokenProgram: TokenFacts['tokenProgram'];
  readonly decimals: number;
  /** Raw units. */
  readonly supply: bigint;
  /** How the list was read. */
  readonly source: 'scan' | 'largest';
  /** Largest first, `limit` at most. Pools, programs and burn addresses are in the list, marked by kind. */
  readonly holders: readonly MapHolder[];
  /**
   * How many addresses hold the token. Known from a scan only; `null` when the
   * list is the owners of the largest accounts.
   */
  readonly holderCount: number | null;
  /** What the list is not, and why. */
  readonly notes: readonly string[];
}

export interface ReadHoldersOptions {
  /**
   * `auto` (default) scans, and reads the largest accounts when the scan
   * fails. `scan` and `largest` use one way only.
   */
  readonly source?: HolderSource;
  /** Holders returned at most. Default 100. */
  readonly limit?: number;
  /** Owners to treat as pools: exchange wallets, lockers, or pool authorities this package does not know. */
  readonly poolOwners?: readonly string[];
  /** Default `confirmed`. */
  readonly commitment?: 'processed' | 'confirmed' | 'finalized';
  /** How long the scan may take. Default 30 seconds. It is asked once: a scan that failed is not tried again. */
  readonly scanTimeoutMs?: number;
}

/** No way of reading the holders worked. `reasons` has one entry for each way that was tried. */
export class HoldersUnavailable extends Error {
  constructor(
    readonly mint: string,
    readonly reasons: readonly string[],
  ) {
    super(`The holders of ${mint} could not be read. ${reasons.join(' ')}`);
    this.name = 'HoldersUnavailable';
  }
}

export const DEFAULT_HOLDER_LIMIT = 100;
export const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

/** A token account without extensions; a classic SPL token account is always this size. */
const TOKEN_ACCOUNT_SIZE = 165;
/** A multisig account. Token-2022 never gives a token account this size, so the two can be told apart. */
const MULTISIG_SIZE = 355;
/** Where the owner starts in a token account; the amount follows it. */
const OWNER_OFFSET = 32;
/** Owner (32 bytes) and amount (8 bytes). */
const SLICE_LENGTH = 40;
/** The most accounts `getMultipleAccounts` takes in one call. */
const ACCOUNTS_PER_CALL = 100;

/**
 * Reads the holders of a token.
 *
 * Returns `null` when the address is not a token mint. Throws
 * `HoldersUnavailable` when the mint was read but its holders could not be.
 */
export async function readHolders(rpc: Rpc, mint: string, options: ReadHoldersOptions = {}): Promise<HolderList | null> {
  if (!isAddress(mint)) throw new Error(`Not a Solana address: ${mint}`);
  const source = options.source ?? 'auto';
  const limit = options.limit ?? DEFAULT_HOLDER_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a whole number, 1 or more');
  const commitment = options.commitment ?? 'confirmed';
  const pools = new Set(options.poolOwners ?? []);
  const reasons: string[] = [];

  if (source !== 'largest') {
    const facts = await readTokenFacts(rpc, mint, { holders: false, commitment });
    if (!facts) return null;
    try {
      return await scanHolders(rpc, facts, limit, pools, commitment, options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS);
    } catch (error) {
      reasons.push(`Scan: ${message(error)}.`);
      if (source === 'scan') throw new HoldersUnavailable(mint, reasons);
    }
  }

  const facts = await readTokenFacts(rpc, mint, { holders: true, poolOwners: [...pools], commitment });
  if (!facts) return null;
  if (!facts.holders) {
    const why = facts.notes.find((note) => note.startsWith('Holders not read'))?.replace(/^Holders not read:\s*/, '') ?? 'not read.';
    throw new HoldersUnavailable(mint, [...reasons, `Largest accounts: ${why}`]);
  }
  const holders: MapHolder[] = facts.holders.holders.slice(0, limit).map((holder) => ({
    owner: holder.owner,
    amount: holder.amount,
    pct: share(holder.amount, facts.supply),
    kind: holder.kind,
    ...(holder.label ? { label: holder.label } : {}),
    accounts: holder.accounts,
  }));
  return {
    mint,
    tokenProgram: facts.tokenProgram,
    decimals: facts.decimals,
    supply: facts.supply,
    source: 'largest',
    holders,
    holderCount: null,
    notes: [...reasons, 'The list is the owners of the largest token accounts (twenty accounts at most), so it may not be every holder.'],
  };
}

async function scanHolders(rpc: Rpc, facts: TokenFacts, limit: number, pools: ReadonlySet<string>, commitment: string, timeoutMs: number): Promise<HolderList> {
  const classic = facts.tokenProgram === 'spl-token';
  const filters: unknown[] = [{ memcmp: { offset: 0, bytes: facts.mint } }];
  // Every classic token account is one size, so the node can skip the rest of the program's accounts.
  if (classic) filters.push({ dataSize: TOKEN_ACCOUNT_SIZE });
  const answer = await rpc.call<unknown>(
    'getProgramAccounts',
    [classic ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM, { encoding: 'base64', commitment, dataSlice: { offset: OWNER_OFFSET, length: SLICE_LENGTH }, filters }],
    { timeoutMs, retries: 0 },
  );
  // With `withContext` a node wraps the list; without it the list is the answer.
  const entries = Array.isArray(answer) ? answer : record(answer)?.['value'];
  if (!Array.isArray(entries)) throw new Error('getProgramAccounts: the answer has no account list');

  const byOwner = new Map<string, { amount: bigint; accounts: number }>();
  let total = 0n;
  for (const entry of entries) {
    const account = record(record(entry)?.['account']);
    const data = account?.['data'];
    const encoded = Array.isArray(data) && data[1] === 'base64' ? data[0] : null;
    if (typeof encoded !== 'string') throw new Error('getProgramAccounts: an entry has no base64 data');
    // The first 32 bytes of another kind of account can equal the mint by design (a multisig lists any keys it
    // likes). Where the node reports the account's size, only the sizes a token account can have are counted.
    const space = account?.['space'];
    if (typeof space === 'number' && !(space === TOKEN_ACCOUNT_SIZE || (!classic && space > TOKEN_ACCOUNT_SIZE && space !== MULTISIG_SIZE))) continue;
    const bytes = decodeBase64(encoded);
    if (bytes.length !== SLICE_LENGTH) throw new Error('getProgramAccounts: an entry is not the 40 bytes that were asked for');
    const amount = readU64(bytes, 32);
    if (amount === 0n) continue; // an empty account is not a holding
    const owner = base58Encode(bytes.subarray(0, 32));
    const seen = byOwner.get(owner) ?? { amount: 0n, accounts: 0 };
    byOwner.set(owner, { amount: seen.amount + amount, accounts: seen.accounts + 1 });
    total += amount;
  }
  // Token accounts never hold more than the supply. More means the scan counted something that is not a holding,
  // or the supply changed between the two reads; either way the shares would be wrong.
  if (total > facts.supply) throw new Error('getProgramAccounts: the balances add up to more than the supply');
  // A supply is held by somebody. An empty answer for a token that has one is a node that did not look.
  if (total === 0n && facts.supply > 0n) throw new Error('getProgramAccounts: no account holds a balance, though the token has a supply');

  const largest = [...byOwner].sort((a, b) => (a[1].amount === b[1].amount ? 0 : a[1].amount > b[1].amount ? -1 : 1)).slice(0, limit);
  const owners = largest.map(([owner]) => owner);
  const behind: unknown[] = [];
  for (let start = 0; start < owners.length; start += ACCOUNTS_PER_CALL) {
    const chunk = owners.slice(start, start + ACCOUNTS_PER_CALL);
    const accounts = await rpc.call<{ value?: unknown }>('getMultipleAccounts', [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment }]);
    const values: unknown = accounts?.value;
    if (!Array.isArray(values) || values.length !== chunk.length) throw new Error('getMultipleAccounts: the answer does not match the owners that were asked for');
    behind.push(...(values as unknown[]));
  }

  const holders: MapHolder[] = largest.map(([owner, held], index) => {
    const { kind, label } = classifyOwner(owner, behind[index], pools);
    return { owner, amount: held.amount, pct: share(held.amount, facts.supply), kind, ...(label ? { label } : {}), accounts: held.accounts };
  });
  return {
    mint: facts.mint,
    tokenProgram: facts.tokenProgram,
    decimals: facts.decimals,
    supply: facts.supply,
    source: 'scan',
    holders,
    holderCount: byOwner.size,
    notes: [],
  };
}

/** Share of the supply in percent, to four decimals. bigint keeps the division exact for any supply size. */
function share(amount: bigint, supply: bigint): number | null {
  if (supply <= 0n) return null;
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]!);
  return value;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
