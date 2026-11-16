import { RpcError, RpcUnavailable, SYSTEM_PROGRAM, findProgramAddress } from '@soltoolkit/rpc';
import { describe, expect, it } from 'vitest';
import { POOL_AUTHORITIES, classifyOwner, metaplexMetadataAddress, readHoldingPct, readTokenFacts } from '../src/onchain';
import { checkToken, extensionWarnings } from '../src/report';
import { BONK, BONK_METADATA_BASE64, PUMP_PROGRAM, USDC, metaplexAccount, mintAccount, offCurveAddress, plainAccount, scriptedRpc, tokenAccount, walletAddress } from './helpers';
import { METAPLEX_METADATA_PROGRAM } from '../src/onchain';

const BONK_METADATA = 'FDZZbyY9XGpL3CNKUZxLk3wFTTQYL3TkDiDzqxrizcPN';
const RAYDIUM_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens at 6 decimals

/** The extensions of a mainnet Token-2022 stablecoin, as the node returned them (the authority shortened to one made-up address). */
const ISSUER = walletAddress('issuer');
const STABLECOIN_EXTENSIONS = [
  { extension: 'mintCloseAuthority', state: { closeAuthority: ISSUER } },
  { extension: 'permanentDelegate', state: { delegate: ISSUER } },
  { extension: 'transferFeeConfig', state: { newerTransferFee: { epoch: 605, maximumFee: 0, transferFeeBasisPoints: 0 }, olderTransferFee: { epoch: 605, maximumFee: 0, transferFeeBasisPoints: 0 }, transferFeeConfigAuthority: ISSUER, withdrawWithheldAuthority: ISSUER, withheldAmount: 0 } },
  { extension: 'confidentialTransferMint', state: { auditorElgamalPubkey: null, authority: ISSUER, autoApproveNewAccounts: false } },
  { extension: 'transferHook', state: { authority: ISSUER, programId: null } },
  { extension: 'metadataPointer', state: { authority: ISSUER, metadataAddress: USDC } },
  { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: USDC, name: 'Stable USD', symbol: 'SUSD', updateAuthority: ISSUER, uri: 'https://example.com/susd.json' } },
];

/** A launchpad Token-2022 mint: metadata in the mint, nobody can change it. */
const LAUNCHPAD_EXTENSIONS = [
  { extension: 'metadataPointer', state: { authority: null, metadataAddress: BONK } },
  { extension: 'tokenMetadata', state: { additionalMetadata: [], mint: BONK, name: ' Dog Coin ', symbol: 'DOG', updateAuthority: null, uri: 'https://example.com/dog.json' } },
];

describe('known addresses', () => {
  it('derives every pool authority from its program and seed', () => {
    const seeds: [string, string, string][] = [
      ['Raydium AMM v4', 'amm authority', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
      ['Raydium CPMM', 'vault_and_lp_mint_auth_seed', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'],
      ['Raydium LaunchLab', 'vault_auth_seed', 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj'],
      ['Meteora DAMM v2', 'pool_authority', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'],
      ['Meteora DBC', 'pool_authority', 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'],
    ];
    const derived = Object.fromEntries(seeds.map(([name, seed, program]) => [findProgramAddress([seed], program).address, name]));
    expect(derived).toEqual(POOL_AUTHORITIES);
  });

  it('derives the Metaplex metadata address of a mint', () => {
    expect(metaplexMetadataAddress(BONK)).toBe(BONK_METADATA);
  });
});

describe('readTokenFacts: the mint', () => {
  it('reads a classic token and its Metaplex metadata in one call', async () => {
    const rpc = scriptedRpc({
      accounts: { [BONK]: mintAccount({ supply: 8_799_429_439_154_324_651n, decimals: 5 }), [BONK_METADATA]: plainAccount(METAPLEX_METADATA_PROGRAM, BONK_METADATA_BASE64) },
    });
    const facts = await readTokenFacts(rpc, BONK, { holders: false });

    expect(facts).toMatchObject({ mint: BONK, tokenProgram: 'spl-token', decimals: 5, supply: 8_799_429_439_154_324_651n, mintAuthority: null, freezeAuthority: null, extensions: [], notes: [] });
    expect(facts?.metadata).toEqual({ source: 'metaplex', name: 'Bonk', symbol: 'Bonk', uri: 'https://arweave.net/QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u3CIZLsw', updateAuthority: '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw', mutable: true });
    expect(facts?.holders).toBeUndefined();
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]).toMatchObject({ method: 'getMultipleAccounts', params: [[BONK, BONK_METADATA], { encoding: 'jsonParsed', commitment: 'confirmed' }] });
  });

  it('reads live authorities as live', async () => {
    const minter = walletAddress('minter');
    const freezer = walletAddress('freezer');
    const rpc = scriptedRpc({ accounts: { [USDC]: mintAccount({ mintAuthority: minter, freezeAuthority: freezer }) } });
    const facts = await readTokenFacts(rpc, USDC, { holders: false });
    expect(facts).toMatchObject({ mintAuthority: minter, freezeAuthority: freezer });
    expect(facts?.metadata).toBeUndefined();
  });

  it('reads Metaplex metadata with unpadded strings, creators, and the immutable flag', async () => {
    const authority = walletAddress('update authority');
    for (const padded of [true, false]) {
      const rpc = scriptedRpc({
        accounts: {
          [BONK]: mintAccount(),
          [BONK_METADATA]: metaplexAccount({ mint: BONK, updateAuthority: authority, name: 'Cat', symbol: 'CAT', uri: 'https://example.com/cat.json', mutable: false, creators: 2, padded }),
        },
      });
      const facts = await readTokenFacts(rpc, BONK, { holders: false });
      expect(facts?.metadata).toEqual({ source: 'metaplex', name: 'Cat', symbol: 'CAT', uri: 'https://example.com/cat.json', updateAuthority: authority, mutable: false });
    }
  });

  it('does not take the metadata of another mint, or of another program, as this token’s', async () => {
    const other = metaplexAccount({ mint: USDC, updateAuthority: walletAddress('a'), name: 'X', symbol: 'X', uri: '', mutable: false });
    const wrongMint = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount(), [BONK_METADATA]: other } }), BONK, { holders: false });
    expect(wrongMint?.metadata).toBeUndefined();
    expect(wrongMint?.notes).toEqual(['The metadata account exists but could not be parsed.']);

    const wrongOwner = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount(), [BONK_METADATA]: plainAccount(SYSTEM_PROGRAM, BONK_METADATA_BASE64) } }), BONK, { holders: false });
    expect(wrongOwner?.metadata).toBeUndefined();
  });

  it('leaves metadata out when the account is cut short', async () => {
    const cut = Buffer.from(BONK_METADATA_BASE64, 'base64').subarray(0, 80).toString('base64');
    const facts = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount(), [BONK_METADATA]: plainAccount(METAPLEX_METADATA_PROGRAM, cut) } }), BONK, { holders: false });
    expect(facts?.metadata).toBeUndefined();
    expect(facts?.notes).toHaveLength(1);
  });

  it('reads Token-2022 metadata from the mint: immutable when the update authority is cleared', async () => {
    const facts = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount({ extensions: LAUNCHPAD_EXTENSIONS }) } }), BONK, { holders: false });
    expect(facts?.tokenProgram).toBe('spl-token-2022');
    expect(facts?.extensions.map((extension) => extension.name)).toEqual(['metadataPointer', 'tokenMetadata']);
    expect(facts?.metadata).toEqual({ source: 'token-2022', name: 'Dog Coin', symbol: 'DOG', uri: 'https://example.com/dog.json', updateAuthority: null, mutable: false });
  });

  it('reads Token-2022 metadata as mutable while it has an update authority', async () => {
    const facts = await readTokenFacts(scriptedRpc({ accounts: { [USDC]: mintAccount({ extensions: STABLECOIN_EXTENSIONS, mintAuthority: ISSUER, freezeAuthority: ISSUER }) } }), USDC, { holders: false });
    expect(facts?.metadata).toMatchObject({ source: 'token-2022', symbol: 'SUSD', updateAuthority: ISSUER, mutable: true });
    expect(facts?.extensions).toHaveLength(7);
  });

  it('answers null for an address that is not a mint', async () => {
    const wallet = walletAddress('someone');
    expect(await readTokenFacts(scriptedRpc({ accounts: {} }), BONK)).toBeNull(); // no account
    expect(await readTokenFacts(scriptedRpc({ accounts: { [wallet]: plainAccount() } }), wallet)).toBeNull(); // a wallet
    expect(await readTokenFacts(scriptedRpc({ accounts: { [BONK]: tokenAccount(USDC, wallet, 5n) } }), BONK)).toBeNull(); // a token account
  });

  it('throws on a mint it cannot read in full, and never guesses an authority', async () => {
    const broken = mintAccount() as { data: { parsed: { info: Record<string, unknown> } } };
    delete broken.data.parsed.info['mintAuthority'];
    await expect(readTokenFacts(scriptedRpc({ accounts: { [BONK]: broken } }), BONK)).rejects.toThrow('does not state its authorities');

    const odd = mintAccount() as { data: { parsed: { info: Record<string, unknown> } } };
    odd.data.parsed.info['freezeAuthority'] = 7;
    await expect(readTokenFacts(scriptedRpc({ accounts: { [BONK]: odd } }), BONK)).rejects.toThrow('freeze authority');
  });

  it('throws when the mint read fails', async () => {
    const down = new RpcUnavailable('getMultipleAccounts', 'HTTP 429 (after 5 attempts)', 5);
    await expect(readTokenFacts(scriptedRpc({ accounts: {}, failing: { getMultipleAccounts: down } }), BONK)).rejects.toBe(down);
    await expect(readTokenFacts(scriptedRpc({ accounts: {} }), 'not an address')).rejects.toThrow('Not a Solana address');
  });
});

describe('readTokenFacts: holders', () => {
  const curve = offCurveAddress('bonding curve');
  const alice = walletAddress('alice');
  const bob = walletAddress('bob');
  const vault = offCurveAddress('multisig vault');

  /** Token accounts t1..t7: a curve, a Raydium pool, a burn, alice twice (one frozen), bob, and a vault with no program account. */
  const chain = {
    accounts: {
      [BONK]: mintAccount({ supply: SUPPLY }),
      t1: tokenAccount(BONK, curve, 600_000_000_000_000n),
      t2: tokenAccount(BONK, RAYDIUM_AUTHORITY, 100_000_000_000_000n),
      t3: tokenAccount(BONK, INCINERATOR, 50_000_000_000_000n),
      t4: tokenAccount(BONK, alice, 40_000_000_000_000n),
      t5: tokenAccount(BONK, bob, 30_000_000_000_000n),
      t6: tokenAccount(BONK, alice, 20_000_000_000_000n, 'frozen'),
      t7: tokenAccount(BONK, vault, 10_000_000_000_000n),
      [curve]: plainAccount(PUMP_PROGRAM),
      [RAYDIUM_AUTHORITY]: plainAccount(), // System-owned, with lamports: it looks like a wallet
      [alice]: plainAccount(),
      // bob and the vault have no account at all
    },
    largest: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'],
  };

  it('sorts owners into kinds and counts only wallets and bare program-derived addresses', async () => {
    const rpc = scriptedRpc(chain);
    const facts = await readTokenFacts(rpc, BONK);

    expect(facts?.holders?.holders).toEqual([
      { owner: curve, amount: 600_000_000_000_000n, pct: 60, kind: 'program', label: PUMP_PROGRAM, accounts: 1, frozen: false },
      { owner: RAYDIUM_AUTHORITY, amount: 100_000_000_000_000n, pct: 10, kind: 'pool', label: 'Raydium AMM v4', accounts: 1, frozen: false },
      { owner: alice, amount: 60_000_000_000_000n, pct: 6, kind: 'wallet', accounts: 2, frozen: true },
      { owner: INCINERATOR, amount: 50_000_000_000_000n, pct: 5, kind: 'burn', accounts: 1, frozen: false },
      { owner: bob, amount: 30_000_000_000_000n, pct: 3, kind: 'wallet', accounts: 1, frozen: false },
      { owner: vault, amount: 10_000_000_000_000n, pct: 1, kind: 'pda', accounts: 1, frozen: false },
    ]);
    // alice 6 + bob 3 + vault 1. The curve, the pool and the burn are not holders.
    expect(facts?.holders?.top10Pct).toBe(10);
    // Seven accounts is the node's whole list, so nothing larger is missing.
    expect(facts?.holders?.complete).toBe(true);
    expect(facts?.notes).toEqual([]);

    expect(rpc.calls.map((call) => call.method)).toEqual(['getMultipleAccounts', 'getTokenLargestAccounts', 'getMultipleAccounts', 'getMultipleAccounts']);
    expect(rpc.calls[3]?.params[1]).toMatchObject({ encoding: 'base64', dataSlice: { offset: 0, length: 0 } });
  });

  it('treats the owners you name as pools', async () => {
    const facts = await readTokenFacts(scriptedRpc(chain), BONK, { poolOwners: [vault, bob] });
    expect(facts?.holders?.holders.filter((holder) => holder.kind === 'pool').map((holder) => holder.owner)).toEqual([RAYDIUM_AUTHORITY, bob, vault]);
    expect(facts?.holders?.top10Pct).toBe(6);
  });

  it('says the share is a lower bound when the node’s 20 accounts hold fewer than ten holders', async () => {
    const accounts: Record<string, unknown> = { [BONK]: mintAccount({ supply: SUPPLY }) };
    const largest: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      // Twelve program-owned vaults, then eight wallets.
      const owner = index < 12 ? offCurveAddress(`vault ${index}`) : walletAddress(`wallet ${index}`);
      if (index < 12) accounts[owner] = plainAccount(PUMP_PROGRAM);
      accounts[`t${index}`] = tokenAccount(BONK, owner, 10_000_000_000_000n);
      largest.push(`t${index}`);
    }
    const facts = await readTokenFacts(scriptedRpc({ accounts, largest }), BONK);
    expect(facts?.holders?.top10Pct).toBe(8);
    expect(facts?.holders?.complete).toBe(false);
  });

  it('has an empty, complete list for a token nobody holds', async () => {
    const facts = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount() }, largest: [] }), BONK);
    expect(facts?.holders).toEqual({ holders: [], top10Pct: 0, complete: true });
  });

  it('skips an account that closed between the two reads', async () => {
    const facts = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount({ supply: SUPPLY }), t1: tokenAccount(BONK, alice, 10_000_000_000_000n) }, largest: ['t1', 'gone'] }), BONK);
    expect(facts?.holders?.holders).toHaveLength(1);
  });

  it('does not list an empty account as a holding', async () => {
    const empty = offCurveAddress('empty vault');
    const rpc = scriptedRpc({
      accounts: { [BONK]: mintAccount({ supply: SUPPLY }), t1: tokenAccount(BONK, alice, 10_000_000_000_000n), t2: tokenAccount(BONK, empty, 0n), t3: tokenAccount(BONK, bob, 0n) },
      largest: ['t1', 't2', 't3'],
    });
    const result = await checkToken({ rpc, mint: BONK });
    expect(result?.facts.holders?.holders.map((holder) => holder.owner)).toEqual([alice]);
    expect(result?.notes).toEqual([]);

    const nobody = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount(), t2: tokenAccount(BONK, empty, 0n) }, largest: ['t2'] }), BONK);
    expect(nobody?.holders).toEqual({ holders: [], top10Pct: 0, complete: true });
  });

  it('leaves holders unknown, with a note, when the endpoint refuses the holder list', async () => {
    const facts = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount() } }), BONK);
    expect(facts?.mintAuthority).toBeNull();
    expect(facts?.holders).toBeUndefined();
    expect(facts?.notes).toHaveLength(1);
    expect(facts?.notes[0]).toBe('Holders not read: getTokenLargestAccounts: Too many requests for a specific RPC call. Many public endpoints refuse this call; use an endpoint that serves it.');
  });

  it('leaves holders unknown when an account in the list is not this mint’s', async () => {
    const facts = await readTokenFacts(scriptedRpc({ accounts: { [BONK]: mintAccount(), t1: tokenAccount(USDC, alice, 5n) }, largest: ['t1'] }), BONK);
    expect(facts?.holders).toBeUndefined();
    expect(facts?.notes[0]).toBe('Holders not read: getMultipleAccounts: an account in the answer is not a token account for this mint.');
  });
});

describe('classifyOwner', () => {
  it('knows burn addresses, pool authorities, program accounts, wallets and bare program-derived addresses', () => {
    const wallet = walletAddress('w');
    const derived = offCurveAddress('d');
    expect(classifyOwner(INCINERATOR, null)).toEqual({ kind: 'burn' });
    expect(classifyOwner(SYSTEM_PROGRAM, plainAccount('NativeLoader1111111111111111111111111111111'))).toEqual({ kind: 'burn' });
    expect(classifyOwner(RAYDIUM_AUTHORITY, plainAccount())).toEqual({ kind: 'pool', label: 'Raydium AMM v4' });
    expect(classifyOwner(wallet, plainAccount(), new Set([wallet]))).toEqual({ kind: 'pool' });
    expect(classifyOwner(derived, plainAccount(PUMP_PROGRAM))).toEqual({ kind: 'program', label: PUMP_PROGRAM });
    expect(classifyOwner(wallet, plainAccount())).toEqual({ kind: 'wallet' });
    expect(classifyOwner(wallet, null)).toEqual({ kind: 'wallet' });
    expect(classifyOwner(derived, plainAccount())).toEqual({ kind: 'pda' });
    expect(classifyOwner(derived, null)).toEqual({ kind: 'pda' });
  });
});

describe('readHoldingPct', () => {
  it('sums a wallet’s token accounts for the mint', async () => {
    const dev = walletAddress('dev');
    const rpc = scriptedRpc({ accounts: { a: tokenAccount(BONK, dev, 30_000_000_000_000n), b: tokenAccount(BONK, dev, 45_000_000_000_000n) }, owned: { [dev]: ['a', 'b'] } });
    expect(await readHoldingPct(rpc, dev, BONK, SUPPLY)).toBe(7.5);
    expect(rpc.calls[0]).toMatchObject({ method: 'getTokenAccountsByOwner', params: [dev, { mint: BONK }, { encoding: 'jsonParsed', commitment: 'confirmed' }] });
  });

  it('is zero for a wallet with no account, and unknown when the supply is zero', async () => {
    const dev = walletAddress('dev');
    expect(await readHoldingPct(scriptedRpc({ accounts: {} }), dev, BONK, SUPPLY)).toBe(0);
    expect(await readHoldingPct(scriptedRpc({ accounts: {} }), dev, BONK, 0n)).toBeUndefined();
  });

  it('throws on an answer for another mint', async () => {
    const dev = walletAddress('dev');
    const rpc = scriptedRpc({ accounts: { a: tokenAccount(USDC, dev, 1n) }, owned: { [dev]: ['a'] } });
    await expect(readHoldingPct(rpc, dev, BONK, SUPPLY)).rejects.toThrow('not a token account for this mint');
  });
});

describe('checkToken', () => {
  const dev = walletAddress('dev');
  const holders = Array.from({ length: 12 }, (_, index) => walletAddress(`holder ${index}`));
  const curve = offCurveAddress('curve');

  /** A clean launch: authorities revoked, immutable metadata, twelve holders of 1% each, the rest on the curve. */
  function cleanChain() {
    const accounts: Record<string, unknown> = {
      [BONK]: mintAccount({ supply: SUPPLY, extensions: LAUNCHPAD_EXTENSIONS }),
      curve0: tokenAccount(BONK, curve, 880_000_000_000_000n),
      [curve]: plainAccount(PUMP_PROGRAM),
      devAccount: tokenAccount(BONK, dev, 20_000_000_000_000n),
    };
    const largest = ['curve0'];
    holders.forEach((holder, index) => {
      accounts[`h${index}`] = tokenAccount(BONK, holder, 10_000_000_000_000n);
      largest.push(`h${index}`);
    });
    return { accounts, largest, owned: { [dev]: ['devAccount'] } };
  }

  it('grades a clean token 8/8 when every check has an input', async () => {
    const result = await checkToken({ rpc: scriptedRpc(cleanChain()), mint: BONK, creator: dev, simulateSell: async () => true, known: { lpBurnedPct: 100, bundlerPct: 4 } });
    expect(result?.inputs).toEqual({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, metadataMutable: false, top10Pct: 10, devHoldingPct: 2, sellSimulationPassed: true, lpBurnedPct: 100, bundlerPct: 4 });
    expect(result?.report).toMatchObject({ score: 8, maxScore: 8, grade: 'safe', unverifiedCount: 0, incomplete: false });
    expect(result?.warnings).toEqual([]);
    expect(result?.notes).toEqual([]);
  });

  it('grades on the chain alone as unknown, never as safe', async () => {
    // Only the two authorities and the metadata are known: five checks are not verified.
    const result = await checkToken({ rpc: scriptedRpc({ accounts: { [BONK]: mintAccount({ extensions: LAUNCHPAD_EXTENSIONS }) } }), mint: BONK });
    expect(result?.inputs).toEqual({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true, metadataMutable: false });
    expect(result?.report).toMatchObject({ score: 3, grade: 'unknown', unverifiedCount: 5, incomplete: true });
    expect(result?.report.checks.find((check) => check.id === 'top10_concentration')).toMatchObject({ passed: false, unverified: true, detail: 'Not verified' });
    expect(result?.notes[0]).toContain('Holders not read');
  });

  it('grades a live mint authority dangerous, whatever else is unknown', async () => {
    const result = await checkToken({ rpc: scriptedRpc({ accounts: { [USDC]: mintAccount({ mintAuthority: ISSUER, freezeAuthority: ISSUER }) } }), mint: USDC });
    expect(result?.report).toMatchObject({ grade: 'dangerous', cappedBy: 'mint_authority_revoked' });
  });

  it('takes the authorities from the chain, not from the caller', async () => {
    const result = await checkToken({
      rpc: scriptedRpc({ accounts: { [USDC]: mintAccount({ mintAuthority: ISSUER }) } }),
      mint: USDC,
      holders: false,
      known: { mintAuthorityRevoked: true, freezeAuthorityRevoked: false, metadataMutable: true, top10Pct: 12 },
    });
    expect(result?.inputs).toEqual({ mintAuthorityRevoked: false, freezeAuthorityRevoked: true, metadataMutable: true, top10Pct: 12 });
  });

  it('prefers the caller’s holder figures to the largest-accounts estimate', async () => {
    const rpc = scriptedRpc(cleanChain());
    const result = await checkToken({ rpc, mint: BONK, creator: dev, known: { top10Pct: 44, devHoldingPct: 9 } });
    expect(result?.inputs).toMatchObject({ top10Pct: 44, devHoldingPct: 9 });
    expect(rpc.calls.some((call) => call.method === 'getTokenAccountsByOwner')).toBe(false);
  });

  it('uses only a definite answer from the sell simulation', async () => {
    const base = { mint: BONK, holders: false } as const;
    const chain = { accounts: { [BONK]: mintAccount() } };

    const failed = await checkToken({ ...base, rpc: scriptedRpc(chain), simulateSell: async () => false });
    expect(failed?.inputs.sellSimulationPassed).toBe(false);
    expect(failed?.report).toMatchObject({ grade: 'dangerous', cappedBy: 'no_honeypot' });

    const unknown = await checkToken({ ...base, rpc: scriptedRpc(chain), simulateSell: async () => undefined });
    expect(unknown?.inputs).not.toHaveProperty('sellSimulationPassed');
    expect(unknown?.notes).toEqual(['The sell simulation could not be run.']);

    const threw = await checkToken({
      ...base,
      rpc: scriptedRpc(chain),
      simulateSell: async () => {
        throw new Error('no route');
      },
    });
    expect(threw?.inputs).not.toHaveProperty('sellSimulationPassed');
    expect(threw?.notes).toEqual(['The sell simulation could not be run: no route.']);
  });

  it('hands the facts it read to the sell simulation', async () => {
    let seen: unknown;
    await checkToken({
      rpc: scriptedRpc(cleanChain()),
      mint: BONK,
      simulateSell: async (facts) => {
        seen = facts.holders?.holders.find((holder) => holder.kind === 'wallet')?.owner;
        return true;
      },
    });
    expect(holders).toContain(seen);
  });

  it('leaves dev holding unverified, with a note, when the creator’s balance cannot be read', async () => {
    const result = await checkToken({ rpc: scriptedRpc({ accounts: { [BONK]: mintAccount() }, failing: { getTokenAccountsByOwner: new RpcError('getTokenAccountsByOwner', -32010, 'excluded from account secondary indexes') } }), mint: BONK, holders: false, creator: dev });
    expect(result?.inputs).not.toHaveProperty('devHoldingPct');
    expect(result?.notes).toEqual(['Dev holding not read: getTokenAccountsByOwner: excluded from account secondary indexes.']);
  });

  it('does not grade a lower bound as a pass, but does grade it as a failure', async () => {
    const build = (walletAmount: bigint) => {
      const accounts: Record<string, unknown> = { [BONK]: mintAccount({ supply: SUPPLY }) };
      const largest: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const owner = index < 12 ? offCurveAddress(`vault ${index}`) : walletAddress(`wallet ${index}`);
        if (index < 12) accounts[owner] = plainAccount(PUMP_PROGRAM);
        accounts[`t${index}`] = tokenAccount(BONK, owner, index < 12 ? 1_000_000_000_000n : walletAmount);
        largest.push(`t${index}`);
      }
      return { accounts, largest };
    };

    const low = await checkToken({ rpc: scriptedRpc(build(10_000_000_000_000n)), mint: BONK }); // eight wallets, 8%
    expect(low?.facts.holders).toMatchObject({ top10Pct: 8, complete: false });
    expect(low?.inputs).not.toHaveProperty('top10Pct');
    expect(low?.notes[0]).toContain('lower bound');

    const high = await checkToken({ rpc: scriptedRpc(build(50_000_000_000_000n)), mint: BONK }); // eight wallets, 40%
    expect(high?.inputs.top10Pct).toBe(40);
    expect(high?.report.checks.find((check) => check.id === 'top10_concentration')).toMatchObject({ passed: false, unverified: false });
  });

  it('notes a large holder that is a program-derived address with no program account', async () => {
    const vault = offCurveAddress('team vault');
    const result = await checkToken({ rpc: scriptedRpc({ accounts: { [BONK]: mintAccount({ supply: SUPPLY }), t1: tokenAccount(BONK, vault, 400_000_000_000_000n) }, largest: ['t1'] }), mint: BONK });
    expect(result?.inputs.top10Pct).toBe(40);
    expect(result?.notes).toHaveLength(1);
    expect(result?.notes[0]).toContain('1 of the ten largest holders is a program-derived address');
  });

  it('answers null for an address that is not a mint', async () => {
    expect(await checkToken({ rpc: scriptedRpc({ accounts: {} }), mint: BONK })).toBeNull();
  });

  it('lists what Token-2022 extensions allow, without scoring it', async () => {
    const result = await checkToken({ rpc: scriptedRpc({ accounts: { [USDC]: mintAccount({ extensions: STABLECOIN_EXTENSIONS }) } }), mint: USDC, holders: false });
    expect(result?.warnings).toEqual([
      `Permanent delegate: ${ISSUER} can move or burn any holder's tokens.`,
      `Transfer fee: 0% now, but ${ISSUER} can raise it.`,
      `Transfer hook: none is set, but ${ISSUER} can set one.`,
    ]);
    expect(result?.report.score).toBe(2); // both authorities revoked; the mutable metadata fails; the warnings change nothing
  });
});

describe('extensionWarnings', () => {
  it('states a live transfer fee, a live hook, frozen-by-default accounts, and tokens that cannot move', () => {
    const hook = offCurveAddress('hook program');
    expect(
      extensionWarnings([
        { name: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 250 }, olderTransferFee: { transferFeeBasisPoints: 100 }, transferFeeConfigAuthority: null } },
        { name: 'transferHook', state: { authority: null, programId: hook } },
        { name: 'defaultAccountState', state: { accountState: 'frozen' } },
        { name: 'nonTransferable', state: {} },
        { name: 'pausableConfig', state: {} },
      ]),
    ).toEqual([
      'Transfer fee: 2.50% of every transfer is withheld.',
      `Transfer hook: every transfer runs the program ${hook}, which can refuse it.`,
      'New token accounts start frozen: a buyer cannot move the token until the freeze authority thaws the account.',
      'Non-transferable: the token cannot be sent or sold.',
      'Pausable: an authority can stop every transfer of this token.',
    ]);
  });

  it('says nothing about extensions that give nobody power over a holder', () => {
    expect(
      extensionWarnings([
        { name: 'metadataPointer', state: { authority: null, metadataAddress: BONK } },
        { name: 'tokenMetadata', state: { updateAuthority: null } },
        { name: 'permanentDelegate', state: { delegate: null } },
        { name: 'transferHook', state: { authority: null, programId: null } },
        { name: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 0 }, olderTransferFee: { transferFeeBasisPoints: 0 }, transferFeeConfigAuthority: null } },
        { name: 'defaultAccountState', state: { accountState: 'initialized' } },
      ]),
    ).toEqual([]);
  });
});
