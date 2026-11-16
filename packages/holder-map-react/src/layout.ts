/**
 * Where each bubble of a holder map sits.
 *
 * A bubble's radius grows with the square root of the holder's share, so its
 * area is what the eye compares. Members of a cluster gather around their
 * cluster's own centre, placed on a ring; every other holder settles in the
 * middle. Bubbles push each other apart until none touch, and two holders
 * joined by a line keep enough room between them for the line to show.
 *
 * The function is pure and has no randomness: the same graph and size always
 * give the same picture, on a server or in a browser.
 */

export interface HolderMapNode {
  readonly id: string;
  /** Share of the supply in percent; `null` when unknown. */
  readonly pct: number | null;
  readonly type: string;
  readonly label?: string;
  readonly cluster?: number;
}

export interface HolderMapEdge {
  readonly a: string;
  readonly b: string;
  readonly kind: string;
}

export interface HolderMapCluster {
  readonly id: number;
  readonly pct: number;
  readonly wallets: number;
}

/** The graph a holder map draws. `HolderGraph` of `@soltoolkit/holder-map` is one. */
export interface HolderMapGraph {
  readonly nodes: readonly HolderMapNode[];
  readonly edges: readonly HolderMapEdge[];
  readonly clusters: readonly HolderMapCluster[];
}

export interface LayoutOptions {
  /** The drawing's width, in its own units. Default 720. */
  readonly width?: number;
  /** Default 480. */
  readonly height?: number;
  /** The radius of a holder with no share, or a share of zero. Default 5. */
  readonly minRadius?: number;
  /** The radius of a holder with the whole supply. Default a fifth of the shorter side. */
  readonly maxRadius?: number;
  /** The space kept between two bubbles. Default 2. */
  readonly gap?: number;
  /** The space kept between two bubbles joined by a line, so the line and its dash pattern can be seen. Default 18. */
  readonly linkGap?: number;
}

export interface Bubble extends HolderMapNode {
  /** The bubble's place in the list: largest share first, as the graph gave it. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** A line between two bubbles. It runs from rim to rim, not from centre to centre. */
export interface Line extends HolderMapEdge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** The cluster both ends belong to, when they belong to the same one. */
  readonly cluster?: number;
}

export interface HolderMapLayout {
  readonly width: number;
  readonly height: number;
  readonly bubbles: readonly Bubble[];
  readonly lines: readonly Line[];
}

export const DEFAULT_WIDTH = 720;
export const DEFAULT_HEIGHT = 480;

/** The share of the drawing the bubbles may cover before they are all scaled down. */
const AREA_BUDGET = 0.5;
/** Passes that pull bubbles to their centres and push them apart. */
const SETTLE_PASSES = 220;
/** Passes that only push apart, so nothing is left touching. */
const SEPARATE_PASSES = 120;
/** The room kept between a bubble and the edge of the drawing, where the drawing is large enough to spare it. */
const EDGE = 4;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const round = (value: number): number => Math.round(value * 100) / 100;

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a number above zero`);
  return value;
}

export function layoutHolderMap(graph: HolderMapGraph, options: LayoutOptions = {}): HolderMapLayout {
  const width = positive(options.width, DEFAULT_WIDTH, 'width');
  const height = positive(options.height, DEFAULT_HEIGHT, 'height');
  const minRadius = positive(options.minRadius, 5, 'minRadius');
  const maxRadius = Math.max(minRadius, positive(options.maxRadius, Math.min(width, height) / 5, 'maxRadius'));
  const gap = options.gap === undefined ? 2 : Math.max(0, options.gap);
  let linkGap = Math.max(gap, options.linkGap === undefined ? 18 : Math.max(0, options.linkGap));

  // One bubble for each id; a repeated id keeps its first entry.
  const seen = new Set<string>();
  const nodes = graph.nodes.filter((node) => (seen.has(node.id) ? false : (seen.add(node.id), true)));

  const radii = nodes.map((node) => {
    const share = node.pct !== null && Number.isFinite(node.pct) && node.pct > 0 ? Math.min(node.pct, 100) : 0;
    return minRadius + (Math.sqrt(share) / 10) * (maxRadius - minRadius);
  });
  // Too many bubbles for the drawing: all of them shrink by the same factor, so shares still compare.
  const covered = radii.reduce((sum, r) => sum + Math.PI * (r + gap / 2) ** 2, 0);
  const budget = AREA_BUDGET * width * height;
  if (covered > budget) {
    const factor = Math.sqrt(budget / covered);
    for (let i = 0; i < radii.length; i += 1) radii[i] = Math.max(1.5, radii[i]! * factor);
    linkGap = Math.max(gap, linkGap * factor);
  }
  const edge = Math.min(EDGE, Math.min(width, height) / 20);
  const limit = Math.max(1, Math.min(width, height) / 2 - edge);
  for (let i = 0; i < radii.length; i += 1) radii[i] = Math.min(radii[i]!, limit);

  // Cluster centres on a ring, the first on the left; with nothing else to place, a single cluster takes the middle.
  const clusterIds = [...new Set(nodes.flatMap((node) => (node.cluster === undefined ? [] : [node.cluster])))].sort((a, b) => a - b);
  const everyoneClustered = nodes.every((node) => node.cluster !== undefined);
  const centres = new Map<number, readonly [number, number]>();
  clusterIds.forEach((id, i) => {
    if (clusterIds.length === 1 && everyoneClustered) {
      centres.set(id, [width / 2, height / 2]);
      return;
    }
    const angle = Math.PI + (i / clusterIds.length) * Math.PI * 2;
    centres.set(id, [width / 2 + Math.cos(angle) * width * 0.32, height / 2 + Math.sin(angle) * height * 0.3]);
  });
  const middle: readonly [number, number] = [width / 2, height / 2];
  const anchors = nodes.map((node) => (node.cluster === undefined ? middle : centres.get(node.cluster)!));

  const x = nodes.map((_, i) => anchors[i]![0] + Math.cos(i * GOLDEN_ANGLE) * (16 + (i % 7) * 6));
  const y = nodes.map((_, i) => anchors[i]![1] + Math.sin(i * GOLDEN_ANGLE) * (16 + (i % 7) * 6));
  const vx = nodes.map(() => 0);
  const vy = nodes.map(() => 0);

  const place = new Map(nodes.map((node, i) => [node.id, i]));
  const joined = new Set<number>();
  for (const edge of graph.edges) {
    const a = place.get(edge.a);
    const b = place.get(edge.b);
    if (a !== undefined && b !== undefined && a !== b) joined.add(Math.min(a, b) * nodes.length + Math.max(a, b));
  }

  const separate = (): void => {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        let dx = x[j]! - x[i]!;
        let dy = y[j]! - y[i]!;
        let distance = Math.hypot(dx, dy);
        const apart = radii[i]! + radii[j]! + (joined.has(i * nodes.length + j) ? linkGap : gap);
        if (distance >= apart) continue;
        if (distance < 0.01) {
          // Two bubbles on one spot have no direction to part in; give them one.
          dx = Math.cos((i + j) * GOLDEN_ANGLE);
          dy = Math.sin((i + j) * GOLDEN_ANGLE);
          distance = 1;
        }
        const push = ((apart - distance) / distance) * 0.5;
        x[i] = x[i]! - dx * push;
        y[i] = y[i]! - dy * push;
        x[j] = x[j]! + dx * push;
        y[j] = y[j]! + dy * push;
      }
    }
  };
  const keepInside = (): void => {
    for (let i = 0; i < nodes.length; i += 1) {
      const reach = radii[i]! + edge;
      x[i] = Math.max(reach, Math.min(width - reach, x[i]!));
      y[i] = Math.max(reach, Math.min(height - reach, y[i]!));
    }
  };

  for (let pass = 0; pass < SETTLE_PASSES; pass += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      vx[i] = vx[i]! + (anchors[i]![0] - x[i]!) * 0.01;
      vy[i] = vy[i]! + (anchors[i]![1] - y[i]!) * 0.01;
    }
    separate();
    for (let i = 0; i < nodes.length; i += 1) {
      x[i] = x[i]! + vx[i]!;
      y[i] = y[i]! + vy[i]!;
      vx[i] = vx[i]! * 0.6;
      vy[i] = vy[i]! * 0.6;
    }
    keepInside();
  }
  for (let pass = 0; pass < SEPARATE_PASSES; pass += 1) {
    separate();
    keepInside();
  }

  const bubbles: Bubble[] = nodes.map((node, index) => ({ ...node, index, x: round(x[index]!), y: round(y[index]!), r: round(radii[index]!) }));
  const byId = new Map(bubbles.map((bubble) => [bubble.id, bubble]));
  const lines: Line[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.a);
    const to = byId.get(edge.b);
    if (!from || !to || from === to) continue;
    const together = from.cluster !== undefined && from.cluster === to.cluster;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    // Two bubbles that overlap leave no room for a line.
    if (distance <= from.r + to.r) continue;
    const ux = dx / distance;
    const uy = dy / distance;
    lines.push({
      ...edge,
      x1: round(from.x + ux * from.r),
      y1: round(from.y + uy * from.r),
      x2: round(to.x - ux * to.r),
      y2: round(to.y - uy * to.r),
      ...(together ? { cluster: from.cluster } : {}),
    });
  }
  return { width, height, bubbles, lines };
}
