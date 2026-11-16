/**
 * A token's holder map in a browser.
 *
 *   pnpm build                                              (once: the example runs the built packages)
 *   pnpm --filter example-holder-map-viewer start           sample data, no network
 *   pnpm --filter example-holder-map-viewer start <mint>    one token, read from an RPC endpoint
 *
 * Then open http://127.0.0.1:4173. The engine (`@soltoolkit/holder-map`) builds
 * the graph here in Node; the page draws it with `@soltoolkit/holder-map-react`.
 * Reads only: nothing is signed and nothing is sent.
 *
 * SOLANA_RPC_URL   the endpoint (default: the public mainnet one). Whether an
 *                  endpoint serves a token's holders depends on the endpoint
 *                  and on how widely the token is held; when it does not, the
 *                  reasons are printed.
 * WALK             how many holders' transactions are read for transfers (default 10)
 * MAX_CALLS        the most calls the transfer walk may make (default 120)
 * PORT             default 4173
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { HoldersUnavailable, buildHolderMap, type HolderGraph } from '@soltoolkit/holder-map';
import { createRpc, isAddress } from '@soltoolkit/rpc';
import { SAMPLE_GRAPH, SAMPLE_NOTES } from './sample';

interface Served {
  readonly title: string;
  readonly graph: HolderGraph;
  readonly notes: readonly string[];
}

function whole(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} must be a whole number, got ${raw}`);
    process.exit(1);
  }
  return value;
}

async function read(mint: string | undefined): Promise<Served> {
  if (mint === undefined) return { title: 'Holder map: sample token', graph: SAMPLE_GRAPH, notes: SAMPLE_NOTES };
  if (!isAddress(mint)) {
    console.error('usage: pnpm --filter example-holder-map-viewer start [mint]');
    process.exit(1);
  }
  const rpc = createRpc({ url: process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com', requestsPerSecond: 2, retries: 1 });
  console.log(`Reading the holders of ${mint} …`);
  try {
    const map = await buildHolderMap(rpc, mint, { walk: whole('WALK', 10), links: { maxCalls: whole('MAX_CALLS', 120), deadlineMs: 120_000 } });
    if (!map) {
      console.error(`${mint} is not a token mint.`);
      process.exit(1);
    }
    return { title: `Holder map: ${mint}`, graph: map.graph, notes: map.notes };
  } catch (error) {
    if (!(error instanceof HoldersUnavailable)) throw error;
    console.error('The endpoint did not serve the holders:');
    for (const reason of error.reasons) console.error(`  ${reason}`);
    process.exit(1);
  }
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Holder map</title>
<style>
  :root { color-scheme: light dark; --page: #f4f4f1; --ink: #0b0b0b; }
  @media (prefers-color-scheme: dark) { :root[data-theme="auto"], :root:not([data-theme]) { --page: #111110; --ink: #f0efec; } }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; --page: #111110; --ink: #f0efec; }
  body { margin: 0; padding: 24px 16px; background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
  header button { font: inherit; padding: 2px 10px; }
  header button[aria-pressed="true"] { font-weight: 600; }
  .hhm { border-radius: 10px; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

const served = await read(process.argv[2]);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./page.tsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const script = bundle.outputFiles[0]!.text;

const pages: Readonly<Record<string, readonly [type: string, body: string]>> = {
  '/': ['text/html; charset=utf-8', HTML],
  '/app.js': ['text/javascript; charset=utf-8', script],
  '/map.json': ['application/json; charset=utf-8', JSON.stringify(served)],
};

const port = whole('PORT', 4173);
createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  const page = pages[path];
  if (!page || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': page[0], 'cache-control': 'no-store' }).end(request.method === 'HEAD' ? undefined : page[1]);
}).listen(port, '127.0.0.1', () => {
  const { nodes, edges, clusters } = served.graph;
  console.log(`${nodes.length} holders, ${edges.length} lines, ${clusters.length} clusters`);
  console.log(`Open http://127.0.0.1:${port}`);
});
