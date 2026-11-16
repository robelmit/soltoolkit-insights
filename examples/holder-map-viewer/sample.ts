/**
 * A made-up token, so the viewer can be looked at with no network.
 *
 * The addresses are not real. The graph is built by the same engine a real
 * map goes through: holders, transfers among them, and the sets a launch
 * feed would report.
 */

import { buildHolderGraph, linksFromSets, type HolderGraph, type HolderInput, type HolderLink } from '@soltoolkit/holder-map';

/** A name, filler, and `demo` at the end: the viewer's short form reads `Dev1…demo`. */
const address = (name: string): string => `${name}${'x'.repeat(40 - name.length)}demo`;

const pool = address('Pool');
const burn = address('Burn');
const dev = [1, 2, 3, 4, 5].map((i) => address(`Dev${i}`));
const bundle = [1, 2, 3, 4].map((i) => address(`Bun${i}`));
const snipers = [1, 2, 3].map((i) => address(`Snp${i}`));
const insiders = [1, 2].map((i) => address(`Ins${i}`));
const lone = Array.from({ length: 26 }, (_, i) => address(`W${String(i + 1).padStart(3, '0')}`));

const holders: HolderInput[] = [
  { address: pool, pct: 18.4, type: 'pool', label: 'Liquidity pool' },
  ...[9.6, 4.1, 3.3, 2.2, 1.4].map((pct, i) => ({ address: dev[i]!, pct, type: 'wallet' })),
  ...[3.9, 3.7, 3.6, 3.1].map((pct, i) => ({ address: bundle[i]!, pct, type: 'wallet' })),
  { address: burn, pct: 3, type: 'burn' },
  ...[2.6, 1.9, 1.2].map((pct, i) => ({ address: snipers[i]!, pct, type: 'wallet' })),
  ...[1.6, 1.1].map((pct, i) => ({ address: insiders[i]!, pct, type: 'wallet' })),
  // One holder's share is not known. It is drawn at the smallest size and never counted as zero.
  ...lone.map((holder, i) => ({ address: holder, pct: i === 7 ? null : Math.round((2.4 / (1 + i * 0.35)) * 100) / 100, type: 'wallet' })),
].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

const transfers: HolderLink[] = [
  { from: dev[0]!, to: dev[1]! },
  { from: dev[0]!, to: dev[2]! },
  { from: dev[1]!, to: dev[3]! },
  { from: dev[3]!, to: dev[4]! },
  // The pool sent tokens to a holder: a line, and no cluster, because a pool never joins one.
  { from: pool, to: lone[0]! },
];

const sets = linksFromSets({ bundles: [bundle], snipers, insiders }, holders.map((holder) => holder.address));

export const SAMPLE_GRAPH: HolderGraph = buildHolderGraph(holders, [...transfers, ...sets]);

export const SAMPLE_NOTES: readonly string[] = ['Sample data: the token and its holders are made up, and no chain was read.'];
