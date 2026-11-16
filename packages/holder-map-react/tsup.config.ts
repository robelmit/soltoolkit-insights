import { defineConfig } from 'tsup';

const shared = {
  format: ['esm', 'cjs'],
  dts: true,
  // The build script empties `dist` once; two builds cleaning the same folder would race.
  clean: false,
  sourcemap: true,
  target: 'es2020',
  platform: 'neutral',
  splitting: false,
  external: ['react', 'react/jsx-runtime'],
} as const;

export default defineConfig([
  {
    ...shared,
    format: [...shared.format],
    external: [...shared.external],
    entry: { index: 'src/index.ts' },
    // The viewer keeps state, so a React Server Components host has to load it as a client module.
    banner: { js: '"use client";' },
  },
  {
    ...shared,
    format: [...shared.format],
    external: [...shared.external],
    // The layout is a pure function; without the banner a server can call it.
    entry: { layout: 'src/layout.ts' },
  },
]);
