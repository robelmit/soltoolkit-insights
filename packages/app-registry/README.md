# @soltoolkit/app-registry

Which trading app placed a transaction: Axiom, Photon, Trojan, BONKbot, Phantom, MetaMask and the rest. This is the app the trader used, not the exchange the trade settled on.

Two parts:

- **`registry.json`**: an open list of 33 trading terminals, bots, wallets and apps, with what identifies each one on chain (fee wallets, router programs, relayers, EVM routers, ERC-8021 builder codes, function selectors) and the names data vendors use for it. Plain JSON, so a program in any language can read it.
- **A detector**: pure functions that read one transaction and name the platform, with the evidence that decided. Solana and EVM (Ethereum, Base, BNB Chain).

No dependencies, and nothing reads the network. You fetch the transaction with whatever client you already use.

```bash
npm i @soltoolkit/app-registry
```

## Solana

```ts
import { attributePlatform, platformLabel, solanaTxFacts } from '@soltoolkit/app-registry';

const res = await fetch(RPC_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    // Version 1 transactions only come back when the request allows them.
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
  }),
});
const { result } = await res.json();

const tx = solanaTxFacts(result); // null for a shape it cannot read
const hit = tx ? attributePlatform(tx) : null;
// { platform: 'photon', by: 'fee-wallet', evidence: 'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH' }

platformLabel(hit?.platform);
// { id: 'photon', name: 'Photon', short: 'PH', kind: 'terminal' }
```

`solanaTxFacts` reads a `getTransaction` answer in the `jsonParsed` or `json` encoding, for legacy, v0 and v1 transactions. `detectPlatform(tx)` is the short form that returns the id alone.

If you already decode transactions yourself, skip `solanaTxFacts` and pass the facts directly: account keys, signers, the program ids of the top-level instructions, lamport balances before and after, token balances before and after, and whether it failed. The `SolanaTxFacts` type lists them.

## EVM

```ts
import { attributePlatform } from '@soltoolkit/app-registry';

// tx from eth_getTransactionByHash, receipt from eth_getTransactionReceipt
const hit = attributePlatform({
  chain: 'base', // 'eth', 'base' or 'bsc'
  from: tx.from,
  to: tx.to,
  input: tx.input,
  logs: receipt.logs,
  failed: receipt.status !== '0x1',
});
// { platform: 'trust', by: 'fee-wallet', evidence: '0xad01c20d5886137e056775af56915de824c8fce5' }
```

The logs are optional. Without them the fee-recipient check is skipped, and the router, builder code and selector still work.

## How it decides

The answer is `{ platform, by, evidence }` or `null`. Unknown is `null`, never a guess. A failed transaction is not a trade, so it is `null` too.

**Solana**, in this order:

1. **Fee wallet** (`by: 'fee-wallet'`). A listed wallet, or a token account it owns, gains in the transaction at least 0.1 % of the trade's leg in that token. For SOL and WSOL the minimum is 0.1 % of the SOL leg and never more than 10,000 lamports. Being present in the transaction is not enough, and dust sent to poison an address does not reach the minimum. A signer is never a fee receiver.
2. **Relayer** (`by: 'fee-payer'`). The network fee was paid by a relayer that pays only for one platform's users.
3. **Router program** (`by: 'program'`). A top-level instruction calls a router only one platform invokes. A router two platforms share (BONKbot and Telemetry use the same ones) never decides alone; the fee wallet tells them apart.

**EVM**, in this order:

1. **Fee recipient** (`by: 'fee-wallet'`). An ERC-20 transfer inside the transaction credits a listed recipient at least 0.001 % of the largest transfer of the same token. The sender paying itself does not count.
2. **Router** (`by: 'router'`). The transaction's `to` is a listed router on that chain.
3. **Builder code** (`by: 'builder-code'`). The calldata ends with an ERC-8021 suffix carrying a listed code. `decodeErc8021(input)` returns the codes on its own.
4. **Selector** (`by: 'selector'`). The first four bytes match a selector listed for a platform whose routers rotate.

Addresses in the registry's `exclusions` never count on either side: protocol fee accounts, landing tips, block-builder tips. They stay excluded even when an entry of your own lists one as a fee wallet.

The thresholds are exported: `PLATFORM_FEE_MIN_LAMPORTS`, `PLATFORM_FEE_MIN_LEG_DIVISOR`, `EVM_FEE_MIN_LEG_DIVISOR`.

## The list

7 terminals, 12 bots, 8 wallets, 3 apps and 3 aggregators. Each entry has a `confidence` and a `source` note saying where its identifiers came from.

| id | Name | Kind | Chains | Identified by | Confidence |
|---|---|---|---|---|---|
| `axiom` | Axiom | terminal | sol, eth, base, bsc | Solana fee wallet, Solana router, EVM fee recipient, EVM router, selector | high |
| `gmgn` | GMGN | terminal | sol, eth, base, bsc | Solana fee wallet, Solana router, EVM fee recipient, EVM router, builder code, selector | high |
| `photon` | Photon | terminal | sol | Solana fee wallet, Solana router | high |
| `trojan` | Trojan | bot | sol | Solana fee wallet, Solana router | high |
| `padre` | Padre | terminal | sol | Solana fee wallet, Solana router | high |
| `bonkbot` | BONKbot | bot | sol | Solana fee wallet, shared Solana router | high |
| `telemetry` | Telemetry | bot | sol | Solana fee wallet, shared Solana router | medium |
| `bloom` | Bloom | bot | sol | Solana fee wallet, Solana router | high |
| `maestro` | Maestro | bot | sol, eth, base, bsc | Solana fee wallet, Solana router, EVM fee recipient, EVM router | high |
| `banana` | Banana Gun | bot | sol, eth, base, bsc | Solana fee wallet, Solana router, EVM router | high |
| `sigma` | Sigma | bot | eth, base | EVM fee recipient, EVM router, builder code, selector | high |
| `bullx` | BullX (inactive) | terminal | sol | Solana fee wallet | low |
| `nova` | Nova (inactive) | bot | sol | Solana fee wallet, Solana router | medium |
| `fomo` | Fomo | app | sol, bsc, base, eth | Solana fee wallet, Solana relayer | high |
| `phantom` | Phantom | wallet | sol, eth, base, bsc | Solana fee wallet | high |
| `okx` | OKX | aggregator | sol, eth, base, bsc | Solana router, EVM router | medium |
| `binance` | Binance Wallet | wallet | sol, eth, base, bsc | Solana router, EVM router | high |
| `metamask` | MetaMask | wallet | eth, base, bsc | EVM fee recipient, EVM router | high |
| `bitget` | Bitget Wallet | wallet | eth, base, bsc | EVM router | high |
| `trust` | Trust Wallet | wallet | eth, base, bsc | EVM fee recipient | medium |
| `rabby` | Rabby | wallet | eth, base, bsc | EVM fee recipient | high |
| `rainbow` | Rainbow | wallet | eth, base, bsc | EVM router | high |
| `backpack` | Backpack | wallet | sol, eth, base, bsc | vendor name only | medium |
| `mevx` | MevX | bot | sol, eth, base | Solana fee wallet, Solana router, EVM router | medium |
| `stbot` | STBot | bot | sol | Solana fee wallet, Solana router | medium |
| `ave` | Ave.ai | terminal | sol, bsc, base, eth | Solana fee wallet, Solana router | medium |
| `pepeboost` | Pepeboost | bot | sol | Solana fee wallet | medium |
| `raybot` | Raybot | bot | sol | Solana fee wallet | medium |
| `moonshot-app` | Moonshot | app | sol | Solana fee wallet | medium |
| `pumpfun-app` | pump.fun app | app | sol | Solana router | medium |
| `bullpen` | Bullpen | terminal | sol | Solana fee wallet | low |
| `kyberswap` | KyberSwap | aggregator | eth, base, bsc | vendor name only | medium |
| `llamaswap` | LlamaSwap | aggregator | eth, base, bsc | vendor name only | medium |

"Chains" is where the app trades; "Identified by" is what the registry has for it. An entry is not detected on a chain it has no identifier for (Phantom on EVM, for one). "Vendor name only" means the entry has no on-chain identifier: it only maps a vendor's label to an id. An inactive entry stopped trading and is kept so its older transactions still resolve.

## Names from data vendors

Data APIs label trades with their own names. `platformIdByAlias` maps them to registry ids:

```ts
import { platformIdByAlias } from '@soltoolkit/app-registry';

platformIdByAlias('terminal-padre'); // 'padre'
platformIdByAlias('Binance Wallet'); // 'binance'
platformIdByAlias('raydium');        // null: an exchange is not an app
```

## Your own entries

Add a platform, replace one by id, or remove one. The built-in index is never changed; you get a new one.

```ts
import { attributePlatform, platformIndexWith } from '@soltoolkit/app-registry';

const { index, issues } = platformIndexWith({
  platforms: [
    { id: 'mine', name: 'Mine', kind: 'terminal', chains: ['sol'], solana: { feeWallets: ['<your fee wallet>'] } },
    { id: 'bullx', disabled: true }, // remove a built-in entry
  ],
});

attributePlatform(tx, { index });
```

Every entry is validated on its own. A bad address drops that address, a bad entry drops that entry, and the rest stands; `issues` lists what was left out. Pass `replace: true` beside `platforms` to use only your list. `parsePlatformRegistry`, `mergePlatformRegistries` and the `PlatformIndex` class are exported for anything more involved.

## `registry.json` from another language

The file ships in the package root and is exported as `@soltoolkit/app-registry/registry.json`.

```jsonc
{
  "version": 1,
  "updated": "2026-10-04",
  "platforms": [
    {
      "id": "photon",            // lower case, stable
      "name": "Photon",
      "short": "PH",             // a monogram, for where no logo is drawn
      "kind": "terminal",        // terminal | bot | wallet | app | aggregator
      "chains": ["sol"],
      "active": false,           // only present on platforms that stopped trading
      "solana": {
        "programs": [],          // routers only this platform invokes
        "sharedPrograms": [],    // routers several platforms use: never decide alone
        "feeWallets": [],        // credited the platform's fee
        "feePayers": []          // relayers that pay the network fee for its users
      },
      "evm": {
        "routers": { "eth": [], "base": [], "bsc": [] },
        "selectors": { "eth": [] },
        "builderCodes": [],      // ERC-8021
        "feeWallets": []
      },
      "aliases": [],             // names data vendors use, lower case
      "exclude": [],             // related addresses that are never its fee wallet
      "confidence": "high",      // high | medium | low
      "source": "…"              // where the identifiers came from
    }
  ],
  "exclusions": { "solana": [], "evm": [] } // never a platform
}
```

EVM addresses, selectors and aliases are lower case. Solana addresses are base58 and case-sensitive. The registry ships no logos.

## Tests

```bash
pnpm --filter @soltoolkit/app-registry test
LIVE=1 pnpm --filter @soltoolkit/app-registry test:live
```

The detector is tested against 31 recorded mainnet transactions (20 Solana, 11 EVM) in [`test/fixtures`](test/fixtures). Each file holds the node's answer, the platform expected and the evidence expected. Two of them must resolve to nothing: a direct PumpSwap trade and a swap through the Uniswap interface. The live test takes the latest transactions of three routers from mainnet and expects the detector to name their platforms. It only reads; set `SOLANA_RPC_URL` to use your own endpoint.

## Limits

- **Entries are observations with a date.** Platforms rotate fee wallets and deploy new routers. An entry that was right when it was recorded can go stale, and then the detector answers `null` or falls back to weaker evidence. The live test is there to notice.
- **It names the app, not who was behind it.** A script that sends its trades through a platform's router is attributed to the platform.
- **Coverage is uneven.** The table shows what each entry can be recognised by. A wallet that routes through an aggregator and takes no fee of its own leaves nothing to see.
- **Low and medium confidence mean what they say.** Read the entry's `source` before relying on it.
- **The entries were recorded from swaps.** Transfers, staking and other activity through the same apps are out of scope.

Corrections and new entries are welcome: open a pull request that changes `registry.json` and adds a recorded transaction to `test/fixtures` showing the identifier at work.

## Sources

The identifiers are public on-chain addresses. They were collected from the projects below and from transactions read on chain; each entry's `source` says which.

- [solana-dex-parser](https://github.com/cxcx-ai/solana-dex-parser) (MIT): Solana bot programs and fee accounts, and the approach of deciding by a credited fee account.
- [sol-parser-sdk](https://github.com/0xfnzero/sol-parser-sdk) (MIT): landing-tip accounts in the exclusions.
- [Dune Spellbook](https://github.com/duneanalytics/spellbook): trading-bot models.
- [DefiLlama dimension-adapters](https://github.com/DefiLlama/dimension-adapters): fee adapters.
- Codex `tradeSource` labels, for the vendor names in `aliases`.

## Licence

MIT
