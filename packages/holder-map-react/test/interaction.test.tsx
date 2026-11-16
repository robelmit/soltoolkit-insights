// @vitest-environment jsdom
/**
 * What a reader can do with the viewer: point at a holder, pick a cluster, select a holder.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HolderMap, type HolderMapNode } from '../src/index';
import { SAMPLE } from './sample';

afterEach(cleanup);

const DEV = 'Dev11111111111111111111111111111111111111111';
const LONE = 'Lone2222222222222222222222222222222222222222';
const POOL = 'Pool1111111111111111111111111111111111111111';

const bubble = (root: HTMLElement, id: string): Element => root.querySelector(`.hhm-bubble[data-id="${id}"]`)!;
const dimmed = (root: HTMLElement, selector: string): number => root.querySelectorAll(`${selector}[data-dim]`).length;

describe('HolderMap in a browser', () => {
  it('shows nothing over the map until a holder is pointed at', () => {
    const { container } = render(<HolderMap graph={SAMPLE} />);
    expect(container.querySelector('.hhm-tip')).toBeNull();
    expect(container.querySelectorAll('.hhm-bubble')).toHaveLength(9);
  });

  it('says who a holder is when it is pointed at, and stops when the pointer leaves', () => {
    const { container } = render(<HolderMap graph={SAMPLE} />);
    fireEvent.mouseEnter(bubble(container, DEV));
    const tip = container.querySelector('.hhm-tip')!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.querySelector('strong')!.textContent).toBe('12.0%');
    expect(tip.textContent).toContain('Dev1…1111');
    expect(tip.textContent).toContain('Wallet');
    expect(tip.textContent).toContain('Cluster 1: 20.0% across 3 wallets');
    expect(bubble(container, DEV).hasAttribute('data-active')).toBe(true);

    fireEvent.mouseLeave(bubble(container, DEV));
    expect(container.querySelector('.hhm-tip')).toBeNull();
    expect(bubble(container, DEV).hasAttribute('data-active')).toBe(false);
  });

  it('says a share is unknown, and names a labelled holder by its label', () => {
    const { container } = render(<HolderMap graph={SAMPLE} />);
    fireEvent.mouseEnter(bubble(container, LONE));
    expect(container.querySelector('.hhm-tip strong')!.textContent).toBe('Share unknown');
    expect(container.querySelector('.hhm-tip')!.textContent).not.toContain('Cluster');
    fireEvent.mouseEnter(bubble(container, POOL));
    expect(container.querySelector('.hhm-tip')!.textContent).toContain('Liquidity pool');
    expect(container.querySelectorAll('.hhm-tip')).toHaveLength(1);
  });

  it('keeps the tooltip inside the map, on the side with room', () => {
    const { container } = render(<HolderMap graph={SAMPLE} />);
    for (const element of container.querySelectorAll('.hhm-bubble')) {
      fireEvent.mouseEnter(element);
      const style = (container.querySelector('.hhm-tip') as HTMLElement).style;
      const horizontal = style.left || style.right;
      const vertical = style.top || style.bottom;
      expect(Boolean(style.left) !== Boolean(style.right)).toBe(true);
      expect(Boolean(style.top) !== Boolean(style.bottom)).toBe(true);
      expect(Number.parseFloat(horizontal)).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(horizontal)).toBeLessThanOrEqual(62);
      expect(Number.parseFloat(vertical)).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(vertical)).toBeLessThanOrEqual(50);
    }
  });

  it('uses the host’s way of writing an address on the map, and the whole address in the table', () => {
    const { container } = render(<HolderMap graph={SAMPLE} formatAddress={(address) => `@${address.slice(0, 3)}`} />);
    fireEvent.mouseEnter(bubble(container, DEV));
    expect(container.querySelector('.hhm-tip .hhm-mono')!.textContent).toBe('@Dev');
    expect(container.querySelector('.hhm-table')!.textContent).toContain(DEV);
  });

  it('dims everything outside the cluster that is picked, and brings it back', () => {
    const { container, getByRole } = render(<HolderMap graph={SAMPLE} />);
    const first = getByRole('button', { name: /Cluster 1/ });
    const second = getByRole('button', { name: /Cluster 2/ });
    expect(dimmed(container, '.hhm-bubble')).toBe(0);

    fireEvent.click(first);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(second.getAttribute('aria-pressed')).toBe('false');
    expect(dimmed(container, '.hhm-bubble')).toBe(6);
    expect(bubble(container, DEV).hasAttribute('data-dim')).toBe(false);
    // Of four lines, the two inside the cluster stay.
    expect(dimmed(container, '.hhm-plot .hhm-line')).toBe(2);

    fireEvent.click(second);
    expect(first.getAttribute('aria-pressed')).toBe('false');
    expect(second.getAttribute('aria-pressed')).toBe('true');
    expect(dimmed(container, '.hhm-bubble')).toBe(7);
    expect(dimmed(container, '.hhm-plot .hhm-line')).toBe(3);

    fireEvent.click(second);
    expect(second.getAttribute('aria-pressed')).toBe('false');
    expect(dimmed(container, '.hhm-bubble')).toBe(0);
    expect(dimmed(container, '.hhm-plot .hhm-line')).toBe(0);
  });

  it('does not repaint a cluster when another is picked', () => {
    const { container, getByRole } = render(<HolderMap graph={SAMPLE} />);
    const fills = (): (string | null)[] => [...container.querySelectorAll('.hhm-mark')].map((mark) => mark.getAttribute('style'));
    const before = fills();
    fireEvent.click(getByRole('button', { name: /Cluster 2/ }));
    expect(fills()).toEqual(before);
  });

  it('forgets a picked cluster the new graph does not have', () => {
    const { container, getByRole, rerender } = render(<HolderMap graph={SAMPLE} />);
    fireEvent.click(getByRole('button', { name: /Cluster 2/ }));
    expect(dimmed(container, '.hhm-bubble')).toBe(7);
    const next = { nodes: SAMPLE.nodes.filter((node) => node.cluster !== 2), edges: [], clusters: SAMPLE.clusters.slice(0, 1) };
    rerender(<HolderMap graph={next} />);
    expect(dimmed(container, '.hhm-bubble')).toBe(0);
    expect(container.querySelectorAll('.hhm-chip[aria-pressed="true"]')).toHaveLength(0);
  });

  it('hands the holder to the host on a click, on Enter and on Space', () => {
    const onSelect = vi.fn<(holder: HolderMapNode) => void>();
    const { container } = render(<HolderMap graph={SAMPLE} onSelect={onSelect} />);
    const target = bubble(container, DEV);
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: 'Enter' });
    fireEvent.keyDown(target, { key: ' ' });
    fireEvent.keyDown(target, { key: 'a' });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ id: DEV, pct: 12, type: 'wallet', cluster: 1 });
  });

  it('shows the tooltip for the holder that has keyboard focus', () => {
    const { container } = render(<HolderMap graph={SAMPLE} onSelect={() => undefined} />);
    fireEvent.focus(bubble(container, DEV));
    expect(container.querySelector('.hhm-tip strong')!.textContent).toBe('12.0%');
    fireEvent.blur(bubble(container, DEV));
    expect(container.querySelector('.hhm-tip')).toBeNull();
  });

  it('gives two viewers on one page their own colours', () => {
    const { container } = render(
      <>
        <HolderMap graph={SAMPLE} colors={{ light: { surface: '#ffffff' } }} />
        <HolderMap graph={SAMPLE} colors={{ light: { surface: '#eeeeee' } }} />
      </>,
    );
    const roots = [...container.querySelectorAll('.hhm')];
    const scopes = roots.map((root) => [...root.classList].find((name) => name !== 'hhm')!);
    expect(new Set(scopes).size).toBe(2);
    expect(roots[0]!.querySelector('style')!.textContent).toContain(`.${scopes[0]}{color-scheme:light;--hhm-surface:#ffffff;`);
    expect(roots[1]!.querySelector('style')!.textContent).toContain(`.${scopes[1]}{color-scheme:light;--hhm-surface:#eeeeee;`);
  });

  describe('in a column narrower than the drawing', () => {
    /** Stands in for the browser's observer: the test says how much room the map has. */
    class Observer {
      static all: Observer[] = [];
      disconnected = false;
      constructor(private readonly report: (entries: { contentRect: { width: number } }[]) => void) {
        Observer.all.push(this);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        this.disconnected = true;
      }
      room(width: number): void {
        act(() => this.report([{ contentRect: { width } }]));
      }
    }
    const viewBox = (root: HTMLElement): string | null => root.querySelector('.hhm-plot svg')!.getAttribute('viewBox');

    beforeEach(() => {
      Observer.all = [];
      vi.stubGlobal('ResizeObserver', Observer);
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('lays the map out again for the room it has, and keeps every holder inside', () => {
      const { container } = render(<HolderMap graph={SAMPLE} />);
      expect(viewBox(container)).toBe('0 0 720 480');
      Observer.all[0]!.room(340.6);
      expect(viewBox(container)).toBe('0 0 340 480');
      for (const holder of container.querySelectorAll('.hhm-bubble')) {
        const x = Number(/translate\(([0-9.]+) /.exec(holder.getAttribute('transform')!)![1]);
        const r = Number(holder.querySelector('.hhm-mark')!.getAttribute('r'));
        expect(x - r).toBeGreaterThanOrEqual(0);
        expect(x + r).toBeLessThanOrEqual(340);
      }
      expect((container.querySelector('.hhm') as HTMLElement).style.maxWidth).toBe('720px');
    });

    it('waits for a resize to stop before drawing again, and never grows past its width', () => {
      const { container } = render(<HolderMap graph={SAMPLE} width={600} />);
      const observer = Observer.all[0]!;
      observer.room(340);
      observer.room(400);
      observer.room(500);
      expect(viewBox(container)).toBe('0 0 340 480');
      act(() => void vi.advanceTimersByTime(150));
      expect(viewBox(container)).toBe('0 0 500 480');
      observer.room(1200);
      act(() => void vi.advanceTimersByTime(150));
      expect(viewBox(container)).toBe('0 0 600 480');
    });

    it('ignores a room of nothing, as a hidden tab reports', () => {
      const { container } = render(<HolderMap graph={SAMPLE} />);
      Observer.all[0]!.room(0);
      expect(viewBox(container)).toBe('0 0 720 480');
    });

    it('stops watching when it leaves the page', () => {
      const { unmount } = render(<HolderMap graph={SAMPLE} />);
      Observer.all[0]!.room(340);
      Observer.all[0]!.room(400);
      unmount();
      expect(Observer.all[0]!.disconnected).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('scales one drawing instead when told not to respond', () => {
      const { container } = render(<HolderMap graph={SAMPLE} responsive={false} />);
      expect(Observer.all).toHaveLength(0);
      expect(viewBox(container)).toBe('0 0 720 480');
    });
  });

  it('opens the table from the keyboard like any details element', () => {
    const { container } = render(<HolderMap graph={SAMPLE} />);
    const details = container.querySelector('details.hhm-table') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll('tbody tr')).toHaveLength(9);
  });
});
