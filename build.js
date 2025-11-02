// Build script using esbuild
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/index.js',
  format: 'cjs',
  external: [
    'better-sqlite3',
    '@hono/node-server',
    'hono'
  ],
  sourcemap: true,
}).catch(() => process.exit(1));
