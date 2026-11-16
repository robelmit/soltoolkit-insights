/**
 * Trading platforms: the terminal, bot or wallet app a trade was placed
 * through, as distinct from the exchange it settled on.
 *
 * The data lives in `registry.json`, shipped beside the code so a program in
 * any language can read the same list. Each entry carries what identifies the
 * platform on chain (Solana router programs, fee wallets and relayers; EVM
 * routers, fee wallets, selectors and ERC-8021 builder codes) and the names
 * data vendors use for it.
 *
 * Unknown stays absent: an id or a name no entry claims resolves to null,
 * never to a near match.
 */

import BUILT_IN from '../registry.json';

export type PlatformKind = 'terminal' | 'bot' | 'wallet' | 'app' | 'aggregator';
export type PlatformConfidence = 'high' | 'medium' | 'low';

export interface PlatformSolana {
  /** Router programs only this platform invokes: the outer instruction alone attributes the trade. */
  readonly programs?: readonly string[];
  /** Routers more than one platform uses: they never attribute alone, the fee wallet decides. */
  readonly sharedPrograms?: readonly string[];
  /** Wallets (or token accounts) credited the platform's fee; a token account owned by one counts too. */
  readonly feeWallets?: readonly string[];
  /** Relayers that pay the network fee only for this platform's users. */
  readonly feePayers?: readonly string[];
}

export interface PlatformEvm {
  /** Router contracts by chain id (`eth`, `base`, `bsc`; lower case), the transaction's `to`. */
  readonly routers?: Readonly<Record<string, readonly string[]>>;
  /** Function selectors (`0x` + 8 hex) by chain id, for routers that rotate. */
  readonly selectors?: Readonly<Record<string, readonly string[]>>;
  /** ERC-8021 builder codes appended to the calldata (Base). */
  readonly builderCodes?: readonly string[];
  /** Fee recipients (lower case): an ERC-20 transfer to one inside the swap attributes it. */
  readonly feeWallets?: readonly string[];
}

export interface PlatformEntry {
  readonly id: string;
  readonly name: string;
  /** Two or three characters, for a monogram where no logo is drawn. */
  readonly short: string;
  readonly kind: PlatformKind;
  readonly chains: readonly string[];
  /** False for a platform that stopped trading; it still attributes its older transactions. */
  readonly active?: boolean;
  readonly solana?: PlatformSolana;
  readonly evm?: PlatformEvm;
  /** Names data vendors use for the platform, lower case. */
  readonly aliases?: readonly string[];
  /** Addresses related to the platform that must never count as its fee wallet (cashback vaults, relayers…). */
  readonly exclude?: readonly string[];
  readonly confidence: PlatformConfidence;
  /** Where the identifiers came from. */
  readonly source?: string;
}

export interface PlatformRegistry {
  readonly version: number;
  readonly updated?: string;
  readonly platforms: readonly PlatformEntry[];
  /** Never a platform: protocol fee accounts, landing tips, block-builder tips. */
  readonly exclusions: { readonly solana: readonly string[]; readonly evm: readonly string[] };
}

/** The display facts of a platform. */
export interface PlatformLabel {
  readonly id: string;
  readonly name: string;
  readonly short: string;
  readonly kind: PlatformKind;
}

/** A parsed registry, with what was left out and what an override asks for. */
export interface ParsedPlatformRegistry {
  readonly registry: PlatformRegistry;
  /** What was dropped, and why. */
  readonly issues: string[];
  /** Ids an override removes (`{ id, disabled: true }`). */
  readonly disabled: string[];
  /** True when an override replaces the base list instead of adding to it. */
  readonly replace: boolean;
}

const KINDS: readonly PlatformKind[] = ['terminal', 'bot', 'wallet', 'app', 'aggregator'];
const CONFIDENCES: readonly PlatformConfidence[] = ['high', 'medium', 'low'];
const ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const SELECTOR = /^0x[0-9a-f]{8}$/;
const BUILDER_CODE = /^[a-z0-9_]{1,32}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The strings of a list that pass `test` (after `map`), each once; anything else is reported and left out. */
function stringList(value: unknown, test: RegExp, where: string, issues: string[], map: (s: string) => string = (s) => s): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${where}: not a list`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? map(item.trim()) : '';
    if (!test.test(text)) {
      issues.push(`${where}: ${typeof item === 'string' ? item : typeof item} is not valid`);
      continue;
    }
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function chainMap(value: unknown, test: RegExp, where: string, issues: string[]): Record<string, string[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    issues.push(`${where}: not an object`);
    return undefined;
  }
  const out: Record<string, string[]> = {};
  for (const [chain, list] of Object.entries(value)) {
    const items = stringList(list, test, `${where}.${chain}`, issues, (s) => s.toLowerCase());
    if (items.length > 0) out[chain.toLowerCase()] = items;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One entry, validated; null when it cannot be used (no id or no name), with the reason in `issues`. */
function parseEntry(raw: unknown, issues: string[]): (PlatformEntry & { readonly disabled?: boolean }) | null {
  if (!isRecord(raw)) {
    issues.push('platform: not an object');
    return null;
  }
  const id = typeof raw['id'] === 'string' ? raw['id'].trim().toLowerCase() : '';
  if (!ID.test(id)) {
    issues.push(`platform: id ${String(raw['id'])} is not valid`);
    return null;
  }
  if (raw['disabled'] === true) return { id, name: id, short: '', kind: 'app', chains: [], confidence: 'low', disabled: true };
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (!name || name.length > 40) {
    issues.push(`${id}: name missing or too long`);
    return null;
  }
  const shortRaw = typeof raw['short'] === 'string' ? raw['short'].trim() : '';
  const short = shortRaw.length >= 1 && shortRaw.length <= 3 ? shortRaw : name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  const kind = KINDS.includes(raw['kind'] as PlatformKind) ? (raw['kind'] as PlatformKind) : 'app';
  const confidence = CONFIDENCES.includes(raw['confidence'] as PlatformConfidence) ? (raw['confidence'] as PlatformConfidence) : 'low';
  const chains = stringList(raw['chains'], /^[a-z0-9]{2,8}$/, `${id}.chains`, issues, (s) => s.toLowerCase());

  let solana: PlatformSolana | undefined;
  if (isRecord(raw['solana'])) {
    const s = raw['solana'];
    const programs = stringList(s['programs'], SOLANA_ADDRESS, `${id}.solana.programs`, issues);
    const sharedPrograms = stringList(s['sharedPrograms'], SOLANA_ADDRESS, `${id}.solana.sharedPrograms`, issues);
    const feeWallets = stringList(s['feeWallets'], SOLANA_ADDRESS, `${id}.solana.feeWallets`, issues);
    const feePayers = stringList(s['feePayers'], SOLANA_ADDRESS, `${id}.solana.feePayers`, issues);
    solana = {
      ...(programs.length ? { programs } : {}),
      ...(sharedPrograms.length ? { sharedPrograms } : {}),
      ...(feeWallets.length ? { feeWallets } : {}),
      ...(feePayers.length ? { feePayers } : {}),
    };
  }
  let evm: PlatformEvm | undefined;
  if (isRecord(raw['evm'])) {
    const e = raw['evm'];
    const routers = chainMap(e['routers'], EVM_ADDRESS, `${id}.evm.routers`, issues);
    const selectors = chainMap(e['selectors'], SELECTOR, `${id}.evm.selectors`, issues);
    const builderCodes = stringList(e['builderCodes'], BUILDER_CODE, `${id}.evm.builderCodes`, issues, (s) => s.toLowerCase());
    const feeWallets = stringList(e['feeWallets'], EVM_ADDRESS, `${id}.evm.feeWallets`, issues, (s) => s.toLowerCase());
    evm = {
      ...(routers ? { routers } : {}),
      ...(selectors ? { selectors } : {}),
      ...(builderCodes.length ? { builderCodes } : {}),
      ...(feeWallets.length ? { feeWallets } : {}),
    };
  }
  const aliases = stringList(raw['aliases'], /^[a-z0-9][a-z0-9 ._()-]{0,47}$/, `${id}.aliases`, issues, (s) => s.toLowerCase());
  const exclude = stringList(raw['exclude'], /^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-f]{40})$/, `${id}.exclude`, issues, (s) => (s.startsWith('0x') || s.startsWith('0X') ? s.toLowerCase() : s));
  return {
    id,
    name,
    short,
    kind,
    chains,
    ...(raw['active'] === false ? { active: false } : {}),
    ...(solana && Object.keys(solana).length ? { solana } : {}),
    ...(evm && Object.keys(evm).length ? { evm } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(exclude.length ? { exclude } : {}),
    confidence,
    ...(typeof raw['source'] === 'string' ? { source: raw['source'] } : {}),
  };
}

/**
 * A registry from untrusted JSON (the built-in file, or a list of your own):
 * each entry is validated on its own, so one bad address drops that address, a
 * bad entry drops that entry, and the rest stands. `issues` says what was left
 * out.
 */
export function parsePlatformRegistry(raw: unknown): ParsedPlatformRegistry {
  const issues: string[] = [];
  const disabled: string[] = [];
  const platforms: PlatformEntry[] = [];
  const body = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) issues.push('registry: not an object');
  const list = Array.isArray(body['platforms']) ? body['platforms'] : [];
  for (const item of list) {
    const entry = parseEntry(item, issues);
    if (!entry) continue;
    if (entry.disabled) {
      disabled.push(entry.id);
      continue;
    }
    if (platforms.some((p) => p.id === entry.id)) {
      issues.push(`${entry.id}: listed twice, the first kept`);
      continue;
    }
    platforms.push(entry);
  }
  const ex = isRecord(body['exclusions']) ? body['exclusions'] : {};
  const exclusions = {
    solana: stringList(ex['solana'], SOLANA_ADDRESS, 'exclusions.solana', issues),
    evm: stringList(ex['evm'], EVM_ADDRESS, 'exclusions.evm', issues, (s) => s.toLowerCase()),
  };
  const version = typeof body['version'] === 'number' ? body['version'] : 1;
  return {
    registry: { version, ...(typeof body['updated'] === 'string' ? { updated: body['updated'] } : {}), platforms, exclusions },
    issues,
    disabled,
    replace: body['replace'] === true,
  };
}

/**
 * A registry with an override applied: entries replace the base entry of the
 * same id (or add a new one), `disabled: true` removes one, the exclusions add
 * up. `replace: true` in the override drops the base entries altogether.
 */
export function mergePlatformRegistries(base: PlatformRegistry, override: Pick<ParsedPlatformRegistry, 'registry' | 'disabled' | 'replace'>): PlatformRegistry {
  const byId = new Map<string, PlatformEntry>();
  if (!override.replace) for (const entry of base.platforms) byId.set(entry.id, entry);
  for (const entry of override.registry.platforms) byId.set(entry.id, entry);
  for (const id of override.disabled) byId.delete(id);
  const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
  const updated = override.registry.updated ?? base.updated;
  return {
    version: Math.max(base.version, override.registry.version),
    ...(updated ? { updated } : {}),
    platforms: [...byId.values()],
    exclusions: {
      solana: union(base.exclusions.solana, override.registry.exclusions.solana),
      evm: union(base.exclusions.evm, override.registry.exclusions.evm),
    },
  };
}

export interface SolanaProgramHit {
  readonly platform: PlatformEntry;
  /** True when more than one platform invokes the program: it never attributes alone. */
  readonly shared: boolean;
}

/** Lookups over one registry. Built once per registry; every lookup is a map read. */
export class PlatformIndex {
  readonly registry: PlatformRegistry;
  private readonly ids = new Map<string, PlatformEntry>();
  private readonly aliases = new Map<string, PlatformEntry>();
  private readonly programs = new Map<string, SolanaProgramHit>();
  private readonly solanaFee = new Map<string, PlatformEntry>();
  private readonly solanaPayers = new Map<string, PlatformEntry>();
  private readonly solanaExcluded = new Set<string>();
  private readonly evmRouters = new Map<string, PlatformEntry>();
  private readonly evmSelectors = new Map<string, PlatformEntry>();
  private readonly evmFee = new Map<string, PlatformEntry>();
  private readonly codes = new Map<string, PlatformEntry>();
  private readonly evmExcluded = new Set<string>();

  constructor(registry: PlatformRegistry) {
    this.registry = registry;
    for (const address of registry.exclusions.solana) this.solanaExcluded.add(address);
    for (const address of registry.exclusions.evm) this.evmExcluded.add(address.toLowerCase());
    for (const entry of registry.platforms) {
      for (const address of entry.exclude ?? []) (address.startsWith('0x') ? this.evmExcluded : this.solanaExcluded).add(address.startsWith('0x') ? address.toLowerCase() : address);
    }
    for (const entry of registry.platforms) {
      this.ids.set(entry.id, entry);
      if (!this.aliases.has(entry.id)) this.aliases.set(entry.id, entry);
      for (const alias of entry.aliases ?? []) if (!this.aliases.has(alias)) this.aliases.set(alias, entry);
      for (const program of entry.solana?.programs ?? []) {
        const seen = this.programs.get(program);
        // A program two entries claim is shared, whatever either says.
        this.programs.set(program, seen && seen.platform.id !== entry.id ? { platform: seen.platform, shared: true } : { platform: entry, shared: false });
      }
      for (const program of entry.solana?.sharedPrograms ?? []) {
        const seen = this.programs.get(program);
        this.programs.set(program, { platform: seen?.platform ?? entry, shared: true });
      }
      for (const wallet of entry.solana?.feeWallets ?? []) if (!this.solanaExcluded.has(wallet) && !this.solanaFee.has(wallet)) this.solanaFee.set(wallet, entry);
      for (const payer of entry.solana?.feePayers ?? []) if (!this.solanaExcluded.has(payer) && !this.solanaPayers.has(payer)) this.solanaPayers.set(payer, entry);
      for (const [chain, routers] of Object.entries(entry.evm?.routers ?? {})) for (const router of routers) if (!this.evmRouters.has(`${chain}:${router}`)) this.evmRouters.set(`${chain}:${router}`, entry);
      for (const [chain, selectors] of Object.entries(entry.evm?.selectors ?? {})) for (const selector of selectors) if (!this.evmSelectors.has(`${chain}:${selector}`)) this.evmSelectors.set(`${chain}:${selector}`, entry);
      for (const wallet of entry.evm?.feeWallets ?? []) if (!this.evmExcluded.has(wallet) && !this.evmFee.has(wallet)) this.evmFee.set(wallet, entry);
      for (const code of entry.evm?.builderCodes ?? []) if (!this.codes.has(code)) this.codes.set(code, entry);
    }
  }

  all(): readonly PlatformEntry[] {
    return this.registry.platforms;
  }

  byId(id: string | null | undefined): PlatformEntry | null {
    return id ? (this.ids.get(id) ?? null) : null;
  }

  /** The platform a vendor's name refers to (`axiom-flash`, `terminal-padre`, `Binance Wallet`…), or null. */
  byAlias(name: string | null | undefined): PlatformEntry | null {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    return this.aliases.get(key) ?? this.aliases.get(key.replace(/\s+/g, '-')) ?? null;
  }

  /** The display facts of an id; null for an id no entry claims. */
  label(id: string | null | undefined): PlatformLabel | null {
    const entry = this.byId(id);
    return entry ? { id: entry.id, name: entry.name, short: entry.short, kind: entry.kind } : null;
  }

  solanaProgram(programId: string): SolanaProgramHit | null {
    return this.programs.get(programId) ?? null;
  }

  solanaFeeWallet(address: string): PlatformEntry | null {
    return this.solanaFee.get(address) ?? null;
  }

  solanaFeePayer(address: string): PlatformEntry | null {
    return this.solanaPayers.get(address) ?? null;
  }

  isSolanaExcluded(address: string): boolean {
    return this.solanaExcluded.has(address);
  }

  evmRouter(chain: string, to: string | null | undefined): PlatformEntry | null {
    return to ? (this.evmRouters.get(`${chain}:${to.toLowerCase()}`) ?? null) : null;
  }

  evmSelector(chain: string, selector: string): PlatformEntry | null {
    return this.evmSelectors.get(`${chain}:${selector.toLowerCase()}`) ?? null;
  }

  evmFeeWallet(address: string): PlatformEntry | null {
    return this.evmFee.get(address.toLowerCase()) ?? null;
  }

  isEvmExcluded(address: string): boolean {
    return this.evmExcluded.has(address.toLowerCase());
  }

  builderCode(code: string): PlatformEntry | null {
    return this.codes.get(code.toLowerCase()) ?? null;
  }
}

const parsedBuiltIn = parsePlatformRegistry(BUILT_IN);

/** The registry shipped in `registry.json`. */
export const BUILT_IN_PLATFORMS: PlatformRegistry = parsedBuiltIn.registry;

/** What the built-in file left out on load; a test keeps it empty. */
export const BUILT_IN_PLATFORM_ISSUES: readonly string[] = parsedBuiltIn.issues;

/** The index over the built-in registry: what every function uses when it is given no other. */
export const BUILT_IN_INDEX: PlatformIndex = new PlatformIndex(BUILT_IN_PLATFORMS);

/**
 * An index over the built-in registry with your own entries applied: add a
 * platform, replace one by id, remove one with `{ id, disabled: true }`, or
 * pass `replace: true` to use only yours. Throws nothing: what could not be
 * used is in `issues`.
 */
export function platformIndexWith(override: unknown): { index: PlatformIndex; issues: string[] } {
  const parsed = parsePlatformRegistry(override);
  return { index: new PlatformIndex(mergePlatformRegistries(BUILT_IN_PLATFORMS, parsed)), issues: parsed.issues };
}

/** The platform a vendor's name refers to, as a registry id; null when no entry claims it. */
export function platformIdByAlias(name: string | null | undefined, index: PlatformIndex = BUILT_IN_INDEX): string | null {
  return index.byAlias(name)?.id ?? null;
}

/** The display facts of a platform id; null for an id no entry claims. */
export function platformLabel(id: string | null | undefined, index: PlatformIndex = BUILT_IN_INDEX): PlatformLabel | null {
  return index.label(id);
}
