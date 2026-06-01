FROM php:8.4-apache

# ----------------------------------------------------------------------
# System dependencies for PHP extensions
# ----------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libzip-dev \
    libicu-dev \
    libpq-dev \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------
# PHP extensions - useful for learning and future projects
# ----------------------------------------------------------------------
RUN docker-php-ext-install \
    mysqli \
    pdo_mysql \
    pdo_pgsql \
    intl \
    zip \
    gd

# ----------------------------------------------------------------------
# Xdebug 3.x - installed in image but controlled by php.ini
# OFF in production (no xdebug config in php.ini)
# ON in development (php.ini-dev enables it)
# ----------------------------------------------------------------------
RUN pecl install xdebug \
    && docker-php-ext-enable xdebug

# ----------------------------------------------------------------------
# Apache configuration
# ----------------------------------------------------------------------
RUN a2enmod rewrite
RUN sed -i 's|/var/www/html|/var/www/html/public|g' /etc/apache2/sites-available/000-default.conf

# ----------------------------------------------------------------------
# Production PHP config (baked into image)
# Dev config overrides this via docker-compose.override.yml
# ----------------------------------------------------------------------
COPY usr/config/php.ini /usr/local/etc/php/php.ini

# ----------------------------------------------------------------------
# Composer + application code
# Volume mount in docker-compose.override.yml replaces this at runtime
# ----------------------------------------------------------------------
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# ----------------------------------------------------------------------
# Application code
# Volume mount in docker-compose.override.yml replaces this at runtime
# Entrypoint runs composer install after mount
# ----------------------------------------------------------------------
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN rm -rf /var/www/html/*
COPY . /var/www/html
WORKDIR /var/www/html
RUN composer install --no-interaction --no-dev --optimize-autoloader
RUN chown -R www-data:www-data /var/www/html

EXPOSE 80
ENTRYPOINT ["docker-entrypoint.sh"]
