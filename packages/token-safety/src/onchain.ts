/**
 * Reading a token's facts from the chain, with nothing but a JSON-RPC endpoint.
 *
 * Two groups of reads:
 *
 *   The mint and its metadata. One call. These are the authoritative facts
 *   (who can mint, who can freeze, whether the name can still change), so a
 *   failure here is thrown. It is never read as "no authority".
 *
 *   The largest holders. Three calls: the largest token accounts, who owns
 *   them, and what kind of address each owner is. Many public endpoints refuse
 *   the first of these. When that happens the holders are left out and a note
 *   says why. A missing holder list is unknown, not zero.
 *
 * Who counts as a holder. A token's largest "holder" is usually a pool or a
 * bonding curve, and counting it makes every token look concentrated. So each
 * owner is sorted into a kind:
 *
 *   `program`  the owner is an account that belongs to a program: a pool, a
 *              bonding curve, a vault
 *   `pool`     the owner is a known pool authority (an address that holds the
 *              vaults of every pool of one program)
 *   `burn`     an address nobody holds the key for
 *   `pda`      a program-derived address with no program account of its own.
 *              It cannot be a plain wallet, but it can be a multisig vault as
 *              easily as a pool authority this list does not know
 *   `wallet`   everything else
 *
 * The top-ten share counts `wallet` and `pda`. Counting an unknown `pda` may
 * overstate concentration; leaving it out could hide a team vault, which is
 * the worse mistake.
 */

import { RpcError, SYSTEM_PROGRAM, addressBytes, base58Encode, findProgramAddress, isAddress, isOnCurve, type Rpc } from '@soltoolkit/rpc';

/** The Metaplex Token Metadata program. */
export const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/**
 * Addresses that hold the token vaults of every pool of one program. Each is
 * a program-derived address; the tests derive them again from their seeds.
 */
export const POOL_AUTHORITIES: Readonly<Record<string, string>> = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium AMM v4',
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: 'Raydium CPMM',
  WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh: 'Raydium LaunchLab',
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: 'Meteora DAMM v2',
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: 'Meteora DBC',
};

/** Addresses with no private key: tokens sent here are gone. */
export const BURN_ADDRESSES: readonly string[] = ['1nc1nerator11111111111111111111111111111111', SYSTEM_PROGRAM];

export type HolderKind = 'wallet' | 'pda' | 'program' | 'pool' | 'burn';

export interface Holder {
  /** The address that owns the token accounts. */
  readonly owner: string;
  /** Raw token units, summed over this owner's accounts among the largest. */
  readonly amount: bigint;
  /** Share of the total supply, in percent. */
  readonly pct: number;
  readonly kind: HolderKind;
  /** For `program`: the program the owner belongs to. For `pool`: the pool program's name. */
  readonly label?: string;
  /** How many of the largest token accounts belong to this owner. */
  readonly accounts: number;
  /** True when one of those accounts is frozen. */
  readonly frozen: boolean;
}

export interface HolderFacts {
  /** The owners of the largest token accounts, largest first. Pools, programs and burn addresses are in the list, marked by kind. */
  readonly holders: readonly Holder[];
  /** Share of the supply held by the ten largest holders of kind `wallet` or `pda`, in percent. */
  readonly top10Pct: number;
  /**
   * False when fewer than ten such holders were found among the accounts the
   * node returned, although more may exist. `top10Pct` is then a lower bound.
   */
  readonly complete: boolean;
}

export interface TokenExtension {
  /** The extension's name as the node reports it, such as `transferFeeConfig`. */
  readonly name: string;
  /** Its parsed state, as the node reports it. */
  readonly state: Readonly<Record<string, unknown>>;
}

export interface TokenMetadataFacts {
  /** Where the metadata lives: in the mint itself (Token-2022) or in a Metaplex account. */
  readonly source: 'token-2022' | 'metaplex';
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  /** Who can change it. `null` when nobody can. */
  readonly updateAuthority: string | null;
  /** True when the name, symbol or image can still be changed. */
  readonly mutable: boolean;
}

export interface TokenFacts {
  readonly mint: string;
  readonly tokenProgram: 'spl-token' | 'spl-token-2022';
  readonly decimals: number;
  /** Raw units. */
  readonly supply: bigint;
  /** Who can mint more. `null` when nobody can. */
  readonly mintAuthority: string | null;
  /** Who can freeze a holder's account. `null` when nobody can. */
  readonly freezeAuthority: string | null;
  /** Token-2022 extensions on the mint. Empty for a classic SPL token. */
  readonly extensions: readonly TokenExtension[];
  /** Absent when the token has no metadata, or its metadata could not be parsed. */
  readonly metadata?: TokenMetadataFacts;
  /** Absent when the holders were not asked for, or the endpoint would not serve them. */
  readonly holders?: HolderFacts;
  /** What could not be read, and why. */
  readonly notes: readonly string[];
}

export interface ReadTokenFactsOptions {
  /** Read the largest holders too. Default true. Costs three more calls. */
  readonly holders?: boolean;
  /** Owners to treat as pools: exchange wallets, lockers, or pool authorities this package does not know. */
  readonly poolOwners?: readonly string[];
  /** Default `confirmed`. */
  readonly commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Reads what the chain says about a token.
 *
 * Returns `null` when the address is not a token mint. Throws when the mint
 * could not be read; holder reads that fail become notes instead.
 */
export async function readTokenFacts(rpc: Rpc, mint: string, options: ReadTokenFactsOptions = {}): Promise<TokenFacts | null> {
  if (!isAddress(mint)) throw new Error(`Not a Solana address: ${mint}`);
  const commitment = options.commitment ?? 'confirmed';
  const metadataAddress = metaplexMetadataAddress(mint);

  const answer = await rpc.call<{ value?: unknown }>('getMultipleAccounts', [[mint, metadataAddress], { encoding: 'jsonParsed', commitment }]);
  const accounts = Array.isArray(answer?.value) ? answer.value : null;
  if (!accounts || accounts.length !== 2) throw new Error('getMultipleAccounts: the answer does not have the two accounts that were asked for');

  const parsedMint = parseMintAccount(accounts[0]);
  if (!parsedMint) return null;

  const notes: string[] = [];
  const metadata = metadataFromExtensions(parsedMint.extensions) ?? parseMetaplexMetadata(accounts[1], mint);
  if (!metadata && record(accounts[1])) notes.push('The metadata account exists but could not be parsed.');

  let holders: HolderFacts | undefined;
  if (options.holders !== false) {
    try {
      holders = await readHolders(rpc, mint, parsedMint.supply, commitment, options.poolOwners ?? []);
    } catch (error) {
      // Any failure here leaves the holders unknown. The mint facts above still stand.
      const refused = error instanceof RpcError && error.method === 'getTokenLargestAccounts';
      notes.push(`Holders not read: ${error instanceof Error ? error.message : String(error)}.${refused ? ' Many public endpoints refuse this call; use an endpoint that serves it.' : ''}`);
    }
  }

  return {
    mint,
    tokenProgram: parsedMint.tokenProgram,
    decimals: parsedMint.decimals,
    supply: parsedMint.supply,
    mintAuthority: parsedMint.mintAuthority,
    freezeAuthority: parsedMint.freezeAuthority,
    extensions: parsedMint.extensions,
    ...(metadata ? { metadata } : {}),
    ...(holders ? { holders } : {}),
    notes,
  };
}

/** The share of the supply a wallet holds, over all its token accounts for the mint, in percent. `undefined` when the supply is zero. */
export async function readHoldingPct(rpc: Rpc, owner: string, mint: string, supply: bigint, commitment: string = 'confirmed'): Promise<number | undefined> {
  if (!isAddress(owner)) throw new Error(`Not a Solana address: ${owner}`);
  const answer = await rpc.call<{ value?: unknown }>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment }]);
  if (!Array.isArray(answer?.value)) throw new Error('getTokenAccountsByOwner: the answer has no account list');
  let held = 0n;
  for (const entry of answer.value) {
    const account = parseTokenAccount(record(entry)?.['account']);
    if (!account || account.mint !== mint) throw new Error('getTokenAccountsByOwner: an account in the answer is not a token account for this mint');
    held += account.amount;
  }
  return pctOf(held, supply);
}

/** The Metaplex metadata account of a mint. */
export function metaplexMetadataAddress(mint: string): string {
  return findProgramAddress(['metadata', addressBytes(METAPLEX_METADATA_PROGRAM), addressBytes(mint)], METAPLEX_METADATA_PROGRAM).address;
}

// ---------------------------------------------------------------------------
// The mint
// ---------------------------------------------------------------------------

interface ParsedMint {
  readonly tokenProgram: 'spl-token' | 'spl-token-2022';
  readonly decimals: number;
  readonly supply: bigint;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly extensions: readonly TokenExtension[];
}

/**
 * A mint account as `jsonParsed` gives it, or `null` when the account is
 * missing or is something else. A mint whose fields are not what a mint has is
 * an error: guessing an authority is how a live one gets reported as revoked.
 */
function parseMintAccount(account: unknown): ParsedMint | null {
  const data = record(record(account)?.['data']);
  if (!data) return null; // no account, or a program that the node does not parse
  const program = data['program'];
  const parsed = record(data['parsed']);
  if ((program !== 'spl-token' && program !== 'spl-token-2022') || parsed?.['type'] !== 'mint') return null;

  const info = record(parsed['info']);
  if (!info) throw new Error('The mint account has no parsed fields');
  const decimals = info['decimals'];
  const supply = info['supply'];
  if (typeof decimals !== 'number' || typeof supply !== 'string' || !/^\d+$/.test(supply)) throw new Error('The mint account has no decimals or supply');
  if (!('mintAuthority' in info) || !('freezeAuthority' in info)) throw new Error('The mint account does not state its authorities');

  const extensions: TokenExtension[] = [];
  if (Array.isArray(info['extensions'])) {
    for (const entry of info['extensions']) {
      const item = record(entry);
      if (item && typeof item['extension'] === 'string') extensions.push({ name: item['extension'], state: record(item['state']) ?? {} });
    }
  }

  return {
    tokenProgram: program,
    decimals,
    supply: BigInt(supply),
    mintAuthority: authority(info['mintAuthority'], 'mint authority'),
    freezeAuthority: authority(info['freezeAuthority'], 'freeze authority'),
    extensions,
  };
}

function authority(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`The mint account's ${name} is not an address or null`);
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Token-2022 keeps metadata in the mint. Nobody can change it once its update authority is cleared. */
function metadataFromExtensions(extensions: readonly TokenExtension[]): TokenMetadataFacts | undefined {
  const state = extensions.find((extension) => extension.name === 'tokenMetadata')?.state;
  if (!state || !('updateAuthority' in state)) return undefined;
  const updateAuthority = state['updateAuthority'];
  if (updateAuthority !== null && typeof updateAuthority !== 'string') return undefined;
  return {
    source: 'token-2022',
    name: text(state['name']),
    symbol: text(state['symbol']),
    uri: text(state['uri']),
    updateAuthority,
    mutable: updateAuthority !== null,
  };
}

/**
 * A Metaplex metadata account:
 *
 *   key u8 (4) · update authority 32 · mint 32 · name, symbol, uri (each a
 *   u32 length and that many bytes, padded with zero bytes on older accounts) ·
 *   seller fee u16 · creators (u8 present, then u32 count and 34 bytes each) ·
 *   primary sale happened u8 · is mutable u8
 */
function parseMetaplexMetadata(account: unknown, mint: string): TokenMetadataFacts | undefined {
  const entry = record(account);
  if (!entry || entry['owner'] !== METAPLEX_METADATA_PROGRAM) return undefined;
  const data = entry['data'];
  if (!Array.isArray(data) || typeof data[0] !== 'string' || data[1] !== 'base64') return undefined;
  const bytes = Buffer.from(data[0], 'base64');

  try {
    if (bytes[0] !== 4) return undefined;
    let offset = 1;
    const updateAuthority = base58Encode(bytes.subarray(offset, offset + 32));
    offset += 32;
    if (base58Encode(bytes.subarray(offset, offset + 32)) !== mint) return undefined;
    offset += 32;

    const readString = (): string => {
      const length = bytes.readUInt32LE(offset);
      offset += 4;
      if (length > 1000 || offset + length > bytes.length) throw new RangeError('string runs past the account');
      const value = bytes.subarray(offset, offset + length).toString('utf8');
      offset += length;
      return value.replace(/\0+$/, '').trim();
    };
    const name = readString();
    const symbol = readString();
    const uri = readString();

    offset += 2; // seller fee
    const hasCreators = bytes.readUInt8(offset);
    offset += 1;
    if (hasCreators === 1) {
      const count = bytes.readUInt32LE(offset);
      offset += 4 + count * 34;
    } else if (hasCreators !== 0) {
      return undefined;
    }
    offset += 1; // primary sale happened
    const isMutable = bytes.readUInt8(offset);
    if (isMutable !== 0 && isMutable !== 1) return undefined;

    return { source: 'metaplex', name, symbol, uri, updateAuthority, mutable: isMutable === 1 };
  } catch (error) {
    if (error instanceof RangeError) return undefined; // shorter than a metadata account
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

interface ParsedTokenAccount {
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly frozen: boolean;
}

function parseTokenAccount(account: unknown): ParsedTokenAccount | null {
  const parsed = record(record(record(account)?.['data'])?.['parsed']);
  if (parsed?.['type'] !== 'account') return null;
  const info = record(parsed['info']);
  const amount = record(info?.['tokenAmount'])?.['amount'];
  if (!info || typeof info['mint'] !== 'string' || typeof info['owner'] !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount)) return null;
  return { mint: info['mint'], owner: info['owner'], amount: BigInt(amount), frozen: info['state'] === 'frozen' };
}

async function readHolders(rpc: Rpc, mint: string, supply: bigint, commitment: string, poolOwners: readonly string[]): Promise<HolderFacts> {
  const largest = await rpc.call<{ value?: unknown }>('getTokenLargestAccounts', [mint, { commitment }]);
  if (!Array.isArray(largest?.value)) throw new RpcError('getTokenLargestAccounts', null, 'the answer has no account list');
  const addresses: string[] = [];
  for (const entry of largest.value) {
    const address = record(entry)?.['address'];
    if (typeof address !== 'string') throw new RpcError('getTokenLargestAccounts', null, 'an entry has no address');
    addresses.push(address);
  }
  if (addresses.length === 0) return { holders: [], top10Pct: 0, complete: true };

  // Who owns each account. Read again rather than trusted from the list, so amount and owner are from one read.
  const tokenAccounts = await rpc.call<{ value?: unknown }>('getMultipleAccounts', [addresses, { encoding: 'jsonParsed', commitment }]);
  if (!Array.isArray(tokenAccounts?.value) || tokenAccounts.value.length !== addresses.length) throw new RpcError('getMultipleAccounts', null, 'the answer does not match the accounts that were asked for');

  const byOwner = new Map<string, { amount: bigint; accounts: number; frozen: boolean }>();
  for (const entry of tokenAccounts.value) {
    if (entry === null) continue; // closed between the two reads
    const account = parseTokenAccount(entry);
    if (!account || account.mint !== mint) throw new RpcError('getMultipleAccounts', null, 'an account in the answer is not a token account for this mint');
    if (account.amount === 0n) continue; // an empty account is not a holding
    const seen = byOwner.get(account.owner) ?? { amount: 0n, accounts: 0, frozen: false };
    byOwner.set(account.owner, { amount: seen.amount + account.amount, accounts: seen.accounts + 1, frozen: seen.frozen || account.frozen });
  }

  // The node returns at most 20 accounts. Fewer than that is the whole list.
  const wholeList = addresses.length < 20;
  if (byOwner.size === 0) return { holders: [], top10Pct: 0, complete: wholeList };

  // What each owner is.
  const owners = [...byOwner.keys()];
  const ownerAccounts = await rpc.call<{ value?: unknown }>('getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment }]);
  const ownerValues: unknown = ownerAccounts?.value;
  if (!Array.isArray(ownerValues) || ownerValues.length !== owners.length) throw new RpcError('getMultipleAccounts', null, 'the answer does not match the owners that were asked for');

  const extraPools = new Set(poolOwners);
  const holders: Holder[] = [...byOwner].map(([owner, held], index) => {
    const { kind, label } = classifyOwner(owner, ownerValues[index], extraPools);
    return { owner, amount: held.amount, pct: pctOf(held.amount, supply) ?? 0, kind, ...(label ? { label } : {}), accounts: held.accounts, frozen: held.frozen };
  });
  holders.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));

  const counted = holders.filter((holder) => holder.kind === 'wallet' || holder.kind === 'pda');
  const top10 = counted.slice(0, 10).reduce((sum, holder) => sum + holder.amount, 0n);
  return {
    holders,
    top10Pct: pctOf(top10, supply) ?? 0,
    complete: counted.length >= 10 || wholeList,
  };
}

/** Sorts an owner into a kind, from its address and the account behind it (`null` when there is none). */
export function classifyOwner(owner: string, account: unknown, extraPools: ReadonlySet<string> = new Set()): { kind: HolderKind; label?: string } {
  if (BURN_ADDRESSES.includes(owner)) return { kind: 'burn' };
  const known = POOL_AUTHORITIES[owner];
  if (known) return { kind: 'pool', label: known };
  if (extraPools.has(owner)) return { kind: 'pool' };

  const program = record(account)?.['owner'];
  if (typeof program === 'string' && program !== SYSTEM_PROGRAM) return { kind: 'program', label: program };
  return isOnCurve(addressBytes(owner)) ? { kind: 'wallet' } : { kind: 'pda' };
}

// ---------------------------------------------------------------------------

function pctOf(part: bigint, whole: bigint): number | undefined {
  if (whole <= 0n) return undefined;
  return Number((part * 1_000_000n) / whole) / 10_000;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
