// Render TRMNL layouts locally with TRMNL's framework CSS and screenshot them.
//
// Usage: node tools/render.mjs <dir> [--time HH:MM] [--format 12|24] [--location NAME] [--data aladhan.json]
//
// <dir> holds any of full.liquid, half_horizontal.liquid, half_vertical.liquid,
// quadrant.liquid, and optionally shared.liquid (defaults to src/shared.liquid).
// Writes <dir>/out/<layout>.png (800x480, as the device shows it) and
// <dir>/out/sheet.png (all layouts side by side).
//
// Screenshots use the agent Chrome over CDP at 127.0.0.1:9333.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Liquid } from 'liquidjs';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const dir = path.resolve(args.find(a => !a.startsWith('--') && !/^\d/.test(a)) || path.join(root, 'src'));
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const time = opt('time', '12:45');
const format = opt('format', '12');
const utcOffset = Number(opt('offset', '-21600'));

const LAYOUTS = {
  full: { view: 'view--full', mashup: null },
  half_horizontal: { view: 'view--half_horizontal', mashup: 'mashup--1Tx1B' },
  half_vertical: { view: 'view--half_vertical', mashup: 'mashup--1Lx1R' },
  quadrant: { view: 'view--quadrant', mashup: 'mashup--2x2' },
};

const sharedPath = fs.existsSync(path.join(dir, 'shared.liquid')) ? path.join(dir, 'shared.liquid') : path.join(root, 'src/shared.liquid');
// liquidjs has no "now" relative to a fixed clock, so substitute a fixed epoch for "now".
const shared = fs.readFileSync(sharedPath, 'utf8').replace(/"now" \| date: "%s"/g, 'fake_now');
const data = JSON.parse(fs.readFileSync(path.resolve(opt('data', path.join(here, 'sample-aladhan.json'))), 'utf8')).data;
const [H, M] = time.split(':').map(Number);
const [d, mo, y] = data.date.gregorian.date.split('-').map(Number);
const fakeNow = Date.UTC(y, mo - 1, d, H, M) / 1000 - utcOffset;

const engine = new Liquid({ timezoneOffset: 0 });
const ctx = {
  fake_now: fakeNow,
  data,
  trmnl: {
    user: { utc_offset: utcOffset, time_zone_iana: 'America/Edmonton' },
    plugin_settings: { custom_fields_values: { time_format: format, lat_lon: '53.5462055,-113.491241', method: '3', school: '0', location_name: opt('location', 'Edmonton') } },
  },
};

const head = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://trmnl.com/css/3.4.6/plugins.min.css">
<link rel="stylesheet" href="https://trmnl.com/fonts/fallbacks.css">
<script type="module" src="https://trmnl.com/js/3.4.6/plugins.min.js"></script>
<style>html,body{margin:0;background:#fff}</style></head>`;

const outDir = path.join(dir, 'out');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = await context.newPage();
await page.bringToFront();
await page.setViewportSize({ width: 800, height: 480 });

const shots = [];
for (const [name, { view, mashup }] of Object.entries(LAYOUTS)) {
  const file = path.join(dir, name + '.liquid');
  if (!fs.existsSync(file)) continue;
  const markup = await engine.parseAndRender(shared + fs.readFileSync(file, 'utf8'), ctx);
  let inner = `<div class="view ${view}">${markup}</div>`;
  if (mashup) inner = `<div class="mashup ${mashup}">${inner}</div>`;
  const html = `${head}<body class="environment trmnl"><div class="trmnl environment"><div class="screen">${inner}</div></div></body></html>`;
  fs.writeFileSync(path.join(outDir, name + '.html'), html);
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const png = path.join(outDir, name + '.png');
  await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 800, height: 480 } });
  shots.push([name, png]);
}

// Contact sheet: all layouts in a 2x2 grid with labels.
const cells = shots.map(([name, png]) => `<figure><img src="data:image/png;base64,${fs.readFileSync(png).toString('base64')}"><figcaption>${name}</figcaption></figure>`).join('');
await page.setViewportSize({ width: 1680, height: 1100 });
await page.setContent(`<html><body style="margin:0;padding:20px;background:#ddd;font:16px system-ui;display:grid;grid-template-columns:800px 800px;gap:20px">
<style>figure{margin:0}img{display:block;width:800px;height:480px;box-shadow:0 0 0 1px #999}figcaption{padding:6px 0;color:#333}</style>${cells}</body></html>`);
await page.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true });
await page.close();
await browser.close().catch(() => {});
console.log(shots.map(([n, p]) => p).concat(path.join(outDir, 'sheet.png')).join('\n'));
