# Course checks

Dev-only checks for the interactive course in `public/course`. They exercise the real
page, the real runner, and the real lessons — the things a visual spot-check misses.

Node 18+ and one dependency:

```bash
npm install --prefix tools/course-checks
```

## verify.mjs — the lessons are true

```bash
node tools/course-checks/verify.mjs              # every chapter
node tools/course-checks/verify.mjs 07-forms     # one chapter
```

For all 14 chapters it lints every code block with `php -l`, runs it with the project's
PHP (including each block's simulated request), and compares stdout against the `output`
the lesson claims. It also runs every exercise starter and solution and confirms the
solution satisfies the exercise's own checks. 84 code blocks, 95 program runs.

This is the gate the Pages workflow runs before deploying: a chapter that stops compiling
cannot be published.

It needs no web server. `PHP_BIN` overrides the interpreter, `APP_ROOT` the project root
used for `vendor/autoload.php`.

## smoke.mjs — the page works

```bash
php -S 127.0.0.1:8092 -t public        # or: docker compose up, then BASE=http://localhost/course/
node tools/course-checks/smoke.mjs
```

28 checks in a real DOM: chapters and progress rail render, a snippet runs and prints what
the chapter claims, the quiz marks and explains, the exercise solution passes its checks and
marks the chapter done, a syntax error is reported as a parse failure, chapters with a
simulated request run and show the request in the receipt, the workbench request panel is
seeded, and — after copying the folder to a plain static server with every `.php` removed —
the course still loads, says "read only", and explains why Run cannot work.

## Environment variables

| Variable | Used by | Default |
|---|---|---|
| `BASE` | smoke | `http://127.0.0.1:8092/course/` |
| `STATIC_PORT` | smoke | `8093` |
| `PHP_BIN` | verify | portable build if present, else `php` |
| `APP_ROOT` | verify | repository root |
