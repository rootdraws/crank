/**
 * build-frontend.mjs
 *
 * Build pipeline for the vanilla JS frontend.
 *
 * Bundles public/app.js → dist/app.min.js (resolves @solana/kit + src/generated/ Codama clients).
 * Copies public/index.html → dist/index.html with script path updated.
 * Copies public/config.json → dist/config.json.
 *
 * Usage:
 *   node scripts/build-frontend.mjs
 *   # Then serve dist/ in production
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const publicDir = join(root, 'public');
const distDir = join(root, 'dist');

// Ensure dist/ exists
mkdirSync(distDir, { recursive: true });

// 1. Bundle + minify app.js (resolves imports from @solana/kit + src/generated/)
console.log('Bundling app.js...');
const result = await esbuild.build({
  entryPoints: [join(publicDir, 'app.js')],
  outfile: join(distDir, 'app.min.js'),
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ['es2020'],
  format: 'iife',
  charset: 'utf8',
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.BROWSER': '"true"',
    'process.version': '""',
    'process.platform': '""',
    'process.stdout': 'null',
    'process.stderr': 'null',
    global: 'globalThis',
  },
  inject: [join(root, 'scripts', 'process-shim.mjs')],
  external: [],
});

if (result.errors.length > 0) {
  console.error('Build errors:', result.errors);
  process.exit(1);
}

const original = readFileSync(join(publicDir, 'app.js'), 'utf-8');
const minified = readFileSync(join(distDir, 'app.min.js'), 'utf-8');
const savings = ((1 - minified.length / original.length) * 100).toFixed(1);
console.log(`  ${original.length} → ${minified.length} bytes (${savings}% reduction)`);

// 2. Bundle enlist.js (Alpha Vault SDK) — only if src/enlist.js exists
const enlistEntry = join(root, 'src', 'enlist.js');
const isDev = process.argv.includes('--dev');
if (existsSync(enlistEntry)) {
  console.log('Bundling enlist.js (Alpha Vault SDK)...');
  const enlistOutDir = isDev ? publicDir : distDir;
  const enlistResult = await esbuild.build({
    entryPoints: [enlistEntry],
    outfile: join(enlistOutDir, 'enlist.bundle.js'),
    bundle: true,
    minify: !isDev,
    sourcemap: true,
    target: ['es2020'],
    format: 'iife',
    charset: 'utf8',
    define: {
      'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
      'process.env.BROWSER': '"true"',
      'process.version': '""',
      'process.platform': '""',
      'process.stdout': 'null',
      'process.stderr': 'null',
      global: 'globalThis',
    },
    inject: [join(root, 'scripts', 'process-shim.mjs')],
    external: [],
  });
  if (enlistResult.errors.length > 0) {
    console.error('Enlist build errors:', enlistResult.errors);
    process.exit(1);
  }
  console.log(`  enlist.bundle.js → ${isDev ? 'public/' : 'dist/'}`);
} else {
  console.log('Skipping enlist.js (not found at src/enlist.js)');
}

// 3. Copy index.html with updated script paths
console.log('Processing index.html...');
let html = readFileSync(join(publicDir, 'index.html'), 'utf-8');
html = html.replace('src="app.js"', 'src="app.min.js"');
writeFileSync(join(distDir, 'index.html'), html);

// 4. Copy static assets
for (const file of ['styles.css', 'monke.png']) {
  const src = join(publicDir, file);
  if (existsSync(src)) {
    copyFileSync(src, join(distDir, file));
    console.log(`Copied ${file}`);
  }
}

// 5. Generate config.json — use local config.json if present, otherwise build from config.example.json + env vars
const configPath = join(publicDir, 'config.json');
const configExamplePath = join(publicDir, 'config.example.json');
const configDest = join(distDir, 'config.json');

if (existsSync(configPath)) {
  copyFileSync(configPath, configDest);
  console.log('Copied config.json (local)');
} else if (existsSync(configExamplePath)) {
  const config = JSON.parse(readFileSync(configExamplePath, 'utf-8'));
  if (process.env.HELIUS_RPC_URL) {
    config.HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;
  }
  writeFileSync(configDest, JSON.stringify(config, null, 2) + '\n');
  console.log(`Generated config.json from config.example.json${process.env.HELIUS_RPC_URL ? ' (HELIUS_RPC_URL from env)' : ''}`);
} else {
  console.warn('WARNING: No config.json or config.example.json found — frontend will fail to load config');
}

console.log(`\nBuild complete → ${distDir}/`);
console.log('Serve with: npx serve dist');
