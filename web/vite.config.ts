import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const hub = process.env.HUB_DEV_URL ?? 'http://localhost:8080';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist', emptyOutDir: true,
    // React and the router change rarely: in their own file they stay cached in browsers across hub updates
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] } } },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': hub,
      '/auth': hub,
      '/oauth': hub,
      '/mcp': hub,
      '/icons': hub,
      '/upload': hub,
      '/.well-known': hub,
      '^/skills/[^/]+/v\\d+\\.tgz': hub,
    },
  },
});
