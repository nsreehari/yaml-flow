import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'step-machine/index': 'src/step-machine/index.ts',
    'event-graph/index': 'src/event-graph/index.ts',
    'stores/index': 'src/stores/index.ts',
    'stores/memory': 'src/stores/memory.ts',
    'stores/localStorage': 'src/stores/localStorage.ts',
    'batch/index': 'src/batch/index.ts',
    'config/index': 'src/config/index.ts',
    'stores/file': 'src/stores/file.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
});
