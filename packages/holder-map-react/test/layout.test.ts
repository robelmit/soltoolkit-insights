import { describe, expect, it } from 'vitest';
import type { HolderGraph } from '@soltoolkit/holder-map';
import { layoutHolderMap, type Bubble, type HolderMapGraph, type HolderMapLayout } from '../src/layout';
import { SAMPLE, crowd } from './sample';

/** Coordinates are rounded to two decimals, so two bubbles may sit this much closer than their radii say. */
const ROUNDING = 0.05;

function overlaps(layout: HolderMapLayout): string[] {
  const found: string[] = [];
  const { bubbles } = layout;
  for (let i = 0; i < bubbles.length; i += 1) {
    for (let j = i + 1; j < bubbles.length; j += 1) {
      const a = bubbles[i]!;
      const b = bubbles[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - ROUNDING) found.push(`${a.id} / ${b.id}`);
    }
  }
  return found;
}

/** Bubbles closer to the edge of the drawing than the room it keeps there. */
const EDGE = 4;
const outside = (layout: HolderMapLayout): Bubble[] =>
  layout.bubbles.filter(
    (b) => b.x - b.r < EDGE - ROUNDING || b.y - b.r < EDGE - ROUNDING || b.x + b.r > layout.width - EDGE + ROUNDING || b.y + b.r > layout.height - EDGE + ROUNDING,
  );

const byId = (layout: HolderMapLayout, id: string): Bubble => layout.bubbles.find((bubble) => bubble.id === id)!;

describe('layoutHolderMap', () => {
  it('takes the graph the engine builds', () => {
    // Compiles only while `HolderGraph` stays assignable to what the viewer draws.
    const graph: HolderGraph = { nodes: [{ id: 'a', pct: 1, type: 'wallet' }], edges: [], clusters: [] };
    const drawn: HolderMapGraph = graph;
    expect(layoutHolderMap(drawn).bubbles).toHaveLength(1);
  });

  it('gives the same picture every time', () => {
    expect(layoutHolderMap(SAMPLE)).toEqual(layoutHolderMap(SAMPLE));
    expect(layoutHolderMap(crowd(120))).toEqual(layoutHolderMap(crowd(120)));
  });

  it('uses the default size, and the size it is given', () => {
    expect(layoutHolderMap(SAMPLE)).toMatchObject({ width: 720, height: 480 });
    expect(layoutHolderMap(SAMPLE, { width: 320, height: 300 })).toMatchObject({ width: 320, height: 300 });
  });

  it('refuses a size that is not a number above zero', () => {
    expect(() => layoutHolderMap(SAMPLE, { width: 0 })).toThrow('width');
    expect(() => layoutHolderMap(SAMPLE, { height: Number.NaN })).toThrow('height');
    expect(() => layoutHolderMap(SAMPLE, { minRadius: -1 })).toThrow('minRadius');
  });

  it('keeps every bubble inside the drawing, with none touching', () => {
    for (const layout of [layoutHolderMap(SAMPLE), layoutHolderMap(SAMPLE, { width: 320, height: 300 })]) {
      expect(layout.bubbles).toHaveLength(SAMPLE.nodes.length);
      expect(outside(layout)).toEqual([]);
      expect(overlaps(layout)).toEqual([]);
    }
  });

  it('keeps a crowded map apart and inside too', () => {
    for (const size of [60, 250]) {
      const layout = layoutHolderMap(crowd(size));
      expect(layout.bubbles).toHaveLength(size);
      expect(outside(layout)).toEqual([]);
      expect(overlaps(layout)).toEqual([]);
    }
  });

  it('sizes a bubble by the square root of the share', () => {
    const layout = layoutHolderMap({
      nodes: [
        { id: 'whole', pct: 100, type: 'wallet' },
        { id: 'quarter', pct: 25, type: 'wallet' },
        { id: 'none', pct: 0, type: 'wallet' },
      ],
      edges: [],
      clusters: [],
    }, { width: 2000, height: 2000, minRadius: 10, maxRadius: 110 });
    expect(byId(layout, 'whole').r).toBe(110);
    expect(byId(layout, 'quarter').r).toBe(60);
    expect(byId(layout, 'none').r).toBe(10);
  });

  it('draws an unknown share at the smallest size, not as nothing', () => {
    const layout = layoutHolderMap(SAMPLE);
    const unknown = byId(layout, 'Lone2222222222222222222222222222222222222222');
    expect(unknown.pct).toBeNull();
    expect(unknown.r).toBe(5);
    expect(layoutHolderMap({ nodes: [{ id: 'a', pct: Number.NaN, type: 'wallet' }, { id: 'b', pct: -3, type: 'wallet' }], edges: [], clusters: [] }).bubbles.map((b) => b.r)).toEqual([5, 5]);
  });

  it('shrinks every bubble by the same factor when they would not fit', () => {
    const layout = layoutHolderMap(crowd(250), { width: 320, height: 240 });
    const radii = layout.bubbles.map((bubble) => bubble.r);
    expect(Math.max(...radii)).toBeLessThan(48);
    // Largest share first in the list, so radii never grow down the list.
    expect(radii).toEqual([...radii].sort((a, b) => b - a));
    expect(outside(layout)).toEqual([]);
  });

  it('gathers a cluster around its own centre', () => {
    const layout = layoutHolderMap(crowd(60, 3));
    const centre = (id: number): [number, number] => {
      const members = layout.bubbles.filter((bubble) => bubble.cluster === id);
      return [members.reduce((sum, b) => sum + b.x, 0) / members.length, members.reduce((sum, b) => sum + b.y, 0) / members.length];
    };
    const centres = new Map([1, 2, 3].map((id) => [id, centre(id)]));
    for (const bubble of layout.bubbles) {
      if (bubble.cluster === undefined) continue;
      const distances = [...centres].map(([id, [x, y]]) => ({ id, d: Math.hypot(bubble.x - x, bubble.y - y) })).sort((a, b) => a.d - b.d);
      expect(distances[0]!.id).toBe(bubble.cluster);
    }
  });

  it('puts a single cluster with nothing else in the middle', () => {
    const layout = layoutHolderMap({
      nodes: [
        { id: 'a', pct: 5, type: 'wallet', cluster: 1 },
        { id: 'b', pct: 5, type: 'wallet', cluster: 1 },
      ],
      edges: [{ a: 'a', b: 'b', kind: 'transfer' }],
      clusters: [{ id: 1, pct: 10, wallets: 2 }],
    });
    const x = (byId(layout, 'a').x + byId(layout, 'b').x) / 2;
    const y = (byId(layout, 'a').y + byId(layout, 'b').y) / 2;
    expect(Math.abs(x - 360)).toBeLessThan(20);
    expect(Math.abs(y - 240)).toBeLessThan(20);
  });

  it('draws a line from rim to rim and names the cluster both ends share', () => {
    const layout = layoutHolderMap(SAMPLE);
    expect(layout.lines).toHaveLength(4);
    const [inside, , , across] = layout.lines;
    const a = byId(layout, inside!.a);
    const b = byId(layout, inside!.b);
    expect(inside).toMatchObject({ kind: 'transfer', cluster: 1 });
    expect(Math.hypot(inside!.x1 - a.x, inside!.y1 - a.y)).toBeCloseTo(a.r, 1);
    expect(Math.hypot(inside!.x2 - b.x, inside!.y2 - b.y)).toBeCloseTo(b.r, 1);
    expect(across!.kind).toBe('transfer');
    expect('cluster' in across!).toBe(false);
  });

  it('keeps room between two joined holders for the line to show', () => {
    const length = (line: { x1: number; y1: number; x2: number; y2: number }): number => Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    for (const line of layoutHolderMap(SAMPLE).lines) expect(length(line)).toBeGreaterThanOrEqual(17.9);
    for (const line of layoutHolderMap(SAMPLE, { linkGap: 30 }).lines) expect(length(line)).toBeGreaterThanOrEqual(29.9);
    // With no room asked for, joined holders sit as close as any other two.
    const tight = layoutHolderMap(SAMPLE, { linkGap: 0 }).lines.map(length);
    expect(Math.min(...tight)).toBeLessThan(17);
  });

  it('drops a line with a missing end, and a line from a holder to itself', () => {
    const layout = layoutHolderMap({
      nodes: [{ id: 'a', pct: 1, type: 'wallet' }, { id: 'b', pct: 1, type: 'wallet' }],
      edges: [
        { a: 'a', b: 'gone', kind: 'transfer' },
        { a: 'a', b: 'a', kind: 'transfer' },
        { a: 'a', b: 'b', kind: 'insider' },
      ],
      clusters: [],
    });
    expect(layout.lines.map((line) => line.kind)).toEqual(['insider']);
  });

  it('draws a repeated holder once', () => {
    const layout = layoutHolderMap({ nodes: [{ id: 'a', pct: 3, type: 'wallet' }, { id: 'a', pct: 9, type: 'pool' }], edges: [], clusters: [] });
    expect(layout.bubbles).toHaveLength(1);
    expect(layout.bubbles[0]).toMatchObject({ id: 'a', pct: 3, type: 'wallet', index: 0 });
  });

  it('parts holders that start on the same spot', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `w${i * 7}`, pct: 2, type: 'wallet' }));
    const layout = layoutHolderMap({ nodes, edges: [], clusters: [] }, { width: 200, height: 200 });
    expect(overlaps(layout)).toEqual([]);
  });

  it('draws nothing for an empty graph', () => {
    expect(layoutHolderMap({ nodes: [], edges: [], clusters: [] })).toEqual({ width: 720, height: 480, bubbles: [], lines: [] });
  });

  it('keeps what the caller put on a holder', () => {
    const graph = { nodes: [{ id: 'a', pct: 1, type: 'wallet', name: 'treasury' }], edges: [], clusters: [] };
    expect(layoutHolderMap(graph).bubbles[0]).toMatchObject({ name: 'treasury' });
  });
});
