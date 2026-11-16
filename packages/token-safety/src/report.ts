/**
 * One call from a mint address to a graded report.
 *
 * `checkToken` reads the chain, turns what it read into the engine's inputs
 * and grades them. What it could not establish stays out of the inputs, so the
 * check shows as "Not verified" and never as a pass.
 *
 * Where each check's input comes from:
 *
 *   mint authority, freeze authority, metadata   the mint account (always)
 *   top ten holders                              the largest token accounts,
 *                                                when the endpoint serves them
 *   dev holding                                  the creator's balance, when
 *                                                you pass the creator
 *   sell simulation                              your `simulateSell` hook
 *   liquidity burned, launch bundle share        `known`, from your own data
 *
 * The last two cannot be read from a single account, so this package does not
 * guess them.
 */

import type { Rpc } from '@soltoolkit/rpc';
import { readHoldingPct, readTokenFacts, type ReadTokenFactsOptions, type TokenExtension, type TokenFacts } from './onchain';
import { SAFETY_THRESHOLDS, evaluateSafety, type SafetyInputs, type SafetyReport } from './safety';

export interface CheckTokenOptions extends ReadTokenFactsOptions {
  readonly rpc: Rpc;
  readonly mint: string;
  /** The wallet that created the token. With it, the dev-holding check runs. */
  readonly creator?: string;
  /**
   * Tries a sell and says whether it would go through. Return `undefined`
   * when the simulation could not be run: only a definite answer is used.
   */
  readonly simulateSell?: (facts: TokenFacts) => Promise<boolean | undefined>;
  /**
   * What you already know from your own data. The mint's authorities always
   * come from the chain, and so does the metadata when the token has any; for
   * the other checks your value is used when you give one.
   */
  readonly known?: SafetyInputs;
}

export interface TokenCheck {
  readonly facts: TokenFacts;
  /** What was fed to the engine. A missing field is a check that could not be run. */
  readonly inputs: SafetyInputs;
  readonly report: SafetyReport;
  /** Token-2022 features that let someone other than the holder act on the tokens. Listed, not scored. */
  readonly warnings: readonly string[];
  /** What could not be read or run, and why. */
  readonly notes: readonly string[];
}

/** Reads a token and grades it. Returns `null` when the address is not a token mint. */
export async function checkToken(options: CheckTokenOptions): Promise<TokenCheck | null> {
  const { rpc, mint, creator, simulateSell, known = {} } = options;
  const facts = await readTokenFacts(rpc, mint, options);
  if (!facts) return null;
  const notes = [...facts.notes];

  // Holders: a lower bound can prove a failure, but it cannot prove a pass.
  let top10Pct: number | undefined;
  if (facts.holders) {
    if (facts.holders.complete || facts.holders.top10Pct > SAFETY_THRESHOLDS.top10MaxPct) top10Pct = facts.holders.top10Pct;
    else notes.push('Fewer than ten holders were found among the largest accounts, so the top-ten share is only a lower bound and is not graded.');
    const topTen = facts.holders.holders.filter((holder) => holder.kind === 'wallet' || holder.kind === 'pda').slice(0, 10);
    const pdas = topTen.filter((holder) => holder.kind === 'pda').length;
    if (pdas > 0) notes.push(`${pdas} of the ten largest holders ${pdas === 1 ? 'is a program-derived address' : 'are program-derived addresses'} with no program account: a multisig vault, or a pool authority this package does not know. Counted as ${pdas === 1 ? 'a holder' : 'holders'}; pass poolOwners to leave ${pdas === 1 ? 'it' : 'them'} out.`);
  }

  let devHoldingPct: number | undefined;
  if (creator !== undefined && known.devHoldingPct === undefined) {
    try {
      devHoldingPct = await readHoldingPct(rpc, creator, mint, facts.supply, options.commitment);
    } catch (error) {
      notes.push(`Dev holding not read: ${messageOf(error)}.`);
    }
  }

  let sellSimulationPassed: boolean | undefined;
  if (simulateSell && known.sellSimulationPassed === undefined) {
    try {
      sellSimulationPassed = await simulateSell(facts);
      if (sellSimulationPassed === undefined) notes.push('The sell simulation could not be run.');
    } catch (error) {
      notes.push(`The sell simulation could not be run: ${messageOf(error)}.`);
    }
  }

  const inputs: SafetyInputs = {
    ...defined({ top10Pct, devHoldingPct, sellSimulationPassed }),
    ...defined(known),
    // The chain is the authority on these, whatever the caller believes.
    mintAuthorityRevoked: facts.mintAuthority === null,
    freezeAuthorityRevoked: facts.freezeAuthority === null,
    ...(facts.metadata ? { metadataMutable: facts.metadata.mutable } : {}),
  };

  return { facts, inputs, report: evaluateSafety(inputs), warnings: extensionWarnings(facts.extensions), notes };
}

/**
 * What a mint's Token-2022 extensions allow someone other than the holder to
 * do. These are stated as warnings and do not change the score.
 */
export function extensionWarnings(extensions: readonly TokenExtension[]): string[] {
  const warnings: string[] = [];
  for (const { name, state } of extensions) {
    switch (name) {
      case 'permanentDelegate':
        if (typeof state['delegate'] === 'string') warnings.push(`Permanent delegate: ${state['delegate']} can move or burn any holder's tokens.`);
        break;
      case 'transferHook':
        if (typeof state['programId'] === 'string') warnings.push(`Transfer hook: every transfer runs the program ${state['programId']}, which can refuse it.`);
        else if (typeof state['authority'] === 'string') warnings.push(`Transfer hook: none is set, but ${state['authority']} can set one.`);
        break;
      case 'transferFeeConfig': {
        const bps = Math.max(feeBps(state['newerTransferFee']), feeBps(state['olderTransferFee']));
        if (bps > 0) warnings.push(`Transfer fee: ${(bps / 100).toFixed(2)}% of every transfer is withheld.`);
        else if (typeof state['transferFeeConfigAuthority'] === 'string') warnings.push(`Transfer fee: 0% now, but ${state['transferFeeConfigAuthority']} can raise it.`);
        break;
      }
      case 'defaultAccountState':
        if (state['accountState'] === 'frozen') warnings.push('New token accounts start frozen: a buyer cannot move the token until the freeze authority thaws the account.');
        break;
      case 'nonTransferable':
        warnings.push('Non-transferable: the token cannot be sent or sold.');
        break;
      case 'pausable':
      case 'pausableConfig':
        warnings.push('Pausable: an authority can stop every transfer of this token.');
        break;
      default:
        break;
    }
  }
  return warnings;
}

function feeBps(fee: unknown): number {
  const bps = typeof fee === 'object' && fee !== null ? (fee as Record<string, unknown>)['transferFeeBasisPoints'] : undefined;
  return typeof bps === 'number' && Number.isFinite(bps) ? bps : 0;
}

/** The fields that have a value. `exactOptionalPropertyTypes` does not allow an explicit `undefined`. */
function defined(inputs: { readonly [K in keyof SafetyInputs]?: SafetyInputs[K] | undefined }): SafetyInputs {
  return Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== undefined)) as SafetyInputs;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
