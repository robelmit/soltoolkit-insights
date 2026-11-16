import { RpcAnswerTooLarge, RpcError } from '@soltoolkit/rpc';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_TIMEOUT_MS, HoldersUnavailable, readHolders } from '../src';
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, fakeRpc, offCurve, scanSlice, strayEntry, wallet, type FakeChain } from './chain';

const MINT = wallet('mint');
const WHALE = wallet('whale');
const SMALL = wallet('small');
const EMPTY = wallet('empty');
const EXCHANGE = wallet('exchange');
const DERIVED = offCurve('derived');
const VAULT = offCurve('vault');
const VAULT_PROGRAM = wallet('vault program');
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

/** Six holders of every kind, and one account that holds nothing. */
function token(overrides: Partial<FakeChain> = {}): FakeChain {
  return {
    mint: MINT,
    supply: 1_000_000n,
    tokenAccounts: [
      { address: 'whale-1', owner: WHALE, amount: 200_000n },
      { address: 'whale-2', owner: WHALE, amount: 50_000n },
      { address: 'derived-1', owner: DERIVED, amount: 100_000n },
      { address: 'vault-1', owner: VAULT, amount: 300_000n },
      { address: 'burn-1', owner: INCINERATOR, amount: 50_000n },
      { address: 'exchange-1', owner: EXCHANGE, amount: 150_000n },
      { address: 'empty-1', owner: EMPTY, amount: 0n },
      { address: 'small-1', owner: SMALL, amount: 1n },
    ],
    ownerPrograms: { [WHALE]: SYSTEM_PROGRAM, [VAULT]: VAULT_PROGRAM },
    ...overrides,
  };
}

const NO_INDEX = new RpcError('getProgramAccounts', -32010, `${TOKEN_PROGRAM} excluded from account secondary indexes; this RPC method unavailable for key`);
const REFUSED = new RpcError('getTokenLargestAccounts', 429, 'Too many requests for a specific RPC call');

describe('readHolders by scan', () => {
  it('adds up each owner’s accounts, drops empty ones, and says what each owner is', async () => {
    const list = await readHolders(fakeRpc(token()), MINT, { poolOwners: [EXCHANGE] });

    expect(list).toEqual({
      mint: MINT,
      tokenProgram: 'spl-token',
      decimals: 6,
      supply: 1_000_000n,
      source: 'scan',
      holders: [
        { owner: VAULT, amount: 300_000n, pct: 30, kind: 'program', label: VAULT_PROGRAM, accounts: 1 },
        { owner: WHALE, amount: 250_000n, pct: 25, kind: 'wallet', accounts: 2 },
        { owner: EXCHANGE, amount: 150_000n, pct: 15, kind: 'pool', accounts: 1 },
        { owner: DERIVED, amount: 100_000n, pct: 10, kind: 'pda', accounts: 1 },
        { owner: INCINERATOR, amount: 50_000n, pct: 5, kind: 'burn', accounts: 1 },
        { owner: SMALL, amount: 1n, pct: 0.0001, kind: 'wallet', accounts: 1 },
      ],
      holderCount: 6,
      notes: [],
    });
  });

  it('asks for the owner and amount of each account only, once, with its own time limit', async () => {
    const rpc = fakeRpc(token());
    await readHolders(rpc, MINT);

    expect(rpc.calls.filter((call) => call.method === 'getProgramAccounts')).toEqual([
      {
        method: 'getProgramAccounts',
        params: [TOKEN_PROGRAM, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 32, length: 40 }, filters: [{ memcmp: { offset: 0, bytes: MINT } }, { dataSize: 165 }] }],
        options: { timeoutMs: DEFAULT_SCAN_TIMEOUT_MS, retries: 0 },
      },
    ]);
    expect(rpc.count('getTokenLargestAccounts')).toBe(0);

    const slow = fakeRpc(token());
    await readHolders(slow, MINT, { scanTimeoutMs: 90_000, commitment: 'finalized' });
    const scan = slow.calls.find((call) => call.method === 'getProgramAccounts');
    expect(scan?.options).toEqual({ timeoutMs: 90_000, retries: 0 });
    expect((scan?.params[1] as { commitment: string }).commitment).toBe('finalized');
  });

  it('returns the largest holders up to the limit, and still counts them all', async () => {
    const rpc = fakeRpc(token());
    const list = await readHolders(rpc, MINT, { limit: 2 });

    expect(list?.holders.map((holder) => holder.owner)).toEqual([VAULT, WHALE]);
    expect(list?.holderCount).toBe(6);
    // Only the owners that are returned are looked up.
    expect(rpc.calls.at(-1)?.params[0]).toEqual([VAULT, WHALE]);
  });

  it('looks the owners up a hundred at a time', async () => {
    const tokenAccounts = Array.from({ length: 150 }, (_, i) => ({ address: `account-${i}`, owner: wallet(`holder ${i}`), amount: BigInt(1000 - i) }));
    const rpc = fakeRpc(token({ tokenAccounts }));
    const list = await readHolders(rpc, MINT, { limit: 150 });

    expect(list?.holders).toHaveLength(150);
    expect(list?.holders[0]?.owner).toBe(wallet('holder 0'));
    expect(list?.holders[149]?.owner).toBe(wallet('holder 149'));
    const lookups = rpc.calls.filter((call) => call.method === 'getMultipleAccounts').map((call) => (call.params[0] as string[]).length);
    expect(lookups).toEqual([2, 100, 50]); // the mint and its metadata, then the owners
  });

  it('reads the list from an answer with a context around it', async () => {
    const list = await readHolders(fakeRpc(token({ scanWithContext: true })), MINT);
    expect(list?.holderCount).toBe(6);
  });

  it('scans the Token-2022 program for a Token-2022 mint, and counts token accounts only', async () => {
    const forged = wallet('forger');
    const rpc = fakeRpc(
      token({
        token2022: true,
        tokenAccounts: [
          { address: 'whale-1', owner: WHALE, amount: 200_000n }, // 170 bytes: an account with an extension
          { address: 'plain-1', owner: SMALL, amount: 100_000n, space: 165 },
        ],
        strayScanEntries: [
          // A multisig whose first signer is the mint matches the filter. It is not a holding.
          strayEntry('multisig', forged, 600_000n, 355),
          // Nor is anything smaller than a token account.
          strayEntry('short', forged, 50_000n, 82),
        ],
      }),
    );
    const list = await readHolders(rpc, MINT);

    expect(list?.tokenProgram).toBe('spl-token-2022');
    expect(list?.holders.map((holder) => [holder.owner, holder.amount])).toEqual([
      [WHALE, 200_000n],
      [SMALL, 100_000n],
    ]);
    expect(list?.holderCount).toBe(2);
    const scan = rpc.calls.find((call) => call.method === 'getProgramAccounts');
    expect(scan?.params[0]).toBe(TOKEN_2022_PROGRAM);
    // No size filter: a Token-2022 account's size depends on its extensions.
    expect((scan?.params[1] as { filters: unknown[] }).filters).toEqual([{ memcmp: { offset: 0, bytes: MINT } }]);
  });

  it('refuses a scan whose balances add up to more than the supply', async () => {
    // A node that does not report sizes cannot be told a forged account from a real one.
    const forged = { pubkey: 'multisig', account: { data: [scanSlice(wallet('forger'), 900_000n), 'base64'], owner: TOKEN_PROGRAM } };
    const rpc = fakeRpc(token({ scanWithoutSpace: true, strayScanEntries: [forged] }));

    const failure = await readHolders(rpc, MINT, { source: 'scan' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HoldersUnavailable);
    expect((failure as HoldersUnavailable).reasons).toEqual(['Scan: getProgramAccounts: the balances add up to more than the supply.']);
  });

  it('refuses an empty answer for a token that has a supply', async () => {
    const failure = await readHolders(fakeRpc(token({ tokenAccounts: [] })), MINT, { source: 'scan' }).catch((error: unknown) => error);
    expect((failure as HoldersUnavailable).reasons).toEqual(['Scan: getProgramAccounts: no account holds a balance, though the token has a supply.']);
  });

  it('has no holders for a token with no supply', async () => {
    const list = await readHolders(fakeRpc(token({ supply: 0n, tokenAccounts: [{ address: 'empty-1', owner: EMPTY, amount: 0n }] })), MINT);
    expect(list).toMatchObject({ source: 'scan', holders: [], holderCount: 0 });
  });

  it('refuses an answer that is not what was asked for', async () => {
    const reasons = async (entry: unknown): Promise<readonly string[]> => {
      const failure = await readHolders(fakeRpc(token({ strayScanEntries: [entry] })), MINT, { source: 'scan' }).catch((error: unknown) => error);
      return (failure as HoldersUnavailable).reasons;
    };
    expect(await reasons({ pubkey: 'x', account: { data: { parsed: {} }, space: 165 } })).toEqual(['Scan: getProgramAccounts: an entry has no base64 data.']);
    expect(await reasons({ pubkey: 'x', account: { data: [Buffer.alloc(165).toString('base64'), 'base64'], space: 165 } })).toEqual(['Scan: getProgramAccounts: an entry is not the 40 bytes that were asked for.']);
  });

  it('with `scan` as the only way, does not fall back', async () => {
    const rpc = fakeRpc(token({ refuse: { getProgramAccounts: NO_INDEX } }));
    const failure = await readHolders(rpc, MINT, { source: 'scan' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HoldersUnavailable);
    expect((failure as HoldersUnavailable).mint).toBe(MINT);
    expect((failure as HoldersUnavailable).reasons).toHaveLength(1);
    expect((failure as HoldersUnavailable).message).toContain(`The holders of ${MINT} could not be read. Scan: getProgramAccounts: `);
    expect(rpc.count('getTokenLargestAccounts')).toBe(0);
  });
});

describe('readHolders by the largest accounts', () => {
  it('falls back when the scan fails, and says why the list is short', async () => {
    const rpc = fakeRpc(token({ refuse: { getProgramAccounts: new RpcAnswerTooLarge('getProgramAccounts', 64 * 1024 * 1024) } }));
    const list = await readHolders(rpc, MINT, { poolOwners: [EXCHANGE] });

    expect(list).toMatchObject({ source: 'largest', holderCount: null, supply: 1_000_000n, decimals: 6 });
    expect(list?.holders).toEqual([
      { owner: VAULT, amount: 300_000n, pct: 30, kind: 'program', label: VAULT_PROGRAM, accounts: 1 },
      { owner: WHALE, amount: 250_000n, pct: 25, kind: 'wallet', accounts: 2 },
      { owner: EXCHANGE, amount: 150_000n, pct: 15, kind: 'pool', accounts: 1 },
      { owner: DERIVED, amount: 100_000n, pct: 10, kind: 'pda', accounts: 1 },
      { owner: INCINERATOR, amount: 50_000n, pct: 5, kind: 'burn', accounts: 1 },
      { owner: SMALL, amount: 1n, pct: 0.0001, kind: 'wallet', accounts: 1 },
    ]);
    expect(list?.notes).toEqual(['Scan: getProgramAccounts: the answer is larger than 67108864 bytes.', 'The list is the owners of the largest token accounts (twenty accounts at most), so it may not be every holder.']);
    expect(rpc.count('getProgramAccounts')).toBe(1);
  });

  it('with `largest` as the only way, does not scan', async () => {
    const rpc = fakeRpc(token());
    const list = await readHolders(rpc, MINT, { source: 'largest', limit: 3 });

    expect(list?.source).toBe('largest');
    expect(list?.holders.map((holder) => holder.owner)).toEqual([VAULT, WHALE, EXCHANGE]);
    expect(list?.notes).toEqual(['The list is the owners of the largest token accounts (twenty accounts at most), so it may not be every holder.']);
    expect(rpc.count('getProgramAccounts')).toBe(0);
  });

  it('throws with both reasons when neither way is served', async () => {
    const rpc = fakeRpc(token({ refuse: { getProgramAccounts: NO_INDEX, getTokenLargestAccounts: REFUSED } }));
    const failure = await readHolders(rpc, MINT).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HoldersUnavailable);
    const { reasons } = failure as HoldersUnavailable;
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toMatch(/^Scan: getProgramAccounts: .*excluded from account secondary indexes/);
    expect(reasons[1]).toMatch(/^Largest accounts: getTokenLargestAccounts: Too many requests/);
  });
});

describe('readHolders', () => {
  it('is null for an address that is not a token mint', async () => {
    const rpc = fakeRpc(token());
    expect(await readHolders(rpc, WHALE)).toBeNull();
    expect(await readHolders(rpc, WHALE, { source: 'largest' })).toBeNull();
    expect(rpc.count('getProgramAccounts')).toBe(0);
  });

  it('refuses what is not an address, and a limit that is not a count', async () => {
    const rpc = fakeRpc(token());
    await expect(readHolders(rpc, 'not-an-address')).rejects.toThrow('Not a Solana address');
    await expect(readHolders(rpc, MINT, { limit: 0 })).rejects.toThrow('limit');
    await expect(readHolders(rpc, MINT, { limit: 2.5 })).rejects.toThrow('limit');
    expect(rpc.calls).toHaveLength(0);
  });

  it('lets a failed read of the mint itself through as the error it is', async () => {
    const down = new RpcError('getMultipleAccounts', -32005, 'Node is unhealthy');
    await expect(readHolders(fakeRpc(token({ refuse: { getMultipleAccounts: down } })), MINT)).rejects.toBe(down);
  });
});
