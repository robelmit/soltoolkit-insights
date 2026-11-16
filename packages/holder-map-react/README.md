# @soltoolkit/holder-map-react

A React viewer for a token's holder map: one bubble for each holder, sized by share, coloured by cluster, with the links between them. It draws SVG from a pure layout, so a server renders the same picture a browser does. No chart library, no canvas, no dependencies besides React.

```tsx
import { HolderMap } from '@soltoolkit/holder-map-react';

// `map` is what `buildHolderMap` of @soltoolkit/holder-map returned.
export function Holders({ map }) {
  return <HolderMap graph={map.graph} notes={map.notes} />;
}
```

The graph does not have to come from `@soltoolkit/holder-map`. Anything of this shape is drawn:

```ts
const graph = {
  nodes: [
    { id: 'PoolAddress…', pct: 31.5, type: 'pool', label: 'Liquidity pool' },
    { id: 'WalletA…', pct: 12, type: 'wallet', cluster: 1 },
    { id: 'WalletB…', pct: 6.25, type: 'wallet', cluster: 1 },
    { id: 'WalletC…', pct: null, type: 'wallet' }, // share unknown
  ],
  edges: [{ a: 'WalletA…', b: 'WalletB…', kind: 'transfer' }],
  clusters: [{ id: 1, pct: 18.25, wallets: 2 }],
};
```

## Install

```bash
npm i @soltoolkit/holder-map-react
```

React 18 or newer. To see it running first, the repo has an example that serves a sample map, or one token read from an RPC endpoint: [`examples/holder-map-viewer`](../../examples/holder-map-viewer).

## What the picture says

| Mark | Meaning |
|---|---|
| A bubble | One holder. Its area grows with the holder's share. A holder whose share is unknown is drawn at the smallest size and is said to be unknown; it is never shown as zero |
| A filled colour | The cluster the holder is in. The legend names each cluster with its share and its number of wallets |
| The neutral dark (or light) tone | A cluster past the palette (see below) |
| Gray | A holder in no cluster |
| A hollow dashed ring | A pool, a program or a burn address: a place tokens sit, not a person who holds them |
| A line | A link between two holders. Solid is a transfer; each other kind has its own dash pattern, named in the legend |
| A percentage inside a bubble | The holder's share, where the bubble is large enough to hold it |

A line says what the graph says: that the token moved between two holders, or that they were in one set. It does not prove one person controls both.

Colour is never the only carrier. Every cluster is named in the legend, pointing at a bubble shows who it is, and the same data is under the map as a table with whole addresses.

## Props

| Prop | Default | |
|---|---|---|
| `graph` | required | `{ nodes, edges, clusters }`. Keep the same object between renders: the layout is worked out again when it changes |
| `notes` | none | Sentences shown under the map: what it covers and what it does not |
| `width` | `720` | The widest the viewer grows, and the width a server draws for |
| `height` | `480` | The drawing's height |
| `responsive` | `true` | In a browser, lay the map out again for the room it has, so bubbles and text keep their size in a narrow column. With `false`, the drawing made for `width` is scaled down as one picture |
| `theme` | `'auto'` | `'auto'` follows the reader's system setting; `'light'` and `'dark'` fix it |
| `colors` | the defaults | `{ light?, dark? }`, each a partial set of colours (see [Colours](#colours)) |
| `table` | `true` | The holders as a table under the map, folded until opened |
| `formatAddress` | first and last four characters | How an address is written on the map. The table always shows the whole address |
| `onSelect` | none | Called with the holder when a bubble is clicked, or chosen with Enter or Space. With it, every bubble can take keyboard focus |
| `label` | a count of holders and clusters | What a screen reader calls the picture |
| `className`, `style` | none | Passed to the outer element |

Clicking a cluster in the legend dims everything outside it; clicking it again brings the rest back. A cluster keeps its colour while it keeps its place in `graph.clusters`, so picking one repaints nothing.

## Colours

The default palette has three cluster colours, for the first three clusters in `graph.clusters` (the engine lists the largest first). Further clusters share one neutral tone and are told apart by position, the legend and the table. Three is deliberate: on a bubble map any two clusters can end up side by side, and the three defaults were checked pair by pair for readers with colour-vision deficiencies, in light and in dark. Every set of four that was tried failed that check.

To use your own colours, pass them for both modes. A cluster gets a colour of its own only when both lists have one for it:

```tsx
<HolderMap
  graph={graph}
  colors={{
    light: { clusters: ['#2a78d6', '#eb6834', '#1baf7a', '#8a5cd6'], surface: '#ffffff' },
    dark: { clusters: ['#3987e5', '#d95926', '#199e70', '#9b74e0'] },
  }}
/>
```

The full set, each with a light and a dark default (`LIGHT_COLORS`, `DARK_COLORS`):

| Name | Used for |
|---|---|
| `surface` | The background of the viewer |
| `text`, `textSecondary`, `muted` | Text, in three weights |
| `hairline` | Borders and rules |
| `clusters` | The cluster colours, in order |
| `onCluster` | The share written inside a cluster's bubble |
| `otherCluster`, `onOtherCluster` | The tone for clusters past the palette, and the text on it |
| `holder`, `onHolder` | A holder in no cluster, and the text on it |

A value must be a colour: a hex code, a name, or a function such as `rgb()`, `oklch()`, `color-mix()` or `var()`. Anything else throws, because the values are written into a style sheet.

The viewer carries its own style sheet, scoped to itself, so two viewers on one page can have different colours and nothing leaks into the host page. The class names start with `hhm-` if you want to adjust something.

## On a server

The package's main entry is marked `"use client"`, because the viewer holds state (the holder pointed at, the cluster picked). In a framework with server components, import it from any component; it is rendered on the server and made interactive in the browser, with the same markup both times.

The layout is also exported by itself, with no React and no `"use client"`, for a server component, a canvas, or an image:

```ts
import { layoutHolderMap } from '@soltoolkit/holder-map-react/layout';

const { bubbles, lines } = layoutHolderMap(graph, { width: 720, height: 480 });
// bubbles: { id, pct, type, label?, cluster?, index, x, y, r }
// lines:   { a, b, kind, x1, y1, x2, y2, cluster? }, from rim to rim
```

`layoutHolderMap` is a pure function with no randomness: the same graph and size always give the same picture. Its options are `width`, `height`, `minRadius`, `maxRadius`, `gap` (the space between two bubbles) and `linkGap` (the space kept between two joined bubbles, so the line shows). When the bubbles would cover more than half the drawing, all of them shrink by one factor, so shares still compare.

## Accessibility

- The legend names every cluster and every kind of line that is drawn.
- Each bubble has a target of at least 24 by 24 units for a pointer, however small it is drawn.
- With `onSelect`, bubbles are buttons: they take focus in the order of `graph.nodes`, show the tooltip on focus, and answer Enter and Space. Each has a spoken name with its address, kind, share and cluster.
- Without `onSelect` the picture is one image with a spoken summary, and the table carries the detail.
- The table lists every holder with its whole address, kind, share and cluster.
- Transitions are switched off for readers who ask for reduced motion.

## What it does not do

- It does not read a chain. Build the graph with [`@soltoolkit/holder-map`](../holder-map), or bring your own.
- No zoom, pan or drag. The layout is fixed for a graph and a size.
- No view over time: it draws the one graph it is given.
- It is made for the map's usual size, up to a few hundred holders. Every pair of bubbles is compared while they settle, so thousands would be slow.

## Tests

```bash
pnpm --filter @soltoolkit/holder-map-react test
```

The layout is tested as a pure function (no overlap, nothing outside the drawing, the same result every time). The viewer is tested rendered to a string, as a server would, and in a simulated browser for pointing, picking a cluster, selecting with the keyboard and resizing. The text colours are checked for contrast against every fill in both modes.

## Licence

MIT
