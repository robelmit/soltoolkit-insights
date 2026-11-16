import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_INDEX,
  BUILT_IN_PLATFORMS,
  BUILT_IN_PLATFORM_ISSUES,
  PlatformIndex,
  mergePlatformRegistries,
  parsePlatformRegistry,
  platformIdByAlias,
  platformIndexWith,
  platformLabel,
} from '../src';

const JITO_TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';

describe('the built-in registry (registry.json)', () => {
  it('loads without leaving anything out, one entry per id, a monogram for each', () => {
    expect(BUILT_IN_PLATFORM_ISSUES).toEqual([]);
    const ids = BUILT_IN_PLATFORMS.platforms.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILT_IN_PLATFORMS.platforms) {
      expect(p.short.length).toBeGreaterThanOrEqual(1);
      expect(p.short.length).toBeLessThanOrEqual(3);
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it('covers the terminals, bots and wallets it says it covers', () => {
    for (const id of ['axiom', 'gmgn', 'photon', 'trojan', 'padre', 'bonkbot', 'bloom', 'maestro', 'banana', 'phantom', 'okx', 'binance', 'metamask', 'sigma', 'fomo']) {
      expect(BUILT_IN_INDEX.byId(id)?.id).toBe(id);
    }
    expect(BUILT_IN_INDEX.all()).toHaveLength(33);
  });

  it('never lists an address both as a fee wallet and as an exclusion, nor one alias for two platforms', () => {
    const excluded = new Set([...BUILT_IN_PLATFORMS.exclusions.solana, ...BUILT_IN_PLATFORMS.platforms.flatMap((p) => p.exclude ?? [])]);
    const wallets = BUILT_IN_PLATFORMS.platforms.flatMap((p) => [...(p.solana?.feeWallets ?? []), ...(p.solana?.feePayers ?? [])]);
    for (const wallet of wallets) expect(excluded.has(wallet)).toBe(false);
    expect(new Set(wallets).size).toBe(wallets.length);
    const aliases = BUILT_IN_PLATFORMS.platforms.flatMap((p) => p.aliases ?? []);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('never lists an EVM fee recipient or router for two platforms', () => {
    const fee = BUILT_IN_PLATFORMS.platforms.flatMap((p) => p.evm?.feeWallets ?? []);
    expect(new Set(fee).size).toBe(fee.length);
    const routers = BUILT_IN_PLATFORMS.platforms.flatMap((p) => Object.entries(p.evm?.routers ?? {}).flatMap(([chain, list]) => list.map((router) => `${chain}:${router}`)));
    expect(new Set(routers).size).toBe(routers.length);
  });

  it('says where every entry came from', () => {
    for (const p of BUILT_IN_PLATFORMS.platforms) expect(p.source, p.id).toBeTruthy();
  });

  it("resolves the names data vendors use, and leaves exchanges unknown", () => {
    expect(platformIdByAlias('axiom-flash')).toBe('axiom');
    expect(platformIdByAlias('terminal')).toBe('padre');
    expect(platformIdByAlias('terminal-padre')).toBe('padre');
    expect(platformIdByAlias('bonkbot')).toBe('bonkbot');
    expect(platformIdByAlias('Binance Wallet')).toBe('binance');
    expect(platformIdByAlias('binance-wallet')).toBe('binance');
    expect(platformIdByAlias('pump-fun-frontend')).toBe('pumpfun-app');
    expect(platformIdByAlias('trust-wallet')).toBe('trust');
    expect(platformIdByAlias('GMGN')).toBe('gmgn');
    // The exchange a trade settled on is not the app it was placed through.
    for (const venue of ['uniswap', 'pancakeswap', 'aerodrome', 'pump', 'pumpswap', 'raydium', 'jupiter', null, '']) expect(platformIdByAlias(venue)).toBeNull();
  });

  it('labels an id, and answers null for an id nobody registered', () => {
    expect(platformLabel('axiom')).toEqual({ id: 'axiom', name: 'Axiom', short: 'AX', kind: 'terminal' });
    expect(platformLabel('phantom')).toMatchObject({ name: 'Phantom', kind: 'wallet' });
    expect(platformLabel('nobody')).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
  });

  it('tells a router one platform invokes from one two platforms share', () => {
    expect(BUILT_IN_INDEX.solanaProgram('FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9')).toMatchObject({ shared: false, platform: { id: 'axiom' } });
    expect(BUILT_IN_INDEX.solanaProgram('BBRouter1cVunVXvkcqeKkZQcBK7ruan37PPm3xzWaXD')?.shared).toBe(true);
    expect(BUILT_IN_INDEX.solanaProgram('11111111111111111111111111111111')).toBeNull();
  });

  it('keeps an inactive platform, so its older transactions still attribute', () => {
    expect(BUILT_IN_INDEX.byId('bullx')?.active).toBe(false);
    expect(BUILT_IN_INDEX.solanaFeeWallet('9RYJ3qr5eU5xAooqVcbmdeusjcViL5Nkiq7Gske3tiKq')?.id).toBe('bullx');
  });
});

describe('a registry of your own', () => {
  it('validates each entry on its own: a bad address drops that address, a bad entry drops that entry', () => {
    const parsed = parsePlatformRegistry({
      platforms: [
        { id: 'newbot', name: 'New Bot', short: 'NB', kind: 'bot', chains: ['sol'], solana: { feeWallets: ['not-an-address', 'Fee1111111111111111111111111111111111111111'] }, confidence: 'medium' },
        { id: 'Bad Id!', name: 'x' },
        { id: 'noname' },
        { id: 'bullx', disabled: true },
      ],
    });
    expect(parsed.registry.platforms.map((p) => p.id)).toEqual(['newbot']);
    expect(parsed.registry.platforms[0]?.solana?.feeWallets).toEqual(['Fee1111111111111111111111111111111111111111']);
    expect(parsed.disabled).toEqual(['bullx']);
    expect(parsed.issues.length).toBe(3);
  });

  it('fills what an entry leaves out with the cautious value', () => {
    const parsed = parsePlatformRegistry({ platforms: [{ id: 'newbot', name: 'New Bot' }] });
    expect(parsed.issues).toEqual([]);
    expect(parsed.registry.platforms[0]).toEqual({ id: 'newbot', name: 'New Bot', short: 'NE', kind: 'app', chains: [], confidence: 'low' });
  });

  it('lower-cases EVM addresses, selectors and aliases, and keeps Solana addresses as written', () => {
    const parsed = parsePlatformRegistry({
      platforms: [
        {
          id: 'newbot',
          name: 'New Bot',
          aliases: ['New-Bot'],
          solana: { programs: ['Prog111111111111111111111111111111111111111'] },
          evm: { routers: { ETH: ['0x00000000000000000000000000000000000000AA'] }, selectors: { eth: ['0xABCDEF12'] }, feeWallets: ['0x00000000000000000000000000000000000000BB'] },
        },
      ],
    });
    const entry = parsed.registry.platforms[0]!;
    expect(parsed.issues).toEqual([]);
    expect(entry.aliases).toEqual(['new-bot']);
    expect(entry.solana?.programs).toEqual(['Prog111111111111111111111111111111111111111']);
    expect(entry.evm).toEqual({ routers: { eth: ['0x00000000000000000000000000000000000000aa'] }, selectors: { eth: ['0xabcdef12'] }, feeWallets: ['0x00000000000000000000000000000000000000bb'] });
    const index = new PlatformIndex(parsed.registry);
    expect(index.evmRouter('eth', '0x00000000000000000000000000000000000000AA')?.id).toBe('newbot');
    expect(index.evmSelector('eth', '0xABCDEF12')?.id).toBe('newbot');
  });

  it('reports a second entry with the same id and keeps the first', () => {
    const parsed = parsePlatformRegistry({ platforms: [{ id: 'a', name: 'First' }, { id: 'a', name: 'Second' }] });
    expect(parsed.registry.platforms.map((p) => p.name)).toEqual(['First']);
    expect(parsed.issues).toEqual(['a: listed twice, the first kept']);
  });

  it('answers an empty registry, with the reason, for something that is not a registry', () => {
    for (const bad of [null, 'text', 42, []]) {
      const parsed = parsePlatformRegistry(bad);
      expect(parsed.registry.platforms).toEqual([]);
      expect(parsed.issues).toEqual(['registry: not an object']);
    }
  });

  it('replaces, adds and removes entries by id; an excluded address never becomes a fee wallet', () => {
    const override = parsePlatformRegistry({
      platforms: [
        { id: 'photon', name: 'Photon', short: 'PH', kind: 'terminal', chains: ['sol'], solana: { feeWallets: ['Photon1111111111111111111111111111111111111'] }, confidence: 'high' },
        { id: 'tipbot', name: 'Tip Bot', short: 'TB', kind: 'bot', chains: ['sol'], solana: { feeWallets: [JITO_TIP] }, confidence: 'low' },
        { id: 'bullx', disabled: true },
      ],
    });
    const index = new PlatformIndex(mergePlatformRegistries(BUILT_IN_PLATFORMS, override));
    expect(index.byId('photon')?.solana?.feeWallets).toEqual(['Photon1111111111111111111111111111111111111']);
    expect(index.byId('bullx')).toBeNull();
    expect(index.byId('tipbot')?.id).toBe('tipbot');
    expect(index.solanaFeeWallet(JITO_TIP)).toBeNull();
    expect(index.byId('axiom')?.id).toBe('axiom');
    const only = new PlatformIndex(mergePlatformRegistries(BUILT_IN_PLATFORMS, { ...override, replace: true }));
    expect(only.byId('axiom')).toBeNull();
  });

  it('builds an index with your entries in one call, and leaves the built-in index as it was', () => {
    const { index, issues } = platformIndexWith({ platforms: [{ id: 'mine', name: 'Mine', kind: 'terminal', aliases: ['my-terminal'], solana: { feeWallets: ['Mine111111111111111111111111111111111111111'] } }] });
    expect(issues).toEqual([]);
    expect(index.solanaFeeWallet('Mine111111111111111111111111111111111111111')?.id).toBe('mine');
    expect(platformIdByAlias('my-terminal', index)).toBe('mine');
    expect(platformLabel('mine', index)).toEqual({ id: 'mine', name: 'Mine', short: 'MI', kind: 'terminal' });
    expect(index.byId('axiom')?.id).toBe('axiom');
    expect(platformIdByAlias('my-terminal')).toBeNull();
    expect(BUILT_IN_INDEX.byId('mine')).toBeNull();
  });
});
