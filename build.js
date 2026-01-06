// Build script using esbuild
const esbuild = require('esbuild');
const { execSync } = require('child_process');

// Use VERSION env var first (for Docker builds), then fall back to git commit hash
let version = process.env.VERSION;
if (!version || version === 'unknown') {
  try {
    version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    console.warn('Could not get git commit hash, using "unknown"');
    version = 'unknown';
  }
}
console.log(`Building with version: ${version}`);

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
