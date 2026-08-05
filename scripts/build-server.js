// Bundles the server into a single dist/server.js.
//
// Everything is bundled except better-sqlite3, which ships a prebuilt native
// binding that can't live inside a JS bundle, and vite, which the server only
// imports in dev (a dynamic import esbuild would otherwise try to pull in —
// dragging the whole dev toolchain into a production bundle).
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  sourcemap: true,
  external: ['better-sqlite3', 'vite'],
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
