// End-to-end check of the interactive course in a real DOM.
//
//   php -S 127.0.0.1:8092 -t public        (or: docker compose up, then BASE=http://localhost/course/)
//   node tools/course-checks/smoke.mjs
//
// It drives the page the way a learner does: run a snippet, answer a quiz, write the
// exercise solution, simulate a request, and finally load the same page from a plain
// static server (no PHP at all) to prove it degrades to read-only honestly.

import jsdomPkg from 'jsdom';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { JSDOM, VirtualConsole } = jsdomPkg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COURSE_DIR = path.resolve(HERE, '..', '..', 'public', 'course');
const BASE = process.env.BASE || 'http://127.0.0.1:8092/course/';
const STATIC_PORT = Number(process.env.STATIC_PORT || 8093);

const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (node) => (node ? node.textContent.trim() : '');

async function waitFor(fn, { timeout = 20000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* keep waiting */
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeDom(html, base) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    const message = String(err.message || err);
    if (/Could not parse CSS|Not implemented|Could not load/i.test(message)) return;
    if (/app\.js/i.test(String(err.stack || ''))) failures.push(`app error: ${message}`);
  });

  return new JSDOM(html, {
    url: base,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(input, base), init);
      window.open = () => null;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    },
  });
}

const run = async (dom, selector) => {
  const btn = dom.window.document.querySelector(selector);
  if (!btn) return null;
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return btn;
};

// ---------------------------------------------------------------- live mode --

const liveHtml = await (await fetch(BASE)).text();
const dom = makeDom(liveHtml, BASE);
const { window } = dom;
const { document } = window;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

await waitFor(() => $('.toc-link'), { label: 'chapter list' });
await waitFor(() => $('.rail-progress .seg'), { label: 'progress rail' });

check('chapter list renders every lesson', $$('.toc-link').length === 14, `${$$('.toc-link').length}`);
check('module headings render', $$('.toc-module').length === 5, `${$$('.toc-module').length}`);
check('progress rail has one segment per chapter', $$('.rail-progress .seg').length === 14);
check('first chapter renders', /your first php page/i.test(text($('.chapter-title'))), text($('.chapter-title')));
check('snippets are rendered', $$('.snippet').length >= 4, `${$$('.snippet').length}`);
check('every snippet has a Run button', $$('.snippet-btn.is-run').length === $$('.snippet').length);
check('PHP is highlighted', $$('pre.hl .tok-kw').length > 0 || $$('pre.hl .tok-com').length > 0);
check('quiz renders', $$('.quiz-item').length >= 2, `${$$('.quiz-item').length}`);
check('exercise renders', !!$('.exercise'));
check('docs links go to php.net', $$('.docs-list a').every((a) => a.getAttribute('href').startsWith('https://www.php.net/manual/en/')), $$('.docs-list a')[0]?.getAttribute('href'));
check('toolchain badge shows the interpreter', /php\s*8\./i.test(text($('#rail-toolchain'))), text($('#rail-toolchain')));

// run the first snippet
await run(dom, '.snippet-btn.is-run');
const receipt = await waitFor(() => {
  const r = $('.snippet-out .receipt:not(.is-running)');
  return r ? r : null;
}, { label: 'snippet receipt' });
check('snippet runs', receipt.dataset.kind === 'ok', text($('.snippet-out .receipt-body')).slice(0, 100));
check('snippet prints what the chapter claims', text($('.snippet-out .receipt-body')).includes('Hello, PHP'), text($('.snippet-out .receipt-body')));

// quiz
const firstQuiz = $('.quiz-item');
const opts = Array.from(firstQuiz.querySelectorAll('.quiz-opt'));
opts[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('quiz marks the correct option', opts[1].classList.contains('is-right'));
check('quiz explains the answer', !$('.quiz-why', firstQuiz).hidden);

// exercise through the workbench
$('#editor').value = '<?php\n\necho "PHP\\n";\necho "sum: ", 2 + 2, "\\n";\n';
$('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
await run(dom, '#btn-check');
const passed = await waitFor(() => {
  const el = $('.exercise-state');
  return el && el.classList.contains('is-pass') ? el : null;
}, { label: 'exercise to pass' });
check('exercise checks pass with the solution', text(passed) === 'passed', text(passed));
check('checklist is rendered and all pass', $$('.exercise-checks li.pass').length >= 3, `${$$('.exercise-checks li.pass').length}`);
check('progress marks the chapter done', $$('.rail-progress .seg.is-done').length === 1);

// syntax errors read as a parse failure
$('#editor').value = '<?php\necho "one"\necho "two";\n';
$('#editor').dispatchEvent(new window.Event('input', { bubbles: true }));
await run(dom, '#btn-run');
const parseReceipt = await waitFor(() => {
  const r = $('#bench-out .receipt:not(.is-running)');
  return r && r.dataset.kind === 'err' ? r : null;
}, { label: 'parse error receipt' });
check('a syntax error is reported as one', /did not parse/i.test(text(parseReceipt.querySelector('.spacer'))), text(parseReceipt.querySelector('.spacer')));
check('the parse message is coloured', $$('#bench-out .receipt-body .d-err').length >= 1);

// ------------------------------------------------------------------ request --

window.location.hash = '#/c/07-forms';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
await waitFor(() => /request carries/i.test(text($('.chapter-title'))), { label: 'forms chapter' });
check('request chapters show a request chip', $$('.req-chip').length >= 1, `${$$('.req-chip').length} chips`);

const reqSnippet = $$('.snippet').find((s) => s.querySelector('.req-chip'));
reqSnippet.querySelector('.snippet-btn.is-run').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const reqReceipt = await waitFor(() => {
  const r = reqSnippet.querySelector('.snippet-out .receipt:not(.is-running)');
  return r ? r : null;
}, { label: 'simulated request receipt' });
check('a snippet with a simulated request runs', reqReceipt.dataset.kind === 'ok', text(reqReceipt.querySelector('.receipt-body')).slice(0, 120));
check('the receipt names the simulated request', /POST|GET/.test(text(reqReceipt.querySelector('.cmd'))), text(reqReceipt.querySelector('.cmd')));

// the workbench request panel is seeded from the exercise
await waitFor(() => !$('#bench-req').hidden, { label: 'request panel' });
check('request panel opens with the exercise', !$('#bench-req').hidden);
check('request panel is pre-filled', $('#req-json').value.trim().length > 0, $('#req-json').value.slice(0, 60));

// ------------------------------------------------------------------- offline --

const stage = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'course-static-'));
const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.endsWith('.php')) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
};
copyTree(COURSE_DIR, stage);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const staticServer = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.join(stage, rel);
  if (!file.startsWith(stage) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => staticServer.listen(STATIC_PORT, '127.0.0.1', resolve));
const staticBase = `http://127.0.0.1:${STATIC_PORT}/`;

const staticHtml = await (await fetch(staticBase)).text();
const offline = makeDom(staticHtml, staticBase);
await waitFor(() => offline.window.document.querySelector('.toc-link'), { label: 'offline chapter list' });
check('the course loads without PHP', offline.window.document.querySelectorAll('.toc-link').length === 14);
const offlineBadge = await waitFor(() => {
  const el = offline.window.document.querySelector('#rail-toolchain');
  return el && /read only|php/i.test(el.textContent) ? el : null;
}, { label: 'offline badge' });
check('the badge says it is read only', /read only/i.test(text(offlineBadge)), text(offlineBadge));

offline.window.document.querySelector('.snippet-btn.is-run').dispatchEvent(new offline.window.MouseEvent('click', { bubbles: true }));
const offlineReceipt = await waitFor(() => {
  const r = offline.window.document.querySelector('.snippet-out .receipt:not(.is-running)');
  return r ? r : null;
}, { label: 'offline run attempt' });
check('running offline explains why it cannot', offlineReceipt.dataset.kind === 'err', text(offlineReceipt.querySelector('.receipt-body')).slice(0, 100));

offline.window.close();
dom.window.close();
staticServer.close();
fs.rmSync(stage, { recursive: true, force: true });

// -------------------------------------------------------------------- report --

const width = Math.max(...results.map((r) => r.name.length));
results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)} ${r.ok ? '' : `  <- ${r.detail || ''}`}`));
console.log(`\n${results.filter((r) => r.ok).length} / ${results.length} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  [...new Set(failures)].forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log('course smoke test passed.');
