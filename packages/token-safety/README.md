# @soltoolkit/token-safety

Eight safety checks for a Solana token, read from the chain and graded. A check that could not be run is reported as **not verified**. It never counts as a pass.

```ts
import { createRpc } from '@soltoolkit/rpc';
import { checkToken } from '@soltoolkit/token-safety';

const rpc = createRpc({ url: 'https://api.mainnet-beta.solana.com' });
const result = await checkToken({ rpc, mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' });

if (result) {
  console.log(result.report.grade, `${result.report.score}/${result.report.maxScore}`);
  for (const check of result.report.checks) {
    console.log(check.unverified ? 'not verified' : check.passed ? 'pass' : 'FAIL', check.label, '-', check.detail);
  }
  for (const warning of result.warnings) console.log('warning:', warning);
  for (const note of result.notes) console.log('note:', note);
}
```

`checkToken` returns `null` when the address is not a token mint. It needs no API key and no indexer: only a JSON-RPC endpoint.

## Install

```bash
npm i @soltoolkit/token-safety @soltoolkit/rpc
```

Node 20 or newer.

## The eight checks

| Check | Fails when | Critical | Where the input comes from |
|---|---|---|---|
| Mint authority | someone can still mint more supply | yes | the mint account |
| Freeze authority | someone can freeze a holder's account | yes | the mint account |
| Liquidity | under 90 % of the LP is burned or locked | yes | you (`known.lpBurnedPct`) |
| Metadata | the name, symbol or image can still be changed | no | the mint (Token-2022) or its Metaplex account |
| Top 10 holders | the ten largest holders own over 30 % | no | the largest token accounts, when the endpoint serves them |
| Dev holdings | the creator owns over 5 % | no | the creator's balance, when you pass `creator` |
| Sell simulation | a sell fails in simulation | yes | your `simulateSell` hook |
| Launch distribution | over 25 % was bought in the launch block by bundled wallets | no | you (`known.bundlerPct`) |

The thresholds are exported as `SAFETY_THRESHOLDS`.

Two inputs cannot be read from the token's own accounts: how much of the liquidity is locked, and who bought in the launch block. This package does not guess them. Pass them in `known` when your own data has them; otherwise those checks stay "not verified".

## How the grade is made

- The score is the number of checks that passed, out of eight.
- **A failed critical check caps the score at 3 and the grade is `dangerous`,** whatever else passes. `report.cappedBy` names the check.
- **With four or more checks not verified, the grade is `unknown`.** A token minutes old has no holder or liquidity data yet; "safe" would be the wrong word for it.
- Otherwise the grade is `safe`, `caution` or `risky`, measured against the checks that ran.
- Not verified is not failed. An unrun sell simulation does not make a token a honeypot.

## Options

```ts
const result = await checkToken({
  rpc,
  mint,
  creator,                         // runs the dev-holding check
  simulateSell: async (facts) => { // runs the sell check; return undefined when it could not be run
    return await mySellSimulation(facts.mint);
  },
  known: { lpBurnedPct: 100, bundlerPct: 12 }, // what your own data knows
  poolOwners: [exchangeWallet],    // owners to leave out of the top ten
  holders: true,                   // false skips the holder read (three calls)
});
```

The mint's authorities always come from the chain, and so does the metadata when the token has any. For every other check, a value in `known` is used as given and the matching read is skipped.

The result:

| Field | What it is |
|---|---|
| `report` | score, grade and the eight check results |
| `inputs` | what was fed to the engine; a missing field is a check that could not be run |
| `facts` | what was read: token program, supply, authorities, extensions, metadata, holders |
| `warnings` | Token-2022 features that let someone other than the holder act on the tokens |
| `notes` | what could not be read or run, and why |

[`examples/safety-report`](../../examples/safety-report) is a runnable version, with the sell simulation wired to `@soltoolkit/launchpad-sdk`.

## Holders

The holder read asks the node for the mint's largest token accounts, merges them by owner, and says what each owner is:

| Kind | Meaning | In the top ten |
|---|---|---|
| `wallet` | an address a key can sign for | yes |
| `pda` | a program-derived address with no program account: a multisig vault, or a pool authority this package does not know | yes, with a note |
| `program` | an account owned by a program, such as a bonding curve or a pool; `label` is the program | no |
| `pool` | a known pool authority (Raydium AMM v4 and CPMM, Raydium LaunchLab, Meteora DAMM v2 and DBC), or one of your `poolOwners` | no |
| `burn` | an address nobody can sign for | no |

Things to know:

- **The endpoint must serve `getTokenLargestAccounts`.** Many public endpoints refuse it, the default public mainnet endpoint among them. When the call is refused, the top-ten check is "not verified" and `notes` says why. Everything else still runs.
- The node returns at most twenty accounts. When fewer than ten of their owners are wallets, the share is a lower bound: it is graded only when it already fails.
- An exchange wallet looks like any other wallet on chain. Pass the ones you know in `poolOwners`.

To take the holder list from one endpoint and the rest from another, wrap two clients. Anything with a `call` method is an `Rpc`:

```ts
const main = createRpc({ url: MAIN_URL });
const lists = createRpc({ url: URL_THAT_SERVES_HOLDER_LISTS });
const rpc = { call: (method, params) => (method === 'getTokenLargestAccounts' ? lists : main).call(method, params) };
```

## Token-2022 warnings

A Token-2022 mint can carry extensions that the eight checks do not cover. `checkToken` states them in `warnings`; they do not change the score.

- **Permanent delegate:** an address that can move or burn any holder's tokens.
- **Transfer hook:** a program that runs on every transfer and can refuse it.
- **Transfer fee:** a share of every transfer is withheld, or an authority can raise it from zero.
- **Default account state frozen:** a new holder cannot move the token until the freeze authority thaws the account.
- **Non-transferable** and **pausable**.

`extensionWarnings(facts.extensions)` gives the same list from facts you already have.

## The parts by themselves

```ts
import { evaluateSafety, readTokenFacts, readHoldingPct, classifyOwner, detectImpersonation } from '@soltoolkit/token-safety';
```

- `evaluateSafety(inputs)` is the engine alone: no network, any chain. Feed it what you know and leave the rest out.
- `readTokenFacts(rpc, mint, options)` reads the chain and grades nothing.
- `readHoldingPct(rpc, owner, mint, supply)` is one owner's share of the supply.
- `classifyOwner(owner, account)` says what kind of holder an address is.

### Copied identities

A copied name or image passes every contract check, because nothing about the contract is wrong. `detectImpersonation` compares a token against the ones you already know:

```ts
const report = detectImpersonation(
  { address, name: 'B0NK', symbol: 'BONK', createdAt: Date.now() },
  knownTokens, // { address, name, symbol, imageHash?, marketCapUsd?, createdAt? }[]
);
console.log(report.risk, report.summary, report.matches);
```

It finds the same image, the same name or symbol, look-alike characters (`0` for `O`, Cyrillic `а` for Latin `a`) and names one edit away from a known one. `risk` is 0 to 100. The list of known tokens is yours to supply.

## Limits

- A report is a snapshot of one moment. Authorities and holders change.
- Passing all eight checks does not make a token a good buy. The checks cover the known ways a token contract or its holders can take a buyer's money, and nothing else.
- Solana only for the chain reads. The engine (`evaluateSafety`) and `detectImpersonation` take plain values and work for any chain.

## Tests

```bash
pnpm --filter @soltoolkit/token-safety test        # scripted node, no network
LIVE=1 pnpm --filter @soltoolkit/token-safety test:live
```

The live test reads four mainnet tokens: two classic SPL tokens (one with live authorities, one with them revoked), a Token-2022 launchpad token and a Token-2022 stablecoin with extensions. Reads only. Set `SOLANA_RPC_URL` to use your own endpoint.

## Licence

MIT
