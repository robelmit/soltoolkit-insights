/**
 * A made-up chain behind the `Rpc` interface: one token, its accounts, their
 * histories. Every answer has the shape a mainnet node gives for the call.
 */

import { createHash } from 'node:crypto';
import { RpcError, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, addressBytes, base58Encode, isOnCurve, type CallOptions, type Rpc } from '@soltoolkit/rpc';

/** A made-up address that could be a wallet (a point on the curve). The same label always gives the same address. */
export function wallet(label: string): string {
  return pick(label, true);
}

/** A made-up address no key can sign for (off the curve), like a program-derived address. */
export function offCurve(label: string): string {
  return pick(label, false);
}

function pick(label: string, onCurve: boolean): string {
  for (let counter = 0; ; counter += 1) {
    const bytes = createHash('sha256').update(`${label}:${counter}`).digest();
    if (isOnCurve(bytes) === onCurve) return base58Encode(bytes);
  }
}

export interface FakeTokenAccount {
  readonly address: string;
  readonly owner: string;
  readonly amount: bigint;
  /** The account's size. Default 165, or 170 for a Token-2022 token. */
  readonly space?: number;
}

export interface FakeSignature {
  readonly signature: string;
  readonly slot: number;
  readonly err?: unknown;
}

export interface FakeChain {
  readonly mint: string;
  readonly token2022?: boolean;
  readonly supply: bigint;
  readonly tokenAccounts: readonly FakeTokenAccount[];
  /** The program that owns the account behind an owner address. An owner that is not here has no account. */
  readonly ownerPrograms?: Readonly<Record<string, string>>;
  /** Each token account's history, newest first. */
  readonly signatures?: Readonly<Record<string, readonly FakeSignature[]>>;
  /** `getTransaction` answers by signature. A signature that is not here answers `null`. */
  readonly transactions?: Readonly<Record<string, unknown>>;
  /** Methods the node refuses, and the error each call gets. */
  readonly refuse?: Readonly<Record<string, Error>>;
  /** Refuse a call by its first parameter (an owner, an account, a signature). */
  readonly refuseFor?: Readonly<Record<string, Error>>;
  /** Entries added to the scan's answer as they are: accounts that match the filter but are not token accounts. */
  readonly strayScanEntries?: readonly unknown[];
  /** Answer the scan as `{ context, value }`, as a node does when asked `withContext`. */
  readonly scanWithContext?: boolean;
  /** Leave `space` out of the scan's entries, as an old node does. */
  readonly scanWithoutSpace?: boolean;
}

export interface FakeRpc extends Rpc {
  readonly calls: { method: string; params: unknown[]; options?: CallOptions }[];
  /** How many calls of a method were made. */
  count(method: string): number;
}

const CONTEXT = { apiVersion: '4.4.0', slot: 1 };

export function fakeRpc(chain: FakeChain): FakeRpc {
  const calls: FakeRpc['calls'] = [];
  const program = chain.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const programName = chain.token2022 ? 'spl-token-2022' : 'spl-token';
  const space = (account: FakeTokenAccount): number => account.space ?? (chain.token2022 ? 170 : 165);

  const mintAccount = {
    data: {
      parsed: { info: { decimals: 6, ...(chain.token2022 ? { extensions: [] } : {}), freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: String(chain.supply) }, type: 'mint' },
      program: programName,
      space: 82,
    },
    executable: false,
    lamports: 1_461_600,
    owner: program,
    rentEpoch: 18446744073709552000,
    space: 82,
  };
  const parsedTokenAccount = (account: FakeTokenAccount): unknown => ({
    data: {
      parsed: {
        info: { isNative: false, mint: chain.mint, owner: account.owner, state: 'initialized', tokenAmount: { amount: String(account.amount), decimals: 6, uiAmount: Number(account.amount) / 1e6, uiAmountString: String(Number(account.amount) / 1e6) } },
        type: 'account',
      },
      program: programName,
      space: space(account),
    },
    executable: false,
    lamports: 2_039_280,
    owner: program,
    rentEpoch: 18446744073709552000,
    space: space(account),
  });
  const account = (address: string): unknown => {
    if (address === chain.mint) return mintAccount;
    const token = chain.tokenAccounts.find((candidate) => candidate.address === address);
    if (token) return parsedTokenAccount(token);
    const owner = chain.ownerPrograms?.[address];
    return owner ? { data: ['', 'base64'], executable: false, lamports: 1_000_000, owner, rentEpoch: 18446744073709552000, space: 0 } : null;
  };

  return {
    calls,
    count: (method) => calls.filter((call) => call.method === method).length,
    async call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T> {
      calls.push({ method, params, ...(options ? { options } : {}) });
      const refused = chain.refuse?.[method] ?? (typeof params[0] === 'string' ? chain.refuseFor?.[params[0]] : undefined);
      if (refused) throw refused;
      switch (method) {
        case 'getMultipleAccounts':
          return { context: CONTEXT, value: (params[0] as string[]).map(account) } as T;
        case 'getProgramAccounts': {
          if (params[0] !== program) return [] as T;
          const entries: unknown[] = chain.tokenAccounts.map((token) => ({
            pubkey: token.address,
            account: { data: [scanSlice(token.owner, token.amount), 'base64'], executable: false, lamports: 2_039_280, owner: program, rentEpoch: 18446744073709552000, ...(chain.scanWithoutSpace ? {} : { space: space(token) }) },
          }));
          entries.push(...(chain.strayScanEntries ?? []));
          return (chain.scanWithContext ? { context: CONTEXT, value: entries } : entries) as T;
        }
        case 'getTokenLargestAccounts': {
          const largest = [...chain.tokenAccounts].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1)).slice(0, 20);
          return { context: CONTEXT, value: largest.map((token) => ({ address: token.address, amount: String(token.amount), decimals: 6, uiAmount: 0, uiAmountString: '0' })) } as T;
        }
        case 'getTokenAccountsByOwner':
          return { context: CONTEXT, value: chain.tokenAccounts.filter((token) => token.owner === params[0]).map((token) => ({ pubkey: token.address, account: parsedTokenAccount(token) })) } as T;
        case 'getSignaturesForAddress': {
          const limit = (params[1] as { limit?: number } | undefined)?.limit ?? 1000;
          const records = chain.signatures?.[params[0] as string] ?? [];
          return records.slice(0, limit).map((entry) => ({ blockTime: 1_700_000_000, confirmationStatus: 'finalized', err: entry.err ?? null, memo: null, signature: entry.signature, slot: entry.slot })) as T;
        }
        case 'getTransaction':
          return (chain.transactions?.[params[0] as string] ?? null) as T;
        default:
          throw new RpcError(method, -32601, 'Method not found');
      }
    },
  };
}

/** The 40 bytes a holder scan asks of each account: the owner, then the amount as a little-endian u64. */
export function scanSlice(owner: string, amount: bigint): string {
  const bytes = Buffer.alloc(40);
  Buffer.from(addressBytes(owner)).copy(bytes, 0);
  bytes.writeBigUInt64LE(amount, 32);
  return bytes.toString('base64');
}

/** A scan entry for an account that is not a token account. */
export function strayEntry(address: string, owner: string, amount: bigint, space: number, program: string = TOKEN_2022_PROGRAM): unknown {
  return { pubkey: address, account: { data: [scanSlice(owner, amount), 'base64'], executable: false, lamports: 1, owner: program, rentEpoch: 0, space } };
}

export interface BalanceChange {
  readonly owner: string;
  readonly before?: bigint;
  readonly after?: bigint;
  readonly mint?: string;
}

/**
 * A `getTransaction` answer (`json` encoding) whose token balances change as
 * given. A change without `before` is an account opened in the transaction; one
 * without `after` is an account closed in it.
 */
export function transaction(mint: string, changes: readonly BalanceChange[], options: { err?: unknown; slot?: number; withoutOwners?: boolean } = {}): unknown {
  const balance = (index: number, change: BalanceChange, amount: bigint): unknown => ({
    accountIndex: index + 1,
    mint: change.mint ?? mint,
    ...(options.withoutOwners ? {} : { owner: change.owner }),
    programId: TOKEN_PROGRAM,
    uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
  });
  return {
    blockTime: 1_700_000_000,
    slot: options.slot ?? 1,
    version: 0,
    meta: {
      err: options.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: changes.flatMap((change, index) => (change.before === undefined ? [] : [balance(index, change, change.before)])),
      postTokenBalances: changes.flatMap((change, index) => (change.after === undefined ? [] : [balance(index, change, change.after)])),
    },
    transaction: { message: { accountKeys: [], instructions: [] }, signatures: [] },
  };
}

export { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM };
