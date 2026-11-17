# soltoolkit-insights

Read-only analysis for Solana tokens and wallets, from the team behind the Hexa trading terminal. Each tool is its own package and needs only a JSON-RPC endpoint.

## Packages

| Package | What it does |
|---|---|
| [`@soltoolkit/token-safety`](packages/token-safety) | Safety checks read from the chain and graded, where a check that could not run never counts as a pass; Token-2022 warnings; copied-identity detection |
| [`@soltoolkit/holder-map`](packages/holder-map) | A token's largest holders, the transfers among them found within a call budget, and the clusters they form |
| [`@soltoolkit/holder-map-react`](packages/holder-map-react) | A React viewer for the holder map: SVG from a pure layout, the same on a server and in a browser |
| [`@soltoolkit/wallet-pnl`](packages/wallet-pnl) | Realized PnL at average cost, win rate, hold time, outcome bands, a smart-money score and a copy-trading score from a trade list. Pure functions |
| [`@soltoolkit/app-registry`](packages/app-registry) | An open list of trading terminals, bots and wallets, and a detector that names the one behind a transaction |

```bash
pnpm --filter example-safety-report start <mint>     # a graded safety report, with a simulated sell
pnpm --filter example-wallet-report start <wallet>   # a wallet's recent trades, PnL and outcome bands
pnpm --filter example-holder-map-viewer start        # a holder map in the browser
```

## Principles

- **Nothing here signs, sends or holds a key.**
- **Unknown is never zero.** A value that could not be read stays `null`; it is never counted as a pass or as nothing.
- **Refuse rather than guess.** A failed read is an error, not "not found".
- **No API key needed.** Everything runs against a plain Solana JSON-RPC endpoint you choose.

## Develop

Node 22.13 or newer and pnpm, to work on the repository. The published packages run on Node 20 or newer.

This repository uses packages of [soltoolkit-sdk](https://github.com/robelmit/soltoolkit-sdk). Until those are on npm, clone it beside this one and run `pnpm install && pnpm build` there first; `.pnpmfile.cjs` then links the local copies.

```bash
pnpm install
pnpm check        # build, typecheck, test, lint
```

## The soltoolkit family

| Repository | What it holds |
|---|---|
| [soltoolkit-sdk](https://github.com/robelmit/soltoolkit-sdk) | Launchpad trade SDK and the shared RPC client |
| [soltoolkit-feed](https://github.com/robelmit/soltoolkit-feed) | The launch feed: a Rust indexer for launches, trades and migrations |
| **soltoolkit-insights** (this one) | Token safety, holder maps and their viewer, wallet PnL, the trading-app registry |
| [soltoolkit-bots](https://github.com/robelmit/soltoolkit-bots) | Telegram and Discord community bots |
| [soltoolkit-agents](https://github.com/robelmit/soltoolkit-agents) | A read-only MCP server for AI agents, an HTTP API, and the soltoolkit Live site |

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

[MIT](LICENSE)
