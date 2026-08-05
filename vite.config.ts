import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client is only ever served by our own Express server — through Vite's
// middleware in dev, from dist/public in production — so there is no separate
// Vite dev server and no /api proxy to configure. Same origin either way.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
})
