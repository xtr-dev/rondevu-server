// Build script using esbuild
const esbuild = require('esbuild');
const { execSync } = require('child_process');

// Get git commit hash
let version = 'unknown';
try {
  version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch (err) {
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
    'hono'
  ],
  sourcemap: true,
  define: {
    'process.env.RONDEVU_VERSION': JSON.stringify(version)
  }
}).catch(() => process.exit(1));
