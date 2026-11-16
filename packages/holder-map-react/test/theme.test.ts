import { describe, expect, it } from 'vitest';
import { BASE_CSS, DARK_COLORS, LIGHT_COLORS, resolveTheme, type HolderMapColors } from '../src/theme';

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const value = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the default colours', () => {
  const modes: [string, HolderMapColors][] = [['light', LIGHT_COLORS], ['dark', DARK_COLORS]];

  it.each(modes)('%s: text reads on the surface', (_, colors) => {
    expect(contrast(colors.text, colors.surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(colors.textSecondary, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(modes)('%s: a share written inside a bubble reads on every fill', (_, colors) => {
    for (const fill of colors.clusters) expect(contrast(colors.onCluster, fill), fill).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.onOtherCluster, colors.otherCluster)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.onHolder, colors.holder)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('has the same number of cluster colours in both modes', () => {
    expect(LIGHT_COLORS.clusters).toHaveLength(DARK_COLORS.clusters.length);
  });
});

describe('resolveTheme', () => {
  it('writes both modes under the viewer’s own class', () => {
    const { css, clusterColors } = resolveTheme('hhm-a1');
    expect(clusterColors).toBe(3);
    expect(css).toContain('.hhm-a1{color-scheme:light;--hhm-surface:#fcfcfb;');
    expect(css).toContain('.hhm-a1[data-theme="dark"]{color-scheme:dark;--hhm-surface:#1a1a19;');
    expect(css).toContain('@media (prefers-color-scheme:dark){.hhm-a1[data-theme="auto"]{color-scheme:dark;');
    expect(css).toContain('--hhm-cluster-3:#1baf7a');
    expect(css).not.toContain('--hhm-cluster-4');
    expect(css.endsWith(BASE_CSS)).toBe(true);
  });

  it('takes a host’s colours for one mode and keeps the rest', () => {
    const { css, clusterColors } = resolveTheme('hhm-a1', { light: { surface: 'transparent', text: 'rgb(10 10 10 / 90%)', muted: 'var(--brand-muted)' } });
    expect(clusterColors).toBe(3);
    expect(css).toContain('.hhm-a1{color-scheme:light;--hhm-surface:transparent;--hhm-text:rgb(10 10 10 / 90%);');
    expect(css).toContain('--hhm-muted:var(--brand-muted)');
    expect(css).toContain('[data-theme="dark"]{color-scheme:dark;--hhm-surface:#1a1a19;');
  });

  it('colours as many clusters as the shorter list has colours', () => {
    const five = ['#111111', '#222222', '#333333', '#444444', '#555555'];
    expect(resolveTheme('s', { light: { clusters: five }, dark: { clusters: five } }).clusterColors).toBe(5);
    const mixed = resolveTheme('s', { light: { clusters: five } });
    expect(mixed.clusterColors).toBe(3);
    expect(mixed.css).not.toContain('--hhm-cluster-4');
    expect(resolveTheme('s', { light: { clusters: [] } }).clusterColors).toBe(0);
  });

  it('refuses a value that is not a colour', () => {
    for (const value of ['red;}body{display:none', '#fff}', 'url(//example.test/x.png)', 'expression(alert(1))', '#fff /* x */', '', '<style>', 'image-set(a)']) {
      expect(() => resolveTheme('s', { light: { surface: value } }), value).toThrow('colors.light.surface is not a colour');
    }
    expect(() => resolveTheme('s', { dark: { clusters: ['#fff', 'x;y'] } })).toThrow('colors.dark.clusters[1] is not a colour');
    expect(() => resolveTheme('s', { dark: { text: 5 as unknown as string } })).toThrow('colors.dark.text is not a colour');
  });

  it('refuses a scope that is not a class name', () => {
    for (const scope of ['', '1a', 'a b', 'a{}', 'a,b']) expect(() => resolveTheme(scope), scope).toThrow('Not a class name');
  });
});
