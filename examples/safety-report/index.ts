/**
 * A safety report for one token, with the sell check wired to the launchpad
 * SDK: a sell is quoted and built for a wallet that holds the token, and the
 * node is asked what it would do. Nothing is signed and nothing is sent.
 *
 *   pnpm --filter example-safety-report start <mint> [creator]
 *
 * `creator` is the wallet that launched the token. With it, the dev-holding
 * check runs.
 *
 * SOLANA_RPC_URL    the endpoint (default: the public mainnet one)
 * HOLDERS_RPC_URL   an endpoint that serves getTokenLargestAccounts, when the
 *                   first one refuses it. Without the holder list, the top-ten
 *                   and sell checks are reported as not verified.
 */

import { LaunchpadError, NoVenueError, createLaunchpads } from '@soltoolkit/launchpad-sdk';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, associatedTokenAddress, createRpc, type Rpc } from '@soltoolkit/rpc';
import { checkToken, type TokenFacts } from '@soltoolkit/token-safety';

const [mint, creator] = process.argv.slice(2);
if (!mint) {
  console.error('usage: pnpm --filter example-safety-report start <mint> [creator]');
  process.exit(1);
}
const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const holdersUrl = process.env['HOLDERS_RPC_URL'];

const main = createRpc({ url: rpcUrl, requestsPerSecond: 2 });
const lists = holdersUrl ? createRpc({ url: holdersUrl, requestsPerSecond: 1 }) : main;
// Anything with a `call` method is an Rpc: the holder list from one endpoint, the rest from the other.
const rpc: Rpc = { call: (method, params) => (method === 'getTokenLargestAccounts' ? lists : main).call(method, params) };

const launchpads = createLaunchpads({ rpcUrl });

/** The least SOL a wallet needs for the simulation to reach the swap. */
const MIN_LAMPORTS = 10_000_000n;

/**
 * Tries a sell of 1 % of a holder's balance, for up to three holders.
 *
 *   true        a sell ran to the end
 *   false       every holder tried had the tokens and the SOL, and the
 *               programs refused each sell
 *   undefined   no answer: no holder to try, or the token is on no venue
 *               the SDK trades
 */
async function simulateSell(facts: TokenFacts): Promise<boolean | undefined> {
  const tokenProgram = facts.tokenProgram === 'spl-token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const wallets = (facts.holders?.holders ?? []).filter((holder) => holder.kind === 'wallet' && !holder.frozen).slice(0, 3);
  let tried = 0;
  let refused = 0;
  for (const holder of wallets) {
    try {
      // The SDK sells from the wallet's associated token account, and the wallet pays the fee.
      const account = associatedTokenAddress(holder.owner, facts.mint, tokenProgram);
      const balance = await rpc.call<{ value: { amount: string } }>('getTokenAccountBalance', [account]);
      const lamports = await rpc.call<{ value: number }>('getBalance', [holder.owner]);
      const amountIn = BigInt(balance.value.amount) / 100n;
      if (amountIn === 0n || BigInt(lamports.value) < MIN_LAMPORTS) {
        console.log(`sell not tried   ${holder.owner}: ${amountIn === 0n ? 'too few tokens' : 'too little SOL for the fee'}`);
        continue;
      }

      const quote = await launchpads.quote({ side: 'sell', mint: facts.mint, amountIn, slippageBps: 1_000, user: holder.owner });
      const built = await launchpads.buildTransaction(quote, holder.owner);
      const simulation = await launchpads.rpc.simulateTransaction(built.base64, { sigVerify: false });
      tried += 1;
      if (!simulation.err) {
        console.log(`sell simulated   ${amountIn} units for ${holder.owner} on ${quote.venue}: ok`);
        return true;
      }
      console.log(`sell simulated   ${amountIn} units for ${holder.owner} on ${quote.venue}: ${JSON.stringify(simulation.err)}`);
      // Only a refusal by a program counts. A missing account or an expired blockhash says nothing about the token.
      if (typeof simulation.err === 'object' && simulation.err !== null && 'InstructionError' in simulation.err) refused += 1;
    } catch (error) {
      if (error instanceof NoVenueError) {
        console.log(`sell not tried   no venue the SDK trades has this token (${error.attempts.map((attempt) => `${attempt.venue}: ${attempt.code}`).join(', ')})`);
        return undefined;
      }
      if (error instanceof LaunchpadError) {
        // The venue has the token but the SDK does not trade it (for example, a pool not quoted in SOL).
        console.log(`sell not tried   ${error.message}`);
        return undefined;
      }
      // This holder could not be tried (no associated account, a read failed): try the next one.
      console.log(`sell not tried   ${holder.owner}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return tried > 0 && refused === tried ? false : undefined;
}

const result = await checkToken({ rpc, mint, ...(creator ? { creator } : {}), simulateSell });

if (!result) {
  console.error(`${mint} is not a token mint.`);
  process.exitCode = 1;
} else {
  const { facts, report, warnings, notes } = result;
  console.log(`\n${facts.metadata?.name ?? '(no metadata)'} ${facts.metadata?.symbol ? `(${facts.metadata.symbol})` : ''}`);
  console.log(`${facts.mint}  ${facts.tokenProgram}\n`);
  console.log(`grade   ${report.grade}    ${report.score} of ${report.maxScore} passed, ${report.unverifiedCount} not verified${report.cappedBy ? `, capped by ${report.cappedBy}` : ''}\n`);
  for (const check of report.checks) {
    const state = check.unverified ? 'not verified' : check.passed ? 'pass' : 'FAIL';
    console.log(`  ${state.padEnd(13)}${check.label.padEnd(20)}${check.detail}`);
  }
  if (facts.holders) {
    console.log('\nLargest holders');
    for (const holder of facts.holders.holders.slice(0, 10)) {
      console.log(`  ${holder.pct.toFixed(2).padStart(6)} %  ${holder.kind.padEnd(8)}${holder.owner}${holder.label ? `  ${holder.label}` : ''}`);
    }
  }
  if (warnings.length > 0) console.log(`\nWarnings\n${warnings.map((warning) => `  ${warning}`).join('\n')}`);
  if (notes.length > 0) console.log(`\nNotes\n${notes.map((note) => `  ${note}`).join('\n')}`);
}
