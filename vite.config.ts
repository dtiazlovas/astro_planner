import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client is only ever served by our own Express server — through Vite's
// middleware in dev, from dist/public in production — so there is no separate
// Vite dev server and no /api proxy to configure. Same origin either way.
// Bind mounts on Windows drives don't deliver inotify events into a Linux
// container, so the watcher never fires and HMR goes silent. Polling is the only
// thing that crosses that boundary, and it costs CPU continuously — so it stays
// opt-in, switched on by the env var compose.yaml sets.
const usePolling = process.env.CHOKIDAR_USEPOLLING === 'true'

export default defineConfig({
  plugins: [react()],
  ...(usePolling ? { server: { watch: { usePolling: true, interval: 300 } } } : {}),
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
  },
})
