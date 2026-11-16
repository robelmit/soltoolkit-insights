/**
 * The reader against mainnet. Opt-in with `LIVE=1`; it only reads.
 *
 *   LIVE=1 pnpm --filter @soltoolkit/token-safety test:live
 *
 * Environment:
 *   SOLANA_RPC_URL   any mainnet JSON-RPC endpoint (default: the public one)
 *
 * The public endpoint refuses `getTokenLargestAccounts`, so on it the holder
 * test checks the other outcome: holders left out, with a note. Point
 * SOLANA_RPC_URL at an endpoint that serves the call to test the holder read.
 */

import { createRpc, type RpcClient } from '@soltoolkit/rpc';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkToken, readHoldingPct, readTokenFacts } from '../../src/index';

const LIVE = process.env['LIVE'] === '1';
const RPC_URL = process.env['SOLANA_RPC_URL']?.trim() || 'https://api.mainnet-beta.solana.com';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
/** A Token-2022 stablecoin with a permanent delegate, a transfer-fee config and a transfer-hook slot. */
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
/** A Token-2022 pump.fun graduate: metadata in the mint, update authority cleared. */
const PUMP_2022 = 'Q2XHaRR82k2Ak2LtM9uEYEE7K9NWB2vyeCFTpRRpump';
/** Holds the vaults of every Raydium AMM v4 pool, BONK's among them. */
const RAYDIUM_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

describe.skipIf(!LIVE)('token facts on mainnet', () => {
  let rpc: RpcClient;

  beforeAll(() => {
    rpc = createRpc({ url: RPC_URL, requestsPerSecond: 2 });
  });

  it('reads USDC: both authorities live, graded dangerous', async () => {
    const result = await checkToken({ rpc, mint: USDC, holders: false });
    expect(result?.facts).toMatchObject({ tokenProgram: 'spl-token', decimals: 6 });
    expect(result?.facts.mintAuthority).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(result?.facts.freezeAuthority).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(result?.facts.supply).toBeGreaterThan(0n);
    expect(result?.facts.metadata).toMatchObject({ source: 'metaplex', symbol: 'USDC' });
    expect(result?.report).toMatchObject({ grade: 'dangerous', cappedBy: 'mint_authority_revoked' });
    console.log('USDC', result?.facts.metadata, result?.report.grade, `${result?.report.score}/${result?.report.maxScore}`);
  });

  it('reads BONK: authorities revoked, Metaplex metadata', async () => {
    const facts = await readTokenFacts(rpc, BONK, { holders: false });
    expect(facts).toMatchObject({ tokenProgram: 'spl-token', decimals: 5, mintAuthority: null, freezeAuthority: null, extensions: [] });
    expect(facts?.metadata).toMatchObject({ source: 'metaplex', name: 'Bonk', symbol: 'Bonk' });
    expect(typeof facts?.metadata?.mutable).toBe('boolean');
    console.log('BONK', facts?.metadata);
  });

  it('reads a Token-2022 launchpad token: metadata in the mint, nobody can change it', async () => {
    const result = await checkToken({ rpc, mint: PUMP_2022, holders: false });
    expect(result?.facts).toMatchObject({ tokenProgram: 'spl-token-2022', mintAuthority: null, freezeAuthority: null });
    expect(result?.facts.metadata).toMatchObject({ source: 'token-2022', updateAuthority: null, mutable: false });
    expect(result?.inputs).toEqual({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, metadataMutable: false });
    // Three of eight known: not enough to call it safe.
    expect(result?.report).toMatchObject({ score: 3, grade: 'unknown' });
    console.log(PUMP_2022, result?.facts.metadata?.name, result?.facts.extensions.map((extension) => extension.name), result?.warnings);
  });

  it('reads a Token-2022 stablecoin and states what its extensions allow', async () => {
    const result = await checkToken({ rpc, mint: PYUSD, holders: false });
    expect(result?.facts.tokenProgram).toBe('spl-token-2022');
    expect(result?.facts.metadata).toMatchObject({ source: 'token-2022', symbol: 'PYUSD', mutable: true });
    expect(result?.facts.extensions.map((extension) => extension.name)).toEqual(expect.arrayContaining(['permanentDelegate', 'transferFeeConfig', 'transferHook', 'tokenMetadata']));
    expect(result?.warnings.some((warning) => warning.startsWith('Permanent delegate: '))).toBe(true);
    console.log('PYUSD', result?.warnings);
  });

  it('answers null for a wallet and for a program', async () => {
    expect(await readTokenFacts(rpc, RAYDIUM_AUTHORITY, { holders: false })).toBeNull();
    expect(await readTokenFacts(rpc, '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', { holders: false })).toBeNull();
  });

  it('reads the share of a token one owner holds', async () => {
    const facts = await readTokenFacts(rpc, BONK, { holders: false });
    const pct = await readHoldingPct(rpc, RAYDIUM_AUTHORITY, BONK, facts!.supply);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
    console.log('Raydium AMM v4 pools hold', pct, '% of BONK');
  });

  it('reads the largest holders, or says why it could not', async () => {
    const result = await checkToken({ rpc: createRpc({ url: RPC_URL, requestsPerSecond: 1, retries: 1 }), mint: BONK });
    const holders = result?.facts.holders;
    if (!holders) {
      // The endpoint does not serve the holder list: unknown, with the reason.
      expect(result?.notes[0]).toContain('Holders not read');
      expect(result?.inputs).not.toHaveProperty('top10Pct');
      expect(result?.report.checks.find((check) => check.id === 'top10_concentration')).toMatchObject({ unverified: true });
      console.log('holders not served by this endpoint:', result?.notes[0]);
      return;
    }
    expect(holders.holders.length).toBeGreaterThan(0);
    expect(holders.top10Pct).toBeGreaterThan(0);
    expect(holders.top10Pct).toBeLessThanOrEqual(100);
    for (const holder of holders.holders) expect(['wallet', 'pda', 'program', 'pool', 'burn']).toContain(holder.kind);
    console.table(holders.holders.map((holder) => ({ owner: holder.owner, pct: holder.pct, kind: holder.kind, label: holder.label ?? '' })));
    console.log('top ten:', holders.top10Pct, '% complete:', holders.complete, result?.notes);
  }, 90_000);
});
