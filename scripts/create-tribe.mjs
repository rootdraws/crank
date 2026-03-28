#!/usr/bin/env node
/**
 * create-tribe.mjs — Scaffold a new tribe frontend
 *
 * Usage:
 *   node scripts/create-tribe.mjs \
 *     --id=newtoken \
 *     --title="NewToken" \
 *     --mint=<token-address> \
 *     --bg="#1a1a2e" \
 *     --accent="#e94560" \
 *     --text="#eaeaea"
 *
 * Generates: src/frontend/tribes/<id>/
 *   tribe.json, theme.css, config.json, branding.json
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const tribesDir = join(root, 'src', 'frontend', 'tribes');

const { values: args } = parseArgs({
  options: {
    id:      { type: 'string' },
    title:   { type: 'string' },
    mint:    { type: 'string' },
    bg:      { type: 'string', default: '#1a1a2e' },
    accent:  { type: 'string', default: '#e94560' },
    text:    { type: 'string', default: '#eaeaea' },
    mobile:       { type: 'boolean', default: true },
    plugin:       { type: 'string', default: 'rank-generic' },
    'single-token': { type: 'boolean', default: false },
  },
  strict: false,
});

const singleToken = args['single-token'];

if (!args.id || !args.title || !args.mint) {
  console.error('Required flags: --id, --title, --mint');
  console.error('Example: node scripts/create-tribe.mjs --id=gsd --title="GSD" --mint=GHvFFSZ...');
  process.exit(1);
}

const tribeDir = join(tribesDir, args.id);
if (existsSync(tribeDir)) {
  console.error(`Tribe "${args.id}" already exists at ${tribeDir}`);
  process.exit(1);
}

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function lighten(hex, pct) {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.min(100, l + pct));
}

function darken(hex, pct) {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.max(0, l - pct));
}

function withAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const bg = args.bg;
const accent = args.accent;
const text = args.text;

const bgWarm = lighten(bg, 4);
const bgPanel = lighten(bg, 6);
const accentDim = lighten(accent, 15);
const accentHot = lighten(accent, 25);
const wireDim = darken(accent, 10);
const dataGreenDim = lighten(text, -10);
const steel = lighten(text, -15);
const steelDim = darken(text, 20);

mkdirSync(tribeDir, { recursive: true });

const tribeJson = {
  id: args.id,
  plugins: [args.plugin],
  mobileLocked: !args.mobile,
  reconPublic: false,
};
if (singleToken) {
  tribeJson.singleToken = true;
  tribeJson.pages = ['trade', 'positions'];
}
writeFileSync(join(tribeDir, 'tribe.json'), JSON.stringify(tribeJson, null, 2) + '\n');

writeFileSync(join(tribeDir, 'branding.json'), JSON.stringify({
  title: `${args.title} | crank.money`,
  favicon: null,
  logo: null,
}, null, 2) + '\n');

const configJson = {
  RPC_URL: 'https://api.mainnet-beta.solana.com',
  FEE_BPS: 30,
  CORE_PROGRAM_ID: '8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia',
  DAMM_V2_PROGRAM_ID: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  DEFAULT_POOL: args.mint,
  BOT_RELAY_URL: 'wss://bot.crank.money',
  METEORA_API_URL: 'https://dlmm.datapi.meteora.ag',
  DAMM_API_URL: 'https://damm-v2.datapi.meteora.ag',
  DEBUG: false,
};
if (singleToken) {
  configJson.SINGLE_TOKEN = true;
  configJson.PAGES = ['trade', 'positions'];
}
writeFileSync(join(tribeDir, 'config.json'), JSON.stringify(configJson, null, 2) + '\n');

writeFileSync(join(tribeDir, 'theme.css'), `:root {
  --void:             ${bg};
  --void-warm:        ${bgWarm};
  --void-panel:       ${bgPanel};

  --nerv-orange:      ${accent};
  --nerv-orange-dim:  ${accentDim};
  --nerv-orange-hot:  ${accentHot};

  --data-green:       ${text};
  --data-green-dim:   ${dataGreenDim};
  --data-green-faint: ${withAlpha(text, 0.08)};

  --wire-cyan:        ${accentDim};
  --wire-cyan-dim:    ${wireDim};
  --wire-cyan-glow:   ${withAlpha(accentDim, 0.12)};

  --alert-red:        #F27E7E;
  --alert-red-dim:    #8C4949;
  --alert-red-hot:    #F2A07E;
  --alert-red-fill:   rgba(242, 126, 126, 0.10);

  --thermal-yellow:   ${accentHot};
  --thermal-magenta:  ${wireDim};
  --thermal-blue:     ${accentDim};
  --thermal-purple:   ${text};

  --steel:            ${steel};
  --steel-dim:        ${steelDim};
  --steel-faint:      ${withAlpha(steelDim, 0.35)};
}

body {
  background: ${bg};
}
`);

console.log(`\n✓ Tribe "${args.id}" scaffolded at ${tribeDir}/`);
console.log(`  tribe.json   — plugin: ${args.plugin}, mobile: ${args.mobile ? 'unlocked' : 'locked'}${singleToken ? ', singleToken' : ''}`);
console.log(`  branding.json — title: "${args.title} | crank.money"`);
console.log(`  config.json  — DEFAULT_POOL: ${args.mint}${singleToken ? ', SINGLE_TOKEN: true' : ''}`);
console.log(`  theme.css    — bg: ${bg}, accent: ${accent}, text: ${text}`);
console.log(`\nBuild with:`);
console.log(`  node scripts/build-frontend.mjs --tribe=${args.id}`);
console.log(`  npx serve dist`);
