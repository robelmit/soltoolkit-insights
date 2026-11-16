/**
 * The page the example serves: it fetches the map as JSON and hands it to the viewer.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { HolderMap, type HolderMapGraph, type HolderMapNode, type HolderMapTheme } from '@soltoolkit/holder-map-react';

interface Served {
  readonly title: string;
  readonly graph: HolderMapGraph;
  readonly notes: readonly string[];
}

const THEMES: readonly HolderMapTheme[] = ['auto', 'light', 'dark'];

function Page(): ReactElement {
  const [served, setServed] = useState<Served | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [theme, setTheme] = useState<HolderMapTheme>('auto');
  const [selected, setSelected] = useState<HolderMapNode | null>(null);

  useEffect(() => {
    fetch('/map.json')
      .then((response) => (response.ok ? (response.json() as Promise<Served>) : Promise.reject(new Error(`/map.json answered ${response.status}`))))
      .then(setServed, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  if (failure) return <p>{failure}</p>;
  if (!served) return <p>Reading the map…</p>;
  return (
    <main>
      <header>
        <h1>{served.title}</h1>
        <div role="group" aria-label="Theme">
          {THEMES.map((name) => (
            <button key={name} type="button" aria-pressed={theme === name} onClick={() => setTheme(name)}>
              {name}
            </button>
          ))}
        </div>
      </header>
      <HolderMap graph={served.graph} notes={served.notes} theme={theme} onSelect={setSelected} />
      <p id="selected">{selected ? `Selected: ${selected.id}` : 'Click a holder to select it.'}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
