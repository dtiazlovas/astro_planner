import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client is only ever served by our own Express server — through Vite's
// middleware in dev, from dist/public in production — so there is no separate
// Vite dev server and no /api proxy to configure. Same origin either way.
export default defineConfig({
  plugins: [react()],
  server: {
    // Vite's middleware rejects requests whose Host header it doesn't recognise
    // (DNS-rebinding protection), so any hostname the dev server answers on has
    // to be listed. Applies to dev mode only — production serves static files
    // and never loads Vite.
    allowedHosts: ['astro-planner-vrld.onrender.com'],
  },
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
})
