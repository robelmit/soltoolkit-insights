/**
 * The whole map in one call: read the holders, find the transfers among them,
 * add the sets the caller knows, and build the graph.
 */

import { type Rpc } from '@soltoolkit/rpc';
import { PASSIVE_HOLDER_TYPES, buildHolderGraph, type BuildGraphOptions, type HolderGraph, type HolderInput, type HolderLink } from './graph';
import { readHolders, type HolderList, type ReadHoldersOptions } from './holders';
import { findHolderLinks, type HolderLinksOptions, type HolderLinksResult } from './links';
import { linksFromSets, type HolderSets } from './sets';

export interface BuildHolderMapOptions extends ReadHoldersOptions {
  /**
   * A holder list of your own, from an indexer or a data API. With it the
   * holders are not read from the RPC endpoint, and `list` in the result is
   * `null`.
   */
  readonly holders?: readonly HolderInput[];
  /**
   * How many holders' transactions are read for transfers, largest first;
   * pools, burn addresses and programs are skipped. Default 30. 0 reads none.
   */
  readonly walk?: number;
  /** Limits for the transfer walk. `among` is set for you: every holder on the map that can be in a cluster. */
  readonly links?: Omit<HolderLinksOptions, 'among' | 'commitment'>;
  /** Sets of wallets known to have acted together: bundles, snipers, insiders. See `buyerSets`. */
  readonly sets?: HolderSets;
  /** Passed to `buildHolderGraph`. */
  readonly graph?: BuildGraphOptions;
}

export interface HolderMap {
  readonly mint: string;
  /** Bubbles, lines and clusters. */
  readonly graph: HolderGraph;
  /** The holders as read from the endpoint; `null` when the caller supplied the list. */
  readonly list: HolderList | null;
  /** What the transfer walk read and found; `null` when no holder was walked. */
  readonly transfers: HolderLinksResult | null;
  /** What the map covers and what it does not, in plain sentences. Show them with the map. */
  readonly notes: readonly string[];
}

export const DEFAULT_WALK = 30;

/**
 * Builds the holder map of a token.
 *
 * Returns `null` when the address is not a token mint. Throws
 * `HoldersUnavailable` when the endpoint would not serve the holders by any
 * way; a transfer walk that fails in part is reported in `transfers` and
 * `notes` instead.
 */
export async function buildHolderMap(rpc: Rpc, mint: string, options: BuildHolderMapOptions = {}): Promise<HolderMap | null> {
  const notes: string[] = [];
  let list: HolderList | null = null;
  let holders: readonly HolderInput[];
  if (options.holders) {
    holders = options.holders;
  } else {
    list = await readHolders(rpc, mint, options);
    if (!list) return null;
    holders = list.holders.map((holder) => ({ address: holder.owner, pct: holder.pct, type: holder.kind, ...(holder.label ? { label: holder.label } : {}) }));
    if (list.holderCount !== null) notes.push(`${list.holderCount} ${list.holderCount === 1 ? 'address holds' : 'addresses hold'} the token; the map shows the largest ${Math.min(list.holders.length, options.graph?.maxNodes ?? 250)}.`);
    notes.push(...list.notes);
  }

  const passive = new Set(options.graph?.passive ?? PASSIVE_HOLDER_TYPES);
  // The holders the map will draw, largest first, less the ones that never join a cluster. Nothing is read
  // for a holder that is not drawn.
  const active = buildHolderGraph(holders, [], options.graph)
    .nodes.filter((node) => !passive.has(node.type))
    .map((node) => node.id);
  const walk = options.walk ?? DEFAULT_WALK;

  let transfers: HolderLinksResult | null = null;
  const links: HolderLink[] = [];
  if (walk > 0 && active.length > 0) {
    transfers = await findHolderLinks(
      rpc,
      mint,
      active.slice(0, walk),
      { ...options.links, among: active, ...(options.commitment && options.commitment !== 'processed' ? { commitment: options.commitment } : {}) },
    );
    // Transfers first: when a set joins the same two holders, the pair keeps the transfer line.
    links.push(...transfers.links.map((transfer) => ({ from: transfer.from, to: transfer.to })));
    notes.push(transfers.note);
  } else {
    notes.push('Transfers among the holders were not read.');
  }
  if (options.sets) {
    links.push(...linksFromSets(options.sets, active));
  }

  return { mint, graph: buildHolderGraph(holders, links, options.graph), list, transfers, notes };
}
