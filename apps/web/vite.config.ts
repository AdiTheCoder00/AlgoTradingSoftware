import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The dev server proxies /api and /ws to the engine so the browser sees a single
 * origin: no CORS preflights and the same relative URLs work in production,
 * where the API serves the built terminal itself.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind the loopback address explicitly: Vite's default `localhost` resolves
    // to ::1 only on some Windows hosts, which makes http://127.0.0.1:5173
    // refuse connections even though the server is up.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
