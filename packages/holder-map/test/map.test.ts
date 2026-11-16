import { RpcError, type Rpc } from '@soltoolkit/rpc';
import { describe, expect, it } from 'vitest';
import { HoldersUnavailable, buildHolderMap } from '../src';
import { fakeRpc, transaction, wallet, type FakeChain } from './chain';

const MINT = wallet('mint');
const POOL = wallet('pool');
const A = wallet('holder a');
const B = wallet('holder b');
const C = wallet('holder c');
const D = wallet('holder d');

/**
 * A pool and four wallets. A sent tokens to B, C sent tokens to D, and B once
 * bought from the pool.
 */
function token(overrides: Partial<FakeChain> = {}): FakeChain {
  return {
    mint: MINT,
    supply: 1_000_000n,
    tokenAccounts: [
      { address: 'pool-1', owner: POOL, amount: 500_000n },
      { address: 'a-1', owner: A, amount: 200_000n },
      { address: 'b-1', owner: B, amount: 100_000n },
      { address: 'c-1', owner: C, amount: 50_000n },
      { address: 'd-1', owner: D, amount: 10_000n },
    ],
    signatures: {
      'a-1': [{ signature: 'moveAB', slot: 10 }],
      'b-1': [
        { signature: 'moveAB', slot: 10 },
        { signature: 'buy', slot: 5 },
      ],
      'c-1': [{ signature: 'moveCD', slot: 7 }],
      'd-1': [{ signature: 'moveCD', slot: 7 }],
    },
    transactions: {
      moveAB: transaction(MINT, [
        { owner: A, before: 250_000n, after: 200_000n },
        { owner: B, before: 50_000n, after: 100_000n },
      ]),
      moveCD: transaction(MINT, [
        { owner: C, before: 60_000n, after: 50_000n },
        { owner: D, after: 10_000n },
      ]),
      buy: transaction(MINT, [
        { owner: POOL, before: 550_000n, after: 500_000n },
        { owner: B, after: 50_000n },
      ]),
    },
    ...overrides,
  };
}

/** An endpoint that must not be asked anything. */
const noRpc: Rpc = {
  call: async (method) => {
    throw new Error(`${method} was called`);
  },
};

describe('buildHolderMap', () => {
  it('reads the holders, finds the transfers among them, and builds the map', async () => {
    const rpc = fakeRpc(token());
    const map = await buildHolderMap(rpc, MINT, { poolOwners: [POOL] });

    expect(map?.mint).toBe(MINT);
    expect(map?.graph).toEqual({
      nodes: [
        { id: POOL, pct: 50, type: 'pool' },
        { id: A, pct: 20, type: 'wallet', cluster: 1 },
        { id: B, pct: 10, type: 'wallet', cluster: 1 },
        { id: C, pct: 5, type: 'wallet', cluster: 2 },
        { id: D, pct: 1, type: 'wallet', cluster: 2 },
      ],
      edges: [
        { a: A, b: B, kind: 'transfer' },
        { a: C, b: D, kind: 'transfer' },
      ],
      clusters: [
        { id: 1, pct: 30, wallets: 2 },
        { id: 2, pct: 6, wallets: 2 },
      ],
    });
    expect(map?.list).toMatchObject({ source: 'scan', holderCount: 5 });
    expect(map?.transfers).toMatchObject({ holdersRead: 4, holdersAsked: 4, transactionsRead: 3, complete: true });
    expect(map?.notes).toEqual(['5 addresses hold the token; the map shows the largest 5.', 'Transfers among the holders, from the latest transactions of the top 4 holders: 3 transactions read, 2 pairs linked.']);

    // The pool's history is every trade of the token. It is not read.
    expect(rpc.calls.filter((call) => call.method === 'getTokenAccountsByOwner').map((call) => call.params[0])).toEqual([A, B, C, D]);
  });

  it('walks the largest holders only, and still finds their transfers to the rest', async () => {
    const rpc = fakeRpc(token());
    const map = await buildHolderMap(rpc, MINT, { poolOwners: [POOL], walk: 1 });

    expect(rpc.calls.filter((call) => call.method === 'getTokenAccountsByOwner').map((call) => call.params[0])).toEqual([A]);
    expect(map?.graph.edges).toEqual([{ a: A, b: B, kind: 'transfer' }]);
    expect(map?.notes.at(-1)).toBe('Transfers among the holders, from the latest transactions of the largest holder: 1 transaction read, 1 pair linked.');
  });

  it('reads no transfers when asked not to, and says so', async () => {
    const rpc = fakeRpc(token());
    const map = await buildHolderMap(rpc, MINT, { poolOwners: [POOL], walk: 0 });

    expect(map?.transfers).toBeNull();
    expect(map?.graph.edges).toEqual([]);
    expect(map?.graph.clusters).toEqual([]);
    expect(map?.notes).toEqual(['5 addresses hold the token; the map shows the largest 5.', 'Transfers among the holders were not read.']);
    expect(rpc.count('getTokenAccountsByOwner')).toBe(0);
  });

  it('draws the sets the caller knows, and a pair the token moved between keeps its transfer line', async () => {
    const sets = { bundles: [[D, C, wallet('sold everything')]], snipers: [A, B], insiders: [B, C] };

    const withoutWalk = await buildHolderMap(fakeRpc(token()), MINT, { poolOwners: [POOL], walk: 0, sets });
    expect(withoutWalk?.graph.edges).toEqual([
      { a: C, b: D, kind: 'bundle' },
      { a: A, b: B, kind: 'sniper' },
      { a: B, b: C, kind: 'insider' },
    ]);
    expect(withoutWalk?.graph.clusters).toEqual([{ id: 1, pct: 36, wallets: 4 }]);

    const withWalk = await buildHolderMap(fakeRpc(token()), MINT, { poolOwners: [POOL], sets });
    expect(withWalk?.graph.edges).toEqual([
      { a: A, b: B, kind: 'transfer' },
      { a: C, b: D, kind: 'transfer' },
      { a: B, b: C, kind: 'insider' },
    ]);
  });

  it('never puts a pool in a set', async () => {
    const map = await buildHolderMap(fakeRpc(token()), MINT, { poolOwners: [POOL], walk: 0, sets: { snipers: [POOL, A, B] } });
    expect(map?.graph.edges).toEqual([{ a: A, b: B, kind: 'sniper' }]);
  });

  it('takes a holder list of the caller’s own and reads nothing for it', async () => {
    const holders = [
      { address: '0xAAA', pct: 12, type: 'wallet' },
      { address: '0xbbb', pct: 8, type: 'wallet' },
      { address: '0xccc', pct: 40, type: 'pool', label: 'Uniswap v3' },
    ];
    const map = await buildHolderMap(noRpc, '0xtoken', { holders, walk: 0, sets: { bundles: [['0xaaa', '0xBBB']] } });

    expect(map).toEqual({
      mint: '0xtoken',
      graph: {
        nodes: [
          { id: '0xccc', pct: 40, type: 'pool', label: 'Uniswap v3' },
          { id: '0xAAA', pct: 12, type: 'wallet', cluster: 1 },
          { id: '0xbbb', pct: 8, type: 'wallet', cluster: 1 },
        ],
        edges: [{ a: '0xAAA', b: '0xbbb', kind: 'bundle' }],
        clusters: [{ id: 1, pct: 20, wallets: 2 }],
      },
      list: null,
      transfers: null,
      notes: ['Transfers among the holders were not read.'],
    });
  });

  it('walks a holder list of the caller’s own', async () => {
    const rpc = fakeRpc(token());
    const map = await buildHolderMap(rpc, MINT, {
      holders: [
        { address: A, pct: 20, type: 'wallet' },
        { address: B, pct: 10, type: 'wallet' },
        { address: POOL, pct: 50, type: 'pool' },
      ],
    });

    expect(map?.list).toBeNull();
    expect(map?.graph.clusters).toEqual([{ id: 1, pct: 30, wallets: 2 }]);
    expect(rpc.count('getProgramAccounts')).toBe(0);
    expect(rpc.count('getMultipleAccounts')).toBe(0);
    expect(map?.notes).toEqual(['Transfers among the holders, from the latest transactions of the top 2 holders: 2 transactions read, 1 pair linked.']);
  });

  it('reads nothing for a holder the map does not draw', async () => {
    const rpc = fakeRpc(token());
    const map = await buildHolderMap(rpc, MINT, { poolOwners: [POOL], graph: { maxNodes: 3 } });

    expect(map?.graph.nodes.map((node) => node.id)).toEqual([POOL, A, B]);
    expect(rpc.calls.filter((call) => call.method === 'getTokenAccountsByOwner').map((call) => call.params[0])).toEqual([A, B]);
    expect(map?.notes[0]).toBe('5 addresses hold the token; the map shows the largest 3.');
  });

  it('passes the limits on: the holder limit, the walk’s budget, the commitment', async () => {
    const rpc = fakeRpc(token());
    const map = await buildHolderMap(rpc, MINT, { poolOwners: [POOL], limit: 4, commitment: 'finalized', links: { maxCalls: 2, signaturesPerAccount: 3 } });

    expect(map?.graph.nodes).toHaveLength(4);
    expect(map?.notes[0]).toBe('5 addresses hold the token; the map shows the largest 4.');
    expect(map?.transfers).toMatchObject({ calls: 2, holdersAsked: 3, holdersRead: 1, complete: false });
    expect(rpc.calls.find((call) => call.method === 'getTokenAccountsByOwner')?.params[2]).toEqual({ encoding: 'jsonParsed', commitment: 'finalized' });
    expect(rpc.calls.find((call) => call.method === 'getSignaturesForAddress')?.params[1]).toEqual({ limit: 3, commitment: 'finalized' });
  });

  it('walks at `confirmed` when the holders are read at `processed`: a node keeps no history for that level', async () => {
    const rpc = fakeRpc(token());
    await buildHolderMap(rpc, MINT, { commitment: 'processed' });
    expect((rpc.calls.find((call) => call.method === 'getProgramAccounts')?.params[1] as { commitment: string }).commitment).toBe('processed');
    expect(rpc.calls.find((call) => call.method === 'getTokenAccountsByOwner')?.params[2]).toEqual({ encoding: 'jsonParsed', commitment: 'confirmed' });
  });

  it('says where the list came from when the scan was not served', async () => {
    const rpc = fakeRpc(token({ refuse: { getProgramAccounts: new RpcError('getProgramAccounts', -32010, 'excluded from account secondary indexes') } }));
    const map = await buildHolderMap(rpc, MINT, { poolOwners: [POOL], walk: 0 });

    expect(map?.list?.source).toBe('largest');
    expect(map?.notes).toEqual([
      'Scan: getProgramAccounts: excluded from account secondary indexes.',
      'The list is the owners of the largest token accounts (twenty accounts at most), so it may not be every holder.',
      'Transfers among the holders were not read.',
    ]);
  });

  it('is null for an address that is not a token mint, and throws when the holders cannot be read', async () => {
    expect(await buildHolderMap(fakeRpc(token()), A)).toBeNull();

    const refused = { getProgramAccounts: new RpcError('getProgramAccounts', 429, 'Too many requests'), getTokenLargestAccounts: new RpcError('getTokenLargestAccounts', 429, 'Too many requests') };
    await expect(buildHolderMap(fakeRpc(token({ refuse: refused })), MINT)).rejects.toBeInstanceOf(HoldersUnavailable);
  });

  it('reports a walk that failed in part instead of throwing', async () => {
    const rpc = fakeRpc(token({ refuse: { getTransaction: new RpcError('getTransaction', -32011, 'Transaction history is not available from this node') } }));
    const map = await buildHolderMap(rpc, MINT, { poolOwners: [POOL] });

    expect(map?.graph.edges).toEqual([]);
    expect(map?.transfers).toMatchObject({ transactionsRead: 0, failedCalls: 3, complete: false });
    expect(map?.notes.at(-1)).toBe('Transfers among the holders, from the latest transactions of the top 4 holders: 0 transactions read, 0 pairs linked (3 calls failed).');
  });
});
