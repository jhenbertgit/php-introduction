/* ---------------------------------------------------------------------------
   Interactive layer for the PHP 8.4 docs.

   Every PHP code block becomes editable and gains a Run button that executes the
   snippet through public/docs/runner.php (the local Docker app's PHP 8.4). When
   the runner is not reachable — the GitHub Pages copy, for instance — the blocks
   stay readable, Run is disabled, and the chip says why.

   No build step, no dependencies: this file is loaded by index.html directly.
   --------------------------------------------------------------------------- */

(function () {
  'use strict';

  var RUNNER = 'runner.php';
  var state = { online: false, php: null, note: 'checking for a local runner…' };
  var blocks = [];
  var chip = null;

  // ---------------------------------------------------------------- helpers --

  function normalise(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(function (line) { return line.replace(/[ \t]+$/, ''); })
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function highlightSource(source) {
    if (typeof Prism !== 'undefined' && Prism.languages && Prism.languages.php) {
      try {
        return Prism.highlight(source, Prism.languages.php, 'php');
      } catch (err) {
        /* fall through to plain text */
      }
    }
    return null;
  }

  function expectedOutputFor(block) {
    var next = block.nextElementSibling;
    while (next && next.nodeType === 1 && !next.classList.contains('code-output')) {
      if (next.classList.contains('code-block')) return null;
      next = next.nextElementSibling;
    }
    if (!next) return null;
    var pre = next.querySelector('pre');
    return pre ? pre.textContent : null;
  }

  function expectedBoxFor(block) {
    var next = block.nextElementSibling;
    while (next && next.nodeType === 1 && !next.classList.contains('code-output')) {
      if (next.classList.contains('code-block')) return null;
      next = next.nextElementSibling;
    }
    return next && next.classList.contains('code-output') ? next : null;
  }

  // ------------------------------------------------------------------- chip --

  function mountChip() {
    chip = el('div', 'run-chip');
    chip.setAttribute('role', 'status');
    chip.appendChild(el('span', 'run-chip__dot'));
    chip.appendChild(el('span', 'run-chip__text', state.note));
    document.body.appendChild(chip);
  }

  function paintChip() {
    if (!chip) return;
    chip.dataset.online = state.online ? 'true' : 'false';
    chip.querySelector('.run-chip__text').textContent = state.online
      ? 'Live PHP ' + state.php + ' — every block is runnable'
      : state.note;
  }

  // ----------------------------------------------------------------- runner --

  function probe() {
    return fetch(RUNNER + '?ping=1', {
      headers: { 'X-PHP-Docs-Runner': '1' },
      cache: 'no-store',
    })
      .then(function (res) {
        return res.ok ? res.json() : Promise.reject(new Error('status ' + res.status));
      })
      .then(function (payload) {
        state.online = !!payload.ok;
        state.php = payload.php || null;
        state.note = payload.ok
          ? ''
          : payload.disabled
            ? 'Runner disabled on this server (runner.disabled present)'
            : 'No PHP CLI on the server';
      })
      .catch(function () {
        state.online = false;
        state.note = 'Reading only — start the local app (docker compose up) to run code';
      });
  }

  function callRunner(code) {
    return fetch(RUNNER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PHP-Docs-Runner': '1',
      },
      body: JSON.stringify({ code: code, timeoutMs: 5000 }),
    }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok) throw new Error(payload.error || 'runner answered ' + res.status);
        return payload;
      });
    });
  }

  // ----------------------------------------------------------------- blocks --

  function enhance(block) {
    var codeEl = block.querySelector('code');
    var pre = block.querySelector('pre');
    if (!codeEl || !pre) return null;

    var record = {
      block: block,
      pre: pre,
      codeEl: codeEl,
      original: codeEl.textContent.replace(/\t/g, '    '),
      expected: expectedOutputFor(block),
      expectedBox: expectedBoxFor(block),
      textarea: null,
      runBtn: null,
      statusEl: null,
      outEl: null,
      running: false,
    };

    // --- toolbar
    var bar = el('div', 'run-bar');

    var runBtn = el('button', 'run-btn');
    runBtn.type = 'button';
    runBtn.innerHTML = '<span class="run-btn__icon">▷</span> Run';
    runBtn.title = 'Run this snippet on the local PHP (Ctrl or Cmd + Enter)';
    bar.appendChild(runBtn);

    var resetBtn = el('button', 'run-quiet', 'Reset');
    resetBtn.type = 'button';
    resetBtn.title = 'Restore the original code';
    bar.appendChild(resetBtn);

    bar.appendChild(el('span', 'run-bar__spacer'));

    var statusEl = el('span', 'run-status', '');
    bar.appendChild(statusEl);

    // The docs' own copy button belongs in the bar, not floating over the code.
    var copyBtn = block.querySelector('.code-block__copy');
    if (copyBtn) bar.appendChild(copyBtn);

    var existingBar = block.querySelector('.run-bar');
    if (existingBar) existingBar.replaceWith(bar);
    else block.insertBefore(bar, block.firstChild);

    // --- editable overlay: highlighted <pre> stays, transparent textarea on top
    var editorWrap = el('div', 'run-edit');
    pre.replaceWith(editorWrap);
    editorWrap.appendChild(pre);

    var textarea = el('textarea', 'run-edit__input');
    textarea.value = record.original;
    textarea.spellcheck = false;
    textarea.setAttribute('wrap', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('aria-label', 'PHP code, editable');
    editorWrap.appendChild(textarea);

    record.textarea = textarea;
    record.runBtn = runBtn;
    record.statusEl = statusEl;
    record.editorWrap = editorWrap;

    // --- output panel
    var out = el('div', 'run-out');
    out.hidden = true;
    var head = el('div', 'run-out__head');
    var label = el('span', 'run-out__label', 'Output');
    head.appendChild(label);
    var meta = el('span', 'run-out__meta');
    head.appendChild(meta);
    out.appendChild(head);
    var body = el('pre', 'run-out__body');
    out.appendChild(body);
    record.outEl = out;
    record.outBody = body;
    record.outMeta = meta;
    record.outLabel = label;

    var anchor = record.expectedBox || block;
    anchor.insertAdjacentElement('afterend', out);

    // --- behaviour
    function repaint() {
      var markup = highlightSource(textarea.value);
      if (markup !== null) codeEl.innerHTML = markup + '\n';
      else codeEl.textContent = textarea.value + '\n';
      pre.scrollLeft = textarea.scrollLeft;
    }

    var repaintTimer = null;
    textarea.addEventListener('input', function () {
      if (repaintTimer) clearTimeout(repaintTimer);
      repaintTimer = setTimeout(repaint, 90);
    });
    textarea.addEventListener('scroll', function () {
      pre.scrollLeft = textarea.scrollLeft;
      pre.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener('keydown', function (event) {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
      event.preventDefault();
      execute();
    });

    runBtn.addEventListener('click', execute);
    resetBtn.addEventListener('click', function () {
      textarea.value = record.original;
      repaint();
      out.hidden = true;
      setStatus('', '');
      if (record.expectedBox) record.expectedBox.classList.remove('run-expected-hit');
    });

    function setStatus(text, kind) {
      statusEl.textContent = text || '';
      statusEl.dataset.state = kind || '';
    }

    function execute() {
      if (record.running) return;
      if (!state.online) {
        setStatus('no local runner', 'err');
        showOfflineNotice();
        return;
      }
      record.running = true;
      runBtn.disabled = true;
      setStatus('running…', 'busy');
      out.hidden = false;
      out.dataset.ok = 'pending';
      label.textContent = 'Output';
      meta.textContent = 'sending to the local PHP…';
      body.textContent = '';

      callRunner(textarea.value)
        .then(function (result) {
          record.running = false;
          runBtn.disabled = false;
          render(record, result);
        })
        .catch(function (err) {
          record.running = false;
          runBtn.disabled = false;
          out.dataset.ok = 'false';
          label.textContent = 'Runner error';
          meta.textContent = '';
          body.textContent = err.message;
          setStatus('runner error', 'err');
        });
    }

    function showOfflineNotice() {
      out.hidden = false;
      out.dataset.ok = 'false';
      label.textContent = 'Not runnable here';
      meta.textContent = '';
      body.textContent =
        'This copy is reading only. Run the app locally (docker compose up) and open it at ' +
        'http://localhost to execute snippets with PHP 8.4.';
    }

    // keep the toolbar honest about the runner state
    record.setStatus = setStatus;
    record.execute = execute;

    if (!state.online) {
      runBtn.disabled = true;
      runBtn.title = state.note;
      setStatus('offline', 'err');
    }

    return record;
  }

  function render(record, result) {
    var out = record.outEl;
    var body = record.outBody;
    var ok = !!result.ok;
    var stdout = result.output ? result.output.stdout : '';
    var stderr = result.output ? result.output.stderr : '';
    var lintFailed = result.stage === 'lint';

    out.dataset.ok = ok ? 'true' : 'false';

    if (lintFailed) {
      record.outLabel.textContent = 'Syntax error';
      record.outMeta.textContent = 'did not run';
      body.textContent = '';
      body.appendChild(el('span', 'run-err', (result.compile && result.compile.stderr) || 'parse error'));
      record.setStatus('syntax error', 'err');
      return;
    }

    if (result.timeout) {
      record.outLabel.textContent = 'Stopped';
      body.textContent = '';
      body.appendChild(el('span', 'run-err', 'The snippet ran longer than 5 seconds and was stopped.'));
      record.outMeta.textContent = 'timeout';
      record.setStatus('timed out', 'err');
      return;
    }

    var rendered = normalise(stdout);
    record.outLabel.textContent = ok ? 'Output' : 'Failed';
    record.outMeta.textContent = 'PHP ' + (result.php || '8.4') + ' · ' + (result.output ? result.output.ms : 0) + ' ms';

    body.textContent = '';
    if (rendered) {
      body.appendChild(document.createTextNode(rendered + '\n'));
    } else if (!stderr) {
      body.appendChild(el('span', 'run-soft', 'This snippet printed nothing.'));
    }
    if (stderr) {
      if (rendered) body.appendChild(document.createTextNode('\n'));
      body.appendChild(el('span', 'run-err', normalise(stderr)));
    }

    record.setStatus(ok ? 'ran in ' + (result.output ? result.output.ms : 0) + ' ms' : 'not ok', ok ? 'ok' : 'err');

    // Compare with the documented output when the page provides one. Exact equality is
    // the strong signal; "most lines present" is worth distinguishing from a real miss,
    // because var_dump formatting differs between PHP builds.
    if (record.expectedBox) {
      record.outEl.querySelectorAll('.run-check').forEach(function (n) { n.remove(); });
      if (!ok || stderr) {
        record.expectedBox.classList.remove('run-expected-hit');
      } else if (record.expected != null) {
        var want = normalise(record.expected);
        var verdict = 'differs';
        if (want === rendered) verdict = 'exact';
        else if (want && rendered && want.split('\n').every(function (line) {
          return line === '' || rendered.indexOf(line) !== -1;
        })) verdict = 'partial';

        record.expectedBox.classList.toggle('run-expected-hit', verdict === 'exact');

        var label = verdict === 'exact'
          ? '✓ matches the documented output'
          : verdict === 'partial'
            ? '≈ close to the documented output'
            : '✗ differs from the documented output';
        var badge = el('span', 'run-check', label);
        badge.dataset.match = verdict === 'exact' ? 'true' : verdict === 'partial' ? 'partial' : 'false';
        record.outMeta.parentNode.insertBefore(badge, record.outMeta);
      }
    }
  }

  // -------------------------------------------------------------------- boot --

  function collect() {
    var found = Array.prototype.slice.call(document.querySelectorAll('.code-block'));
    var records = [];
    found.forEach(function (block) {
      var code = block.querySelector('code');
      if (!code) return;
      var language = code.className || '';
      if (language.indexOf('language-php') === -1 && language.indexOf('language-html') === -1) return;
      var record = enhance(block);
      if (record) records.push(record);
    });
    return records;
  }

  function boot() {
    mountChip();
    paintChip();

    // Highlighting is already applied by the page; enhance the existing blocks.
    blocks = collect();

    probe().then(function () {
      paintChip();
      blocks.forEach(function (record) {
        if (state.online) {
          record.runBtn.disabled = false;
          record.runBtn.title = 'Run this snippet on the local PHP (Ctrl or Cmd + Enter)';
          record.setStatus('', '');
        } else {
          record.runBtn.disabled = true;
          record.runBtn.title = state.note;
          record.setStatus('offline', 'err');
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Exposed for tests and for the console.
  window.phpDocsInteractive = {
    get online() { return state.online; },
    get php() { return state.php; },
    get blocks() { return blocks; },
    runBlock: function (index) {
      var record = blocks[index];
      if (record) record.execute();
      return record ? record.textarea.value : null;
    },
  };
}());
