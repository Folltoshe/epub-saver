import Path from 'node:path'
import { defineConfig } from 'vite'

const SourceRoot = Path.join(process.cwd(), 'src')

export default defineConfig({
  build: {
    outDir: 'dist',
    lib: {
      entry: Path.join(SourceRoot, 'index.ts'),
      name: 'EpubSaver',
      formats: ['cjs', 'iife', 'es'],
      fileName: 'epub-saver',
    },
    minify: false,
  },
})
