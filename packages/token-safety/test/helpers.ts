/**
 * A scripted RPC and account fixtures in the shapes a mainnet node returns
 * (`jsonParsed` for mints and token accounts, base64 for everything else).
 */

import { createHash } from 'node:crypto';
import { RpcError, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, addressBytes, base58Encode, isOnCurve, type Rpc } from '@soltoolkit/rpc';
import { METAPLEX_METADATA_PROGRAM } from '../src/onchain';

export const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** The BONK metadata account's data, as mainnet returned it. */
export const BONK_METADATA_BASE64 =
  'BHlZUWfaSAxa4TRFAdIRt3NjQOP73wDs3mO2TciKzC8cvAfFbmCtPT8Xc4LqxlSPuh/TLP2QygKz58+hhf3Oc5ggAAAAQm9uawAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAQm9uawAAAAAAAMgAAABodHRwczovL2Fyd2VhdmUubmV0L1FQQzZGWWRVbi0zVjh5dEZOdW9DUzg1UzJ0SEF1aURibGg2dTNDSVpMc3cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAf8BAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

/** A made-up address that could be a wallet (it is a point on the curve). The same label always gives the same address. */
export function walletAddress(label: string): string {
  return pick(label, true);
}

/** A made-up address that no key can sign for (it is off the curve), like a program-derived address. */
export function offCurveAddress(label: string): string {
  return pick(label, false);
}

function pick(label: string, onCurve: boolean): string {
  for (let counter = 0; ; counter += 1) {
    const bytes = createHash('sha256').update(`${label}:${counter}`).digest();
    if (isOnCurve(bytes) === onCurve) return base58Encode(bytes);
  }
}

export interface MintFixture {
  readonly mintAuthority?: string | null;
  readonly freezeAuthority?: string | null;
  readonly supply?: bigint;
  readonly decimals?: number;
  /** Present for a Token-2022 mint. */
  readonly extensions?: readonly { extension: string; state?: unknown }[];
}

export function mintAccount(fixture: MintFixture = {}): unknown {
  const token2022 = fixture.extensions !== undefined;
  return {
    data: {
      parsed: {
        info: {
          decimals: fixture.decimals ?? 6,
          ...(token2022 ? { extensions: fixture.extensions } : {}),
          freezeAuthority: fixture.freezeAuthority ?? null,
          isInitialized: true,
          mintAuthority: fixture.mintAuthority ?? null,
          supply: String(fixture.supply ?? 1_000_000_000_000_000n),
        },
        type: 'mint',
      },
      program: token2022 ? 'spl-token-2022' : 'spl-token',
      space: 82,
    },
    executable: false,
    lamports: 1_461_600,
    owner: token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    rentEpoch: 18446744073709552000,
    space: 82,
  };
}

export function tokenAccount(mint: string, owner: string, amount: bigint, state: 'initialized' | 'frozen' = 'initialized'): unknown {
  return {
    data: {
      parsed: { info: { isNative: false, mint, owner, state, tokenAmount: { amount: String(amount), decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) } }, type: 'account' },
      program: 'spl-token',
      space: 165,
    },
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM,
    rentEpoch: 18446744073709552000,
    space: 165,
  };
}

/** An account as a base64 read returns it: only its owner matters to the classifier. */
export function plainAccount(owner: string = SYSTEM_PROGRAM, data = ''): unknown {
  return { data: [data, 'base64'], executable: false, lamports: 1_000_000, owner, rentEpoch: 18446744073709552000, space: 0 };
}

export interface MetaplexFixture {
  readonly mint: string;
  readonly updateAuthority: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly mutable: boolean;
  /** How many creators the account lists. Default none. */
  readonly creators?: number;
  /** Pad the strings with zero bytes to their full width, as older accounts do. */
  readonly padded?: boolean;
}

export function metaplexAccount(fixture: MetaplexFixture): unknown {
  const string = (value: string, width: number): Buffer => {
    const bytes = Buffer.from(value, 'utf8');
    const body = fixture.padded ? Buffer.concat([bytes, Buffer.alloc(width - bytes.length)]) : bytes;
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    return Buffer.concat([length, body]);
  };
  const creators = fixture.creators ?? 0;
  const creatorBytes = creators === 0 ? Buffer.from([0]) : Buffer.concat([Buffer.from([1, creators, 0, 0, 0]), Buffer.alloc(creators * 34, 7)]);
  const data = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(addressBytes(fixture.updateAuthority)),
    Buffer.from(addressBytes(fixture.mint)),
    string(fixture.name, 32),
    string(fixture.symbol, 10),
    string(fixture.uri, 200),
    Buffer.from([0, 0]),
    creatorBytes,
    Buffer.from([1, fixture.mutable ? 1 : 0]),
    Buffer.from([1, 255, 1, 2]),
  ]);
  return plainAccount(METAPLEX_METADATA_PROGRAM, data.toString('base64'));
}

export interface ScriptedChain {
  /** Every account the node knows, by address. An address that is not here reads as `null`. */
  readonly accounts: Record<string, unknown>;
  /** The largest token accounts of a mint, in the order the node lists them. Leave out to have the node refuse the call. */
  readonly largest?: readonly string[];
  /** Token accounts by owner, for `getTokenAccountsByOwner`. */
  readonly owned?: Record<string, readonly string[]>;
  /** Methods that fail, and the error each throws. */
  readonly failing?: Record<string, Error>;
}

export interface ScriptedRpc extends Rpc {
  readonly calls: { method: string; params: unknown[] }[];
}

/** An `Rpc` that answers from a table, in the node's envelope (`{ context, value }`). */
export function scriptedRpc(chain: ScriptedChain): ScriptedRpc {
  const calls: { method: string; params: unknown[] }[] = [];
  const context = { apiVersion: '4.4.0', slot: 1 };
  return {
    calls,
    async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
      calls.push({ method, params });
      const failure = chain.failing?.[method];
      if (failure) throw failure;
      switch (method) {
        case 'getMultipleAccounts':
          return { context, value: (params[0] as string[]).map((address) => chain.accounts[address] ?? null) } as T;
        case 'getTokenLargestAccounts':
          if (!chain.largest) throw new RpcError(method, 429, 'Too many requests for a specific RPC call');
          return { context, value: chain.largest.map((address) => ({ address, amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' })) } as T;
        case 'getTokenAccountsByOwner':
          return { context, value: (chain.owned?.[params[0] as string] ?? []).map((pubkey) => ({ pubkey, account: chain.accounts[pubkey] })) } as T;
        default:
          throw new RpcError(method, -32601, 'Method not found');
      }
    },
  };
}
