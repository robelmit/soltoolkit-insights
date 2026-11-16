/**
 * The detector against mainnet. Opt-in with `LIVE=1`; it only reads.
 *
 *   LIVE=1 pnpm --filter @soltoolkit/app-registry test:live
 *
 * Environment:
 *   SOLANA_RPC_URL   any mainnet JSON-RPC endpoint (default: the public one)
 *
 * For each router below it takes the program's latest transactions, reads
 * them the way the README shows, and expects the detector to name the
 * platform the registry lists the router under. A router that has gone quiet
 * or moved fails here, which is the point: the entry needs a new look.
 */

import { createRpc, type RpcClient } from '@soltoolkit/rpc';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILT_IN_INDEX, attributePlatform, solanaTxFacts } from '../../src/index';

const LIVE = process.env['LIVE'] === '1';
const RPC_URL = process.env['SOLANA_RPC_URL']?.trim() || 'https://api.mainnet-beta.solana.com';

const ROUTERS: readonly { platform: string; program: string }[] = [
  { platform: 'axiom', program: 'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9' },
  { platform: 'photon', program: 'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW' },
  { platform: 'trojan', program: 'troyXT7Ty3s2rjJe4bqWaroUrS4Fjd8rbHHNHxcACF4' },
];

interface SignatureRow {
  readonly signature: string;
  readonly err: unknown;
}

describe.skipIf(!LIVE)('attribution on mainnet', () => {
  let rpc: RpcClient;

  beforeAll(() => {
    rpc = createRpc({ url: RPC_URL, requestsPerSecond: 2 });
  });

  it.each(ROUTERS)('names $platform for a recent transaction of its router', async ({ platform, program }) => {
    expect(BUILT_IN_INDEX.solanaProgram(program)).toMatchObject({ shared: false, platform: { id: platform } });
    const rows = await rpc.call<SignatureRow[]>('getSignaturesForAddress', [program, { limit: 15 }]);
    const landed = rows.filter((row) => row.err === null).slice(0, 5);
    expect(landed.length).toBeGreaterThan(0);

    const seen: string[] = [];
    for (const row of landed) {
      // Version 1 transactions only come back when the request allows them.
      const result = await rpc.call<unknown>('getTransaction', [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      const tx = solanaTxFacts(result);
      if (!tx) continue;
      const got = attributePlatform(tx);
      seen.push(`${row.signature.slice(0, 8)}… ${got ? `${got.platform} by ${got.by}` : 'nothing'}`);
    }
    console.log(platform, seen);
    expect(seen.some((line) => line.includes(` ${platform} by `))).toBe(true);
  }, 90_000);
});
