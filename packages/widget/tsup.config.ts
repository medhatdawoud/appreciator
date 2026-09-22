import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { widget: 'src/index.ts' },
  // `widget.js` is the IIFE for a plain <script src>; `widget.mjs` is for bundlers.
  format: ['iife', 'esm'],
  globalName: 'Appreciator',
  platform: 'browser',
  target: 'es2020',
  dts: true,
  sourcemap: true,
  minify: true,
  clean: true,
  outExtension: ({ format }) => ({ js: format === 'iife' ? '.js' : '.mjs' }),
});
