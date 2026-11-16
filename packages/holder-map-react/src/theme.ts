/**
 * The viewer's colours, for a light and a dark surface.
 *
 * Colour says one thing on the map: which cluster a holder belongs to. Any two
 * bubbles can end up side by side, so the cluster colours have to stay apart
 * from each other in every pairing, for readers with a colour vision
 * deficiency too. Three colours pass that test together on both surfaces,
 * which is why the default palette has three: the three largest clusters are
 * coloured, and the clusters after them share one neutral tone. Position,
 * the lines and the cluster list still tell those apart.
 *
 * A host that wants more colours passes its own list. It should test the list
 * the same way before it does.
 */

export interface HolderMapColors {
  /** What the map is drawn on. */
  readonly surface: string;
  /** Primary text. */
  readonly text: string;
  /** Secondary text: legends, notes. */
  readonly textSecondary: string;
  /** Lines between holders of different clusters, and the ring of a pool, program or burn address. */
  readonly muted: string;
  /** Borders. */
  readonly hairline: string;
  /** One colour for each of the largest clusters, in order. */
  readonly clusters: readonly string[];
  /** Text inside a bubble that wears a cluster colour. */
  readonly onCluster: string;
  /** Clusters past the end of `clusters`. */
  readonly otherCluster: string;
  readonly onOtherCluster: string;
  /** A holder in no cluster. */
  readonly holder: string;
  readonly onHolder: string;
}

export const LIGHT_COLORS: HolderMapColors = {
  surface: '#fcfcfb',
  text: '#0b0b0b',
  textSecondary: '#52514e',
  muted: '#898781',
  hairline: '#e1e0d9',
  clusters: ['#2a78d6', '#eb6834', '#1baf7a'],
  onCluster: '#000000',
  otherCluster: '#52514e',
  onOtherCluster: '#ffffff',
  holder: '#c3c2b7',
  onHolder: '#0b0b0b',
};

export const DARK_COLORS: HolderMapColors = {
  surface: '#1a1a19',
  text: '#f0efec',
  textSecondary: '#c3c2b7',
  muted: '#898781',
  hairline: '#2c2c2a',
  clusters: ['#3987e5', '#d95926', '#199e70'],
  onCluster: '#000000',
  otherCluster: '#c3c2b7',
  onOtherCluster: '#0b0b0b',
  holder: '#52514e',
  onHolder: '#f0efec',
};

export type HolderMapTheme = 'auto' | 'light' | 'dark';

export interface HolderMapColorOverrides {
  readonly light?: Partial<HolderMapColors>;
  readonly dark?: Partial<HolderMapColors>;
}

/** A colour as CSS takes it: a hex value, a colour function, a custom property or a name. Nothing that could end a declaration. */
const COLOR = /^[#a-zA-Z0-9(),.%\s/-]+$/;
/** The functions a colour may be written with. `url(…)` is not one: a colour never loads anything. */
const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark', 'var']);

function checked(value: string, name: string): string {
  const refuse = (): never => {
    throw new Error(`${name} is not a colour: ${String(value)}`);
  };
  if (typeof value !== 'string' || value.trim() === '' || !COLOR.test(value) || value.includes('/*')) return refuse();
  for (const match of value.matchAll(/([a-zA-Z-]*)\(/g)) {
    if (!COLOR_FUNCTIONS.has(match[1]!.toLowerCase())) return refuse();
  }
  return value.trim();
}

function variables(colors: HolderMapColors, count: number, name: string): string {
  const out = [
    `--hhm-surface:${checked(colors.surface, `${name}.surface`)}`,
    `--hhm-text:${checked(colors.text, `${name}.text`)}`,
    `--hhm-text-2:${checked(colors.textSecondary, `${name}.textSecondary`)}`,
    `--hhm-muted:${checked(colors.muted, `${name}.muted`)}`,
    `--hhm-hairline:${checked(colors.hairline, `${name}.hairline`)}`,
    `--hhm-on-cluster:${checked(colors.onCluster, `${name}.onCluster`)}`,
    `--hhm-other:${checked(colors.otherCluster, `${name}.otherCluster`)}`,
    `--hhm-on-other:${checked(colors.onOtherCluster, `${name}.onOtherCluster`)}`,
    `--hhm-holder:${checked(colors.holder, `${name}.holder`)}`,
    `--hhm-on-holder:${checked(colors.onHolder, `${name}.onHolder`)}`,
  ];
  for (let i = 0; i < count; i += 1) out.push(`--hhm-cluster-${i + 1}:${checked(colors.clusters[i]!, `${name}.clusters[${i}]`)}`);
  return out.join(';');
}

export interface ResolvedTheme {
  /** How many clusters get a colour of their own: the shorter of the two cluster lists. */
  readonly clusterColors: number;
  /** The style sheet for one viewer: its colours in both modes, then the rules every viewer shares. */
  readonly css: string;
}

/**
 * The style sheet of one viewer.
 *
 * `scope` is a class only that viewer carries, so two viewers on a page can
 * wear different colours.
 */
export function resolveTheme(scope: string, overrides: HolderMapColorOverrides = {}): ResolvedTheme {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(scope)) throw new Error(`Not a class name: ${scope}`);
  const light: HolderMapColors = { ...LIGHT_COLORS, ...overrides.light };
  const dark: HolderMapColors = { ...DARK_COLORS, ...overrides.dark };
  const clusterColors = Math.min(light.clusters.length, dark.clusters.length);
  const lightVars = variables(light, clusterColors, 'colors.light');
  const darkVars = variables(dark, clusterColors, 'colors.dark');
  const css = [
    `.${scope}{color-scheme:light;${lightVars}}`,
    `.${scope}[data-theme="dark"]{color-scheme:dark;${darkVars}}`,
    `@media (prefers-color-scheme:dark){.${scope}[data-theme="auto"]{color-scheme:dark;${darkVars}}}`,
    BASE_CSS,
  ].join('\n');
  return { clusterColors, css };
}

/** The rules every viewer shares. They only read the variables above. */
export const BASE_CSS = `
.hhm{position:relative;box-sizing:border-box;background:var(--hhm-surface);color:var(--hhm-text);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.hhm *{box-sizing:border-box}
.hhm-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:8px 12px}
.hhm-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:1px solid var(--hhm-hairline);border-radius:12px;background:transparent;color:var(--hhm-text);font:inherit;cursor:pointer}
.hhm-chip:hover{border-color:var(--hhm-muted)}
.hhm-chip[aria-pressed="true"]{border-color:var(--hhm-text)}
.hhm-chip:focus-visible{outline:2px solid var(--hhm-text);outline-offset:1px}
.hhm-chip b{font-weight:600;font-variant-numeric:tabular-nums}
.hhm-chip span,.hhm-key{color:var(--hhm-text-2)}
.hhm-key{display:inline-flex;align-items:center;gap:6px}
.hhm-swatch{flex:none;width:8px;height:8px;border-radius:50%}
.hhm-ring{flex:none;width:10px;height:10px;border-radius:50%;border:1.5px dashed var(--hhm-muted)}
.hhm-plot{position:relative}
.hhm-plot svg{display:block;width:100%;height:auto;overflow:visible}
.hhm-line{fill:none;stroke:var(--hhm-muted);stroke-width:1.5;transition:opacity .15s}
.hhm-line[data-dim]{opacity:.1}
.hhm-bubble{outline:none;transition:opacity .15s}
.hhm-bubble[data-dim]{opacity:.2}
.hhm-hit{fill:transparent;stroke:none}
.hhm-bubble[data-select]{cursor:pointer}
.hhm-mark{stroke:transparent;stroke-width:2}
.hhm-mark[data-plain]{stroke:var(--hhm-muted);stroke-width:1}
.hhm-mark[data-venue]{fill:var(--hhm-surface);stroke:var(--hhm-muted);stroke-width:1.5;stroke-dasharray:3 3}
.hhm-bubble[data-active] .hhm-mark,.hhm-bubble:focus-visible .hhm-mark{stroke:var(--hhm-text);stroke-width:2;stroke-dasharray:none}
.hhm-label{font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;text-anchor:middle;dominant-baseline:central;pointer-events:none}
.hhm-tip{position:absolute;z-index:1;pointer-events:none;min-width:150px;max-width:280px;padding:8px 10px;border:1px solid var(--hhm-hairline);border-radius:8px;background:var(--hhm-surface);color:var(--hhm-text-2);box-shadow:0 4px 16px rgba(0,0,0,.18)}
.hhm-tip strong{display:block;color:var(--hhm-text);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.hhm-tip div{display:flex;align-items:center;gap:6px}
.hhm-empty{padding:24px 12px;color:var(--hhm-text-2)}
.hhm-notes{margin:0;padding:6px 12px 8px 28px;color:var(--hhm-text-2)}
.hhm-table{padding:0 12px 10px}
.hhm-table summary{cursor:pointer;color:var(--hhm-text-2)}
.hhm-table table{width:100%;margin-top:6px;border-collapse:collapse;font-variant-numeric:tabular-nums}
.hhm-table th,.hhm-table td{padding:4px 10px 4px 0;border-bottom:1px solid var(--hhm-hairline);text-align:left;vertical-align:top}
.hhm-table th{color:var(--hhm-text-2);font-weight:500}
.hhm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.hhm-line,.hhm-bubble{transition:none}}
`.trim();
