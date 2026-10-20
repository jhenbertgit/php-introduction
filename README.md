# PHP Basic

PHP 8.4 learning exercises running in Docker with Traefik reverse proxy. PSR-4 autoloading, OOP architecture, multiple hands-on examples.

## Exercises

| Page | Description |
|------|-------------|
| `/` (index.php) | ATM Withdrawal — session-based PIN verification, balance tracking, form validation |
| `/gradeCalculator.index.php` | Grade Calculator — weighted scores, letter grades, remarks via `App\GradeCalculator` class |
| `/example.php` | Arrays & Objects — `array_all`, `array_combine`, class constructor, `var_dump` |

Switch the active page by editing `public/index.php` (currently includes `atm_withdrawal.php`).

## Interactive documentation

`public/docs/` holds a PHP 8.4 guide with 123 code blocks. Each block is editable and has a
**Run** button: the snippet is executed by the PHP 8.4 inside the Docker container and the
output appears underneath, next to the documented output so you can see whether it agrees.

```
docker compose up -d
open http://localhost/docs/
```

What it does:

- `public/docs/runner.php` — lints the snippet (`php -l`), then runs it in a throwaway
  directory with the PHP CLI and returns stdout, stderr and timing as JSON.
- `public/docs/interactive.js` — adds the toolbar, the editable overlay (the highlighted
  block stays visible while you type) and the output panel; compares the result with the
  documented output (`✓ matches`, `≈ close`, `✗ differs`).
- `public/docs/interactive.css` — styling for both themes.

Snippets that use `App\` classes get `vendor/autoload.php` injected automatically, after any
`declare(...)` or `namespace` statement, so `use App\GradeCalculator;` works without a
`require` line.

### It executes code — read this

The runner runs snippets as `www-data` inside the container. That is fine for a local
learning app and wrong for anything public. To turn it off:

```bash
docker compose exec php-server sh -c 'touch public/docs/runner.disabled'   # until recreated
PHP_DOCS_RUNNER=off docker compose up -d                                    # environment switch
```

Hardening already in the runner: `exec`, `shell_exec`, `system`, `proc_open`, sockets,
`curl_*`, `mail` and friends are disabled for snippets; `open_basedir` limits them to their
temp directory plus the app root; 5 s wall clock limit, 128 MB memory limit, 64 KB caps on
code and output; requests must carry the `X-PHP-Docs-Runner` header.

### On GitHub Pages

Pages cannot run PHP, so `.github/workflows/deploy-pages.yml` publishes `public/docs`
**with every `.php` file excluded**. The hosted copy stays readable, marks Run as
unavailable, and says to run the app locally — it never pretends a snippet ran.

### Known limits

Some blocks cannot run in isolation and say so by failing visibly: multi-file examples that
`require` a sibling file, snippets needing `pdo_mysql`/`redis`/`ffi`, examples reading
`$_GET`/`$_POST` (there is no request), and blocks that deliberately demonstrate an error.

### Checking the docs after you edit them

`tools/docs-checks/` holds three jsdom checks — page smoke test, a run of all 123 blocks,
and the Pages-like offline behaviour. See `tools/docs-checks/README.md`.

## Quick Start

1. Copy `.env.example` to `.env` (or use defaults)
2. Run `docker compose up -d --build`
3. Open http://localhost in your browser

## Development

### Dev Mode (default)

```bash
docker compose up -d
```

Automatically uses `docker-compose.override.yml` which enables:
- Xdebug 3 for step debugging
- Live code sync via volume mount
- Error display in browser
- Opcache disabled
- Composer install on container start

### Production Mode

```bash
docker compose -f docker-compose.yml up -d --build
```

No Xdebug, no volume mount, errors off.

### Useful Commands

| Command | Make | Description |
|---------|------|-------------|
| `docker compose up -d` | `make up` | Start dev |
| `docker compose down` | `make down` | Stop |
| `docker compose build` | `make build` | Rebuild image |
| `docker compose restart php-server` | `make restart` | Restart PHP server |
| `docker compose logs -f` | `make logs` | View all logs |
| `docker compose logs -f php-server` | `make logs-php` | View PHP logs |
| `docker compose exec php-server bash` | `make shell` | Shell into container |
| `make xdebug-on` | `make xdebug-on` | Enable Xdebug |
| `make xdebug-off` | `make xdebug-off` | Disable Xdebug |
| `make lint` | `make lint` | Lint PHP files |
| `docker compose -f docker-compose.yml up -d --build` | `make prod` | Production mode |
| `docker compose down -v --rmi local` | `make clean` | Remove containers, images, volumes |

> **Windows:** `make` requires Git Bash. Or use the `docker compose` commands directly.

## Xdebug Setup

1. Install the [PHP Debug extension](https://marketplace.visualstudio.com/items?itemName=xdebug.php-debug) in VS Code
2. Start **"Listen for Xdebug"** debug configuration (F5 → select it)
3. Open http://localhost with Xdebug trigger active (browser extension or `XDEBUG_SESSION=1` cookie)
4. Set breakpoints in VS Code — they'll hit when the page loads

## File Structure

```
.
├── .dockerignore                    # Excluded from Docker build context
├── .env                             # Environment variables (ports, Xdebug config)
├── .env.example                     # Template for .env
├── .gitignore                       # Git exclusions
├── .vscode/launch.json              # VS Code Xdebug configuration
├── composer.json                    # PHP project metadata & PSR-4 autoloading
├── composer.lock                    # Dependency lockfile
├── docker-entrypoint.sh             # Container startup script (composer install)
├── Dockerfile                       # Builds PHP 8.4 + Apache image
├── docker-compose.yml              # Production-safe base configuration
├── docker-compose.override.yml      # Dev additions (Xdebug, volume mount)
├── Makefile                         # Shortcut commands
├── public/
│   ├── index.php                    # Web entry point — includes active exercise
│   ├── gradeCalculator.index.php    # Grade calculator form (uses App\GradeCalculator)
│   ├── example.php                  # Array functions & object basics
│   └── atm_withdrawal.php           # ATM withdrawal with PIN & balance logic
├── src/
│   └── GradeCalculator.php          # Grade calculator logic (App\ namespace)
└── usr/config/
    ├── php.ini                      # Production PHP config (errors OFF)
    └── php.ini-dev                  # Development PHP config (errors ON, Xdebug)
```

## How Dev/Prod Separation Works

- **`docker compose up`** = `docker-compose.yml` + `docker-compose.override.yml` (dev)
- **`docker compose -f docker-compose.yml up`** = base only (prod)
- The override mounts `php.ini-dev` and your source code as volumes
- The base bakes in production `php.ini` and copies code into the image
- `docker-entrypoint.sh` runs `composer install` on startup in dev mode
