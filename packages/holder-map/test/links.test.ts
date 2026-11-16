import { readFileSync } from 'node:fs';
import { RpcError } from '@soltoolkit/rpc';
import { describe, expect, it } from 'vitest';
import { findHolderLinks, tokenDeltas, transferBetweenHolders, type TokenDelta } from '../src';
import { fakeRpc, transaction, wallet, type FakeChain } from './chain';

const MINT = wallet('mint');
const OTHER_MINT = wallet('other mint');
const A = wallet('holder a');
const B = wallet('holder b');
const C = wallet('holder c');
const POOL = wallet('pool');

/**
 * Three holders and a pool.
 *
 * - `swap`    A sells 60 to the pool: the pool's balance moves, so no link.
 * - `moveAB`  A sends 30 to B: the one transfer.
 * - `bundle`  B and C both buy from the pool: two balances up, none down.
 * - `failed`  a transaction that failed: never read.
 * - `gone`    a signature the node no longer has the transaction for.
 */
function world(overrides: Partial<FakeChain> = {}): FakeChain {
  return {
    mint: MINT,
    supply: 10_000n,
    tokenAccounts: [
      { address: 'accA', owner: A, amount: 10n },
      { address: 'accB', owner: B, amount: 50n },
      { address: 'accB-old', owner: B, amount: 0n },
      { address: 'accC', owner: C, amount: 20n },
    ],
    signatures: {
      accA: [
        { signature: 'swap', slot: 12 },
        { signature: 'moveAB', slot: 10 },
      ],
      accB: [
        { signature: 'moveAB', slot: 10 },
        { signature: 'failed', slot: 9, err: { InstructionError: [0, 'Custom'] } },
        { signature: 'bundle', slot: 8 },
      ],
      'accB-old': [],
      accC: [
        { signature: 'bundle', slot: 8 },
        { signature: 'gone', slot: 7 },
      ],
    },
    transactions: {
      swap: transaction(MINT, [
        { owner: A, before: 100n, after: 40n },
        { owner: POOL, before: 1000n, after: 1060n },
        { owner: A, before: 5n, after: 9n, mint: OTHER_MINT },
      ]),
      moveAB: transaction(MINT, [
        { owner: A, before: 40n, after: 10n },
        { owner: B, after: 30n },
      ]),
      bundle: transaction(MINT, [
        { owner: B, before: 30n, after: 50n },
        { owner: C, after: 20n },
        { owner: POOL, before: 1060n, after: 1020n },
      ]),
    },
    ...overrides,
  };
}

/** The world without the signature whose transaction is gone: every call answers. */
function wholeWorld(): FakeChain {
  const chain = world();
  return { ...chain, signatures: { ...chain.signatures, accC: [{ signature: 'bundle', slot: 8 }] } };
}

describe('findHolderLinks', () => {
  it('finds the transfer between two holders, and draws nothing for a swap or a bundle', async () => {
    const rpc = fakeRpc(wholeWorld());
    const result = await findHolderLinks(rpc, MINT, [A, B, C]);

    expect(result.links).toEqual([{ from: A, to: B, signature: 'moveAB', slot: 10 }]);
    expect(result).toMatchObject({ calls: 10, failedCalls: 0, holdersRead: 3, holdersAsked: 3, transactionsRead: 3, complete: true });
    expect(result.note).toBe('Transfers among the holders, from the latest transactions of the top 3 holders: 3 transactions read, 1 pair linked.');
  });

  it('asks for each holder’s accounts of the mint, their newest signatures, then each transaction once, newest first', async () => {
    const rpc = fakeRpc(world());
    await findHolderLinks(rpc, MINT, [A, B, C]);

    const of = (method: string): unknown[][] => rpc.calls.filter((call) => call.method === method).map((call) => call.params);
    expect(of('getTokenAccountsByOwner')).toEqual([
      [A, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      [B, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      [C, { mint: MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    ]);
    // B's fuller account first.
    expect(of('getSignaturesForAddress')).toEqual([
      ['accA', { limit: 10, commitment: 'confirmed' }],
      ['accB', { limit: 10, commitment: 'confirmed' }],
      ['accB-old', { limit: 10, commitment: 'confirmed' }],
      ['accC', { limit: 10, commitment: 'confirmed' }],
    ]);
    // `moveAB` and `bundle` are each in two histories and are read once; `failed` is not read.
    expect(of('getTransaction')).toEqual([
      ['swap', { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }],
      ['moveAB', { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }],
      ['bundle', { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }],
      ['gone', { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }],
    ]);
  });

  it('says so when a transaction could not be read', async () => {
    const result = await findHolderLinks(fakeRpc(world()), MINT, [A, B, C]);
    expect(result.links).toHaveLength(1);
    expect(result).toMatchObject({ calls: 11, failedCalls: 1, holdersRead: 3, transactionsRead: 3, complete: false });
    expect(result.note).toBe('Transfers among the holders, from the latest transactions of the top 3 holders: 3 transactions read, 1 pair linked (1 call failed).');
  });

  it('stops at the call budget and says what was left unread', async () => {
    const rpc = fakeRpc(world());
    const result = await findHolderLinks(rpc, MINT, [A, B, C], { maxCalls: 5 });

    expect(rpc.calls).toHaveLength(5);
    expect(result).toMatchObject({ links: [], calls: 5, holdersRead: 2, transactionsRead: 0, complete: false });
    expect(result.note).toBe('Transfers among the holders, from the latest transactions of the top 3 holders: 0 transactions read, 0 pairs linked (2 of 3 holders read; the budget ended with 3 transactions unread).');
  });

  it('does not count a holder as read when the budget ends between its accounts', async () => {
    const result = await findHolderLinks(fakeRpc(world()), MINT, [A, B, C], { maxCalls: 4 });
    expect(result).toMatchObject({ calls: 4, holdersRead: 1, complete: false });
  });

  it('stops at the deadline', async () => {
    let clock = 0;
    const inner = fakeRpc(world());
    const slow = {
      call: async <T>(method: string, params: unknown[]): Promise<T> => {
        clock += 3000;
        return inner.call<T>(method, params);
      },
    };
    const result = await findHolderLinks(slow, MINT, [A, B, C], { deadlineMs: 8000, now: () => clock });
    expect(result.calls).toBe(3);
    expect(result.complete).toBe(false);
  });

  it('carries on past a holder whose accounts could not be read', async () => {
    const rpc = fakeRpc(world({ refuseFor: { [A]: new RpcError('getTokenAccountsByOwner', 429, 'Too many requests') } }));
    const result = await findHolderLinks(rpc, MINT, [A, B, C]);

    // A's own history was not read, and the transfer is still found from B's side.
    expect(result.links).toEqual([{ from: A, to: B, signature: 'moveAB', slot: 10 }]);
    expect(result).toMatchObject({ holdersRead: 2, holdersAsked: 3, failedCalls: 2, complete: false });
    expect(result.note).toContain('2 of 3 holders read');
  });

  it('does not count a holder as read when one of its signature lists failed', async () => {
    const rpc = fakeRpc(world({ refuseFor: { 'accB-old': new RpcError('getSignaturesForAddress', -32005, 'Node is behind') } }));
    const result = await findHolderLinks(rpc, MINT, [A, B, C]);
    expect(result.links).toHaveLength(1);
    expect(result.holdersRead).toBe(2);
  });

  it('finds a transfer to a holder that was not walked when that holder is among the set', async () => {
    const rpc = fakeRpc(wholeWorld());
    // Only A is walked. B is not in the set by default, so A's transfer to it is someone outside moving.
    expect((await findHolderLinks(rpc, MINT, [A])).links).toEqual([]);
    expect((await findHolderLinks(rpc, MINT, [A], { among: [A, B, C] })).links).toEqual([{ from: A, to: B, signature: 'moveAB', slot: 10 }]);
  });

  it('keeps one link for a pair, from the newest transaction', async () => {
    const chain = wholeWorld();
    const rpc = fakeRpc({
      ...chain,
      signatures: { ...chain.signatures, accA: [{ signature: 'back', slot: 20 }, ...chain.signatures!['accA']!] },
      transactions: {
        ...chain.transactions,
        back: transaction(MINT, [
          { owner: B, before: 50n, after: 45n },
          { owner: A, before: 10n, after: 15n },
        ]),
      },
    });
    expect((await findHolderLinks(rpc, MINT, [A, B, C])).links).toEqual([{ from: B, to: A, signature: 'back', slot: 20 }]);
  });

  it('takes the limits it is given', async () => {
    const rpc = fakeRpc(wholeWorld());
    await findHolderLinks(rpc, MINT, [A, B, B, C], { signaturesPerAccount: 1, accountsPerHolder: 1, commitment: 'finalized' });

    // B is walked once, and only its fullest account.
    expect(rpc.count('getTokenAccountsByOwner')).toBe(3);
    expect(rpc.calls.filter((call) => call.method === 'getSignaturesForAddress').map((call) => call.params)).toEqual([
      ['accA', { limit: 1, commitment: 'finalized' }],
      ['accB', { limit: 1, commitment: 'finalized' }],
      ['accC', { limit: 1, commitment: 'finalized' }],
    ]);
    // One signature each: swap, moveAB, bundle.
    expect(rpc.count('getTransaction')).toBe(3);
  });

  it('has nothing to read without holders', async () => {
    const rpc = fakeRpc(world());
    const result = await findHolderLinks(rpc, MINT, []);
    expect(result).toEqual({ links: [], calls: 0, failedCalls: 0, holdersRead: 0, holdersAsked: 0, transactionsRead: 0, complete: true, note: 'No holders whose transfers could be read.' });
    expect(rpc.calls).toHaveLength(0);
  });
});

describe('transferBetweenHolders', () => {
  const holders = new Set([A, B, C]);
  const delta = (owner: string, before: bigint, after: bigint, mint = MINT): TokenDelta => ({ owner, mint, before, after });

  it('reads a plain transfer', () => {
    expect(transferBetweenHolders([delta(A, 100n, 0n), delta(B, 0n, 100n)], MINT, holders)).toEqual({ from: A, to: B });
  });

  it('allows a transfer fee of a tenth, and no more', () => {
    expect(transferBetweenHolders([delta(A, 100n, 0n), delta(B, 0n, 90n)], MINT, holders)).toEqual({ from: A, to: B });
    expect(transferBetweenHolders([delta(A, 100n, 0n), delta(B, 0n, 89n)], MINT, holders)).toBeNull();
  });

  it('refuses when more arrived than left', () => {
    expect(transferBetweenHolders([delta(A, 100n, 50n), delta(B, 0n, 60n)], MINT, holders)).toBeNull();
  });

  it('refuses a swap: the pool moved too', () => {
    expect(transferBetweenHolders([delta(A, 100n, 40n), delta(POOL, 1000n, 1060n)], MINT, holders)).toBeNull();
    expect(transferBetweenHolders([delta(A, 100n, 40n), delta(B, 0n, 60n), delta(POOL, 1000n, 1001n)], MINT, holders)).toBeNull();
  });

  it('refuses a bundle (two up, none down) and a transaction with two senders', () => {
    expect(transferBetweenHolders([delta(B, 0n, 20n), delta(C, 0n, 20n)], MINT, holders)).toBeNull();
    expect(transferBetweenHolders([delta(A, 50n, 0n), delta(B, 50n, 0n), delta(C, 0n, 100n)], MINT, holders)).toBeNull();
  });

  it('ignores other mints and balances that did not change', () => {
    expect(transferBetweenHolders([delta(A, 100n, 0n), delta(B, 0n, 100n), delta(POOL, 7n, 900n, OTHER_MINT), delta(C, 5n, 5n), delta(POOL, 1000n, 1000n)], MINT, holders)).toEqual({ from: A, to: B });
  });

  it('is null for nothing', () => {
    expect(transferBetweenHolders([], MINT, holders)).toBeNull();
    expect(transferBetweenHolders([delta(A, 100n, 0n)], MINT, holders)).toBeNull();
  });
});

describe('tokenDeltas', () => {
  it('reads a transfer from a mainnet node’s answer', () => {
    // A Token-2022 `TransferChecked` of 1 PYUSD, as `getTransaction` returned it.
    const recorded = JSON.parse(readFileSync(new URL('./fixtures/pyusd-transfer.json', import.meta.url), 'utf8')) as { mint: string; from: string; to: string; answer: unknown };
    const deltas = tokenDeltas(recorded.answer, recorded.mint);
    expect(deltas).toEqual([
      { owner: recorded.from, mint: recorded.mint, before: 12_863_400_660_839n, after: 12_863_399_660_839n },
      { owner: recorded.to, mint: recorded.mint, before: 918_040_292n, after: 919_040_292n },
    ]);
    expect(transferBetweenHolders(deltas, recorded.mint, new Set([recorded.from, recorded.to]))).toEqual({ from: recorded.from, to: recorded.to });
    // With the receiver outside the set, somebody other than a holder moved: not a transfer among holders.
    expect(transferBetweenHolders(deltas, recorded.mint, new Set([recorded.from]))).toBeNull();
  });

  it('reads each owner’s balance of the mint before and after', () => {
    const answer = transaction(MINT, [
      { owner: A, before: 40n, after: 10n },
      { owner: B, after: 30n }, // opened in the transaction
      { owner: C, before: 7n }, // closed in it
      { owner: A, before: 1n, after: 2n, mint: OTHER_MINT },
    ]);
    expect(tokenDeltas(answer, MINT)).toEqual([
      { owner: A, mint: MINT, before: 40n, after: 10n },
      { owner: C, mint: MINT, before: 7n, after: 0n },
      { owner: B, mint: MINT, before: 0n, after: 30n },
    ]);
  });

  it('adds up an owner’s accounts', () => {
    const answer = transaction(MINT, [
      { owner: A, before: 40n, after: 0n },
      { owner: A, before: 2n, after: 12n },
      { owner: B, before: 0n, after: 30n },
    ]);
    expect(tokenDeltas(answer, MINT)).toEqual([
      { owner: A, mint: MINT, before: 42n, after: 12n },
      { owner: B, mint: MINT, before: 0n, after: 30n },
    ]);
  });

  it('is empty for a transaction that failed: nothing moved', () => {
    expect(tokenDeltas(transaction(MINT, [{ owner: A, before: 40n, after: 40n }], { err: { InstructionError: [1, 'Custom'] } }), MINT)).toEqual([]);
  });

  it('is empty when the transaction did not touch the mint', () => {
    expect(tokenDeltas(transaction(OTHER_MINT, [{ owner: A, before: 1n, after: 2n }]), MINT)).toEqual([]);
    expect(tokenDeltas({ meta: { err: null } }, MINT)).toEqual([]);
  });

  it('throws for an answer that is not a transaction, or a balance without an owner', () => {
    expect(() => tokenDeltas(null, MINT)).toThrow('no transaction');
    expect(() => tokenDeltas({ slot: 1 }, MINT)).toThrow('no transaction');
    expect(() => tokenDeltas(transaction(MINT, [{ owner: A, before: 1n, after: 2n }], { withoutOwners: true }), MINT)).toThrow('no owner');
    expect(() => tokenDeltas({ meta: { err: null, preTokenBalances: 'none' } }, MINT)).toThrow('not a list');
  });
});
