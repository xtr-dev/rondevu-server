// Build script using esbuild
const esbuild = require('esbuild');
const { execSync } = require('child_process');

// Use git commit hash for version (like Cloudflare Workers deployment)
let version = 'unknown';
try {
  version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch (e) {
  console.warn('Could not get git commit hash, using "unknown"');
}

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
