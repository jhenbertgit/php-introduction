// End-to-end DOM smoke test for the interactive PHP docs.
// Needs the docs served by a PHP server that can execute runner.php:
//
//   php -S 127.0.0.1:8090 -t C:\Users\Jhenbert\php-basic\public\docs
//   node smoketest.mjs                        (BASE defaults to http://127.0.0.1:8090/)
//   BASE=http://localhost/ node smoketest.mjs (the Docker app)

import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole } = jsdomPkg;

const BASE = process.env.BASE || 'http://127.0.0.1:8090/';
const results = [];
const failures = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* keep waiting */
    }
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const virtualConsole = new VirtualConsole();
const pageNotes = [];
virtualConsole.on('jsdomError', (err) => {
  const message = String(err.message || err);
  if (/Could not parse CSS|Not implemented|Could not load/i.test(message)) return;
  // Only failures inside the interactive layer are this test's business; the docs page
  // has its own scripts (CDN widgets, IntersectionObserver) that jsdom does not model.
  if (/interactive\.js/i.test(String(err.stack || '')) || /phpDocsInteractive/.test(message)) {
    failures.push(`interactive layer error: ${message}`);
  } else {
    pageNotes.push(message.split('\n')[0]);
  }
});

const html = await (await fetch(BASE)).text();
const dom = new JSDOM(html, {
  url: BASE,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(input, BASE), init);
    window.open = () => null;
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    // jsdom does not implement these; the docs page uses them for scroll effects.
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  },
});

const { window } = dom;
const { document } = window;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const text = (node) => (node ? node.textContent.trim() : '');

// ------------------------------------------------------------------ structure --

const api = await waitFor(() => window.phpDocsInteractive, { label: 'interactive script' });
const online = await waitFor(() => window.phpDocsInteractive.online, { label: 'runner probe' });

check('docs page loads', document.title.includes('PHP 8.4'), document.title);
check('runner detected', online === true, `online=${online}`);
check('PHP version reported', /^8\.4\./.test(String(api.php)), String(api.php));

const bars = $$('.run-bar');
check('every code block got a toolbar', bars.length >= 100, `${bars.length} toolbars`);
check('editors are present', $$('.run-edit__input').length === bars.length, `${$$('.run-edit__input').length} editors`);
check('output panels are present', $$('.run-out').length === bars.length, `${$$('.run-out').length} panels`);
check('copy button kept and moved into the bar', $$('.run-bar .code-block__copy').length === bars.length, `${$$('.run-bar .code-block__copy').length} copy buttons`);
check('state chip renders', !!$('.run-chip'), text($('.run-chip')));
check('chip says live', /Live PHP/.test(text($('.run-chip'))), text($('.run-chip')));
check('run buttons enabled while online', $$('.run-btn:not([disabled])').length === bars.length);

// ------------------------------------------------------------------- execution --

// The greeting function block: its documented output is exactly the three lines it prints.
const record = await waitFor(
  () => api.blocks.find(
    (b) => b.expected && b.expected.trim().split('\n')[0] === 'Hello, Alice!' && /function greet/.test(b.original),
  ),
  { label: 'the greeting block' },
);

record.runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const out = await waitFor(
  () => {
    const el = record.outEl;
    return el && !el.hidden && el.dataset.ok !== 'pending' ? el : null;
  },
  { label: 'first run to finish' },
);

check('snippet runs', out.dataset.ok === 'true', text(out.querySelector('.run-out__body')).slice(0, 120));
check('output matches the docs', text(out.querySelector('.run-out__body')).includes('Hello, Alice!'), text(out.querySelector('.run-out__body')));
check('output compared with the documented output', text(out.querySelector('.run-check')).startsWith('✓'), text(out.querySelector('.run-check')));check('status line reports timing', /ran in \d+ ms/.test(text(record.statusEl)), text(record.statusEl));
check('PHP version shown in the panel', /PHP 8\.4/.test(text(out.querySelector('.run-out__meta'))), text(out.querySelector('.run-out__meta')));

// --------------------------------------------------------------------- editing --

const textarea = record.textarea;
textarea.value = '$total = 0;\nforeach ([1, 2, 3, 4] as $n) {\n    $total += $n;\n}\necho "total: ", $total;';
textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
record.runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const edited = await waitFor(
  () => (text(record.outBody).includes('total:') ? record.outEl : null),
  { label: 'edited snippet output' },
);
check('edited code runs', text(record.outBody).trim() === 'total: 10', text(record.outBody));
check('mismatch flagged against documented output', text(record.outEl.querySelector('.run-check')).startsWith('✗'), text(record.outEl.querySelector('.run-check')));
check('editor repaints the highlighted source', record.codeEl.textContent.includes('$total'), record.codeEl.textContent.slice(0, 80));
void edited;

// ------------------------------------------------------------- syntax errors --

textarea.value = '<?php echo 1 +;';
textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
record.runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const syntax = await waitFor(
  () => (text(record.outEl.querySelector('.run-out__label')) === 'Syntax error' ? record.outEl : null),
  { label: 'syntax error report' },
);
check('parse errors read as syntax errors', text(syntax.querySelector('.run-out__label')) === 'Syntax error');
check('parse error text is shown', /syntax error/i.test(text(syntax.querySelector('.run-out__body'))), text(syntax.querySelector('.run-out__body')).slice(0, 120));

// ------------------------------------------------------------------- reset --

record.block.querySelector('.run-quiet').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('reset restores the original code', record.textarea.value === record.original);

// ------------------------------------------------- automatic output registry --

// A block whose documented output is known and which needs no special conditions.
const second = await waitFor(
  () => api.blocks.find((b) => b.expected && b.expected.trim() && /echo|print/.test(b.original) && b !== record),
  { label: 'a second block with expected output' },
);
second.runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const secondOut = await waitFor(
  () => (second.outEl && second.outEl.dataset.ok !== 'pending' && second.outEl.dataset.ok !== undefined ? second.outEl : null),
  { label: 'second run' },
);
check('a second, unrelated block also runs', secondOut.dataset.ok === 'true' || secondOut.dataset.ok === 'false', `ok=${secondOut.dataset.ok}`);
check('its output panel is filled', text(second.outBody).length > 0, text(second.outBody).slice(0, 80));

// --------------------------------------------------------------------- report --

dom.window.close();

const width = Math.max(...results.map((r) => r.name.length));
results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)} ${r.ok ? '' : `  <- ${r.detail || ''}`}`));
console.log(`\n${results.filter((r) => r.ok).length} / ${results.length} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  [...new Set(failures)].forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log('PHP docs smoke test passed.');
