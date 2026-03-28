/**
 * build-frontend.mjs
 *
 * Build pipeline for the vanilla JS frontend.
 *
 * Usage:
 *   node scripts/build-frontend.mjs              # builds crank tribe (default)
 *   node scripts/build-frontend.mjs --tribe=gsd  # builds gsd tribe
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const publicDir = join(root, 'public');
const distDir = join(root, 'dist');
const frontendDir = join(root, 'src', 'frontend');

const { values: args } = parseArgs({
  options: {
    tribe: { type: 'string', default: 'crank' },
  },
  strict: false,
});

const tribeName = args.tribe;
const tribeDir = join(frontendDir, 'tribes', tribeName);

if (!existsSync(tribeDir)) {
  console.error(`Tribe "${tribeName}" not found at ${tribeDir}`);
  process.exit(1);
}

const tribeConfig = JSON.parse(readFileSync(join(tribeDir, 'tribe.json'), 'utf-8'));
const branding = existsSync(join(tribeDir, 'branding.json'))
  ? JSON.parse(readFileSync(join(tribeDir, 'branding.json'), 'utf-8'))
  : { title: 'crank.money' };

console.log(`Building tribe: ${tribeName} (plugins: ${tribeConfig.plugins.join(', ')})`);

mkdirSync(distDir, { recursive: true });

// 1. Generate tribe-specific entry point
const pluginImports = tribeConfig.plugins.map(p => {
  const pluginDir = join(frontendDir, 'plugins', p);
  if (!existsSync(pluginDir)) {
    console.error(`Plugin "${p}" not found at ${pluginDir}`);
    process.exit(1);
  }
  return `import './plugins/${p}/index.js';`;
}).join('\n');

const entrySource = readFileSync(join(frontendDir, 'app.js'), 'utf-8');

const hasRankMonke = tribeConfig.plugins.includes('rank-monke');
let tribeEntry;

if (hasRankMonke) {
  tribeEntry = entrySource;
} else {
  tribeEntry = entrySource
    .replace(
      /import \{[^}]+\} from '\.\/plugins\/rank-monke\/index\.js';/,
      `import { showSubPage, ensureBurnFireRunning } from './plugins/${tribeConfig.plugins.find(p => p.startsWith('rank-')) || 'rank-generic'}/index.js';
const initBurnFireCanvas = () => {}, renderMonkeList = () => {}, renderRoster = () => {}, renderGlobalStats = () => {};
const handleFeedMonke = () => {}, handleFeedGoose = () => {}, handleClaimAll = () => {}, handleMonkeBurnLookup = () => {};
const handleMintPegged = () => {}, handleRedeemPegged = () => {}, updatePeggedEstimates = () => {};`
    );
}

if (!tribeEntry.includes(pluginImports)) {
  const firstImport = tribeEntry.indexOf('import ');
  tribeEntry = pluginImports + '\n' + tribeEntry;
}

const tribeEntryPath = join(frontendDir, '.tribe-entry.js');
writeFileSync(tribeEntryPath, tribeEntry);

// 2. Bundle
console.log('Bundling app.js...');
const result = await esbuild.build({
  entryPoints: [tribeEntryPath],
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

const minified = readFileSync(join(distDir, 'app.min.js'), 'utf-8');
console.log(`  Bundle: ${minified.length} bytes`);

// 3. Process HTML
console.log('Processing index.html...');
let html = readFileSync(join(publicDir, 'index.html'), 'utf-8');
html = html.replace('src="app.js"', 'src="app.min.js"');

if (branding.title) {
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${branding.title}</title>`);
}

if (!tribeConfig.mobileLocked) {
  html = html.replace(/\s*<!-- MOBILE GATE.*?<\/script>\s*/s, '\n\n');
}

if (tribeConfig.singleToken && Array.isArray(tribeConfig.pages)) {
  const pageMap = { trade: 'page-trade', positions: 'page-positions', rank: 'page-rank', ops: 'page-ops', recon: 'page-recon' };
  const pageIndexMap = { trade: 0, positions: 1, rank: 2, ops: 3, recon: 4 };

  function stripPageDiv(src, pageId) {
    const idStr = `id="${pageId}"`;
    let openPos = -1;
    let search = 0;
    while (true) {
      const idx = src.indexOf('<div', search);
      if (idx === -1) return src;
      const tagEnd = src.indexOf('>', idx);
      if (tagEnd === -1) return src;
      if (src.substring(idx, tagEnd + 1).includes(idStr)) { openPos = idx; break; }
      search = tagEnd + 1;
    }

    let stripStart = openPos;
    const beforeChunk = src.substring(Math.max(0, openPos - 500), openPos);
    const commentIdx = beforeChunk.lastIndexOf('<!--');
    if (commentIdx !== -1) {
      const lineStart = beforeChunk.lastIndexOf('\n', commentIdx);
      stripStart = openPos - (beforeChunk.length - (lineStart !== -1 ? lineStart : commentIdx));
    }

    let depth = 0;
    let pos = openPos;
    while (pos < src.length) {
      const nextOpen = src.indexOf('<div', pos);
      const nextClose = src.indexOf('</div>', pos);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) {
          const endPos = nextClose + 6;
          const afterNewline = src.indexOf('\n', endPos);
          const cutEnd = afterNewline !== -1 ? afterNewline + 1 : endPos;
          return src.substring(0, stripStart) + src.substring(cutEnd);
        }
        pos = nextClose + 6;
      }
    }
    return src;
  }

  for (const [name, id] of Object.entries(pageMap)) {
    if (!tribeConfig.pages.includes(name)) {
      html = stripPageDiv(html, id);
    }
  }

  for (const [name, idx] of Object.entries(pageIndexMap)) {
    if (!tribeConfig.pages.includes(name)) {
      const regex = new RegExp(`\\s*<button class="mobile-nav-tab[^"]*" data-page="${idx}"[\\s\\S]*?</button>`, 'g');
      html = html.replace(regex, '');
    }
  }

  console.log(`  Stripped pages to: [${tribeConfig.pages.join(', ')}]`);
}

writeFileSync(join(distDir, 'index.html'), html);

// 4. Concatenate CSS (base + tribe theme)
let css = readFileSync(join(publicDir, 'styles.css'), 'utf-8');
const themeCssPath = join(tribeDir, 'theme.css');
if (existsSync(themeCssPath)) {
  const themeCss = readFileSync(themeCssPath, 'utf-8');
  if (themeCss.trim().length > 0 && !themeCss.startsWith('/*')) {
    css += '\n\n/* ---- Tribe theme overrides ---- */\n' + themeCss;
  }
}
writeFileSync(join(distDir, 'styles.css'), css);
console.log(`Wrote styles.css${existsSync(themeCssPath) ? ' + tribe theme' : ''}`);

// 5. Copy static assets
for (const file of ['monke.png', 'filler.svg', 'gate.js', 'pegged-logo.png', 'pegged-metadata.json', 'crank-token.png']) {
  const src = join(publicDir, file);
  if (existsSync(src)) {
    copyFileSync(src, join(distDir, file));
  }
}

// 6. Config: tribe config → public config → config.example.json
const tribeConfigJsonPath = join(tribeDir, 'config.json');
const configPath = join(publicDir, 'config.json');
const configExamplePath = join(publicDir, 'config.example.json');
const configDest = join(distDir, 'config.json');

if (existsSync(tribeConfigJsonPath) && tribeName !== 'crank') {
  const runtimeConfig = JSON.parse(readFileSync(tribeConfigJsonPath, 'utf-8'));
  if (tribeConfig.singleToken) runtimeConfig.SINGLE_TOKEN = true;
  if (Array.isArray(tribeConfig.pages)) runtimeConfig.PAGES = tribeConfig.pages;
  writeFileSync(configDest, JSON.stringify(runtimeConfig, null, 2) + '\n');
  console.log(`Wrote config.json (tribe: ${tribeName}, singleToken: ${!!tribeConfig.singleToken})`);
} else if (existsSync(configPath)) {
  copyFileSync(configPath, configDest);
  console.log('Copied config.json (local)');
} else if (existsSync(configExamplePath)) {
  const config = JSON.parse(readFileSync(configExamplePath, 'utf-8'));
  if (process.env.HELIUS_RPC_URL) config.HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;
  writeFileSync(configDest, JSON.stringify(config, null, 2) + '\n');
  console.log('Generated config.json from config.example.json');
} else {
  console.warn('WARNING: No config.json found');
}

// Cleanup temp entry
import { unlinkSync } from 'fs';
try { unlinkSync(tribeEntryPath); } catch {}

console.log(`\nBuild complete (tribe: ${tribeName}) → ${distDir}/`);
console.log('Serve with: npx serve dist');
