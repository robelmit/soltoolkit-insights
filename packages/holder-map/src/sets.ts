/**
 * Sets of holders that acted together, as links for the map.
 *
 * A transfer is not the only thing that connects two wallets. Wallets that
 * bought in one transaction were paid for by one signer; wallets that bought
 * in the slot the token launched in were placed there together. Neither shows
 * up as a transfer between them, so the map takes such sets as input and
 * draws each as a star (`starLinks`).
 *
 * `buyerSets` finds two of these sets in a token's earliest buys. The buys are
 * the caller's to supply (from an indexer, or from the token's first
 * transactions); nothing here reads the chain.
 */

import { holderKey, starLinks, type HolderLink } from './graph';

/** One buy from the token's first trades. */
export interface EarlyBuy {
  readonly buyer: string;
  /** The slot (Solana) or block (EVM) the buy landed in. */
  readonly slot: number;
  /** The transaction the buy was part of. */
  readonly signature: string;
}

export interface HolderSets {
  /** Each entry is one bundle: wallets that bought together. */
  readonly bundles?: readonly (readonly string[])[];
  /** Wallets that bought within the launch's first slots. */
  readonly snipers?: readonly string[];
  /** Wallets the caller knows to act together, such as the creator and wallets that traded the creator's other launches. */
  readonly insiders?: readonly string[];
}

export interface BuyerSetOptions {
  /** The slot the token started trading in. Without it only buys that share a transaction make a bundle, and no sniper set is found. */
  readonly launchSlot?: number;
  /** A buy this many slots after the launch slot, or sooner, is a snipe. Default 3. */
  readonly sniperSlots?: number;
}

/** How many slots after launch still count as sniping, unless the caller says otherwise. */
export const SNIPER_SLOTS = 3;

/**
 * The bundles and the sniper set in a list of early buys.
 *
 * A bundle is two or more wallets whose buys landed in one transaction, or in
 * the launch slot. The sniper set is every wallet that bought within
 * `sniperSlots` of the launch slot. A wallet can be in both.
 */
export function buyerSets(buys: readonly EarlyBuy[], options: BuyerSetOptions = {}): Required<Pick<HolderSets, 'bundles' | 'snipers'>> {
  const { launchSlot } = options;
  const sniperSlots = options.sniperSlots ?? SNIPER_SLOTS;

  /** Distinct buyers per group, in the order they first appear. */
  const groups = new Map<string, Map<string, string>>();
  const add = (group: string, buyer: string): void => {
    const members = groups.get(group) ?? new Map<string, string>();
    if (!members.has(holderKey(buyer))) members.set(holderKey(buyer), buyer);
    groups.set(group, members);
  };
  const snipers = new Map<string, string>();
  for (const buy of buys) {
    // Buys in the launch slot are one bundle whatever transaction carried them.
    add(launchSlot !== undefined && buy.slot === launchSlot ? 'launch-slot' : `tx:${buy.signature}`, buy.buyer);
    if (launchSlot !== undefined && buy.slot >= launchSlot && buy.slot - launchSlot <= sniperSlots && !snipers.has(holderKey(buy.buyer))) snipers.set(holderKey(buy.buyer), buy.buyer);
  }
  const bundles = [...groups.values()].filter((members) => members.size >= 2).map((members) => [...members.values()]);
  return { bundles, snipers: [...snipers.values()] };
}

/**
 * The links that draw the sets among the holders on the map.
 *
 * `holders` is the map's holder list, largest first: wallets outside it are
 * dropped, and the largest member of each set becomes the centre of its star.
 * A set with fewer than two members on the map draws nothing. Bundles come
 * first, then snipers, then insiders; when two sets join the same pair, the
 * graph keeps the first line.
 */
export function linksFromSets(sets: HolderSets, holders: readonly string[]): HolderLink[] {
  const rank = new Map<string, number>();
  holders.forEach((address, i) => {
    if (!rank.has(holderKey(address))) rank.set(holderKey(address), i);
  });
  const onMap = (wallets: readonly string[]): string[] =>
    wallets
      .filter((wallet) => rank.has(holderKey(wallet)))
      .sort((a, b) => rank.get(holderKey(a))! - rank.get(holderKey(b))!)
      .map((wallet) => holders[rank.get(holderKey(wallet))!]!);

  const links: HolderLink[] = [];
  for (const bundle of sets.bundles ?? []) links.push(...starLinks(onMap(bundle), 'bundle'));
  links.push(...starLinks(onMap(sets.snipers ?? []), 'sniper'));
  links.push(...starLinks(onMap(sets.insiders ?? []), 'insider'));
  return links;
}
