# @soltoolkit/holder-map

A holder map for a Solana token: who the largest holders are, which of them the token moved between, and the clusters those links form. It reads a plain JSON-RPC endpoint within a fixed budget of calls. No API key, no indexer.

```ts
import { createRpc } from '@soltoolkit/rpc';
import { buildHolderMap } from '@soltoolkit/holder-map';

const rpc = createRpc({ url: RPC_URL }); // any mainnet JSON-RPC endpoint
const map = await buildHolderMap(rpc, mint);

if (map) {
  for (const cluster of map.graph.clusters) {
    console.log(`cluster ${cluster.id}: ${cluster.wallets} wallets hold ${cluster.pct}%`);
  }
  for (const edge of map.graph.edges) console.log(edge.a, '-', edge.b, edge.kind);
  for (const note of map.notes) console.log('note:', note);
}
```

`buildHolderMap` returns `null` when the address is not a token mint, and throws `HoldersUnavailable` when the endpoint would not serve the holders (see [Reading the holders](#reading-the-holders)).

## Install

```bash
npm i @soltoolkit/holder-map @soltoolkit/rpc
```

Node 20 or newer.

## What a map is

| Part | What it is |
|---|---|
| `graph.nodes` | one bubble per holder, largest share first: `id` (the address), `pct`, `type`, an optional `label`, and `cluster` when the holder is in one |
| `graph.edges` | a line between two holders, with the `kind` of thing that joined them |
| `graph.clusters` | every set of two or more connected holders: `id`, the members' shares added up (`pct`), and how many `wallets` |
| `list` | the holders as they were read: amounts, token program, supply, and the holder count when it is known |
| `transfers` | what the transfer walk read and found, and whether it finished |
| `notes` | what the map covers and what it does not, in plain sentences |

**Show `notes` with the map.** A map with no lines can mean the holders are not connected, or that the walk was cut short. The notes say which.

Rules the graph keeps:

- **Pools, burn addresses and program accounts are bubbles, never cluster members.** Everybody sends tokens to the pool; that says nothing about who controls whom.
- **A holder the token moved between and a large share of the other holders is a venue**, whatever its type says: an unlabelled pool, a launchpad vault, an exchange wallet. It is drawn as a pool and kept out of clusters. Without this rule one unlabelled pool joins most of the map into a single cluster. `graph.hubDegreePct` sets the share; `1` turns the rule off.
- **An unknown share is not zero.** A holder without a share is drawn and linked, but is not added to a cluster's total.
- A cluster's share is the sum of its members' shares. Nothing is inferred.

## Reading the holders

There are two ways to ask a node who holds a token, and neither is served everywhere.

| Way | What you get | When it fails |
|---|---|---|
| A scan (`getProgramAccounts` on the token program, filtered by mint) | every holder and a real holder count, in one call | the answer grows with the number of holders, so for a widely held token the node refuses it or the answer passes the client's size cap; some endpoints refuse scans of the token program altogether |
| The largest accounts (`getTokenLargestAccounts`) | the owners of twenty accounts at most; no holder count | many public endpoints refuse the call |

`readHolders` scans first and falls back to the largest accounts. The result says which one it used (`source`), and `notes` carries the reason the scan failed when it did.

When neither is served it throws `HoldersUnavailable`, with one reason for each way that was tried. **A failed read is never an empty holder list.**

```ts
import { HoldersUnavailable, readHolders } from '@soltoolkit/holder-map';

try {
  const list = await readHolders(rpc, mint, { limit: 100 });
  if (list) console.log(list.source, list.holderCount, list.holders[0]);
} catch (error) {
  if (error instanceof HoldersUnavailable) console.log(error.reasons);
  else throw error;
}
```

Options: `source` (`auto`, `scan` or `largest`), `limit` (default 100), `poolOwners`, `commitment`, `scanTimeoutMs` (default 30 seconds; a scan is asked once and not retried).

Only the owner and the amount of each account are asked for, 40 bytes an account. To give up early on a scan that cannot succeed instead of downloading it, cap the answer size on the client:

```ts
const rpc = createRpc({ url, maxResponseBytes: 8 * 1024 * 1024 });
```

Each holder has a `kind`: `wallet`, `pda`, `program`, `pool` or `burn`, as in [`@soltoolkit/token-safety`](../token-safety#holders). Two things to know:

- A pool whose token account is owned by a program-owned account (a bonding curve, some AMM pools) is `program`, with the program as its `label`. It is kept out of clusters the same way a `pool` is.
- An exchange wallet looks like any other wallet on chain. Pass the ones you know in `poolOwners`.

## The transfer walk

A wallet's own history is every token it ever touched. The history of its token account for one mint is its history of that token alone, so the walk reads that:

1. `getTokenAccountsByOwner` for each holder walked;
2. `getSignaturesForAddress` for each of those accounts: its newest transactions;
3. `getTransaction` for each distinct signature, newest first, until the budget is spent.

A transaction is a transfer between holders A and B when, for this token, A's balance fell, B's rose, nobody else's moved, and B received what A sent (less a Token-2022 transfer fee at most). A swap moves a pool's balance too, and a bundle of buys moves several holders up and none down. Neither is a transfer, and neither draws a line.

The budget is yours to set:

```ts
const map = await buildHolderMap(rpc, mint, {
  walk: 30,                       // holders whose history is read, largest first; 0 reads none
  links: {
    maxCalls: 300,                // calls the walk may make in all
    deadlineMs: 20_000,           // and how long it may take
    signaturesPerAccount: 10,     // newest transactions looked at for each account
    accountsPerHolder: 2,
  },
});
console.log(map?.transfers?.complete, map?.transfers?.calls);
```

Those are the defaults, except `deadlineMs`, which has none.

- Pools, burn addresses and programs are not walked: a pool's history is every trade of the token.
- Holders are walked largest first, so when the budget ends early the largest holders are the ones that were read.
- A call that fails is counted (`failedCalls`) and the walk carries on. It does not throw.
- **The walk reads the newest transactions only.** An old transfer between two busy wallets can be out of its reach. `transfers.complete` is `false` when the budget ended early or a call failed, and the note says what was left unread. It is never presented as "no transfers".

`findHolderLinks(rpc, mint, holders, options)` is the walk by itself. `tokenDeltas` and `transferBetweenHolders` read one `getTransaction` answer, for when the transactions come from somewhere else.

## Bundles, snipers and insiders

A transfer is not the only thing that connects two wallets. Wallets that bought in one transaction were paid for by one signer; wallets that bought in the slot the token launched in were placed there together. Neither shows up as a transfer between them, so the map takes such sets as input.

```ts
import { buildHolderMap, buyerSets } from '@soltoolkit/holder-map';

// The token's earliest buys: { buyer, slot, signature }[], from your indexer or its first transactions.
const sets = buyerSets(earlyBuys, { launchSlot });

const map = await buildHolderMap(rpc, mint, {
  sets: { ...sets, insiders: [creator, ...walletsYouKnowActWithTheCreator] },
});
```

- A **bundle** is two or more wallets whose buys landed in one transaction, or in the launch slot.
- The **sniper** set is every wallet that bought within three slots of the launch (`sniperSlots`).
- **Insiders** are yours to name.

Each set is drawn as a star around its largest member on the map, and each line carries its kind (`bundle`, `sniper`, `insider`). When a transfer and a set join the same two holders, the pair keeps the transfer line. Wallets that are no longer holders draw nothing.

This package does not read the early buys from the chain. They are an input.

## With your own data

Everything below the reads is pure and knows nothing about a chain. Addresses are strings, and an address that starts with `0x` is compared without case, so the graph works for an EVM token too.

```ts
import { buildHolderGraph, linksFromSets, sharesFromBalances } from '@soltoolkit/holder-map';

const graph = buildHolderGraph(
  [
    { address: '0xaaa…', pct: 12, type: 'wallet' },
    { address: '0xbbb…', pct: 8, type: 'wallet' },
    { address: '0xccc…', pct: 40, type: 'pool', label: 'Uniswap v3' },
  ],
  [{ from: '0xaaa…', to: '0xbbb…' }],            // a transfer unless `kind` says otherwise
  { maxNodes: 250 },
);
```

To use a holder list of your own with the RPC transfer walk, pass it to `buildHolderMap` as `holders`; nothing is read for the list then. With `walk: 0` as well, no call is made at all.

- `sharesFromBalances(balances)` turns a complete set of balances into shares.
- `starLinks(members, kind)` and `linksFromSets(sets, holders)` turn sets into links.
- A link's `kind` may also be `funding`, for a pair your own data knows one funded the other. Nothing in this package produces it.

## What it does not do

- **It does not find a shared funder.** Two holders paid from one wallet that is not itself a holder are not joined, unless your own data says so and you pass the link.
- No middlemen: a wallet that is not a top holder is never a bubble.
- No view over time. A map is a snapshot of the holders now and of their newest transactions.
- A line says the token moved between two holders, or that they bought together. It does not prove one person controls both.
- The chain reads are Solana only.

## Tests

```bash
pnpm --filter @soltoolkit/holder-map test        # scripted node, no network
LIVE=1 pnpm --filter @soltoolkit/holder-map test:live
```

The unit tests run against a scripted node, plus one transfer recorded from a mainnet node's `getTransaction` answer. The live test reads the holders of a small token and of a widely held one, and builds one map within a call budget. Which way the holders can be read depends on the endpoint, so the live test accepts a scan, the largest accounts, or `HoldersUnavailable` with its reasons, and prints which it got. Reads only. Set `SOLANA_RPC_URL` to use your own endpoint.

## Licence

MIT
