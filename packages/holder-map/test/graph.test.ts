import { describe, expect, it } from 'vitest';
import { HUB_TYPE, buildHolderGraph, holderKey, sharesFromBalances, starLinks, type HolderInput, type HolderLink } from '../src';

const holder = (address: string, pct: number | null, type = 'wallet'): HolderInput => ({ address, pct, type });
const transfer = (from: string, to: string): HolderLink => ({ from, to });

describe('buildHolderGraph', () => {
  it('joins holders the token moved between into a cluster, and keeps pools out of it', () => {
    const holders = [holder('A', 10), holder('B', 5), holder('C', 2.5), holder('D', 1), holder('E', 20, 'dev'), holder('POOL', 40, 'pool')];
    const links = [
      transfer('A', 'B'),
      transfer('B', 'A'), // the same pair again
      transfer('B', 'C'),
      transfer('POOL', 'D'), // a buy, not a relation
      transfer('D', 'D'), // to itself
      transfer('A', 'X'), // X is not a holder
      transfer('E', 'POOL'),
    ];
    const graph = buildHolderGraph(holders, links);

    expect(graph.clusters).toEqual([{ id: 1, pct: 17.5, wallets: 3 }]);
    expect(graph.edges).toEqual([
      { a: 'A', b: 'B', kind: 'transfer' },
      { a: 'B', b: 'C', kind: 'transfer' },
      { a: 'POOL', b: 'D', kind: 'transfer' },
      { a: 'E', b: 'POOL', kind: 'transfer' },
    ]);
    expect(graph.nodes).toEqual([
      { id: 'POOL', pct: 40, type: 'pool' },
      { id: 'E', pct: 20, type: 'dev' },
      { id: 'A', pct: 10, type: 'wallet', cluster: 1 },
      { id: 'B', pct: 5, type: 'wallet', cluster: 1 },
      { id: 'C', pct: 2.5, type: 'wallet', cluster: 1 },
      { id: 'D', pct: 1, type: 'wallet' },
    ]);
  });

  it('compares 0x addresses without case, and never counts an unknown share as zero', () => {
    const holders = [holder('0xAAA', 1), holder('0xbbb', 2), holder('0xccc', 30), holder('0xddd', 25), holder('0xeee', null), holder('0xfff', 0.5)];
    const links = [transfer('0xaaa', '0xBBB'), transfer('0xccc', '0xDDD'), transfer('0xeee', '0xaaa')];
    const graph = buildHolderGraph(holders, links);

    expect(graph.clusters).toEqual([
      { id: 1, pct: 55, wallets: 2 },
      { id: 2, pct: 3, wallets: 2 },
    ]);
    // The holder whose share is unknown is drawn and linked, with no cluster and no share.
    expect(graph.nodes.find((node) => node.id === '0xeee')).toEqual({ id: '0xeee', pct: null, type: 'wallet' });
    expect(graph.nodes.at(-1)?.id).toBe('0xeee');
    expect(graph.edges).toHaveLength(3);

    const capped = buildHolderGraph(holders, links, { maxNodes: 5 });
    expect(capped.nodes.map((node) => node.id)).toEqual(['0xccc', '0xddd', '0xbbb', '0xAAA', '0xfff']);
    expect(capped.edges).toHaveLength(2);

    expect(holderKey('0xAbC')).toBe('0xabc');
    expect(holderKey('So11111111111111111111111111111111111111112')).toBe('So11111111111111111111111111111111111111112');
  });

  it('draws one bubble for an address listed twice, keeping the first entry', () => {
    const graph = buildHolderGraph([holder('A', 10), holder('A', 99, 'pool'), holder('B', 5)], [transfer('A', 'B')]);
    expect(graph.nodes).toEqual([
      { id: 'A', pct: 10, type: 'wallet', cluster: 1 },
      { id: 'B', pct: 5, type: 'wallet', cluster: 1 },
    ]);
  });

  it('treats a holder linked to a large share of the others as a venue', () => {
    const wallets = Array.from({ length: 10 }, (_, i) => holder(`W${i}`, 5));
    const holders = [holder('HUB', 30), ...wallets];
    const fromHub = wallets.map((wallet) => transfer('HUB', wallet.address));

    const graph = buildHolderGraph(holders, [...fromHub, transfer('W1', 'W2')]);
    expect(graph.nodes[0]).toEqual({ id: 'HUB', pct: 30, type: HUB_TYPE });
    expect(graph.clusters).toEqual([{ id: 1, pct: 10, wallets: 2 }]);
    expect(graph.edges).toHaveLength(11);

    // With the rule off, the hub joins everything it touched.
    expect(buildHolderGraph(holders, fromHub, { hubDegreePct: 1 }).clusters).toEqual([{ id: 1, pct: 80, wallets: 11 }]);

    // Two links are not a hub.
    const few = buildHolderGraph(holders, [transfer('HUB', 'W0'), transfer('HUB', 'W1')]);
    expect(few.nodes[0]).toEqual({ id: 'HUB', pct: 30, type: 'wallet', cluster: 1 });
    expect(few.clusters).toEqual([{ id: 1, pct: 40, wallets: 3 }]);
  });

  it('keeps a hub out of clusters when the passive list does not name the hub type', () => {
    const wallets = Array.from({ length: 10 }, (_, i) => holder(`W${i}`, 5));
    const graph = buildHolderGraph(
      [holder('HUB', 30), ...wallets],
      wallets.map((wallet) => transfer('HUB', wallet.address)),
      { passive: ['burn'] },
    );
    expect(graph.nodes[0]).toEqual({ id: 'HUB', pct: 30, type: HUB_TYPE });
    expect(graph.clusters).toEqual([]);
  });

  it('takes the passive types from the caller', () => {
    const holders = [holder('A', 10, 'exchange'), holder('B', 5), holder('C', 4)];
    const links = [transfer('A', 'B'), transfer('A', 'C')];
    expect(buildHolderGraph(holders, links).clusters).toEqual([{ id: 1, pct: 19, wallets: 3 }]);
    expect(buildHolderGraph(holders, links, { passive: ['exchange'] }).clusters).toEqual([]);
  });

  it('carries a label to the node', () => {
    const graph = buildHolderGraph([{ address: 'P', pct: 50, type: 'pool', label: 'Raydium' }, holder('A', 1)], []);
    expect(graph.nodes).toEqual([
      { id: 'P', pct: 50, type: 'pool', label: 'Raydium' },
      { id: 'A', pct: 1, type: 'wallet' },
    ]);
  });

  it('numbers clusters by share, then by size', () => {
    const holders = [holder('A', 3), holder('B', 3), holder('C', 2), holder('D', 2), holder('E', 2), holder('F', 9), holder('G', 9)];
    const graph = buildHolderGraph(holders, [transfer('A', 'B'), transfer('C', 'D'), transfer('D', 'E'), transfer('F', 'G')]);
    expect(graph.clusters).toEqual([
      { id: 1, pct: 18, wallets: 2 },
      { id: 2, pct: 6, wallets: 3 },
      { id: 3, pct: 6, wallets: 2 },
    ]);
  });

  it('is empty for no holders, and has no clusters without links', () => {
    expect(buildHolderGraph([], [transfer('A', 'B')])).toEqual({ nodes: [], edges: [], clusters: [] });
    const graph = buildHolderGraph([holder('A', 10), holder('B', 5)], []);
    expect(graph.clusters).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.nodes).toHaveLength(2);
  });
});

describe('starLinks', () => {
  const bundle = [holder('C', 3, 'bundler'), ...Array.from({ length: 9 }, (_, i) => holder(`B${i}`, 1, 'bundler'))];
  const holders = [...bundle, holder('X', 40)];
  const members = bundle.map((member) => member.address);

  it('joins a set to its first member, and the star is not a hub', () => {
    const links = starLinks(members, 'bundle');
    expect(links).toHaveLength(9);
    expect(links[0]).toEqual({ from: 'C', to: 'B0', kind: 'bundle' });

    const graph = buildHolderGraph(holders, links);
    expect(graph.nodes.find((node) => node.id === 'C')).toEqual({ id: 'C', pct: 3, type: 'bundler', cluster: 1 });
    expect(graph.clusters).toEqual([{ id: 1, pct: 12, wallets: 10 }]);
    expect(graph.edges.every((edge) => edge.kind === 'bundle')).toBe(true);

    // The same lines as transfers are what a venue looks like.
    const asTransfers = buildHolderGraph(
      holders,
      links.map(({ from, to }) => ({ from, to })),
    );
    expect(asTransfers.nodes.find((node) => node.id === 'C')?.type).toBe(HUB_TYPE);
  });

  it('keeps the first kind for a pair joined twice', () => {
    const graph = buildHolderGraph([holder('B1', 1), holder('B2', 1), holder('Z', 1)], [transfer('B1', 'B2'), ...starLinks(['B1', 'B2', 'Z'], 'sniper')]);
    expect(graph.edges).toEqual([
      { a: 'B1', b: 'B2', kind: 'transfer' },
      { a: 'B1', b: 'Z', kind: 'sniper' },
    ]);
  });

  it('draws nothing for fewer than two members, and one line for a member named twice', () => {
    expect(starLinks([], 'bundle')).toEqual([]);
    expect(starLinks(['A'], 'bundle')).toEqual([]);
    expect(starLinks(['A', 'A', 'B', 'B'], 'insider')).toEqual([{ from: 'A', to: 'B', kind: 'insider' }]);
  });
});

describe('sharesFromBalances', () => {
  it('gives each positive balance its share of their sum', () => {
    const shares = sharesFromBalances(
      new Map([
        ['a', 500n],
        ['b', 250n],
        ['c', 250n],
        ['d', 0n],
        ['e', -5n],
      ]),
    );
    expect([...shares]).toEqual([
      ['a', 50],
      ['b', 25],
      ['c', 25],
    ]);
  });

  it('is empty for no balances, and exact for a supply past what a number holds', () => {
    expect(sharesFromBalances(new Map()).size).toBe(0);
    expect(sharesFromBalances(new Map([['a', 0n]])).size).toBe(0);
    const shares = sharesFromBalances(
      new Map([
        ['whale', 10n ** 30n],
        ['dust', 1n],
      ]),
    );
    expect(shares.get('dust')).toBe(0);
    expect(shares.get('whale')).toBe(99.9999);
  });
});
