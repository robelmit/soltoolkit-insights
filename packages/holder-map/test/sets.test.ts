import { describe, expect, it } from 'vitest';
import { SNIPER_SLOTS, buildHolderGraph, buyerSets, linksFromSets, type EarlyBuy } from '../src';

const buy = (buyer: string, slot: number, signature: string): EarlyBuy => ({ buyer, slot, signature });

describe('buyerSets', () => {
  it('finds wallets that bought in one transaction', () => {
    const sets = buyerSets([buy('A', 100, 'tx1'), buy('B', 100, 'tx1'), buy('C', 100, 'tx2'), buy('D', 140, 'tx3'), buy('E', 140, 'tx3'), buy('F', 140, 'tx3')]);
    expect(sets.bundles).toEqual([
      ['A', 'B'],
      ['D', 'E', 'F'],
    ]);
    // Without the launch slot nothing can be called a snipe.
    expect(sets.snipers).toEqual([]);
  });

  it('makes one bundle of the launch slot, whatever transaction carried each buy', () => {
    const sets = buyerSets([buy('A', 100, 'tx1'), buy('B', 100, 'tx2'), buy('C', 101, 'tx3'), buy('D', 101, 'tx4')], { launchSlot: 100 });
    expect(sets.bundles).toEqual([['A', 'B']]);
  });

  it('counts a buyer once, however many buys it made', () => {
    const sets = buyerSets([buy('A', 100, 'tx1'), buy('A', 100, 'tx1'), buy('A', 100, 'tx2')], { launchSlot: 100 });
    expect(sets.bundles).toEqual([]);
    expect(sets.snipers).toEqual(['A']);
  });

  it('names the wallets that bought within the first slots', () => {
    const buys = [buy('A', 100, 'a'), buy('B', 100 + SNIPER_SLOTS, 'b'), buy('C', 100 + SNIPER_SLOTS + 1, 'c'), buy('EARLY', 99, 'd')];
    expect(buyerSets(buys, { launchSlot: 100 }).snipers).toEqual(['A', 'B']);
    expect(buyerSets(buys, { launchSlot: 100, sniperSlots: 0 }).snipers).toEqual(['A']);
    expect(buyerSets(buys, { launchSlot: 100, sniperSlots: 10 }).snipers).toEqual(['A', 'B', 'C']);
  });

  it('compares 0x addresses without case', () => {
    const sets = buyerSets([buy('0xAAA', 5, 't'), buy('0xaaa', 5, 't'), buy('0xBBB', 5, 't')]);
    expect(sets.bundles).toEqual([['0xAAA', '0xBBB']]);
  });

  it('is empty for no buys', () => {
    expect(buyerSets([])).toEqual({ bundles: [], snipers: [] });
  });
});

describe('linksFromSets', () => {
  const holders = ['BIG', 'MID', 'SMALL', 'TINY'];

  it('draws each set as a star around its largest holder, and drops wallets that are not on the map', () => {
    const links = linksFromSets({ bundles: [['TINY', 'GONE', 'MID', 'SMALL']] }, holders);
    expect(links).toEqual([
      { from: 'MID', to: 'SMALL', kind: 'bundle' },
      { from: 'MID', to: 'TINY', kind: 'bundle' },
    ]);
  });

  it('draws nothing for a set with fewer than two members on the map', () => {
    expect(linksFromSets({ bundles: [['BIG', 'GONE'], ['GONE']], snipers: ['SMALL'], insiders: [] }, holders)).toEqual([]);
    expect(linksFromSets({}, holders)).toEqual([]);
  });

  it('puts bundles before snipers before insiders, so a pair keeps the stronger line', () => {
    const links = linksFromSets({ insiders: ['BIG', 'MID'], snipers: ['BIG', 'MID', 'SMALL'], bundles: [['BIG', 'MID']] }, holders);
    expect(links.map((link) => link.kind)).toEqual(['bundle', 'sniper', 'sniper', 'insider']);

    const graph = buildHolderGraph(
      holders.map((address, i) => ({ address, pct: 10 - i, type: 'wallet' })),
      links,
    );
    expect(graph.edges).toEqual([
      { a: 'BIG', b: 'MID', kind: 'bundle' },
      { a: 'BIG', b: 'SMALL', kind: 'sniper' },
    ]);
    expect(graph.clusters).toEqual([{ id: 1, pct: 27, wallets: 3 }]);
  });

  it('writes a holder as the map has it', () => {
    expect(linksFromSets({ bundles: [['0xaaa', '0xBBB']] }, ['0xAAA', '0xbbb'])).toEqual([{ from: '0xAAA', to: '0xbbb', kind: 'bundle' }]);
  });
});
