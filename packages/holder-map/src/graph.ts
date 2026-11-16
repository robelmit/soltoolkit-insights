/**
 * The holder map's graph.
 *
 * Bubbles are a token's top holders, sized by their share of the supply. A
 * line joins two holders that something connects, and every set of holders
 * connected that way is a cluster: wallets one hand controls, or one bundle
 * funded. A cluster's share is the sum of its members' shares, nothing
 * inferred.
 *
 * Pools, burn addresses and program accounts are bubbles but never cluster
 * members: everybody sends tokens to the pool, which says nothing about who
 * controls whom. A venue the source did not label still gives itself away by
 * its degree. A holder the token moved between and a large share of the other
 * holders is a pool, a launchpad vault or an exchange, not an owner, so such a
 * hub is drawn as a pool and left out of clusters. Without this rule one
 * unlabelled pool joins most of the map into a single "cluster".
 *
 * Unknown shares stay out of the sum rather than counting as zero: a holder
 * without a share is drawn and linked, but not clustered.
 *
 * A line need not be a transfer. `HolderLink.kind` names what joined two
 * holders (a transfer, a bundle, the sniper set, the creator's circle) and the
 * edge carries it, so a viewer can say what each line means. Only transfers
 * count toward the hub rule.
 *
 * The functions here are pure and know nothing about a chain: addresses are
 * strings, and an address that starts with `0x` is compared without case.
 */

export interface HolderInput {
  readonly address: string;
  /** Share of the supply in percent; `null` when the source did not report it. */
  readonly pct: number | null;
  /** What the holder is: `wallet`, `pool`, `burn`, or any label of your own. Types listed as passive never join a cluster. */
  readonly type: string;
  /** A name to show with the bubble, such as the pool program's. Carried to the node unchanged. */
  readonly label?: string;
}

/**
 * What a line between two holders says:
 *
 * - `transfer`  the token moved between them
 * - `bundle`    they bought in one transaction, or in the launch slot
 * - `sniper`    both bought within the launch's first slots
 * - `insider`   a set the caller knows to act together, such as the creator and wallets that traded the creator's other launches
 * - `funding`   one funded the other
 */
export type LinkKind = 'transfer' | 'funding' | 'bundle' | 'sniper' | 'insider';

/** A link between two holders: a transfer of the token unless `kind` says what else joined them. */
export interface HolderLink {
  readonly from: string;
  readonly to: string;
  readonly kind?: LinkKind;
}

export interface MapNode {
  /** The holder's address, as given. */
  readonly id: string;
  /** Share of the supply in percent, to two decimals; `null` when unknown. */
  readonly pct: number | null;
  readonly type: string;
  /** The holder's label, when it was given one. */
  readonly label?: string;
  /** The cluster the holder belongs to, when it belongs to one. */
  readonly cluster?: number;
}

export interface MapEdge {
  readonly a: string;
  readonly b: string;
  readonly kind: LinkKind;
}

export interface MapCluster {
  /** 1 is the cluster with the largest share. */
  readonly id: number;
  /** The members' shares added up, in percent. */
  readonly pct: number;
  readonly wallets: number;
}

export interface HolderGraph {
  /** Largest share first; unknown shares last. */
  readonly nodes: MapNode[];
  readonly edges: MapEdge[];
  /** Sets of two or more connected holders, largest share first. */
  readonly clusters: MapCluster[];
}

export interface BuildGraphOptions {
  /** Holder types that never join a cluster. Default `PASSIVE_HOLDER_TYPES`. */
  readonly passive?: readonly string[];
  /** Bubbles drawn at most; the largest shares stay. Default 250. */
  readonly maxNodes?: number;
  /**
   * A holder linked by transfers to at least this share of the other holders
   * is a venue (pool, vault, exchange): drawn as a pool and kept out of
   * clusters. Default 0.4; 1 turns the rule off.
   */
  readonly hubDegreePct?: number;
}

export const PASSIVE_HOLDER_TYPES: readonly string[] = ['pool', 'burn', 'program'];
export const HUB_DEGREE_PCT = 0.4;
/** A hub is linked to at least this many other holders, whatever the share, so a small map never produces a hub by accident. */
export const HUB_MIN_DEGREE = 5;
/** How a hub is relabelled when its own type did not say it was a venue. */
export const HUB_TYPE = 'pool';

/** The form an address is compared in: an EVM address without case; any other address as it is. */
export const holderKey = (address: string): string => (address.startsWith('0x') ? address.toLowerCase() : address);

const round = (value: number): number => Math.round(value * 100) / 100;

export function buildHolderGraph(holders: readonly HolderInput[], links: readonly HolderLink[], options: BuildGraphOptions = {}): HolderGraph {
  const passive = new Set(options.passive ?? PASSIVE_HOLDER_TYPES);
  const maxNodes = options.maxNodes ?? 250;
  const hubDegreePct = options.hubDegreePct ?? HUB_DEGREE_PCT;
  // One bubble per address; the largest shares first, unknown shares last.
  const byKey = new Map<string, HolderInput>();
  for (const holder of holders) {
    const key = holderKey(holder.address);
    if (!byKey.has(key)) byKey.set(key, holder);
  }
  const kept = [...byKey.entries()].sort((a, b) => (b[1].pct ?? -1) - (a[1].pct ?? -1)).slice(0, maxNodes);
  const index = new Map<string, number>();
  kept.forEach(([key], i) => index.set(key, i));

  const parent = kept.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const types = kept.map(([, holder]) => holder.type);

  const pairs: [number, number, LinkKind][] = [];
  const seen = new Set<string>();
  // Degree by transfers only: the centre of a set's star (`starLinks`) touches every member by construction,
  // which says nothing about it being a venue.
  const degree = kept.map(() => 0);
  for (const link of links) {
    const a = index.get(holderKey(link.from));
    const b = index.get(holderKey(link.to));
    if (a === undefined || b === undefined || a === b) continue;
    const pair = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const kind = link.kind ?? 'transfer';
    pairs.push([a, b, kind]);
    if (kind === 'transfer') {
      degree[a] = degree[a]! + 1;
      degree[b] = degree[b]! + 1;
    }
  }
  // Hubs: venues the source did not label. Judged before any cluster forms.
  // A hub stays out of clusters even when the caller's passive list does not name `HUB_TYPE`.
  const hubAt = Math.max(HUB_MIN_DEGREE, Math.ceil(hubDegreePct * (kept.length - 1)));
  const hubs = new Set<number>();
  if (hubDegreePct < 1) {
    kept.forEach((_, i) => {
      if (degree[i]! < hubAt || passive.has(types[i]!)) return;
      types[i] = HUB_TYPE;
      hubs.add(i);
    });
  }
  const clusterable = (i: number): boolean => !passive.has(types[i]!) && !hubs.has(i) && kept[i]![1].pct !== null;

  const edges: MapEdge[] = pairs.map(([a, b, kind]) => ({ a: kept[a]![1].address, b: kept[b]![1].address, kind }));
  for (const [a, b] of pairs) if (clusterable(a) && clusterable(b)) union(a, b);

  const members = new Map<number, number[]>();
  kept.forEach((_, i) => {
    if (!clusterable(i)) return;
    const root = find(i);
    const list = members.get(root) ?? [];
    list.push(i);
    members.set(root, list);
  });
  const groups = [...members.values()]
    .filter((list) => list.length >= 2)
    .map((list) => ({ list, pct: list.reduce((sum, i) => sum + (kept[i]![1].pct ?? 0), 0) }))
    .sort((a, b) => b.pct - a.pct || b.list.length - a.list.length);
  const clusterOf = new Map<number, number>();
  const clusters: MapCluster[] = groups.map((group, n) => {
    for (const i of group.list) clusterOf.set(i, n + 1);
    return { id: n + 1, pct: round(group.pct), wallets: group.list.length };
  });

  const nodes: MapNode[] = kept.map(([, holder], i) => {
    const cluster = clusterOf.get(i);
    return {
      id: holder.address,
      pct: holder.pct === null ? null : round(holder.pct),
      type: types[i]!,
      ...(holder.label !== undefined ? { label: holder.label } : {}),
      ...(cluster !== undefined ? { cluster } : {}),
    };
  });
  return { nodes, edges, clusters };
}

/**
 * Links that join a set of wallets into one cluster (a bundle's buyers, the
 * sniper set, the creator's circle): every member to the first, so a set of n
 * draws n − 1 lines rather than a clique. Order the members largest first to
 * put the largest at the centre. A member named twice, or the centre itself,
 * draws no line.
 */
export function starLinks(members: readonly string[], kind: LinkKind): HolderLink[] {
  const [centre, ...rest] = members;
  if (centre === undefined) return [];
  const seen = new Set<string>([holderKey(centre)]);
  const out: HolderLink[] = [];
  for (const member of rest) {
    const key = holderKey(member);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: centre, to: member, kind });
  }
  return out;
}

/**
 * Shares from balances: each positive balance over their sum, in percent with
 * four decimals. Use it when the balances are the whole supply (every token
 * account of a mint, or balances added up from a complete transfer history).
 */
export function sharesFromBalances(balances: ReadonlyMap<string, bigint>): Map<string, number> {
  let supply = 0n;
  for (const balance of balances.values()) if (balance > 0n) supply += balance;
  const out = new Map<string, number>();
  if (supply === 0n) return out;
  for (const [address, balance] of balances) {
    if (balance <= 0n) continue;
    // bigint keeps the division exact for any supply size.
    out.set(address, Number((balance * 1_000_000n) / supply) / 10_000);
  }
  return out;
}
