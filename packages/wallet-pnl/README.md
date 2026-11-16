# @soltoolkit/wallet-pnl

Wallet performance from a list of trades: realized PnL, win rate, hold time, how the outcomes are spread, two scores, and which small positions are worth closing.

Every function is pure. The same trades give the same answer, nothing reads the network, and there are no dependencies. You bring the trades; the [wallet report example](../../examples/wallet-report) shows one way to read them from a plain RPC endpoint.

```bash
npm i @soltoolkit/wallet-pnl
```

## Performance

```ts
import { computeWalletPerformance } from '@soltoolkit/wallet-pnl';

const HOUR = 3_600_000;
const performance = computeWalletPerformance([
  { ts: 0 * HOUR, token: 'AAA', side: 'buy', amount: 1_000, valueUsd: 100 },
  { ts: 1 * HOUR, token: 'AAA', side: 'buy', amount: 1_000, valueUsd: 300 },
  { ts: 2 * HOUR, token: 'AAA', side: 'sell', amount: 500, valueUsd: 250 },
  { ts: 3 * HOUR, token: 'BBB', side: 'buy', amount: 50, valueUsd: 200 },
  { ts: 5 * HOUR, token: 'BBB', side: 'sell', amount: 50, valueUsd: 120 },
]);

performance.realizedPnlUsd; // 70    AAA: 250 - 500 × 0.20 = +150, BBB: 120 - 200 = -80
performance.winCount;       // 0     AAA is still open, so it is not a win yet
performance.lossCount;      // 1
performance.avgHoldSeconds; // 7200  BBB, from first buy to full exit
performance.positions;      // per token: amount held, average cost, realized PnL, invested, proceeds, hold time
```

A trade is `{ ts, token, side, amount, valueUsd }`: `ts` in milliseconds, `amount` in whole tokens (already divided by the decimals), `valueUsd` the value of the whole trade. The functions only add and divide the value, so any one unit works if you use it throughout; the names say USD, and the two scores below assume it.

How the numbers are made:

- **Average cost.** Each buy adds to the position's cost; a sale realizes its proceeds less the average cost of what was sold. This is the number a holdings view shows for the same position.
- **A sale with no recorded buy adds no profit.** The wallet got those tokens somewhere the trade list does not show (a transfer, an airdrop, an earlier buy). Their proceeds are kept in `proceedsUsd` and counted nowhere else, and a position never goes negative.
- **Only closed positions win or lose.** A position is closed when all of it is sold. Break-even is not a loss.
- **Multiples** (`bestMultiple`, `worstMultiple`) are what a closed position returned on what was put in: 2 doubled it, 0 lost it all.
- Trades with a non-finite or non-positive amount are skipped. Order does not matter; they are sorted by time.

### A time window

```ts
computeWalletPerformance(trades, { since: Date.now() - 7 * 24 * HOUR });
```

Trades before `since` still build the positions, so a sale inside the window keeps the cost of the buy before it. Volume, trade count, realized PnL, wins and losses are the window's own. Pass the whole history and move `since` for a 1-day, 7-day or 30-day view.

### Outcome bands

```ts
import { computePnlDistribution, extremePositions } from '@soltoolkit/wallet-pnl';

computePnlDistribution(performance).bands;
// >500%, 200% ~ 500%, 0% ~ 200%, 0% ~ -50%, < -50%   each with a count and a share
extremePositions(performance); // { best, worst }: the closed positions with the most and the least realized PnL
```

A wallet can win most of its trades and still shrink, when the wins are small and the losses are deep. The bands show that; a win rate does not. Each closed position lands in exactly one band (lower bound inclusive), and the bands' win and loss counts match `winCount` and `lossCount` when no window is set. Open positions are left out. `PNL_BANDS` holds the boundaries.

## Smart score

```ts
import { computeSmartScore } from '@soltoolkit/wallet-pnl';

computeSmartScore(performance); // 0-100
```

A blend for ranking wallets, so that one lucky trade does not outrank a long steady record:

| Part | Weight | How it is read |
|---|---|---|
| Realized PnL | 0.35 | log scale, full marks at $1M |
| Win rate | 0.30 | as is |
| Sample size | 0.20 | log scale, full marks at 50 closed positions |
| Consistency | 0.15 | one minus the share of all profit that came from the single best position |

A wallet with no closed position scores 0.

## Copy score

Ranking by profit picks wallets whose edge is being first, and a copy is never first. `scoreWalletForCopying` scores three things and multiplies them, so a strong record that cannot be copied does not rank well:

```ts
import { recordFromPerformance, scoreWalletForCopying, rankWalletsForCopying } from '@soltoolkit/wallet-pnl';

const record = recordFromPerformance(performance);
// { realisedPnlUsd, winRate, tradeCount, stopLossDiscipline?, medianProfitUsd?, tradesPerWeek? }

const copy = scoreWalletForCopying({ ...record, medianEntryMarketCapUsd: 2_000_000 });
copy.score;           // 0-100
copy.tier;            // 'strong' (65 and up) | 'viable' (40) | 'marginal' (20) | 'avoid'
copy.notes;           // plain reasons, for showing next to the number
copy.expectedDragPct; // the estimated cost of copying, percent per trade

rankWalletsForCopying([{ address: 'a', record }, /* … */]); // sorted by score, each with its copyScore
```

| Part | What lowers it |
|---|---|
| Track record | Weights: bounded losses 0.34, profit 0.28, return 0.16, sample size 0.12, win rate 0.10. Win rate is the smallest on purpose |
| Copyability | Median entry under $100K market cap (−35), median profit under $80 a trade (−25), more than 1,000 trades a week (−30), estimated drag above 6 % a trade (−20) |
| Dev reputation | Volume in tokens the wallet deployed itself |

`recordFromPerformance` fills what a trade list can give. `stopLossDiscipline` is the share of losing positions that lost less than half of what was put in (`boundedLossShare` moves the line). Entry market cap, self-dealing and latency are not in a trade list; add them to the record when you have them. A field with nothing to measure it from stays absent, and an absent field is scored as unknown, not as good: with no losing position there is no discipline figure, and the score says so in `notes`.

**These weights, thresholds and the drag model are judgements, not measurements.** `expectedDragPct` assumes a delay of two seconds when none is given, a fixed round-trip cost, and that the delay costs more at a low market cap. They are named constants in [`src/copy-score.ts`](src/copy-score.ts); read them before you show the score to anyone, and change them to fit what you observe.

## Dust

Which small positions are worth closing. On Solana a token account holds a rent deposit (`SOLANA_TOKEN_ACCOUNT_RENT_SOL`, 0.00203928 SOL) that comes back when the account is closed, so closing can pay even when the tokens are worth nothing.

```ts
import { assessDust, summariseDust } from '@soltoolkit/wallet-pnl';

assessDust(
  { address: 'mint…', symbol: 'OLD', amount: 12, valueUsd: 0.04, costUsd: 30, liquidityUsd: 9_000 },
  { nativePriceUsd: 150 },
);
// { action: 'close', rentRecoveryUsd: 0.31, netRecoveryUsd: 0.35,
//   reason: 'Worth only 0.04, but closing refunds 0.31 in rent — more than the tokens.' }

const summary = summariseDust(positions, { nativePriceUsd: 150 });
summary.closeable;        // verdicts with action 'close', most recovered first
summary.stuck;            // worth something, but the pool is too thin to sell into
summary.totalRecoveryUsd; // from closing everything closeable
summary.rentPortionUsd;   // how much of that is rent
```

| Action | When |
|---|---|
| `close` | Value plus rent, less the cost of selling, is above zero and the position is under `keepAboveUsd` |
| `stuck` | Selling would move the price by 30 % or more, and the position is worth more than twice the rent |
| `keep` | The position is at or above `keepAboveUsd` (default $25), or closing would cost more than it returns |

Options: `nativePriceUsd` (required, the SOL price), `feeRate` (default 0.0075 of the trade), `keepAboveUsd` (default 25).

The cost of selling is an estimate: the fee rate plus a price impact read from the position's share of the pool's liquidity (`exitImpactPct`). When the liquidity is not known, a thin pool is assumed (25 % impact), so the answer leans towards keeping. This package only decides; it builds no transaction.

## Limits

- You supply the trades and their values. Nothing here reads a chain or a price.
- One cost method (average cost). No FIFO, no tax lots.
- Unrealized PnL is not computed; it needs current prices. `positions` gives the amount held and its average cost, so it is one multiplication once you have a price.
- Fees are counted only if they are inside `valueUsd`.

## Tests

```bash
pnpm --filter @soltoolkit/wallet-pnl test
```

Unit tests only: the package has no network code. The wallet report example runs it on trades read from mainnet.

## Licence

[MIT](LICENSE)
