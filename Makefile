# ----------------------------------------------------------------------
# PHP Basic - Development Commands
# Usage: make <command>
# ----------------------------------------------------------------------

.PHONY: up down build restart logs logs-php shell xdebug-on xdebug-off lint test prod clean help

help: ## Show this help
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

up: ## Start all services (dev mode)
	docker compose up -d

down: ## Stop all services
	docker compose down

build: ## Rebuild the PHP image
	docker compose build

restart: ## Restart PHP server only
	docker compose restart php-server

logs: ## Tail logs from all services
	docker compose logs -f

logs-php: ## Tail logs from PHP server only
	docker compose logs -f php-server

shell: ## Open a shell in the PHP container
	docker compose exec php-server bash

xdebug-on: ## Enable Xdebug (restart required)
	docker compose exec php-server bash -c "echo 'xdebug.mode = debug,develop' > /usr/local/etc/php/conf.d/xdebug-toggle.ini && echo 'Xdebug enabled. Run: make restart'"

xdebug-off: ## Disable Xdebug (restart required)
	docker compose exec php-server bash -c "echo 'xdebug.mode = off' > /usr/local/etc/php/conf.d/xdebug-toggle.ini && echo 'Xdebug disabled. Run: make restart'"

lint: ## Lint PHP files for syntax errors
	docker compose exec php-server bash -c "find /var/www/html -name '*.php' -exec php -l {} \; 2>&1 | grep -v 'No syntax errors'"

test: ## Run PHP tests (placeholder - add PHPUnit later)
	@echo "No tests configured yet. Add PHPUnit to run tests."

prod: ## Start in production mode (no Xdebug, no volume mount)
	docker compose -f docker-compose.yml up -d --build

clean: ## Remove containers, images, and volumes
	docker compose down -v --rmi local
	@echo "Cleaned up. Run 'make build && make up' to start fresh."
