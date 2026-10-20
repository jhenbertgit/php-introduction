// Checks how the docs behave where there is no PHP runner — which is exactly the
// GitHub Pages deployment. The page must stay readable, with Run clearly unavailable.
//
//   node offline.mjs
//
// It copies public/docs without runner.php, serves it from a plain static server (no PHP
// at all) and drives the result in jsdom.

import jsdomPkg from 'jsdom';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const vendorRequire = createRequire(import.meta.url);

const { JSDOM, VirtualConsole } = jsdomPkg;

// tools/docs-checks/ -> ../../public/docs
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = process.env.DOCS_DIR || path.resolve(HERE, '..', '..', 'public', 'docs');
const PORT = Number(process.env.PORT || 8091);
const BASE = `http://127.0.0.1:${PORT}/`;

const results = [];
const failures = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- build a Pages-like copy: no PHP files at all
const stage = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'php-docs-static-'));
for (const entry of fs.readdirSync(DOCS_DIR)) {
  const from = path.join(DOCS_DIR, entry);
  if (entry.endsWith('.php')) continue;
  if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(stage, entry));
}
const served = fs.readdirSync(stage);
fs.writeFileSync(path.join(stage, '.nojekyll'), '');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, BASE).pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(stage, rel);
  if (!file.startsWith(stage) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => { /* the docs' own scripts are out of scope here */ });

const html = await (await fetch(BASE)).text();
const dom = new JSDOM(html, {
  url: BASE,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(input, BASE), init);
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(url);
      return null;
    };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  },
});

const { window } = dom;
const { document } = window;
let api = null;
for (let i = 0; i < 150 && !api; i += 1) {
  api = window.phpDocsInteractive;
  await sleep(100);
}

// give the probe time to fail: wait until the chip stops saying "checking…"
let chipText = '';
for (let i = 0; i < 100; i += 1) {
  const node = document.querySelector('.run-chip');
  chipText = node ? node.textContent : '';
  if (chipText && !/checking/i.test(chipText)) break;
  await sleep(100);
}

check('stage excludes PHP files', !served.some((f) => f.endsWith('.php')), served.join(', '));
check('interactive script still loads', !!api);
check('runner is reported offline', api && api.online === false, api ? `online=${api.online}` : 'no api');
check('chip explains the situation', /Reading only/i.test(chipText), chipText);
check('blocks are still enhanced', document.querySelectorAll('.run-bar').length >= 100, `${document.querySelectorAll('.run-bar').length} bars`);
check('every Run button is disabled', Array.from(document.querySelectorAll('.run-btn')).every((b) => b.disabled), `${document.querySelectorAll('.run-btn:not([disabled])').length} enabled`);
check('code stays readable (no editors forced)', document.querySelectorAll('.run-edit__input').length >= 100);
check('copy buttons survive', document.querySelectorAll('.code-block__copy').length >= 100, `${document.querySelectorAll('.code-block__copy').length}`);

// clicking a Run button must explain rather than fail silently
const record = api.blocks.find((b) => /Hello, Alice!/.test(b.expected || ''));
record.runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(150);
const out = record.outEl;
check('clicking Run explains it cannot run', !out.hidden && /Not runnable here/i.test(out.textContent), out.hidden ? 'panel stayed hidden' : out.textContent.trim().slice(0, 90));
check('the explanation names the fix', /docker compose up/i.test(out.textContent), out.textContent.trim().slice(0, 120));

// the fallback: the same snippet can still be run, in php-play.dev
const LZ = vendorRequire(path.join(DOCS_DIR, 'lz-string.js'));
const playBtns = Array.from(document.querySelectorAll('.run-play-btn'));
check('static copy offers the playground', playBtns.length >= 100, `${playBtns.length} buttons`);
playBtns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const openedUrl = (window.__opened || [])[0];
check('the button opens php-play.dev', !!openedUrl && openedUrl.startsWith('https://php-play.dev/?c='), String(openedUrl || '').slice(0, 64));
const decoded = openedUrl ? LZ.decompressFromEncodedURIComponent(new URL(openedUrl).searchParams.get('c')) : null;
check('the link carries the block\'s exact code', decoded === playBtns[0].closest('.code-block').querySelector('textarea').value, JSON.stringify(decoded || '').slice(0, 80));

dom.window.close();
server.close();
fs.rmSync(stage, { recursive: true, force: true });

const width = Math.max(...results.map((r) => r.name.length));
results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)} ${r.ok ? '' : `  <- ${r.detail || ''}`}`));
console.log(`\n${results.filter((r) => r.ok).length} / ${results.length} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  [...new Set(failures)].forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log('offline (Pages-like) behaviour passed.');
