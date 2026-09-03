import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

export default defineConfig({
  mode: process.env.NODE_ENV,
  resolve: {
    dedupe: ['yjs'],
    alias: {
      '@sheet-engine/core': path.resolve(__dirname, 'src/sheet-engine/core'),
      '@sheet-engine/react': path.resolve(__dirname, 'src/sheet-engine/react'),
      '@sheet-engine/formula-parser': path.resolve(
        __dirname,
        'src/sheet-engine/formula-parser',
      ),
    },
  },
  // The dsheet worker builds as a separate self-contained graph (default iife
  // format, library externals below do not apply), so exceljs/luckyexcel are
  // bundled into the worker blob — a blob worker cannot resolve bare imports.
  // The worker graph must stay single-chunk: no dynamic imports anywhere in
  // the pipeline, or iife worker output breaks (Vercel demo build).
  build: {
    lib: {
      name: 'dsheet',
      entry: {
        index: path.resolve(__dirname, './src/index.ts'),
        constants: path.resolve(__dirname, './src/constants.ts'),
        formula: path.resolve(__dirname, './src/formula.ts'),
        persistence: path.resolve(__dirname, './src/persistence.ts'),
      },
      formats: ['es'],
      fileName: (format, entryName) =>
        entryName === 'index' ? `index.${format}.js` : `${entryName}.js`,
    },
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      external: [
        'react',
        'react-dom',
        // Subpath imports (react/jsx-runtime etc.) must stay external too —
        // inlining them breaks under React 19 (React 18-only internals).
        /^react\//,
        /^react-dom\//,
        'yjs',
        /^yjs\//,
        'y-indexeddb',
        'y-protocols',
        'exceljs',
        'xlsx',
        'xlsx-js-style',
        'katex',
        'lodash',
        'papaparse',
        'luckyexcel',
        'immer',
        'dayjs',
        '@fileverse/ui',
        '@fileverse/ens',
        '@fileverse-dev/formulajs',
        '@fileverse-dev/dsheets-templates',
        '@tippyjs/react',
        'viem',
        'viem/chains',
        'viem/ens',
      ],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
        chunkFileNames: '[name]-[hash].js',
      },
    },
    sourcemap: false,
    emptyOutDir: true,
  },
  plugins: [
    react(),
    dts({
      tsconfigPath: './tsconfig.json',
    }),
  ],
  define: {
    'process:env.NODE_ENV': JSON.stringify('production'),
  },
});
