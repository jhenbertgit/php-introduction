// Runs every code block on the page through the live runner and reports how many
// execute, how many match their documented output, and what the failures look like.
//
//   node audit.mjs            (needs the docs served by a PHP server, BASE below)

import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole } = jsdomPkg;
const BASE = process.env.BASE || 'http://127.0.0.1:8090/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const virtualConsole = new VirtualConsole();
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
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  },
});

const { window } = dom;

let api = null;
for (let i = 0; i < 200; i += 1) {
  api = window.phpDocsInteractive;
  if (api) break;
  await sleep(100);
}
if (!api) {
  console.error('the interactive script did not load — is interactive.js beside index.html?');
  process.exit(1);
}

// wait for the probe
for (let i = 0; i < 100 && !api.online; i += 1) await sleep(100);
if (!api.online) {
  console.error('runner is not online — start the PHP server first');
  process.exit(1);
}

const rows = [];
for (let index = 0; index < api.blocks.length; index += 1) {
  const record = api.blocks[index];
  record.execute();

  let settled = null;
  for (let i = 0; i < 300; i += 1) {
    await sleep(50);
    if (record.outEl.dataset.ok !== 'pending') {
      settled = record.outEl;
      break;
    }
  }
  if (!settled) {
    rows.push({ index, verdict: 'no-response', label: '', expected: record.expected !== null, snippet: record.original.split('\n')[0] });
    continue;
  }

  const badge = settled.querySelector('.run-check');
  const label = settled.querySelector('.run-out__label').textContent.trim();
  const errText = settled.querySelector('.run-err') ? settled.querySelector('.run-err').textContent.trim() : '';
  rows.push({
    index,
    verdict: settled.dataset.ok === 'true' ? 'ran' : 'failed',
    label,
    match: badge ? badge.dataset.match : (record.expected === null ? 'no-doc-output' : 'none'),
    expected: record.expected !== null,
    snippet: record.original.split('\n').find((l) => l.trim() && !/^<\?php|^\/\//.test(l)) || record.original.split('\n')[0],
    status: record.statusEl.textContent.trim(),
    error: errText.split('\n').filter((l) => l.trim()).slice(0, 2).join(' | '),
  });
}

const by = (fn) => rows.filter(fn).length;
const matched = by((r) => r.match === 'true');
const partial = by((r) => r.match === 'partial');
const differs = by((r) => r.match === 'false');
const ran = by((r) => r.verdict === 'ran');
const failed = by((r) => r.verdict === 'failed');
const withDocs = by((r) => r.expected);

console.log(`\nblocks: ${rows.length}`);
console.log(`ran without error:      ${ran}`);
console.log(`reported an error:      ${failed}`);
console.log(`have documented output: ${withDocs}`);
console.log(`  exact match:          ${matched}`);
console.log(`  close:                ${partial}`);
console.log(`  differs:              ${differs}`);

const interesting = rows.filter((r) => r.verdict === 'failed');
if (interesting.length) {
  console.log('\nblocks that reported an error:');
  interesting.forEach((r) => {
    console.log(`  #${String(r.index).padEnd(3)} ${r.label.padEnd(12)} ${r.error.slice(0, 110)}`);
  });
}

const differing = rows.filter((r) => r.verdict === 'ran' && r.match === 'false').slice(0, 8);
if (differing.length) {
  console.log('\nfirst few blocks whose output differs from the documented one:');
  differing.forEach((r) => {
    console.log(`  #${String(r.index).padEnd(3)} ${r.snippet.trim().slice(0, 70)}`);
  });
}

dom.window.close();
