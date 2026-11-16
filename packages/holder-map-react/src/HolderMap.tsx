/**
 * The holder map as a picture: one bubble for each holder, sized by share,
 * coloured by cluster, with the links between them.
 *
 * It is SVG, drawn from a pure layout, so a server renders the same picture a
 * browser does. Everything the picture says is also in the legend, the
 * tooltip and the table under it; colour is never the only carrier.
 */

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react';
import { DEFAULT_WIDTH, layoutHolderMap, type Bubble, type HolderMapGraph, type HolderMapNode, type Line } from './layout';
import { resolveTheme, type HolderMapColorOverrides, type HolderMapTheme } from './theme';

export interface HolderMapProps {
  /** What to draw. A `HolderGraph` of `@soltoolkit/holder-map` fits as it is. Keep the same object between renders: the layout is worked out again when it changes. */
  readonly graph: HolderMapGraph;
  /** Lines shown under the map: what it covers and what it does not. */
  readonly notes?: readonly string[];
  /** The widest the viewer grows, and the width a server draws for. Default 720. */
  readonly width?: number;
  /** Default 480. */
  readonly height?: number;
  /**
   * Lay the map out again for the room it has, once it is in a browser, so
   * bubbles and text keep their size in a narrow column. With `false` the
   * drawing made for `width` is scaled down as one picture. Default true.
   */
  readonly responsive?: boolean;
  /** `auto` follows the reader's system setting. Default `auto`. */
  readonly theme?: HolderMapTheme;
  /** Colours to use instead of the defaults, for either mode. */
  readonly colors?: HolderMapColorOverrides;
  /** The holders as a table under the map, folded until opened. Default true. */
  readonly table?: boolean;
  /** How an address is shown on the map. Default: the first and last four characters. */
  readonly formatAddress?: (address: string) => string;
  /** Called when a holder is clicked, or chosen with the keyboard. With it, every bubble can take focus. */
  readonly onSelect?: (holder: HolderMapNode) => void;
  /** What a screen reader calls the picture. Default: a count of holders and clusters. */
  readonly label?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** Holder types drawn as a hollow ring: places tokens sit, not people who hold them. */
export const VENUE_TYPES: readonly string[] = ['pool', 'burn', 'program'];

/** How each kind of link is named and drawn. A kind not listed here is drawn solid under its own name. */
export const LINE_KINDS: Readonly<Record<string, { readonly label: string; readonly dash?: string }>> = {
  transfer: { label: 'Transfer' },
  bundle: { label: 'Bought in one bundle', dash: '6 3' },
  sniper: { label: 'Sniper set', dash: '2 3' },
  insider: { label: 'Insider set', dash: '8 3 2 3' },
  funding: { label: 'Shared funder', dash: '12 4' },
};

const TYPE_NAMES: Readonly<Record<string, string>> = { wallet: 'Wallet', pool: 'Pool', burn: 'Burn address', program: 'Program' };

/** Clusters that get a button of their own in the legend; the table lists the rest. */
const MAX_CLUSTER_CHIPS = 8;
/** A share is written inside a bubble at least this large. */
const LABEL_RADIUS = 16;
/** The smallest target a pointer has to hit, as a radius. */
const HIT_RADIUS = 12;
/** How long the viewer waits after its room changes before laying the map out again. */
const RESIZE_WAIT_MS = 120;

const shortAddress = (address: string): string => (address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

function share(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function typeName(type: string): string {
  return TYPE_NAMES[type] ?? (type === '' ? 'Holder' : type.charAt(0).toUpperCase() + type.slice(1));
}

interface Tone {
  readonly fill: string;
  readonly ink: string;
  readonly look: 'cluster' | 'venue' | 'plain';
}

export function HolderMap(props: HolderMapProps): ReactElement {
  const { graph, notes, width = DEFAULT_WIDTH, height, responsive = true, theme = 'auto', colors, table = true, formatAddress = shortAddress, onSelect, label, className, style } = props;
  const scope = `hhm-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const light = colors?.light;
  const dark = colors?.dark;
  const resolved = useMemo(() => resolveTheme(scope, { ...(light ? { light } : {}), ...(dark ? { dark } : {}) }), [scope, light, dark]);

  // The room the drawing has, known only in a browser. A server, and the first render, draw for `width`.
  const plot = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  const empty = graph.nodes.length === 0;
  useEffect(() => {
    const element = plot.current;
    if (!responsive || !element || typeof ResizeObserver === 'undefined') {
      setRoom(null);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[entries.length - 1]?.contentRect.width ?? 0);
      if (next <= 0) return;
      clearTimeout(timer);
      if (first) {
        first = false;
        setRoom(next);
        return;
      }
      // A window being dragged reports many widths; only the one it stops at is drawn.
      timer = setTimeout(() => setRoom(next), RESIZE_WAIT_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [responsive, empty]);
  const drawn = room === null ? width : Math.min(width, room);
  const layout = useMemo(() => layoutHolderMap(graph, { width: drawn, ...(height === undefined ? {} : { height }) }), [graph, drawn, height]);

  const [active, setActive] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  // A cluster keeps its colour for as long as it keeps its place in the graph's own list; focusing one repaints nothing.
  const slots = useMemo(() => new Map(graph.clusters.map((cluster, i) => [cluster.id, i])), [graph]);
  const focused = focus !== null && slots.has(focus) ? focus : null;
  const venues = new Set(VENUE_TYPES);

  const clusterColor = (id: number): string => {
    const slot = slots.get(id);
    return slot !== undefined && slot < resolved.clusterColors ? `var(--hhm-cluster-${slot + 1})` : 'var(--hhm-other)';
  };
  const toneOf = (bubble: HolderMapNode): Tone => {
    if (bubble.cluster !== undefined) {
      const slot = slots.get(bubble.cluster);
      const own = slot !== undefined && slot < resolved.clusterColors;
      return { fill: clusterColor(bubble.cluster), ink: own ? 'var(--hhm-on-cluster)' : 'var(--hhm-on-other)', look: 'cluster' };
    }
    if (venues.has(bubble.type)) return { fill: 'var(--hhm-surface)', ink: 'var(--hhm-text)', look: 'venue' };
    return { fill: 'var(--hhm-holder)', ink: 'var(--hhm-on-holder)', look: 'plain' };
  };

  const describe = (bubble: HolderMapNode): string => {
    const parts = [formatAddress(bubble.id), bubble.label ?? typeName(bubble.type), share(bubble.pct) ?? 'share unknown'];
    if (bubble.cluster !== undefined) parts.push(`cluster ${bubble.cluster}`);
    return parts.join(', ');
  };

  const plain = layout.bubbles.some((bubble) => toneOf(bubble).look === 'plain');
  const venue = layout.bubbles.some((bubble) => toneOf(bubble).look === 'venue');
  const kinds = [...new Set(layout.lines.map((line) => line.kind))];
  const chips = graph.clusters.slice(0, MAX_CLUSTER_CHIPS);
  const unlisted = graph.clusters.length - chips.length;
  const hasLegend = chips.length > 0 || plain || venue || kinds.length > 0;
  const shown = active === null ? undefined : layout.bubbles.find((bubble) => bubble.id === active);
  const summary = label ?? `Holder map: ${count(layout.bubbles.length, 'holder')}${graph.clusters.length > 0 ? `, ${count(graph.clusters.length, 'cluster')}` : ''}`;

  const onKey = (bubble: Bubble) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect?.(bubble);
  };

  const renderLine = (line: Line, i: number): ReactElement => (
    <line
      key={`${line.a}|${line.b}|${line.kind}|${i}`}
      className="hhm-line"
      x1={line.x1}
      y1={line.y1}
      x2={line.x2}
      y2={line.y2}
      strokeDasharray={LINE_KINDS[line.kind]?.dash}
      style={line.cluster === undefined ? undefined : { stroke: clusterColor(line.cluster) }}
      data-kind={line.kind}
      data-dim={focused !== null && line.cluster !== focused ? '' : undefined}
    />
  );

  const renderBubble = (bubble: Bubble): ReactElement => {
    const tone = toneOf(bubble);
    const text = bubble.r >= LABEL_RADIUS ? share(bubble.pct) : null;
    return (
      <g
        key={bubble.id}
        className="hhm-bubble"
        transform={`translate(${bubble.x} ${bubble.y})`}
        data-id={bubble.id}
        data-active={active === bubble.id ? '' : undefined}
        data-dim={focused !== null && bubble.cluster !== focused ? '' : undefined}
        data-select={onSelect ? '' : undefined}
        onMouseEnter={() => setActive(bubble.id)}
        onMouseLeave={() => setActive((current) => (current === bubble.id ? null : current))}
        onClick={() => {
          setActive(bubble.id);
          onSelect?.(bubble);
        }}
        {...(onSelect
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': describe(bubble),
              onFocus: () => setActive(bubble.id),
              onBlur: () => setActive((current) => (current === bubble.id ? null : current)),
              onKeyDown: onKey(bubble),
            }
          : {})}
      >
        <circle className="hhm-hit" r={Math.max(bubble.r, HIT_RADIUS)} />
        <circle
          className="hhm-mark"
          r={bubble.r}
          style={tone.look === 'venue' ? undefined : { fill: tone.fill }}
          data-venue={tone.look === 'venue' ? '' : undefined}
          data-plain={tone.look === 'plain' ? '' : undefined}
        />
        {text === null ? null : (
          <text className="hhm-label" style={{ fill: tone.ink }}>
            {text}
          </text>
        )}
      </g>
    );
  };

  const renderTip = (bubble: Bubble): ReactElement => {
    const right = bubble.x <= layout.width / 2;
    const below = bubble.y <= layout.height / 2;
    const cluster = bubble.cluster === undefined ? undefined : graph.clusters.find((entry) => entry.id === bubble.cluster);
    const place: CSSProperties = {
      ...(right ? { left: `${((bubble.x + bubble.r) / layout.width) * 100}%` } : { right: `${((layout.width - bubble.x + bubble.r) / layout.width) * 100}%` }),
      ...(below ? { top: `${(bubble.y / layout.height) * 100}%` } : { bottom: `${((layout.height - bubble.y) / layout.height) * 100}%` }),
      margin: '0 8px',
    };
    return (
      <div className="hhm-tip" role="tooltip" style={place}>
        <strong>{share(bubble.pct) ?? 'Share unknown'}</strong>
        <div className="hhm-mono">{formatAddress(bubble.id)}</div>
        <div>{bubble.label ?? typeName(bubble.type)}</div>
        {bubble.cluster === undefined ? null : (
          <div>
            <i className="hhm-swatch" style={{ background: clusterColor(bubble.cluster) }} />
            Cluster {bubble.cluster}
            {cluster ? `: ${share(cluster.pct) ?? 'share unknown'} across ${count(cluster.wallets, 'wallet')}` : ''}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={['hhm', scope, className].filter(Boolean).join(' ')} data-theme={theme} style={{ maxWidth: width, ...style }}>
      <style dangerouslySetInnerHTML={{ __html: resolved.css }} />
      {hasLegend ? (
        <div className="hhm-legend">
          {chips.map((cluster) => (
            <button
              key={cluster.id}
              type="button"
              className="hhm-chip"
              aria-pressed={focused === cluster.id}
              onClick={() => setFocus((current) => (current === cluster.id ? null : cluster.id))}
            >
              <i className="hhm-swatch" style={{ background: clusterColor(cluster.id) }} />
              Cluster {cluster.id}
              <b>{share(cluster.pct) ?? 'unknown'}</b>
              <span>{count(cluster.wallets, 'wallet')}</span>
            </button>
          ))}
          {unlisted > 0 ? <span className="hhm-key">and {count(unlisted, 'smaller cluster')}</span> : null}
          {plain ? (
            <span className="hhm-key">
              <i className="hhm-swatch" style={{ background: 'var(--hhm-holder)' }} />
              No cluster
            </span>
          ) : null}
          {venue ? (
            <span className="hhm-key">
              <i className="hhm-ring" />
              Pool, program or burn address
            </span>
          ) : null}
          {kinds.map((kind) => (
            <span key={kind} className="hhm-key" data-kind={kind}>
              <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true">
                <line className="hhm-line" x1="1" y1="4" x2="21" y2="4" strokeDasharray={LINE_KINDS[kind]?.dash} />
              </svg>
              {LINE_KINDS[kind]?.label ?? kind}
            </span>
          ))}
        </div>
      ) : null}
      {layout.bubbles.length === 0 ? (
        <div className="hhm-empty">No holders to show.</div>
      ) : (
        <div className="hhm-plot" ref={plot}>
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role={onSelect ? 'group' : 'img'} aria-label={summary}>
            <g>{layout.lines.map(renderLine)}</g>
            <g>{layout.bubbles.map(renderBubble)}</g>
          </svg>
          {shown ? renderTip(shown) : null}
        </div>
      )}
      {notes && notes.length > 0 ? (
        <ul className="hhm-notes">
          {notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}
      {table && layout.bubbles.length > 0 ? (
        <details className="hhm-table">
          <summary>{count(layout.bubbles.length, 'holder')} as a table</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Address</th>
                <th scope="col">Kind</th>
                <th scope="col">Share</th>
                <th scope="col">Cluster</th>
              </tr>
            </thead>
            <tbody>
              {layout.bubbles.map((bubble) => (
                <tr key={bubble.id}>
                  <td>{bubble.index + 1}</td>
                  <td className="hhm-mono">{bubble.id}</td>
                  <td>{bubble.label ?? typeName(bubble.type)}</td>
                  <td>{share(bubble.pct) ?? 'unknown'}</td>
                  <td>{bubble.cluster === undefined ? 'none' : `Cluster ${bubble.cluster}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}
