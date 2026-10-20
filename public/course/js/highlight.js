/* Minimal PHP tokenizer for display. Not a parser: it colours what PHP looks like so the
   eye can find variables, keywords, strings and comments quickly. */
(function () {
  'use strict';

  const KEYWORDS = new Set([
    'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone',
    'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty',
    'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'enum', 'extends',
    'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if', 'implements',
    'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset', 'list', 'match',
    'namespace', 'new', 'or', 'print', 'private', 'protected', 'public', 'readonly', 'require',
    'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try', 'unset', 'use', 'var',
    'while', 'xor', 'yield', 'true', 'false', 'null', 'int', 'float', 'string', 'bool', 'void',
    'iterable', 'object', 'mixed', 'never', 'self', 'parent', 'this',
  ]);

  const BUILTINS = new Set([
    'count', 'array_map', 'array_filter', 'array_sum', 'array_keys', 'array_combine',
    'array_values', 'array_merge', 'array_key_exists', 'in_array', 'sort', 'usort', 'ksort',
    'implode', 'explode', 'strlen', 'strtoupper', 'strtolower', 'str_replace', 'substr',
    'trim', 'sprintf', 'printf', 'number_format', 'json_encode', 'json_decode', 'var_dump',
    'print_r', 'htmlspecialchars', 'intdiv', 'is_int', 'is_numeric', 'is_array', 'gettype',
    'session_start', 'session_destroy', 'setcookie', 'header', 'define', 'defined', 'constant',
    'max', 'min', 'round', 'floor', 'ceil', 'abs', 'rand', 'date', 'time', 'str_starts_with',
    'str_contains', 'preg_match', 'preg_replace', 'file_get_contents', 'file_put_contents',
  ]);

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const span = (cls, text) => `<span class="${cls}">${escapeHtml(text)}</span>`;
  const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
  const IDENT = /[A-Za-z0-9_\u0080-\uffff]/;

  function highlight(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let afterFunctionWord = false;
    let afterNewWord = false;

    while (i < n) {
      const c = src[i];
      const next = src[i + 1];

      // PHP opening/closing tags
      if (c === '<' && src.startsWith('<?php', i)) {
        out += span('tok-com', '<?php');
        i += 5;
        continue;
      }
      if (c === '<' && src.startsWith('<?=', i)) {
        out += span('tok-com', '<?=');
        i += 3;
        continue;
      }
      if (c === '?' && next === '>') {
        out += span('tok-com', '?>');
        i += 2;
        continue;
      }

      // comments
      if ((c === '/' && next === '/') || c === '#') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += span('tok-com', src.slice(i, j));
        i = j;
        continue;
      }
      if (c === '/' && next === '*') {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        out += span('tok-com', src.slice(i, j));
        i = j;
        continue;
      }

      // heredoc / nowdoc
      if (c === '<' && src.startsWith('<<<', i)) {
        const head = /^<<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/.exec(src.slice(i));
        if (head) {
          const label = head[2];
          const bodyStart = i + head[0].length;
          const closeRe = new RegExp(`^${label};?\\s*$`, 'm');
          const rest = src.slice(bodyStart);
          const close = closeRe.exec(rest);
          const end = close ? bodyStart + close.index + close[0].length : n;
          out += span('tok-str', src.slice(i, end));
          i = end;
          continue;
        }
      }

      // strings
      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1;
        while (j < n) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === quote) {
            j += 1;
            break;
          }
          j += 1;
        }
        const text = src.slice(i, j);
        out += span('tok-str', text);
        i = j;
        afterFunctionWord = false;
        continue;
      }

      // variables
      if (c === '$' && next !== undefined && IDENT_START.test(next)) {
        let j = i + 1;
        while (j < n && IDENT.test(src[j])) j += 1;
        out += span('tok-var-p', src.slice(i, j));
        i = j;
        afterFunctionWord = false;
        continue;
      }

      // numbers
      if (c >= '0' && c <= '9') {
        const num = /^0[xX][0-9a-fA-F_]+|^0[bB][01_]+|^[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
        const text = num ? num[0] : c;
        out += span('tok-num', text);
        i += text.length;
        continue;
      }

      // identifiers and keywords
      if (IDENT_START.test(c)) {
        let j = i;
        while (j < n && IDENT.test(src[j])) j += 1;
        const word = src.slice(i, j);
        const lower = word.toLowerCase();

        let cls;
        if (afterFunctionWord) cls = 'tok-fn';
        else if (afterNewWord) cls = 'tok-type';
        else if (KEYWORDS.has(lower)) cls = 'tok-kw';
        else if (src[j] === '(' && BUILTINS.has(lower)) cls = 'tok-macro';
        else if (/^[A-Z]/.test(word)) cls = 'tok-type';
        else cls = 'tok-var';

        out += span(cls, word);
        afterFunctionWord = lower === 'function' || lower === 'fn';
        afterNewWord = lower === 'new';
        i = j;
        continue;
      }

      // operators and punctuation
      if (src.startsWith('->', i)) {
        out += span('tok-op', '->');
        i += 2;
        continue;
      }
      if (src.startsWith('=>', i)) {
        out += span('tok-op', '=>');
        i += 2;
        continue;
      }
      if (src.startsWith('::', i)) {
        out += span('tok-op', '::');
        i += 2;
        continue;
      }

      let j = i + 1;
      while (j < n && !IDENT_START.test(src[j]) && !/[0-9$'"<]/.test(src[j]) && !src.startsWith('->', j) && !src.startsWith('=>', j) && !src.startsWith('::', j) && !src.startsWith('//', j) && !src.startsWith('/*', j)) {
        j += 1;
      }
      out += span('tok-punct', src.slice(i, j));
      i = j;
      afterFunctionWord = false;
      afterNewWord = false;
    }

    return out;
  }

  window.PHPHL = { highlight, escapeHtml };
}());
