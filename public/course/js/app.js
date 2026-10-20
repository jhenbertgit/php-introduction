/* PHP, hands on — application.
   Renders chapters, runs snippets through the project's PHP 8.4, keeps progress.
   Every snippet can carry a simulated request (method, $_GET, $_POST, $_SESSION). */

(function () {
  'use strict';

  const { highlight, escapeHtml } = window.PHPHL;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const STORE_KEY = 'php-handson-v1';
  const MANUAL = 'https://www.php.net/manual/en/';

  /* ------------------------------------------------------------- progress -- */

  function defaultProgress() {
    return { v: 1, code: {}, requests: {}, exercise: {}, quiz: {}, visited: {}, lastVisited: null };
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultProgress();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultProgress(), parsed, {
        code: parsed.code || {},
        requests: parsed.requests || {},
        exercise: parsed.exercise || {},
        quiz: parsed.quiz || {},
        visited: parsed.visited || {},
      });
    } catch {
      return defaultProgress();
    }
  }

  const state = {
    online: false,
    php: null,
    note: 'checking the interpreter…',
    curriculum: null,
    manual: { groups: [], intro: '' },
    lessons: new Map(),
    order: [],
    currentId: null,
    progress: loadProgress(),
    exerciseUI: null,
  };

  function saveProgress() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.progress));
    } catch {
      /* storage may be unavailable; the course still works */
    }
  }

  const dom = {};

  /* ------------------------------------------------------------------ api -- */

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return res.json();
  }

  async function ping() {
    try {
      const payload = await fetchJson('run.php?ping=1');
      state.online = !!payload.ok;
      state.php = payload.php || null;
      state.note = payload.ok
        ? ''
        : payload.disabled
          ? 'the snippet runner is disabled on this server'
          : 'no PHP CLI found on this server';
    } catch {
      state.online = false;
      state.note = 'reading only — serve this folder with the project (docker compose up) to run code';
    }
  }

  async function runCode(code, request) {
    const res = await fetch('run.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Snippet-Runner': '1' },
      body: JSON.stringify({ code, request: request || {} }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `request failed (${res.status})`);
    return payload;
  }

  /* ------------------------------------------------------------- helpers -- */

  function sanitize(html) {
    const holder = document.createElement('div');
    holder.innerHTML = String(html || '');
    const allowed = new Set([
      'P', 'STRONG', 'EM', 'CODE', 'A', 'UL', 'OL', 'LI', 'BR', 'SPAN',
      'H3', 'H4', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUP', 'SUB',
    ]);
    holder.querySelectorAll('*').forEach((node) => {
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT') {
        node.remove();
        return;
      }
      if (!allowed.has(tag)) {
        node.replaceWith(...Array.from(node.childNodes));
        return;
      }
      Array.from(node.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') node.removeAttribute(attr.name);
      });
      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^\s*javascript:/i.test(href)) node.removeAttribute('href');
        if (/^https?:/i.test(href)) {
          node.target = '_blank';
          node.rel = 'noopener noreferrer';
        }
      }
    });
    return holder.innerHTML;
  }

  function docsHref(href) {
    const value = String(href || '');
    return /^https?:\/\//i.test(value) ? value : MANUAL + value.replace(/^\/+/, '');
  }

  function lessonMeta(id) {
    const lesson = state.lessons.get(id);
    if (!lesson) return null;
    for (const mod of state.curriculum.modules) {
      if (mod.lessons.includes(id)) return { lesson, mod };
    }
    return { lesson, mod: state.curriculum.modules[0] };
  }

  const chapterNumber = (id) => String(state.order.indexOf(id) + 1).padStart(2, '0');
  const isDone = (id) => state.progress.exercise[id] === 'passed';

  /* ------------------------------------------------------------ rail/toc -- */

  function buildToc() {
    const frag = document.createDocumentFragment();
    state.curriculum.modules.forEach((mod) => {
      const available = mod.lessons.filter((id) => state.lessons.has(id));
      if (!available.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'toc-module';
      wrap.innerHTML = `<div class="toc-module-head"><span class="toc-numeral">${escapeHtml(mod.numeral)}</span>
        <h2 class="toc-module-title">${escapeHtml(mod.title)}</h2></div>`;

      const list = document.createElement('ul');
      list.className = 'toc-list';
      available.forEach((id) => {
        const lesson = state.lessons.get(id);
        const li = document.createElement('li');
        li.innerHTML = `<a class="toc-link" href="#/c/${id}" data-lesson="${id}">
          <span class="toc-mark" aria-hidden="true"></span><span>${escapeHtml(lesson.title)}</span></a>`;
        list.appendChild(li);
      });
      wrap.appendChild(list);
      frag.appendChild(wrap);
    });

    const shelf = document.createElement('a');
    shelf.className = 'toc-shelf-link';
    shelf.href = '#/shelf';
    shelf.textContent = 'The manual and search';
    frag.appendChild(shelf);
    dom.toc.replaceChildren(frag);
  }

  function buildRail() {
    const frag = document.createDocumentFragment();
    state.order.forEach((id) => {
      const seg = document.createElement('span');
      seg.className = 'seg';
      seg.dataset.lesson = id;
      const lesson = state.lessons.get(id);
      seg.title = lesson ? `Chapter ${chapterNumber(id)} — ${lesson.title}` : id;
      frag.appendChild(seg);
    });
    dom.railProgress.replaceChildren(frag);
    updateProgressUI();
  }

  function updateProgressUI() {
    let done = 0;
    state.order.forEach((id) => {
      const passed = isDone(id);
      const visited = !!state.progress.visited[id];
      if (passed) done += 1;

      const seg = $(`.seg[data-lesson="${id}"]`, dom.railProgress);
      if (seg) {
        seg.classList.toggle('is-done', passed);
        seg.classList.toggle('is-visited', visited && !passed);
        seg.classList.toggle('is-current', id === state.currentId);
      }
      const link = $(`.toc-link[data-lesson="${id}"]`, dom.toc);
      if (link) {
        link.classList.toggle('is-done', passed);
        link.classList.toggle('is-visited', visited && !passed);
        link.classList.toggle('is-current', id === state.currentId);
        const mark = $('.toc-mark', link);
        if (mark) mark.textContent = passed ? '✓' : visited ? '·' : '';
      }
    });

    const total = state.order.length || 14;
    dom.railCount.textContent = `${done} / ${total}`;
    dom.railProgress.setAttribute('aria-label', `Course progress: ${done} of ${total} chapters complete`);
  }

  /* ---------------------------------------------------------- receipts ---- */

  function colorize(text) {
    return String(text || '')
      .split('\n')
      .map((line) => {
        let cls = null;
        if (/^\s*(PHP )?(Fatal error|Parse error)/i.test(line)) cls = 'd-err';
        else if (/^\s*Warning:/.test(line)) cls = 'd-warn';
        else if (/^\s*(Notice|Deprecated):/.test(line)) cls = 'd-help';
        else if (/^\s*Stack trace:/.test(line)) cls = 'd-frame';
        else if (/^#\d+\s/.test(line)) cls = 'd-frame';
        const safe = escapeHtml(line);
        return cls ? `<span class="${cls}">${safe}</span>` : safe;
      })
      .join('\n');
  }

  function describeRequest(request) {
    if (!request || (!request.method && !request.post && !request.get && !request.session)) return '';
    const parts = [String(request.method || 'GET').toUpperCase()];
    if (request.post && Object.keys(request.post).length) parts.push(`${Object.keys(request.post).length} POST field${Object.keys(request.post).length === 1 ? '' : 's'}`);
    if (request.get && Object.keys(request.get).length) parts.push(`${Object.keys(request.get).length} GET field${Object.keys(request.get).length === 1 ? '' : 's'}`);
    if (request.session) parts.push('session');
    return parts.join(' · ');
  }

  function buildReceipt(result, options) {
    const opts = options || {};
    const simulated = describeRequest(opts.request);
    const el = document.createElement('div');
    el.className = 'receipt';
    el.dataset.kind = result.ok ? 'ok' : 'err';

    let label;
    let body;
    if (result.stage === 'lint') {
      label = 'did not parse';
      body = String((result.compile && result.compile.stderr) || 'parse error').replace(/\s+$/, '');
    } else if (result.timeout) {
      label = 'stopped after 5 seconds';
      body = String((result.output && result.output.stdout) || '').replace(/\s+$/, '');
    } else if (result.output) {
      const out = String(result.output.stdout || '').replace(/\s+$/, '');
      const err = String(result.output.stderr || '').replace(/\s+$/, '');
      label = result.ok ? 'ran' : `exited with code ${result.output.code}`;
      body = [out, err].filter(Boolean).join('\n') || '(no output)';
    } else {
      label = 'no result';
      body = String(result.error || '');
    }

    const ms = result.output ? result.output.ms : 0;
    el.innerHTML = `
      <div class="receipt-head">
        <span class="cmd">$ php snippet.php${simulated ? ` <span class="d-loc">[${escapeHtml(simulated)}]</span>` : ''}</span>
        <span class="spacer">${label}</span>
      </div>
      <pre class="receipt-body"></pre>
      <div class="receipt-foot">php ${escapeHtml(result.php || state.php || '8.4')} · ${ms} ms</div>`;

    const bodyEl = $('.receipt-body', el);
    bodyEl.innerHTML = result.stage === 'lint' ? colorize(body) : escapeHtml(body);
    return el;
  }

  function buildPendingReceipt(message) {
    const el = document.createElement('div');
    el.className = 'receipt is-running';
    el.dataset.kind = 'ok';
    el.innerHTML = `
      <div class="receipt-head"><span class="cmd">$ php snippet.php</span><span class="spacer">working</span></div>
      <pre class="receipt-body d-muted"></pre>`;
    $('.receipt-body', el).textContent = message || 'running…';
    return el;
  }

  function buildErrorReceipt(message) {
    const el = document.createElement('div');
    el.className = 'receipt';
    el.dataset.kind = 'err';
    el.innerHTML = `
      <div class="receipt-head"><span class="cmd">$ request</span><span class="spacer">failed</span></div>
      <pre class="receipt-body"></pre>`;
    $('.receipt-body', el).textContent = message;
    return el;
  }

  /* --------------------------------------------------------------- blocks -- */

  function renderBlock(block) {
    if (block.type === 'prose') {
      const div = document.createElement('div');
      div.className = 'prose';
      div.innerHTML = sanitize(block.html);
      return div;
    }

    if (block.type === 'callout') {
      const tone = ['help', 'warn', 'note'].includes(block.tone) ? block.tone : 'note';
      const aside = document.createElement('aside');
      aside.className = `callout tone-${tone}`;
      const label = tone === 'help' ? 'help:' : tone === 'warn' ? 'warning:' : 'note:';
      aside.innerHTML = `<span class="callout-label">${label}</span>${sanitize(block.html)}`;
      return aside;
    }

    if (block.type === 'diagram') {
      const figure = document.createElement('figure');
      figure.className = 'diagram';
      figure.innerHTML = block.title ? `<p class="diagram-title">${escapeHtml(block.title)}</p>` : '';
      const pre = document.createElement('pre');
      pre.textContent = block.ascii || '';
      figure.appendChild(pre);
      return figure;
    }

    if (block.type !== 'code') return document.createElement('div');

    const runnable = block.runnable !== false;
    const figure = document.createElement('figure');
    figure.className = 'snippet';

    const frame = document.createElement('div');
    frame.className = 'snippet-frame slab';

    const bar = document.createElement('div');
    bar.className = 'snippet-bar';
    const name = document.createElement('span');
    name.className = 'snippet-name';
    name.textContent = block.title || (runnable ? 'snippet.php' : 'fragment');
    bar.appendChild(name);

    if (block.request) {
      const chip = document.createElement('span');
      chip.className = 'req-chip';
      chip.textContent = describeRequest(block.request);
      bar.appendChild(chip);
    }

    let runBtn = null;
    if (runnable) {
      runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'snippet-btn is-run';
      runBtn.textContent = 'Run';
      bar.appendChild(runBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'snippet-btn';
      editBtn.textContent = 'Edit here';
      editBtn.addEventListener('click', () => {
        loadIntoBench(block.code, block.request || null);
        openBench();
      });
      bar.appendChild(editBtn);
    }

    const pre = document.createElement('pre');
    pre.className = 'hl';
    const codeEl = document.createElement('code');
    codeEl.innerHTML = highlight(block.code || '');
    pre.appendChild(codeEl);
    frame.appendChild(bar);
    frame.appendChild(pre);

    const out = document.createElement('div');
    out.className = 'snippet-out';
    out.hidden = true;
    frame.appendChild(out);
    figure.appendChild(frame);

    if (block.output) {
      const note = document.createElement('p');
      note.className = 'snippet-note';
      note.innerHTML = `prints <b>${escapeHtml(String(block.output).replace(/\n/g, ' ⏎ '))}</b>`;
      figure.appendChild(note);
    }

    if (runBtn) {
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        runBtn.textContent = 'Running';
        out.hidden = false;
        out.replaceChildren(buildPendingReceipt('running snippet.php…'));
        try {
          const result = await runCode(block.code, block.request || {});
          out.replaceChildren(buildReceipt(result, { request: block.request }));
        } catch (err) {
          out.replaceChildren(buildErrorReceipt(err.message));
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = 'Run';
        }
      });
    }

    return figure;
  }

  /* ----------------------------------------------------------------- quiz -- */

  function renderQuiz(lesson) {
    const items = Array.isArray(lesson.quiz) ? lesson.quiz : [];
    if (!items.length) return null;

    const section = document.createElement('section');
    section.className = 'quiz';
    section.innerHTML = '<h2 class="quiz-head">Check yourself</h2>';
    const saved = Array.isArray(state.progress.quiz[lesson.id]) ? state.progress.quiz[lesson.id] : [];

    items.forEach((item, qi) => {
      const wrap = document.createElement('div');
      wrap.className = 'quiz-item';
      const q = document.createElement('p');
      q.className = 'quiz-q';
      q.innerHTML = sanitize(item.q);
      wrap.appendChild(q);

      const opts = document.createElement('div');
      opts.className = 'quiz-opts';
      const why = document.createElement('p');
      why.className = 'quiz-why';
      why.hidden = true;
      why.innerHTML = sanitize(item.why || '');

      const buttons = [];
      (item.options || []).forEach((option, oi) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quiz-opt';
        btn.innerHTML = `<span class="mark" aria-hidden="true"></span><span>${sanitize(option)}</span>`;
        btn.addEventListener('click', () => {
          const correct = oi === item.answer;
          buttons.forEach((b, bi) => {
            b.disabled = true;
            if (bi === item.answer) {
              b.classList.add('is-right');
              $('.mark', b).textContent = '✓';
            } else if (bi === oi) {
              b.classList.add('is-wrong');
              $('.mark', b).textContent = '×';
            }
          });
          why.hidden = false;
          why.classList.toggle('is-wrong', !correct);
          if (!Array.isArray(state.progress.quiz[lesson.id])) state.progress.quiz[lesson.id] = [];
          state.progress.quiz[lesson.id][qi] = oi;
          saveProgress();
        });
        opts.appendChild(btn);
        buttons.push(btn);
      });

      wrap.appendChild(opts);
      wrap.appendChild(why);
      section.appendChild(wrap);

      const answered = saved[qi];
      if (typeof answered === 'number') {
        buttons.forEach((b, bi) => {
          b.disabled = true;
          if (bi === item.answer) {
            b.classList.add('is-right');
            $('.mark', b).textContent = '✓';
          } else if (bi === answered) {
            b.classList.add('is-wrong');
            $('.mark', b).textContent = '×';
          }
        });
        why.hidden = false;
        why.classList.toggle('is-wrong', answered !== item.answer);
      }
    });

    return section;
  }

  /* ------------------------------------------------------------- exercise -- */

  function checkResult(lesson, result) {
    const checks = (lesson.exercise && lesson.exercise.checks) || [];
    const compiled = !!result && result.stage !== 'lint';
    const stdout = String((result && result.output && result.output.stdout) || '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
    const lines = stdout.split('\n').filter((l) => l.trim().length);

    return checks.map((check) => {
      switch (check.kind) {
        case 'compiles':
          return { ok: compiled, label: 'it runs' };
        case 'outputEquals':
          return { ok: compiled && stdout === String(check.value).trim(), label: `output is exactly ${JSON.stringify(String(check.value))}` };
        case 'outputContains':
          return { ok: compiled && stdout.includes(String(check.value)), label: `output contains ${JSON.stringify(String(check.value))}` };
        case 'stdoutLines':
          return { ok: compiled && lines.length === Number(check.value), label: `prints ${check.value} non-empty line${Number(check.value) === 1 ? '' : 's'}` };
        default:
          return { ok: false, label: 'unknown check' };
      }
    });
  }

  function renderExercise(lesson) {
    if (!lesson.exercise) return null;
    const ex = lesson.exercise;

    const section = document.createElement('section');
    section.className = 'exercise';
    const head = document.createElement('div');
    head.className = 'exercise-head';
    head.innerHTML = '<h3>Exercise</h3><span class="exercise-state">not checked</span>';
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'exercise-body';
    const brief = document.createElement('p');
    brief.className = 'exercise-brief';
    brief.innerHTML = sanitize(ex.brief);
    body.appendChild(brief);

    const actions = document.createElement('div');
    actions.className = 'exercise-actions';

    const writeBtn = document.createElement('button');
    writeBtn.type = 'button';
    writeBtn.className = 'btn';
    writeBtn.textContent = 'Write it in the workbench';
    writeBtn.addEventListener('click', () => {
      loadIntoBench(state.progress.code[lesson.id] || ex.starter, ex.request || null);
      openBench();
      dom.editor.focus();
    });
    actions.appendChild(writeBtn);

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'btn btn-run';
    checkBtn.textContent = 'Check my answer';
    checkBtn.addEventListener('click', () => {
      if (state.currentId === lesson.id) runBench(true);
    });
    actions.appendChild(checkBtn);

    let hintEl = null;
    if (ex.hint) {
      const hintBtn = document.createElement('button');
      hintBtn.type = 'button';
      hintBtn.className = 'btn btn-quiet';
      hintBtn.textContent = 'Hint';
      hintEl = document.createElement('div');
      hintEl.className = 'exercise-hint';
      hintEl.hidden = true;
      hintEl.innerHTML = sanitize(ex.hint);
      hintBtn.addEventListener('click', () => {
        hintEl.hidden = !hintEl.hidden;
        hintBtn.textContent = hintEl.hidden ? 'Hint' : 'Hide hint';
      });
      actions.appendChild(hintBtn);
    }

    let solEl = null;
    if (ex.solution) {
      const solBtn = document.createElement('button');
      solBtn.type = 'button';
      solBtn.className = 'btn btn-quiet';
      solBtn.textContent = 'Solution';
      solEl = document.createElement('div');
      solEl.className = 'exercise-solution';
      solEl.hidden = true;
      solEl.innerHTML = '<pre></pre>';
      $('pre', solEl).textContent = ex.solution;
      solBtn.addEventListener('click', () => {
        solEl.hidden = !solEl.hidden;
        solBtn.textContent = solEl.hidden ? 'Solution' : 'Hide solution';
      });
      actions.appendChild(solBtn);
    }

    body.appendChild(actions);
    if (hintEl) body.appendChild(hintEl);
    if (solEl) body.appendChild(solEl);

    const checkList = document.createElement('ul');
    checkList.className = 'exercise-checks';
    checkList.hidden = true;
    body.appendChild(checkList);
    section.appendChild(body);

    state.exerciseUI = {
      lessonId: lesson.id,
      stateEl: $('.exercise-state', head),
      checkList,
      checkBtn,
    };
    applyExerciseState(lesson);
    return section;
  }

  function applyExerciseState(lesson) {
    const ui = state.exerciseUI;
    if (!ui || ui.lessonId !== lesson.id) return;
    const passed = isDone(lesson.id);
    ui.stateEl.classList.toggle('is-pass', passed);
    ui.stateEl.textContent = passed ? 'passed' : 'not checked';
  }

  function paintChecks(results, passed) {
    const ui = state.exerciseUI;
    if (!ui) return;
    ui.checkList.hidden = false;
    ui.checkList.replaceChildren(...results.map((r) => {
      const li = document.createElement('li');
      li.className = r.ok ? 'pass' : 'fail';
      li.innerHTML = `<span class="tick" aria-hidden="true">${r.ok ? '✓' : '×'}</span><span>${escapeHtml(r.label)}</span>`;
      return li;
    }));
    ui.stateEl.classList.toggle('is-pass', passed);
    ui.stateEl.textContent = passed ? 'passed' : 'not yet';
  }

  /* --------------------------------------------------------------- lesson -- */

  function renderLesson(id) {
    const meta = lessonMeta(id);
    if (!meta) return;
    const { lesson, mod } = meta;

    state.currentId = id;
    state.progress.visited[id] = true;
    state.progress.lastVisited = id;
    saveProgress();

    const inner = document.createElement('div');
    inner.className = 'lesson-inner';

    const head = document.createElement('header');
    head.className = 'chapter-head';
    head.innerHTML = `
      <div class="chapter-eyebrow">
        <span>Chapter ${escapeHtml(chapterNumber(id))}</span><span class="dot">·</span>
        <span>${escapeHtml(mod.title)}</span><span class="dot">·</span>
        <span>${escapeHtml(String(lesson.minutes || 8))} min</span>
      </div>
      <h1 class="chapter-title">${escapeHtml(lesson.title)}</h1>
      <p class="chapter-summary">${escapeHtml(lesson.summary || '')}</p>`;
    inner.appendChild(head);

    (lesson.blocks || []).forEach((block) => {
      const node = renderBlock(block);
      if (node) inner.appendChild(node);
    });

    const quiz = renderQuiz(lesson);
    if (quiz) inner.appendChild(quiz);
    const exercise = renderExercise(lesson);
    if (exercise) inner.appendChild(exercise);
    const docs = renderDocs(lesson);
    if (docs) inner.appendChild(docs);
    inner.appendChild(renderChapterNav(id));

    dom.lesson.replaceChildren(inner);
    dom.lesson.scrollTop = 0;
    dom.lesson.focus({ preventScroll: true });

    bindBench(lesson);
    updateProgressUI();
    closeToc();
    document.title = `${lesson.title} — PHP, hands on`;
    if (window.innerWidth <= 900) closeBench();
  }

  function renderDocs(lesson) {
    const links = Array.isArray(lesson.docs) ? lesson.docs : [];
    if (!links.length) return null;
    const list = document.createElement('ul');
    list.className = 'docs-list';
    links.forEach((link) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = docsHref(link.href);
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `<span class="arrow" aria-hidden="true">→</span><span>${escapeHtml(link.label)}</span><span class="doc-kind">php.net</span>`;
      li.appendChild(a);
      list.appendChild(li);
    });
    return list;
  }

  function renderChapterNav(id) {
    const nav = document.createElement('nav');
    nav.className = 'chapter-nav';
    const idx = state.order.indexOf(id);
    const prev = idx > 0 ? state.order[idx - 1] : null;
    const next = idx >= 0 && idx < state.order.length - 1 ? state.order[idx + 1] : null;

    if (prev) {
      const a = document.createElement('a');
      a.href = `#/c/${prev}`;
      a.innerHTML = `<span class="nav-dir">Previous</span><span class="nav-title">${escapeHtml(state.lessons.get(prev).title)}</span>`;
      nav.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'spacer';
      nav.appendChild(span);
    }

    const a = document.createElement('a');
    a.className = 'is-next';
    if (next) {
      a.href = `#/c/${next}`;
      a.innerHTML = `<span class="nav-dir">Next chapter</span><span class="nav-title">${escapeHtml(state.lessons.get(next).title)}</span>`;
    } else {
      a.href = '#/shelf';
      a.innerHTML = '<span class="nav-dir">Finished</span><span class="nav-title">Where to read next</span>';
    }
    nav.appendChild(a);
    return nav;
  }

  /* ---------------------------------------------------------------- shelf -- */

  function renderShelf() {
    state.currentId = null;
    const inner = document.createElement('div');
    inner.className = 'shelf-inner';

    inner.innerHTML = `
      <h1 class="shelf-title">The manual</h1>
      <p class="shelf-intro">${escapeHtml(state.manual.intro || '')}</p>
      ${state.online ? '' : `<p class="shelf-note hosted-note">${escapeHtml(state.note)}</p>`}
      <form class="std-search" id="std-form">
        <input type="search" name="pattern" id="std-input" placeholder="Search php.net — try array_map, match, session_start" aria-label="Search the PHP manual">
        <button class="btn" type="submit">Search the manual</button>
      </form>`;

    (state.manual.groups || []).forEach((group) => {
      const section = document.createElement('section');
      section.className = 'shelf-group';
      section.innerHTML = `<h2>${escapeHtml(group.title)}</h2>`;
      (group.items || []).forEach((item) => {
        const a = document.createElement('a');
        a.className = 'shelf-item';
        a.href = docsHref(item.href);
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = `<span class="shelf-label">${escapeHtml(item.label)}</span>
          ${item.tag ? `<span class="shelf-tag">${escapeHtml(item.tag)}</span>` : ''}
          <span class="shelf-note">${escapeHtml(item.note || '')}</span>`;
        section.appendChild(a);
      });
      inner.appendChild(section);
    });

    if (state.curriculum.afterword) {
      const after = state.curriculum.afterword;
      const section = document.createElement('section');
      section.className = 'afterword';
      section.innerHTML = `<h2>${escapeHtml(after.title)}</h2><p class="prose">${escapeHtml(after.body)}</p>`;
      const list = document.createElement('ul');
      list.className = 'afterword-links';
      (after.links || []).forEach((link) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = docsHref(link.href);
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = `<span class="arrow" aria-hidden="true">→</span><span>${escapeHtml(link.label)}</span><span class="note">${escapeHtml(link.note || '')}</span>`;
        li.appendChild(a);
        list.appendChild(li);
      });
      section.appendChild(list);
      inner.appendChild(section);
    }

    dom.lesson.replaceChildren(inner);
    dom.lesson.scrollTop = 0;
    updateProgressUI();
    closeToc();
    document.title = 'The manual — PHP, hands on';

    $('#std-form', inner).addEventListener('submit', (event) => {
      event.preventDefault();
      const q = $('#std-input', inner).value.trim();
      window.open(`https://www.php.net/manual-lookup.php?pattern=${encodeURIComponent(q)}`, '_blank', 'noopener');
    });
  }

  /* ---------------------------------------------------------------- bench -- */

  function paintEditor() {
    const code = dom.editor.value;
    $('code', dom.editorHl).innerHTML = `${highlight(code)}\n`;
    const lineCount = code.split('\n').length;
    let numbers = '';
    for (let i = 1; i <= lineCount; i += 1) numbers += `${i}\n`;
    dom.gutter.textContent = numbers;
    syncEditorScroll();
  }

  function syncEditorScroll() {
    dom.editorHl.scrollTop = dom.editor.scrollTop;
    dom.editorHl.scrollLeft = dom.editor.scrollLeft;
    dom.gutter.scrollTop = dom.editor.scrollTop;
  }

  function setEditorCode(code) {
    dom.editor.value = code || '';
    paintEditor();
    dom.editor.scrollTop = 0;
    dom.editor.scrollLeft = 0;
    syncEditorScroll();
  }

  function loadIntoBench(code, request) {
    setEditorCode(code);
    setRequest(request || null);
  }

  function setStatus(text, kind) {
    dom.benchStatus.textContent = text || '';
    dom.benchStatus.className = `bench-status${kind ? ` is-${kind}` : ''}`;
  }

  function setRequest(request) {
    if (!request) {
      dom.benchReq.hidden = true;
      dom.benchMode.textContent = 'no request';
      dom.reqMethod.value = 'POST';
      dom.reqJson.value = '';
      return;
    }
    dom.benchReq.hidden = false;
    dom.reqMethod.value = String(request.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
    const payload = {};
    if (request.get && Object.keys(request.get).length) payload.get = request.get;
    if (request.post && Object.keys(request.post).length) payload.post = request.post;
    if (request.session) payload.session = request.session;
    dom.reqJson.value = Object.keys(payload).length ? JSON.stringify(payload, null, 2) : '';
    dom.benchMode.textContent = describeRequest(request) || 'request';
  }

  /** Read the request panel. Returns { request } or { error }. */
  function readRequest() {
    if (dom.benchReq.hidden) return { request: {} };
    const method = dom.reqMethod.value;
    const text = dom.reqJson.value.trim();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return { error: `the request JSON is not valid: ${err.message}` };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'the request must be a JSON object' };
      }
    }

    const request = { method };
    const known = ['get', 'post', 'session'].some((key) => key in parsed);
    if (known) {
      if (parsed.get) request.get = parsed.get;
      if (parsed.post) request.post = parsed.post;
      if (parsed.session) request.session = parsed.session;
    } else if (Object.keys(parsed).length) {
      // A bare object is the obvious shorthand: fields for the chosen method.
      if (method === 'GET') request.get = parsed;
      else request.post = parsed;
    }
    return { request };
  }

  function emptyBenchOutput() {
    const div = document.createElement('div');
    div.className = 'bench-out-empty';
    div.innerHTML = state.online
      ? `<p>Run a snippet and the interpreter's answer lands here.</p>
      <p class="bench-out-sub">Executed by the PHP ${escapeHtml(state.php || '8.4')} in this project. The Request panel simulates a form submission or a session.</p>`
      : `<p>Run a snippet and the answer lands here.</p>
      <p class="bench-out-sub">${escapeHtml(state.note)}</p>`;
    dom.benchOut.replaceChildren(div);
  }

  function bindBench(lesson) {
    const ex = lesson.exercise || {};
    const saved = state.progress.code[lesson.id];
    const storedRequest = state.progress.requests[lesson.id];
    loadIntoBench(saved || ex.starter || '<?php\n\necho "hello";\n', ex.request || storedRequest || null);
    dom.benchFilename.textContent = 'snippet.php';
    setStatus(state.online ? '' : 'read only', state.online ? '' : 'err');
    emptyBenchOutput();
  }

  function saveEditorCode() {
    if (!state.currentId) return;
    state.progress.code[state.currentId] = dom.editor.value;
    if (!dom.benchReq.hidden) {
      state.progress.requests[state.currentId] = { method: dom.reqMethod.value, json: dom.reqJson.value };
    }
    saveProgress();
  }

  function insertAtCursor(text) {
    const start = dom.editor.selectionStart;
    const end = dom.editor.selectionEnd;
    dom.editor.setRangeText(text, start, end, 'end');
    paintEditor();
    saveEditorCode();
  }

  async function runBench(checkExercise) {
    const lesson = state.lessons.get(state.currentId);
    if (!lesson) return;

    const parsed = readRequest();
    dom.benchReq.classList.toggle('is-bad', !!parsed.error);
    if (parsed.error) {
      setStatus('bad request JSON', 'err');
      dom.benchOut.replaceChildren(buildErrorReceipt(parsed.error));
      dom.reqJson.focus();
      return;
    }
    if (!state.online) {
      setStatus('no interpreter', 'err');
      dom.benchOut.replaceChildren(buildErrorReceipt(state.note || 'the interpreter is not reachable'));
      return;
    }

    dom.runBtn.disabled = true;
    dom.checkBtn.disabled = true;
    setStatus('running…', 'busy');
    dom.benchOut.replaceChildren(buildPendingReceipt('executing snippet.php…'));

    try {
      const result = await runCode(dom.editor.value, parsed.request);
      dom.benchOut.replaceChildren(buildReceipt(result, { request: parsed.request }));

      if (result.ok) setStatus(`ran · ${result.output.ms} ms`, 'ok');
      else if (result.stage === 'lint') setStatus('did not parse — read the message', 'err');
      else setStatus(`exited with code ${result.output ? result.output.code : '?'}`, 'err');

      if (lesson.exercise) {
        const results = checkResult(lesson, result);
        const passed = results.length > 0 && results.every((r) => r.ok);
        paintChecks(results, passed);
        if (passed) {
          state.progress.exercise[lesson.id] = 'passed';
          saveProgress();
          updateProgressUI();
          applyExerciseState(lesson);
          if (checkExercise) setStatus('exercise passed', 'ok');
        } else if (checkExercise) {
          setStatus('not yet — the checks below say what is missing', 'err');
        }
      }
    } catch (err) {
      dom.benchOut.replaceChildren(buildErrorReceipt(err.message));
      setStatus('could not reach the interpreter', 'err');
    } finally {
      dom.runBtn.disabled = false;
      dom.checkBtn.disabled = false;
    }
  }

  function openBench() {
    dom.bench.classList.add('is-open');
    if (window.innerWidth <= 900) dom.scrim.hidden = false;
  }

  function closeBench() {
    dom.bench.classList.remove('is-open');
    dom.scrim.hidden = true;
  }

  function openToc() {
    dom.toc.classList.add('is-open');
    dom.btnToc.setAttribute('aria-expanded', 'true');
    dom.scrim.hidden = false;
  }

  function closeToc() {
    dom.toc.classList.remove('is-open');
    dom.btnToc.setAttribute('aria-expanded', 'false');
    if (!dom.bench.classList.contains('is-open')) dom.scrim.hidden = true;
  }

  /* --------------------------------------------------------------- search -- */

  function setupSearch() {
    const input = dom.searchInput;
    const results = dom.searchResults;
    const close = () => {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    };

    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        close();
        return;
      }
      const matches = state.order
        .map((id) => ({ id, lesson: state.lessons.get(id), meta: lessonMeta(id) }))
        .filter(({ lesson }) => {
          const hay = [lesson.title, lesson.summary, (lesson.keywords || []).join(' ')].join(' ').toLowerCase();
          return hay.includes(q);
        })
        .slice(0, 8);

      results.replaceChildren();
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'r-empty';
        empty.textContent = `No chapter mentions “${input.value.trim()}”.`;
        results.appendChild(empty);
      } else {
        matches.forEach(({ id, lesson, meta }) => {
          const a = document.createElement('a');
          a.href = `#/c/${id}`;
          a.innerHTML = `${escapeHtml(lesson.title)}<span class="r-meta">Chapter ${chapterNumber(id)} · ${escapeHtml(meta.mod.title)}</span>`;
          a.addEventListener('click', close);
          results.appendChild(a);
        });
      }
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = '';
        close();
        input.blur();
      } else if (event.key === 'Enter') {
        const first = results.querySelector('a');
        if (first) {
          first.click();
          input.value = '';
          close();
        }
      }
    });
    document.addEventListener('click', (event) => {
      if (!input.closest('.search').contains(event.target)) close();
    });
  }

  /* -------------------------------------------------------------- wiring --- */

  function setupEditor() {
    paintEditor();
    dom.editor.addEventListener('input', () => {
      paintEditor();
      saveEditorCode();
    });
    dom.editor.addEventListener('scroll', syncEditorScroll, { passive: true });
    dom.reqJson.addEventListener('input', () => {
      dom.benchReq.classList.remove('is-bad');
      saveEditorCode();
    });

    dom.editor.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        insertAtCursor('    ');
        return;
      }
      if (event.key === 'Enter') {
        const value = dom.editor.value;
        const pos = dom.editor.selectionStart;
        const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
        const line = value.slice(lineStart, pos);
        const indent = (/^[ \t]*/.exec(line) || [''])[0];
        const opensBlock = /\{\s*$/.test(line);
        if (opensBlock || indent) {
          event.preventDefault();
          const insertion = `\n${indent}${opensBlock ? '    ' : ''}`;
          dom.editor.setRangeText(insertion, pos, dom.editor.selectionEnd, 'end');
          paintEditor();
          saveEditorCode();
        }
      }
    });

    dom.runBtn.addEventListener('click', () => runBench(false));
    dom.checkBtn.addEventListener('click', () => runBench(true));
    dom.btnReset.addEventListener('click', () => {
      const lesson = state.lessons.get(state.currentId);
      if (!lesson) return;
      const starter = (lesson.exercise && lesson.exercise.starter) || '';
      loadIntoBench(starter, (lesson.exercise && lesson.exercise.request) || null);
      if (state.currentId) delete state.progress.code[state.currentId];
      saveProgress();
      setStatus('reset to the starting code');
      emptyBenchOutput();
      applyExerciseState(lesson);
      if (state.exerciseUI) state.exerciseUI.checkList.hidden = true;
    });
    dom.btnSolution.addEventListener('click', () => {
      const lesson = state.lessons.get(state.currentId);
      if (!lesson || !lesson.exercise || !lesson.exercise.solution) return;
      setEditorCode(lesson.exercise.solution);
      saveEditorCode();
      setStatus('solution loaded — run it, then write your own');
    });

    const toggleRequest = () => {
      if (!dom.benchReq.hidden && dom.reqJson.value.trim() === '') {
        dom.benchReq.hidden = true;
        dom.benchMode.textContent = 'no request';
        return;
      }
      dom.benchReq.hidden = false;
      dom.reqJson.focus();
    };
    dom.btnReq.addEventListener('click', toggleRequest);
    dom.btnReqClear.addEventListener('click', () => {
      dom.reqJson.value = '';
      dom.benchReq.classList.remove('is-bad');
      dom.benchMode.textContent = dom.reqMethod.value;
      saveEditorCode();
    });
    dom.reqMethod.addEventListener('change', () => {
      dom.benchMode.textContent = dom.reqMethod.value;
      saveEditorCode();
    });

    dom.btnToc.addEventListener('click', () => {
      if (dom.toc.classList.contains('is-open')) closeToc();
      else openToc();
    });
    dom.btnBenchClose.addEventListener('click', closeBench);
    dom.scrim.addEventListener('click', () => {
      closeToc();
      closeBench();
    });
  }

  function setupGlobalKeys() {
    document.addEventListener('keydown', (event) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
      if (event.key === '/' && !inField) {
        event.preventDefault();
        dom.searchInput.focus();
        return;
      }
      if (event.key === 'Escape') {
        closeToc();
        if (window.innerWidth <= 900) closeBench();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runBench(false);
      }
    });
  }

  /* ----------------------------------------------------------------- boot -- */

  function resumeTarget() {
    const last = state.progress.lastVisited;
    if (last && state.lessons.has(last)) return last;
    const unfinished = state.order.find((id) => !isDone(id));
    return unfinished || state.order[0];
  }

  function route() {
    const hash = location.hash.replace(/^#/, '');
    if (hash.startsWith('/shelf')) {
      renderShelf();
      return;
    }
    const match = /^\/c\/([\w-]+)/.exec(hash);
    const id = match && state.lessons.has(match[1]) ? match[1] : resumeTarget();
    if (!id) {
      dom.lesson.innerHTML = '<div class="lesson-inner"><p class="prose">No chapters found. Check that content/lessons exists.</p></div>';
      return;
    }
    if (state.currentId !== id) renderLesson(id);
    if (!match) renderLesson(id);
  }

  const ELEMENT_IDS = {
    toc: 'toc',
    lesson: 'lesson-body',
    bench: 'bench',
    benchOut: 'bench-out',
    benchStatus: 'bench-status',
    benchFilename: 'bench-filename',
    benchMode: 'bench-mode',
    benchReq: 'bench-req',
    editor: 'editor',
    editorHl: 'editor-hl',
    gutter: 'gutter',
    reqMethod: 'req-method',
    reqJson: 'req-json',
    runBtn: 'btn-run',
    checkBtn: 'btn-check',
    btnReset: 'btn-reset',
    btnSolution: 'btn-solution',
    btnReq: 'btn-req',
    btnReqClear: 'btn-req-clear',
    btnToc: 'btn-toc',
    btnBenchClose: 'btn-bench-close',
    scrim: 'scrim',
    railProgress: 'rail-progress',
    railCount: 'rail-count',
    railToolchain: 'rail-toolchain',
    searchInput: 'search-input',
    searchResults: 'search-results',
  };

  async function boot() {
    Object.entries(ELEMENT_IDS).forEach(([key, id]) => {
      dom[key] = document.getElementById(id);
    });

    setupEditor();
    setupSearch();
    setupGlobalKeys();

    try {
      await ping();
      const [curriculum, manual] = await Promise.all([
        fetchJson('content/curriculum.json'),
        fetchJson('content/bookshelf.json').catch(() => ({ groups: [], intro: '' })),
      ]);
      state.curriculum = curriculum;
      state.manual = manual;
      state.order = curriculum.modules.flatMap((mod) => mod.lessons);

      const loaded = await Promise.all(state.order.map(async (id) => {
        try {
          state.lessons.set(id, await fetchJson(`content/lessons/${id}.json`));
          return id;
        } catch (err) {
          console.warn(`lesson ${id} unavailable`, err);
          return null;
        }
      }));
      state.order = loaded.filter(Boolean);

      buildToc();
      buildRail();
      route();
      window.addEventListener('hashchange', route);

      dom.railToolchain.textContent = state.online ? `php ${state.php || ''}`.trim() : 'read only';
      dom.railToolchain.title = state.online
        ? `Snippets run on PHP ${state.php} in this project`
        : state.note;
      emptyBenchOutput();
    } catch (err) {
      dom.lesson.innerHTML = `<div class="lesson-inner"><h1 class="chapter-title">Cannot load the course</h1>
        <p class="prose">${escapeHtml(err.message)}</p>
        <p class="prose">Serve this folder with the project: <code>docker compose up -d</code>, then open <code>http://localhost/course/</code>.</p></div>`;
    }
  }

  boot();
}());
