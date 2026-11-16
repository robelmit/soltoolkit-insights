/**
 * A wallet's recent trading record, read from a plain RPC endpoint.
 *
 *   pnpm --filter example-wallet-report start <wallet> [solPriceUsd]
 *
 * Reads the wallet's latest transactions, keeps the ones that swapped SOL for
 * one token or one token for SOL, and hands that trade list to the PnL
 * package. Reads only: nothing is signed and nothing is sent.
 *
 * With `solPriceUsd`, values are in dollars at that one price and the two
 * scores are shown (their scales are in dollars). Without it, values are in
 * SOL and the scores are left out.
 *
 * SOLANA_RPC_URL   the endpoint (default: the public mainnet one)
 * LIMIT            how many of the latest transactions to read (default 40)
 *
 * What this reader does not do: it does not price each trade at the SOL price
 * of its own day, it skips swaps paid in a stablecoin or another token, and
 * the SOL side of a trade is everything the wallet paid or received in that
 * transaction (network fee, tips and account rent included).
 */

import { createRpc, isAddress } from '@soltoolkit/rpc';
import {
  computePnlDistribution,
  computeSmartScore,
  computeWalletPerformance,
  extremePositions,
  recordFromPerformance,
  scoreWalletForCopying,
  type WalletTrade,
} from '@soltoolkit/wallet-pnl';

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

const [wallet, priceArg] = process.argv.slice(2);
if (!wallet || !isAddress(wallet)) {
  console.error('usage: pnpm --filter example-wallet-report start <wallet> [solPriceUsd]');
  process.exit(1);
}
const solPrice = priceArg === undefined ? undefined : Number(priceArg);
if (solPrice !== undefined && !(solPrice > 0)) {
  console.error(`solPriceUsd must be a positive number, got ${priceArg}`);
  process.exit(1);
}
const limit = Number(process.env['LIMIT'] ?? 40);
const rpc = createRpc({ url: process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com', requestsPerSecond: 2 });

interface TokenBalance {
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

interface Transaction {
  readonly blockTime: number | null;
  readonly transaction: { readonly message: { readonly accountKeys: readonly string[] } };
  readonly meta: {
    readonly err: unknown;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly TokenBalance[];
    readonly postTokenBalances?: readonly TokenBalance[];
  } | null;
}

/** What the wallet's token accounts held, per mint, in base units. */
function held(balances: readonly TokenBalance[] | undefined): Map<string, { amount: bigint; decimals: number }> {
  const byMint = new Map<string, { amount: bigint; decimals: number }>();
  for (const balance of balances ?? []) {
    if (balance.owner !== wallet) continue;
    const before = byMint.get(balance.mint)?.amount ?? 0n;
    byMint.set(balance.mint, { amount: before + BigInt(balance.uiTokenAmount.amount), decimals: balance.uiTokenAmount.decimals });
  }
  return byMint;
}

/** The trade in one transaction, or the reason there is none. */
function tradeOf(tx: Transaction): WalletTrade | string {
  if (!tx.meta || tx.blockTime === null) return 'no detail';
  if (tx.meta.err) return 'failed';
  const index = tx.transaction.message.accountKeys.indexOf(wallet!);
  if (index < 0) return 'wallet not a named account';

  const before = held(tx.meta.preTokenBalances);
  const after = held(tx.meta.postTokenBalances);

  // SOL moved: the wallet's own lamports, plus any wrapped SOL it holds.
  let lamports = BigInt(tx.meta.postBalances[index]!) - BigInt(tx.meta.preBalances[index]!);
  lamports += (after.get(WRAPPED_SOL)?.amount ?? 0n) - (before.get(WRAPPED_SOL)?.amount ?? 0n);

  const moved: { mint: string; delta: bigint; decimals: number }[] = [];
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    if (mint === WRAPPED_SOL) continue;
    const delta = (after.get(mint)?.amount ?? 0n) - (before.get(mint)?.amount ?? 0n);
    if (delta !== 0n) moved.push({ mint, delta, decimals: (after.get(mint) ?? before.get(mint))!.decimals });
  }

  if (moved.length === 0) return 'no token moved';
  if (moved.length > 1) return 'more than one token moved';
  const { mint, delta, decimals } = moved[0]!;
  // A buy pays SOL for tokens; a sell is the reverse. Anything else is a transfer or a swap in another asset.
  if ((delta > 0n) === (lamports > 0n) || lamports === 0n) return 'not a swap against SOL';

  const sol = Number(lamports < 0n ? -lamports : lamports) / 1e9;
  return {
    ts: tx.blockTime * 1000,
    token: mint,
    side: delta > 0n ? 'buy' : 'sell',
    amount: Number(delta < 0n ? -delta : delta) / 10 ** decimals,
    valueUsd: solPrice === undefined ? sol : sol * solPrice,
  };
}

const signatures = await rpc.call<{ signature: string }[]>('getSignaturesForAddress', [wallet, { limit }]);
const trades: WalletTrade[] = [];
const skipped = new Map<string, number>();
for (const { signature } of signatures) {
  const tx = await rpc.call<Transaction | null>('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  const trade = tx ? tradeOf(tx) : 'no detail';
  if (typeof trade === 'string') skipped.set(trade, (skipped.get(trade) ?? 0) + 1);
  else trades.push(trade);
}

const money = (value: number): string => (solPrice === undefined ? `${value.toFixed(4)} SOL` : `$${value.toFixed(2)}`);
const short = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`;

console.log(`\n${wallet}`);
console.log(`${signatures.length} transactions read, ${trades.length} trades against SOL`);
for (const [reason, count] of skipped) console.log(`  skipped ${String(count).padStart(3)}  ${reason}`);

if (trades.length === 0) {
  console.log('\nNo trades to report.');
} else {
  const performance = computeWalletPerformance(trades);
  const closed = performance.winCount + performance.lossCount;
  console.log(`\nvolume         ${money(performance.totalVolumeUsd)} over ${performance.tradeCount} trades`);
  console.log(`realized PnL   ${money(performance.realizedPnlUsd)}`);
  console.log(`closed         ${closed} positions: ${performance.winCount} won, ${performance.lossCount} lost${closed > 0 ? ` (win rate ${(performance.winRate * 100).toFixed(0)} %)` : ''}`);
  if (closed > 0) console.log(`average hold   ${Math.round(performance.avgHoldSeconds)} s`);
  console.log(`still open     ${performance.positions.filter((position) => position.amount > 0).length} positions`);

  if (closed > 0) {
    console.log('\nOutcomes of closed positions');
    for (const band of computePnlDistribution(performance).bands) {
      console.log(`  ${band.label.padEnd(12)} ${String(band.count).padStart(3)}  ${(band.share * 100).toFixed(0).padStart(3)} %`);
    }
    const { best, worst } = extremePositions(performance);
    if (best) console.log(`\nbest    ${short(best.token)}  ${money(best.realizedPnlUsd)}`);
    if (worst) console.log(`worst   ${short(worst.token)}  ${money(worst.realizedPnlUsd)}`);
  }

  if (solPrice !== undefined) {
    const copy = scoreWalletForCopying(recordFromPerformance(performance));
    console.log(`\nsmart score    ${computeSmartScore(performance)} of 100`);
    console.log(`copy score     ${copy.score} of 100 (${copy.tier}): track record ${copy.trackRecord}, copyability ${copy.copyability}`);
    for (const note of copy.notes) console.log(`  ${note}`);
  }
  console.log('\nA sale of tokens bought before the transactions read here is counted at no cost and no profit.');
}
