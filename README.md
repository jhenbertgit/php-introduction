# PHP Basic - Grade Calculator

A simple PHP 8.4 grade calculator running in Docker with Traefik reverse proxy. Uses PSR-4 autoloading and an OOP architecture.

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
| `docker compose exec php-server bash -c "echo 'xdebug.mode = debug,develop' > ... && make restart"` | `make xdebug-on` | Enable Xdebug |
| `docker compose exec php-server bash -c "echo 'xdebug.mode = off' > ... && make restart"` | `make xdebug-off` | Disable Xdebug |
| `docker compose exec php-server bash -c "find ... -name '*.php' -exec php -l {} \;"` | `make lint` | Lint PHP files |
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
├── docker-entrypoint.sh              # Container startup script (composer install)
├── Dockerfile                       # Builds PHP 8.4 + Apache image
├── docker-compose.yml              # Production-safe base configuration
├── docker-compose.override.yml      # Dev additions (Xdebug, volume mount)
├── Makefile                         # Shortcut commands
├── public/
│   └── index.php                    # Web entry point (Apache DocumentRoot)
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
