// Verifies course content: every code block lints, runs, and prints what the lesson
// claims; every exercise solution satisfies its checks; the JSON shape is complete.
//
//   node tools/verify.mjs                 every lesson in content/lessons
//   node tools/verify.mjs 01-hello        one lesson
//   node tools/verify.mjs path/to/dir     a specific folder
//
// PHP_BIN  optional path to the php CLI (default: the portable build, else "php" on PATH)
// APP_ROOT optional project root used for the App\ autoloader (default: this checkout)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// One scratch directory per process, in the OS temp area: several verifiers can run at
// once, and the repository is never written to.
const SCRATCH = path.join(os.tmpdir(), `php-course-verify-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);

const PORTABLE = 'C:\\Users\\Jhenbert\\Documents\\dsh\\php-runtime\\php\\php.exe';
const PHP_BIN = process.env.PHP_BIN || (fs.existsSync(PORTABLE) ? PORTABLE : 'php');
const APP_ROOT = process.env.APP_ROOT
  || ROOT;

fs.mkdirSync(SCRATCH, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const problems = [];
const notes = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);

/** Compile a request preamble the same way the real runner does. */
function requestPreamble(request) {
  const req = request || {};
  const method = String(req.method || 'GET').toUpperCase();
  const encode = (value) => JSON.stringify(value ?? null).replace(/'/g, "\\'");
  const lines = ['<?php'];
  lines.push(`$_SERVER['REQUEST_METHOD'] = '${method}';`);
  lines.push(`$_SERVER['HTTP_HOST'] = 'localhost';`);
  lines.push(`$_SERVER['REQUEST_URI'] = '/';`);
  lines.push(`$_GET = json_decode('${encode(req.get || {})}', true) ?: [];`);
  lines.push(`$_POST = json_decode('${encode(req.post || {})}', true) ?: [];`);
  if (req.session !== undefined) {
    lines.push(`session_start();`);
    lines.push(`$_SESSION = json_decode('${encode(req.session)}', true) ?: [];`);
  }
  lines.push('?>');
  return lines.join('\n') + '\n';
}

/** Mirror the real runner: load the app autoloader for snippets that use App\ classes. */
function injectAutoload(code) {
  const autoload = path.join(APP_ROOT, 'vendor', 'autoload.php');
  if (!fs.existsSync(autoload)) return code;
  if (/(?:^|\n)\s*namespace\s+[^;{]+;/i.test(code)) return code;
  if (!/\bApp\\\\|use App/.test(code)) return code;

  const match = /^(\s*<\?php)(\s*declare\s*\([^;]*\)\s*;)?/i.exec(code);
  if (!match) return code;
  const at = match[0].length;
  const requireLine = `\nrequire '${autoload.replace(/\\/g, '/')}';`;
  return code.slice(0, at) + requireLine + code.slice(at);
}

/** Build the file the runner would execute. */
function composeSnippet(code, request) {
  let body = /<\?php|<\?=/i.test(code) ? code : `<?php\n${code}`;
  body = injectAutoload(body);
  if (!request) return body;

  // A snippet that declares strict_types must keep it as the first statement.
  if (/^\s*<\?php\s*declare\s*\(/i.test(body)) {
    return body;
  }
  const preamble = requestPreamble(request);
  return `${preamble}<?php\n${body.replace(/^\s*<\?php\s*/i, '')}`;
}

function runPhp(args, cwd) {
  const outFile = path.join(cwd, `out-${crypto.randomUUID().slice(0, 8)}.txt`);
  const errFile = path.join(cwd, `err-${crypto.randomUUID().slice(0, 8)}.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let result;
  try {
    result = spawnSync(PHP_BIN, args, {
      cwd,
      stdio: ['ignore', outFd, errFd],
      timeout: 20_000,
      env: { ...process.env, APP_ROOT },
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const read = (file) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        /* retry */
      }
    }
    return '';
  };
  const stdout = read(outFile);
  const stderr = read(errFile);
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return {
    code: result.status,
    timedOut: result.error !== undefined,
    stdout,
    stderr: stderr
      .split('\n')
      .filter((line) => !/Ignoring session_start\(\)|A session had already been started/i.test(line))
      .join('\n'),
  };
}

function execute(code, request) {
  const dir = path.join(SCRATCH, crypto.randomUUID().slice(0, 12));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'snippet.php');
  fs.writeFileSync(file, composeSnippet(code, request), 'utf8');
  try {
    const lint = runPhp(['-l', file], dir);
    if (lint.code !== 0) {
      return { compiled: false, lint, run: null };
    }
    // The same diagnostic settings App\SnippetRunner uses, so the harness sees what the
    // browser will see: printed output on stdout, notices and warnings on stderr.
    const run = runPhp(['-d', 'display_errors=stderr', '-d', 'error_reporting=E_ALL', '-d', 'log_errors=0', file], dir);
    return { compiled: true, lint, run };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const strip = (text) => String(text || '').replace(/\r/g, '').split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');

/**
 * The app shows printed output and diagnostics together, but PHP appends
 * " in /tmp/.../snippet.php on line N" to notices and warnings, which no lesson can pin
 * down. Strip that suffix and require the claimed lines to be present.
 */
function matchesClaim(claim, result) {
  const combined = strip(`${result.run.stdout || ''}\n${result.run.stderr || ''}`)
    .replace(/\s+in \S*snippet\.php(?:\s+on\s+line\s+\d+)?/g, '');
  const wanted = strip(claim).split('\n').filter((line) => line.trim());
  return wanted.every((line) => combined.includes(line.trim()));
}

function evaluateChecks(checks, result) {
  const stdout = strip(result.run && result.run.stdout);
  const lines = stdout.split('\n').filter((line) => line.trim());
  return (checks || []).map((check) => {
    switch (check.kind) {
      case 'compiles':
        return result.compiled && !/Fatal error/i.test(result.run.stderr || '');
      case 'outputEquals':
        return stdout === strip(check.value);
      case 'outputContains':
        return stdout.includes(String(check.value));
      case 'stdoutLines':
        return lines.length === Number(check.value);
      default:
        return false;
    }
  });
}

const target = process.argv[2] || path.join(ROOT, 'public', 'course', 'content', 'lessons');
const only = process.argv[3];
const dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.join(ROOT, 'public', 'course', 'content', 'lessons');
const filter = fs.existsSync(target) && fs.statSync(target).isDirectory() ? only : process.argv[2];

const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .filter((f) => !filter || f.startsWith(filter));

if (!files.length) {
  console.error(`no lesson files found in ${dir}`);
  process.exit(1);
}

let blocks = 0;
let runs = 0;

for (const file of files) {
  const where = file.replace(/\.json$/, '');
  let lesson;
  try {
    lesson = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    problem(where, `invalid JSON — ${err.message}`);
    continue;
  }

  if (lesson.id !== where) problem(where, `id "${lesson.id}" does not match the filename`);
  if (!lesson.title) problem(where, 'missing title');
  if (!lesson.summary) problem(where, 'missing summary');
  if (lesson.summary && lesson.summary.length > 110) problem(where, 'summary is longer than 110 characters');
  if (typeof lesson.minutes !== 'number') problem(where, 'minutes must be a number');
  if (!Array.isArray(lesson.blocks) || lesson.blocks.length < 4) problem(where, 'needs at least 4 blocks');
  if (!Array.isArray(lesson.quiz) || lesson.quiz.length < 2) problem(where, 'needs at least 2 quiz items');
  if (!lesson.exercise) problem(where, 'missing exercise');

  (lesson.quiz || []).forEach((item, i) => {
    if (!Array.isArray(item.options) || item.options.length < 2) problem(where, `quiz[${i}] needs 2+ options`);
    if (typeof item.answer !== 'number' || item.answer < 0 || item.answer >= (item.options || []).length) {
      problem(where, `quiz[${i}] answer index out of range`);
    }
    if (!item.why) problem(where, `quiz[${i}] missing why`);
  });

  (lesson.blocks || []).forEach((block, i) => {
    if (!['prose', 'code', 'callout', 'diagram'].includes(block.type)) {
      problem(where, `blocks[${i}] unknown type "${block.type}"`);
      return;
    }
    if (block.type === 'diagram' && block.ascii) {
      const long = String(block.ascii).split('\n').filter((line) => line.length > 74);
      if (long.length) problem(where, `blocks[${i}] diagram has ${long.length} line(s) over 74 characters`);
    }
    if (block.type !== 'code') return;

    blocks += 1;
    const result = execute(block.code, block.request);

    if (block.runnable === false) {
      if (result.compiled) notes.push(`${where}: blocks[${i}] is a fragment but lints cleanly`);
      else notes.push(`${where}: blocks[${i}] fragment rejected by the linter, as intended`);
      return;
    }
    if (!result.compiled) {
      problem(where, `blocks[${i}] does not lint:\n${(result.lint.stderr + result.lint.stdout).split('\n').slice(0, 5).join('\n')}`);
      return;
    }
    runs += 1;
    if (result.run.timedOut) problem(where, `blocks[${i}] did not finish within 20 seconds`);
    if (/Fatal error/i.test(result.run.stderr || '')) {
      problem(where, `blocks[${i}] fatals at runtime:\n${strip(result.run.stderr).split('\n').slice(0, 4).join('\n')}`);
      return;
    }
    if (block.output) {
      if (!matchesClaim(block.output, result)) {
        problem(where, `blocks[${i}] claims output ${JSON.stringify(strip(block.output).slice(0, 120))} but printed ${JSON.stringify(strip(`${result.run.stdout}\n${result.run.stderr}`).slice(0, 200))}`);
      }
    }
  });

  if (lesson.exercise) {
    const ex = lesson.exercise;
    if (!ex.brief) problem(where, 'exercise missing brief');
    if (!ex.starter) problem(where, 'exercise missing starter');
    if (!Array.isArray(ex.checks) || !ex.checks.length) problem(where, 'exercise needs at least one check');
    if (!ex.solution) problem(where, 'exercise missing solution');

    if (ex.starter) {
      const starter = execute(ex.starter, ex.request);
      if (!starter.compiled) {
        problem(where, `exercise starter does not lint:\n${(starter.lint.stderr + starter.lint.stdout).split('\n').slice(0, 4).join('\n')}`);
      }
    }
    if (ex.solution) {
      const solution = execute(ex.solution, ex.request);
      if (!solution.compiled) {
        problem(where, `exercise solution does not lint:\n${(solution.lint.stderr + solution.lint.stdout).split('\n').slice(0, 4).join('\n')}`);
      } else {
        runs += 1;
        const verdicts = evaluateChecks(ex.checks, solution);
        if (verdicts.some((ok) => !ok)) {
          problem(
            where,
            `exercise solution fails its own checks (${JSON.stringify(ex.checks)}) — printed ${JSON.stringify(strip(solution.run.stdout).slice(0, 160))}${solution.run.stderr ? ` stderr ${JSON.stringify(strip(solution.run.stderr).slice(0, 120))}` : ''}`,
          );
        }
      }
    }
  }

  (lesson.docs || []).forEach((doc, i) => {
    if (!doc.label || !doc.href) problem(where, `docs[${i}] needs both label and href`);
    else if (!/^(https?:\/\/|[a-z0-9._-]+\.php$)/i.test(doc.href)) {
      problem(where, `docs[${i}] should be a php.net manual page name or an absolute URL: ${doc.href}`);
    }
  });
}

// curriculum cross-check (only meaningful for a full run of the canonical folder)
if (!filter && path.resolve(dir) === path.resolve(ROOT, 'public', 'course', 'content', 'lessons')) {
try {
  const curriculum = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'course', 'content', 'curriculum.json'), 'utf8'));
  const listed = curriculum.modules.flatMap((m) => m.lessons);
  const present = fs.readdirSync(path.join(ROOT, 'public', 'course', 'content', 'lessons')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  listed.forEach((id) => {
    if (!present.includes(id)) problems.push(`curriculum: lists ${id} but content/lessons/${id}.json is missing`);
  });
  present.forEach((id) => {
    if (!listed.includes(id)) problems.push(`curriculum: ${id}.json exists but is not listed in curriculum.json`);
  });
} catch (err) {
  problems.push(`curriculum.json: ${err.message}`);
}
}

const unique = [...new Set(problems)];
console.log(`\nchecked ${files.length} lesson(s), ${blocks} code block(s), ${runs} program run(s) with ${path.basename(PHP_BIN)}`);
if (notes.length) {
  console.log(`\nnotes (${notes.length}):`);
  notes.forEach((note) => console.log(`  - ${note}`));
}
if (unique.length) {
  console.log(`\nFAIL — ${unique.length} problem(s):`);
  unique.forEach((p) => console.log(`  ✗ ${p}`));
  process.exit(1);
}
console.log('\nPASS — every snippet linted and ran, every claimed output matched, every exercise solution passed its checks.');
