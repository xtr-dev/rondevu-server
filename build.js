// Build script using esbuild
const esbuild = require('esbuild');
const pkg = require('./package.json');

// Use package.json version
const version = pkg.version || 'unknown';

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
    'hono',
    'mysql2',
    'mysql2/promise',
    'pg'
  ],
  sourcemap: true,
  define: {
    'RONDEVU_VERSION': JSON.stringify(version)
  }
}).catch(() => process.exit(1));
