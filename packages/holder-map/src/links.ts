/**
 * Transfers of a token among its top holders, read from a plain RPC endpoint.
 *
 * A wallet's own history is every token it ever touched. The history of its
 * token account for one mint is its history of that token alone, so the walk
 * reads that instead, within a fixed budget of calls:
 *
 *  1. `getTokenAccountsByOwner(owner, { mint })` for each holder: the
 *     accounts whose history is the holder's history of this token;
 *  2. `getSignaturesForAddress(account, { limit })` for each account: its
 *     newest transactions;
 *  3. `getTransaction` for each distinct signature, newest first, until the
 *     budget is spent.
 *
 * A transaction is a transfer between holders A and B when, for this mint, A's
 * balance fell, B's rose, nobody else's moved, and B received what A sent
 * (less a Token-2022 transfer fee at most). A swap moves a pool's balance
 * too; a bundle of buys moves several holders up and none down. Neither is a
 * transfer, and neither draws a line.
 *
 * The walk reads the newest transactions only, so an old transfer between two
 * busy wallets can be out of its reach. What the budget did not reach is said
 * in the result. It is never presented as "no transfers".
 */

import { type Rpc } from '@soltoolkit/rpc';

/** How one owner's balance of one mint changed in a transaction. */
export interface TokenDelta {
  /** The owner of the token account. */
  readonly owner: string;
  readonly mint: string;
  /** Raw units before and after. */
  readonly before: bigint;
  readonly after: bigint;
}

/** A transfer of the token from one holder to another. */
export interface HolderTransfer {
  readonly from: string;
  readonly to: string;
  /** The transaction that carried it: the newest one found for the pair. */
  readonly signature: string;
  readonly slot: number;
}

export interface HolderLinksResult {
  /** One entry for each pair of holders the token moved between. */
  readonly links: readonly HolderTransfer[];
  /** RPC calls made. */
  readonly calls: number;
  /** Calls that failed. Their holders or transactions are missing from the result. */
  readonly failedCalls: number;
  /** Holders whose accounts and signatures were all read. */
  readonly holdersRead: number;
  /** Holders that were to be read. */
  readonly holdersAsked: number;
  readonly transactionsRead: number;
  /** True when every holder was read and every transaction found was read. False when the budget ended first, or a call failed. */
  readonly complete: boolean;
  /** What the links cover, in one sentence. */
  readonly note: string;
}

export interface HolderLinksOptions {
  /**
   * The holders a transfer may run between. Default: the holders that are
   * walked. Pass the whole holder list to also find a transfer between a
   * walked holder and one further down. Leave pools out: a balance change
   * outside this set is what tells a swap from a transfer.
   */
  readonly among?: readonly string[];
  /** RPC calls at most. Default 300. */
  readonly maxCalls?: number;
  /** Stop after this long, in milliseconds. No limit by default. */
  readonly deadlineMs?: number;
  /** Newest signatures read for each token account. Default 10. */
  readonly signaturesPerAccount?: number;
  /** Token accounts read for each holder, fullest first. Default 2: one is the rule, and an older account beside the associated one happens. */
  readonly accountsPerHolder?: number;
  /** Default `confirmed`. */
  readonly commitment?: 'confirmed' | 'finalized';
  /** The clock, for tests. */
  readonly now?: () => number;
}

export const DEFAULT_MAX_CALLS = 300;
export const DEFAULT_SIGNATURES_PER_ACCOUNT = 10;
export const DEFAULT_ACCOUNTS_PER_HOLDER = 2;
/** What may be lost to a Token-2022 transfer fee between what left and what arrived: a tenth. */
const FEE_TENTHS = 1n;

/**
 * Finds the transfers of `mint` among `holders`.
 *
 * `holders` are walked in the order given, so put the largest first: when the
 * budget ends early, the largest holders are the ones that were read. The
 * function does not throw for a failed call; it counts it and carries on.
 */
export async function findHolderLinks(rpc: Rpc, mint: string, holders: readonly string[], options: HolderLinksOptions = {}): Promise<HolderLinksResult> {
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
  const perAccount = options.signaturesPerAccount ?? DEFAULT_SIGNATURES_PER_ACCOUNT;
  const perHolder = options.accountsPerHolder ?? DEFAULT_ACCOUNTS_PER_HOLDER;
  const commitment = options.commitment ?? 'confirmed';
  const now = options.now ?? Date.now;
  const started = now();
  let calls = 0;
  let failedCalls = 0;
  const budget = (): boolean => calls < maxCalls && now() - started < deadlineMs;
  const among = new Set(options.among ?? holders);
  const walked = [...new Set(holders)];

  /** One call. `null` when it failed; the failure is counted, not thrown. */
  const ask = async <T>(method: string, params: unknown[], read: (answer: unknown) => T): Promise<T | null> => {
    calls += 1;
    try {
      return read(await rpc.call<unknown>(method, params));
    } catch {
      failedCalls += 1;
      return null;
    }
  };

  // 1 and 2: each holder's accounts, then their newest signatures.
  const newest = new Map<string, number>();
  let holdersRead = 0;
  for (const owner of walked) {
    if (!budget()) break;
    const accounts = await ask('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment }], tokenAccounts);
    if (accounts === null) continue;
    let read = true;
    for (const account of accounts.slice(0, perHolder)) {
      if (!budget()) {
        read = false;
        break;
      }
      const records = await ask('getSignaturesForAddress', [account, { limit: perAccount, commitment }], signatureRecords);
      if (records === null) {
        read = false;
        continue;
      }
      for (const entry of records) {
        if (entry.failed) continue;
        newest.set(entry.signature, Math.max(newest.get(entry.signature) ?? 0, entry.slot));
      }
    }
    if (read) holdersRead += 1;
  }

  // 3: the transactions, newest first. A signature two holders share (the transfer itself) is read once.
  const signatures = [...newest.entries()].sort((a, b) => b[1] - a[1]);
  const links: HolderTransfer[] = [];
  const pairs = new Set<string>();
  let asked = 0;
  let transactionsRead = 0;
  for (const [signature, slot] of signatures) {
    if (!budget()) break;
    asked += 1;
    const deltas = await ask('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment }], (answer) => tokenDeltas(answer, mint));
    if (deltas === null) continue;
    transactionsRead += 1;
    const moved = transferBetweenHolders(deltas, mint, among);
    if (!moved) continue;
    const pair = [moved.from, moved.to].sort().join('|');
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    links.push({ ...moved, signature, slot });
  }

  const complete = holdersRead === walked.length && asked === signatures.length && transactionsRead === asked;
  const missed: string[] = [];
  if (holdersRead < walked.length) missed.push(`${holdersRead} of ${walked.length} holders read`);
  if (asked < signatures.length) missed.push(`the budget ended with ${signatures.length - asked} transactions unread`);
  if (failedCalls > 0) missed.push(`${failedCalls} ${failedCalls === 1 ? 'call' : 'calls'} failed`);
  const note =
    walked.length === 0
      ? 'No holders whose transfers could be read.'
      : `Transfers among the holders, from the latest transactions of the ${walked.length === 1 ? 'largest holder' : `top ${walked.length} holders`}: ${transactionsRead} ${transactionsRead === 1 ? 'transaction' : 'transactions'} read, ${links.length} ${links.length === 1 ? 'pair' : 'pairs'} linked${missed.length > 0 ? ` (${missed.join('; ')})` : ''}.`;
  return { links, calls, failedCalls, holdersRead, holdersAsked: walked.length, transactionsRead, complete, note };
}

/**
 * The one transfer a transaction's balance changes describe, or `null`.
 *
 * It is a transfer when, for `mint`, exactly one holder's balance fell and one
 * other's rose, nobody outside `holders` moved (a pool does in a swap), and
 * what arrived is what left, less a Token-2022 transfer fee at most. Changes
 * in other mints (the SOL leg, another token) do not matter.
 */
export function transferBetweenHolders(deltas: readonly TokenDelta[], mint: string, holders: ReadonlySet<string>): { readonly from: string; readonly to: string } | null {
  let sender: { owner: string; amount: bigint } | null = null;
  let receiver: { owner: string; amount: bigint } | null = null;
  for (const delta of deltas) {
    if (delta.mint !== mint) continue;
    const change = delta.after - delta.before;
    if (change === 0n) continue;
    if (!holders.has(delta.owner)) return null;
    if (change < 0n) {
      if (sender) return null;
      sender = { owner: delta.owner, amount: -change };
    } else {
      if (receiver) return null;
      receiver = { owner: delta.owner, amount: change };
    }
  }
  if (!sender || !receiver || sender.owner === receiver.owner) return null;
  if (receiver.amount > sender.amount || receiver.amount * 10n < sender.amount * (10n - FEE_TENTHS)) return null;
  return { from: sender.owner, to: receiver.owner };
}

/**
 * How each owner's balance of `mint` changed in a `getTransaction` answer
 * (`json` or `jsonParsed` encoding).
 *
 * Empty when the transaction failed: nothing moved. Throws when the answer is
 * not a transaction, or a balance entry for the mint names no owner (very old
 * transactions do not), since a transfer cannot be read from it.
 */
export function tokenDeltas(transaction: unknown, mint: string): TokenDelta[] {
  const meta = record(record(transaction)?.['meta']);
  if (!meta) throw new Error('getTransaction: the answer has no transaction');
  if (meta['err'] !== null && meta['err'] !== undefined) return [];

  const byOwner = new Map<string, { before: bigint; after: bigint }>();
  const add = (side: 'before' | 'after', list: unknown): void => {
    if (list === null || list === undefined) return;
    if (!Array.isArray(list)) throw new Error('getTransaction: the token balances are not a list');
    for (const entry of list) {
      const balance = record(entry);
      if (balance?.['mint'] !== mint) continue;
      const owner = balance['owner'];
      const amount = record(balance['uiTokenAmount'])?.['amount'];
      if (typeof owner !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount)) throw new Error('getTransaction: a token balance has no owner or no amount');
      const seen = byOwner.get(owner) ?? { before: 0n, after: 0n };
      seen[side] += BigInt(amount);
      byOwner.set(owner, seen);
    }
  };
  // An account opened in the transaction is in the second list only, one closed in it in the first only:
  // the missing side is a balance of zero.
  add('before', meta['preTokenBalances']);
  add('after', meta['postTokenBalances']);
  return [...byOwner].map(([owner, { before, after }]) => ({ owner, mint, before, after }));
}

/** A holder's token accounts for the mint, fullest first. */
function tokenAccounts(answer: unknown): string[] {
  const value = record(answer)?.['value'];
  if (!Array.isArray(value)) throw new Error('getTokenAccountsByOwner: the answer has no account list');
  const accounts: { address: string; amount: bigint }[] = [];
  for (const entry of value) {
    const address = record(entry)?.['pubkey'];
    if (typeof address !== 'string') throw new Error('getTokenAccountsByOwner: an entry has no address');
    const info = record(record(record(record(record(entry)?.['account'])?.['data'])?.['parsed'])?.['info']);
    const amount = record(info?.['tokenAmount'])?.['amount'];
    accounts.push({ address, amount: typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : 0n });
  }
  accounts.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  return accounts.map((account) => account.address);
}

function signatureRecords(answer: unknown): { signature: string; slot: number; failed: boolean }[] {
  if (!Array.isArray(answer)) throw new Error('getSignaturesForAddress: the answer is not a list');
  return answer.map((entry) => {
    const row = record(entry);
    const signature = row?.['signature'];
    const slot = row?.['slot'];
    if (typeof signature !== 'string' || typeof slot !== 'number') throw new Error('getSignaturesForAddress: an entry has no signature or no slot');
    return { signature, slot, failed: row?.['err'] !== null && row?.['err'] !== undefined };
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
