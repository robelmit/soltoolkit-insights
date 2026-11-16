/**
 * What a server sends: the viewer rendered to a string, with no browser.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HolderMap } from '../src/index';
import { SAMPLE, crowd } from './sample';

const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const occurrences = (text: string, part: string): number => text.split(part).length - 1;
/** The drawing alone, without the style sheet and the legend above it. */
const plot = (text: string): string => text.slice(text.indexOf('class="hhm-plot"'));

describe('HolderMap on a server', () => {
  it('draws one bubble for each holder and one line for each link', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    expect(occurrences(out, 'class="hhm-bubble"')).toBe(9);
    expect(occurrences(plot(out), '<line class="hhm-line"')).toBe(4);
    expect(out).toContain('viewBox="0 0 720 480"');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="Holder map: 9 holders, 2 clusters"');
  });

  it('renders the same markup twice', () => {
    expect(html(<HolderMap graph={SAMPLE} />)).toBe(html(<HolderMap graph={SAMPLE} />));
  });

  it('carries its own style sheet, with quotes intact', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    const scope = /class="hhm (hhm-[a-zA-Z0-9]+)"/.exec(out)?.[1];
    expect(scope).toBeDefined();
    expect(out).toContain(`<style>.${scope}{color-scheme:light;`);
    expect(out).toContain(`.${scope}[data-theme="dark"]{`);
    expect(out).toContain('"Segoe UI"');
    expect(out).not.toContain('&quot;Segoe');
  });

  it('follows the system setting unless told a mode', () => {
    expect(html(<HolderMap graph={SAMPLE} />)).toContain('data-theme="auto"');
    expect(html(<HolderMap graph={SAMPLE} theme="dark" />)).toContain('data-theme="dark"');
    expect(html(<HolderMap graph={SAMPLE} theme="light" />)).toContain('data-theme="light"');
  });

  it('colours clusters in the order the graph lists them', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    // Three members of the first cluster, two of the second; a line inside a cluster takes its colour.
    expect(occurrences(out, 'style="fill:var(--hhm-cluster-1)"')).toBe(3);
    expect(occurrences(out, 'style="fill:var(--hhm-cluster-2)"')).toBe(2);
    expect(occurrences(out, 'style="stroke:var(--hhm-cluster-1)"')).toBe(2);
    expect(occurrences(out, 'style="stroke:var(--hhm-cluster-2)"')).toBe(1);
  });

  it('never gives a cluster past the palette a colour of its own', () => {
    const out = html(<HolderMap graph={crowd(60, 5)} />);
    expect(out).toContain('fill:var(--hhm-cluster-3)');
    expect(out).not.toContain('--hhm-cluster-4)');
    expect(out).toContain('fill:var(--hhm-other)');
    expect(occurrences(out, 'class="hhm-chip"')).toBe(5);
  });

  it('uses a longer palette when the host passes one for both modes', () => {
    const five = ['#111111', '#222222', '#333333', '#444444', '#555555'];
    const out = html(<HolderMap graph={crowd(60, 5)} colors={{ light: { clusters: five }, dark: { clusters: five } }} />);
    expect(out).toContain('fill:var(--hhm-cluster-5)');
    expect(out).not.toContain('fill:var(--hhm-other)');
  });

  it('draws a pool or a burn address hollow, and a lone wallet in the neutral tone', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    expect(occurrences(out, 'data-venue=""')).toBe(2);
    expect(occurrences(out, 'data-plain=""')).toBe(2);
    expect(out).toContain('Pool, program or burn address');
    expect(out).toContain('No cluster');
  });

  it('names every kind of line it draws, and no other', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    expect(out).toContain('Transfer');
    expect(out).toContain('Bought in one bundle');
    expect(out).toContain('Sniper set');
    expect(out).not.toContain('Insider set');
    expect(out).not.toContain('Shared funder');
    expect(out).toContain('stroke-dasharray="6 3"');
    expect(out).toContain('stroke-dasharray="2 3"');
  });

  it('draws a kind it does not know as a solid line under its own name', () => {
    const graph = { ...SAMPLE, edges: [{ a: SAMPLE.nodes[1]!.id, b: SAMPLE.nodes[2]!.id, kind: 'same-deployer' }] };
    const out = html(<HolderMap graph={graph} />);
    expect(out).toContain('data-kind="same-deployer"');
    expect(out).toContain('same-deployer</span>');
    expect(out).not.toContain('stroke-dasharray="');
  });

  it('writes the share inside a bubble large enough to hold it', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    expect(out).toContain('>31.5%</text>');
    expect(out).toContain('>12.0%</text>');
    expect(out).not.toContain('>0.40%</text>');
  });

  it('lists the clusters as buttons', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    expect(occurrences(out, 'class="hhm-chip"')).toBe(2);
    expect(occurrences(out, 'aria-pressed="false"')).toBe(2);
    expect(out).toMatch(/Cluster 1<b>20\.0%<\/b><span>3 wallets<\/span>/);
    expect(out).toMatch(/Cluster 2<b>7\.00%<\/b><span>2 wallets<\/span>/);
  });

  it('sums up clusters past the eighth in one line', () => {
    const out = html(<HolderMap graph={crowd(250, 11)} />);
    expect(occurrences(out, 'class="hhm-chip"')).toBe(8);
    expect(out).toContain('and 3 smaller clusters');
  });

  it('gives the same data as a table, with whole addresses', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    expect(out).toContain('<summary>9 holders as a table</summary>');
    expect(occurrences(out, '<tr>')).toBe(10);
    expect(out).toContain('<td class="hhm-mono">Dev11111111111111111111111111111111111111111</td><td>Wallet</td><td>12.0%</td><td>Cluster 1</td>');
    expect(out).toContain('<td>Liquidity pool</td><td>31.5%</td><td>none</td>');
    expect(out).toContain('<td>Burn address</td>');
    // An unknown share is said to be unknown; it is not written as zero.
    expect(out).toContain('<td>Wallet</td><td>unknown</td><td>none</td>');
    expect(out).not.toContain('<td>0.00%</td>');
  });

  it('leaves the table out when asked', () => {
    expect(html(<HolderMap graph={SAMPLE} table={false} />)).not.toContain('<table');
  });

  it('shows the notes it is given', () => {
    const out = html(<HolderMap graph={SAMPLE} notes={['Transfers were read for 30 of 100 holders.', 'A <b>line</b> is not proof.']} />);
    expect(out).toContain('<li>Transfers were read for 30 of 100 holders.</li>');
    expect(out).toContain('<li>A &lt;b&gt;line&lt;/b&gt; is not proof.</li>');
    expect(html(<HolderMap graph={SAMPLE} />)).not.toContain('hhm-notes"');
    expect(html(<HolderMap graph={SAMPLE} notes={[]} />)).not.toContain('hhm-notes"');
  });

  it('says so when there is nothing to draw', () => {
    const out = html(<HolderMap graph={{ nodes: [], edges: [], clusters: [] }} />);
    expect(out).toContain('No holders to show.');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<table');
    expect(out).not.toContain('hhm-legend"');
  });

  it('takes a size, a class, a style and a label', () => {
    const out = html(<HolderMap graph={SAMPLE} width={320} height={300} className="mine" style={{ borderRadius: 8 }} label="Holders of EXAMPLE" />);
    expect(out).toContain('viewBox="0 0 320 300"');
    expect(out).toMatch(/class="hhm hhm-[a-zA-Z0-9]+ mine"/);
    expect(out).toContain('style="max-width:320px;border-radius:8px"');
    expect(out).toContain('aria-label="Holders of EXAMPLE"');
  });

  it('refuses a colour that would break out of the style sheet', () => {
    expect(() => html(<HolderMap graph={SAMPLE} colors={{ light: { surface: 'red}</style><script>' } }} />)).toThrow('is not a colour');
  });

  it('escapes what a graph says about a holder', () => {
    const graph = { nodes: [{ id: '<img src=x onerror=1>', pct: 40, type: '"><script>', label: '<i>pool</i>' }], edges: [], clusters: [] };
    const out = html(<HolderMap graph={graph} onSelect={() => undefined} />);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<i>pool');
  });

  it('makes each holder a button only when there is something to select', () => {
    expect(html(<HolderMap graph={SAMPLE} />)).not.toContain('role="button"');
    const out = html(<HolderMap graph={SAMPLE} onSelect={() => undefined} />);
    expect(occurrences(out, 'role="button"')).toBe(9);
    expect(occurrences(out, 'tabindex="0"')).toBe(9);
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Dev1…1111, Wallet, 12.0%, cluster 1"');
    expect(out).toContain('aria-label="Lone…2222, Wallet, share unknown"');
  });

  it('gives every bubble a target a pointer can hit', () => {
    const out = html(<HolderMap graph={SAMPLE} />);
    const radii = [...out.matchAll(/class="hhm-hit" r="([0-9.]+)"/g)].map((match) => Number(match[1]));
    expect(radii).toHaveLength(9);
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(12);
  });
});
