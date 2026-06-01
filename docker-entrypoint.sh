#!/bin/bash
set -e

# Install/update Composer dependencies (dev mode — vendor not baked in)
if [ -f composer.json ]; then
    composer install --no-interaction 2>/dev/null || true
fi

# Start Apache in foreground
exec apache2-foreground
