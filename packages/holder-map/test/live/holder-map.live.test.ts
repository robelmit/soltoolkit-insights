/**
 * The holder map against mainnet. Opt-in with `LIVE=1`; it only reads.
 *
 *   LIVE=1 pnpm --filter @soltoolkit/holder-map test:live
 *
 * Environment:
 *   SOLANA_RPC_URL   any mainnet JSON-RPC endpoint (default: the public one)
 *
 * Which way the holders can be read depends on the endpoint and on the token,
 * so each test accepts the outcomes the package documents (a scan, the largest
 * accounts, or `HoldersUnavailable` with the reasons) and prints which one it
 * got. What it never accepts is an empty list for a token that has holders.
 */

import { createRpc, isAddress, type RpcClient } from '@soltoolkit/rpc';
import { beforeAll, describe, expect, it } from 'vitest';
import { HoldersUnavailable, buildHolderMap, readHolders, type HolderList } from '../../src/index';

const LIVE = process.env['LIVE'] === '1';
const RPC_URL = process.env['SOLANA_RPC_URL']?.trim() || 'https://api.mainnet-beta.solana.com';

/** A Token-2022 launchpad token held by a handful of addresses: small enough for a scan anywhere scans are served. */
const SMALL_TOKEN = 'Q2XHaRR82k2Ak2LtM9uEYEE7K9NWB2vyeCFTpRRpump';
/** Held by so many addresses that a scan's answer passes any sensible size cap. */
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function checkList(list: HolderList): void {
  expect(list.holders.length).toBeGreaterThan(0);
  expect(list.supply).toBeGreaterThan(0n);
  let total = 0n;
  list.holders.forEach((holder, i) => {
    expect(isAddress(holder.owner)).toBe(true);
    expect(holder.amount).toBeGreaterThan(0n);
    expect(['wallet', 'pda', 'program', 'pool', 'burn']).toContain(holder.kind);
    if (i > 0) expect(holder.amount <= list.holders[i - 1]!.amount).toBe(true);
    total += holder.amount;
  });
  expect(total <= list.supply).toBe(true);
  if (list.source === 'scan') expect(list.holderCount).toBeGreaterThanOrEqual(list.holders.length);
  else expect(list.holderCount).toBeNull();
}

describe.skipIf(!LIVE)('holder map on mainnet', () => {
  let rpc: RpcClient;

  beforeAll(() => {
    // One retry: an endpoint that refuses a call keeps refusing it, and the reason is what the test is after.
    rpc = createRpc({ url: RPC_URL, requestsPerSecond: 2, retries: 1 });
  });

  it('reads the holders of a small token', async () => {
    try {
      const list = await readHolders(rpc, SMALL_TOKEN, { scanTimeoutMs: 60_000 });
      expect(list).not.toBeNull();
      checkList(list!);
      expect(list!.tokenProgram).toBe('spl-token-2022');
      console.log(`small token: ${list!.source}, ${list!.holders.length} holders listed, count ${list!.holderCount}`, list!.notes);
      console.log(list!.holders.slice(0, 5).map((holder) => `${holder.owner} ${holder.pct}% ${holder.kind}${holder.label ? ` (${holder.label})` : ''}`));
    } catch (error) {
      expect(error).toBeInstanceOf(HoldersUnavailable);
      expect((error as HoldersUnavailable).reasons).toHaveLength(2);
      console.log('small token: not served by this endpoint', (error as HoldersUnavailable).reasons);
    }
  }, 180_000);

  it('never returns an empty list for a widely held token', async () => {
    // A small size cap, so a scan that cannot succeed is given up early instead of downloaded.
    const capped = createRpc({ url: RPC_URL, requestsPerSecond: 2, retries: 1, maxResponseBytes: 4 * 1024 * 1024 });
    try {
      const list = await readHolders(capped, BONK, { scanTimeoutMs: 20_000 });
      expect(list).not.toBeNull();
      checkList(list!);
      expect(list!.source).toBe('largest');
      expect(list!.notes[0]).toMatch(/^Scan: /);
      console.log(`BONK: ${list!.source}, ${list!.holders.length} holders listed`, list!.notes);
    } catch (error) {
      expect(error).toBeInstanceOf(HoldersUnavailable);
      expect((error as HoldersUnavailable).reasons).toHaveLength(2);
      console.log('BONK: not served by this endpoint', (error as HoldersUnavailable).reasons);
    }
  }, 180_000);

  it('builds a map within its call budget', async () => {
    let map;
    try {
      map = await buildHolderMap(rpc, SMALL_TOKEN, { scanTimeoutMs: 60_000, walk: 4, links: { maxCalls: 24, signaturesPerAccount: 5 } });
    } catch (error) {
      expect(error).toBeInstanceOf(HoldersUnavailable);
      console.log('map: holders not served by this endpoint', (error as HoldersUnavailable).reasons);
      return;
    }
    expect(map).not.toBeNull();
    expect(map!.graph.nodes.length).toBeGreaterThan(0);
    expect(map!.graph.nodes.length).toBe(map!.list!.holders.length);
    expect(map!.notes.length).toBeGreaterThan(0);
    if (map!.transfers) {
      expect(map!.transfers.calls).toBeLessThanOrEqual(24);
      expect(map!.transfers.holdersAsked).toBeLessThanOrEqual(4);
    }
    for (const edge of map!.graph.edges) expect(map!.graph.nodes.some((node) => node.id === edge.a) && map!.graph.nodes.some((node) => node.id === edge.b)).toBe(true);
    console.log('map notes', map!.notes);
    console.log('map', { nodes: map!.graph.nodes.length, edges: map!.graph.edges, clusters: map!.graph.clusters, transfers: map!.transfers && { ...map!.transfers, links: map!.transfers.links.length } });
  }, 240_000);
});
