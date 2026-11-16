# Contributing

Thanks for helping. This repo is a pnpm + Turborepo workspace in strict TypeScript.

## Setup

```bash
corepack enable
pnpm install
pnpm check        # build, typecheck, test and lint: must be green before a pull request
```

Work on one package with `pnpm --filter @soltoolkit/<name> test -- --watch`.

## Rules the code follows

1. **Unknown is never zero.** Missing data stays `null` in every type, score and check. A check with no data is `unknown`, never a pass.
2. **Refuse instead of guessing.** If a pool is not the shape an adapter expects, it throws a typed error. It does not fall back to an estimate.
3. **Amounts are `bigint` base units** (lamports, raw token units). Floats are for display only.
4. **No keys.** Nothing here signs or sends. A change that takes a private key will not be merged.


## Tests

- Unit tests run offline from recorded fixtures.
- Live tests run with `LIVE=1 SOLANA_RPC_URL=<your endpoint> pnpm test`. They only read and simulate.

## Commits and pull requests

- One change per pull request, with the test that proves it.
- Say what changed and why in the description. Link the transaction or account that shows the problem when there is one.
- By contributing you agree your work is released under the MIT licence of this repo.
