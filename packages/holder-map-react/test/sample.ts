import type { HolderMapGraph, HolderMapNode } from '../src/layout';

/** A small map: two clusters, a pool, a burn address, two lone wallets (one with an unknown share). */
export const SAMPLE: HolderMapGraph = {
  nodes: [
    { id: 'Pool1111111111111111111111111111111111111111', pct: 31.5, type: 'pool', label: 'Liquidity pool' },
    { id: 'Dev11111111111111111111111111111111111111111', pct: 12, type: 'wallet', cluster: 1 },
    { id: 'Dev22222222222222222222222222222222222222222', pct: 6.25, type: 'wallet', cluster: 1 },
    { id: 'Dev33333333333333333333333333333333333333333', pct: 1.75, type: 'wallet', cluster: 1 },
    { id: 'Snipe111111111111111111111111111111111111111', pct: 4, type: 'wallet', cluster: 2 },
    { id: 'Snipe222222222222222222222222222222222222222', pct: 3, type: 'wallet', cluster: 2 },
    { id: 'Burn1111111111111111111111111111111111111111', pct: 2, type: 'burn' },
    { id: 'Lone1111111111111111111111111111111111111111', pct: 0.4, type: 'wallet' },
    { id: 'Lone2222222222222222222222222222222222222222', pct: null, type: 'wallet' },
  ],
  edges: [
    { a: 'Dev11111111111111111111111111111111111111111', b: 'Dev22222222222222222222222222222222222222222', kind: 'transfer' },
    { a: 'Dev11111111111111111111111111111111111111111', b: 'Dev33333333333333333333333333333333333333333', kind: 'bundle' },
    { a: 'Snipe111111111111111111111111111111111111111', b: 'Snipe222222222222222222222222222222222222222', kind: 'sniper' },
    { a: 'Pool1111111111111111111111111111111111111111', b: 'Dev11111111111111111111111111111111111111111', kind: 'transfer' },
  ],
  clusters: [
    { id: 1, pct: 20, wallets: 3 },
    { id: 2, pct: 7, wallets: 2 },
  ],
};

/** A crowded map with no randomness: `size` holders, every fourth in one of `clusters` clusters. */
export function crowd(size: number, clusters = 5): HolderMapGraph {
  const nodes: HolderMapNode[] = [];
  for (let i = 0; i < size; i += 1) {
    const pct = i === 0 ? 22 : Math.round((40 / (i + 2)) * 100) / 100;
    const inCluster = i > 0 && i % 4 === 0;
    nodes.push({ id: `holder-${i}`, pct, type: i === 0 ? 'pool' : 'wallet', ...(inCluster ? { cluster: ((i / 4) % clusters) + 1 } : {}) });
  }
  const members = new Map<number, string[]>();
  for (const node of nodes) if (node.cluster !== undefined) members.set(node.cluster, [...(members.get(node.cluster) ?? []), node.id]);
  const edges = [...members.values()].flatMap((ids) => ids.slice(1).map((id) => ({ a: ids[0]!, b: id, kind: 'transfer' })));
  const list = [...members.entries()].map(([id, ids]) => ({ id, pct: 1, wallets: ids.length })).sort((a, b) => a.id - b.id);
  return { nodes, edges, clusters: list };
}
