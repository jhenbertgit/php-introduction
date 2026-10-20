# Docs checks

Dev-only checks for the interactive documentation in `public/docs`. They drive the real
page in a DOM (jsdom) and talk to the real runner, so they catch what a visual glance
cannot: a snippet that stops compiling, a Run button that stops answering, an editor that
loses its highlighting.

Node 18+ and one dependency:

```bash
npm install --prefix tools/docs-checks
```

## smoketest.mjs — the page works

```bash
php -S 127.0.0.1:8090 -t public/docs        # or: docker compose up, then BASE=http://localhost/
node tools/docs-checks/smoketest.mjs
```

23 checks: the runner is detected, all 123 blocks are enhanced, a snippet executes and
matches its documented output, editing changes the result, a syntax error is reported as
one, reset restores the code.

## audit.mjs — how much of the docs really runs

```bash
node tools/docs-checks/audit.mjs
```

Executes every block and reports how many ran, how many errored, and how many outputs match
the documented ones. Some failures are expected: multi-file examples, snippets needing the
`pdo_mysql`/`redis`/`ffi` extensions, and blocks that deliberately show an error.

## offline.mjs — what GitHub Pages sees

```bash
node tools/docs-checks/offline.mjs
```

Stages `public/docs` **without** any `.php` file (exactly what the Pages workflow publishes),
serves it from a plain static server, and asserts the page stays readable with Run disabled
and an explanation instead of a silent failure.

## Environment variables

| Variable | Used by | Default |
|---|---|---|
| `BASE` | smoketest, audit | `http://127.0.0.1:8090/` |
| `DOCS_DIR` | offline | `public/docs` relative to this folder |
| `PORT` | offline | `8091` |
