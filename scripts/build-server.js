// Bundles the server into a single dist/server.js.
//
// Everything is bundled except better-sqlite3, which ships a prebuilt native
// binding that can't live inside a JS bundle; vite, which the server only
// imports in dev (a dynamic import esbuild would otherwise try to pull in —
// dragging the whole dev toolchain into a production bundle); and @vercel/blob,
// whose undici dependency loads a WASM parser through require() that does not
// survive bundling. The blob SDK is imported lazily and only when a store is
// configured, so a deployment without one never resolves it at all.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  // The floor from package.json engines: the bundle has to run on the oldest
  // Node the project supports, not the newest it is built on.
  target: 'node22',
  sourcemap: true,
  external: ['better-sqlite3', 'vite', '@vercel/blob'],
  // ESM output, but bundled CJS dependencies (express and friends) still expect
  // these to exist.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module'",
      "import { fileURLToPath as __fileURLToPath } from 'node:url'",
      "import { dirname as __pathDirname } from 'node:path'",
      'const require = __createRequire(import.meta.url)',
      'const __filename = __fileURLToPath(import.meta.url)',
      'const __dirname = __pathDirname(__filename)',
    ].join('\n'),
  },
})

console.log('built dist/server.js')
