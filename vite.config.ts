import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import { resolve } from 'path'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src')
    }
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Isolate face-api.js (which bundles tensorflow) into its own chunk
          // to avoid rollup parse errors on its massive minified output
          if (id.includes('face-api.js') || id.includes('tensorflow') || id.includes('@tensorflow')) {
            return 'face-api'
          }
          if (id.includes('pdfjs-dist')) {
            return 'pdfjs'
          }
        },
      },
    },
  },
});
