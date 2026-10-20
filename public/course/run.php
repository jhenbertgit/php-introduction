<?php

declare(strict_types=1);

/**
 * Snippet runner for the interactive course (public/course).
 *
 * Same contract as the documentation runner, plus request simulation:
 *
 *   POST JSON {
 *     "code": "...",
 *     "request": { "method": "POST", "get": {...}, "post": {...}, "session": {...} }
 *   }
 *
 * The work lives in App\SnippetRunner. Disable it with PHP_DOCS_RUNNER=off (or
 * PHP_SNIPPET_RUNNER=off), or by creating runner.disabled next to this file.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$appRoot = dirname(__DIR__, 2);
$autoload = $appRoot . '/vendor/autoload.php';
if (is_file($autoload)) {
    require $autoload;
}

/**
 * @param array<string, mixed> $payload
 */
function sendJson(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

if (!class_exists(\App\SnippetRunner::class)) {
    sendJson(['ok' => false, 'error' => 'App\SnippetRunner is missing — run composer install'], 500);
}

$runner = new \App\SnippetRunner($appRoot, __DIR__);

if (isset($_GET['ping'])) {
    sendJson($runner->describe());
}

if ($runner->isDisabled()) {
    sendJson(['ok' => false, 'error' => 'the snippet runner is disabled on this server'], 403);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    sendJson(['ok' => false, 'error' => 'POST required'], 405);
}

$header = $_SERVER['HTTP_X_SNIPPET_RUNNER'] ?? $_SERVER['HTTP_X_PHP_DOCS_RUNNER'] ?? '';
if ($header !== '1') {
    sendJson(['ok' => false, 'error' => 'missing X-Snippet-Runner header'], 400);
}

$raw = file_get_contents('php://input', false, null, 0, 131073);
if ($raw === false) {
    sendJson(['ok' => false, 'error' => 'could not read the request body'], 400);
}

$payload = json_decode($raw, true);
if (!is_array($payload) || !isset($payload['code']) || !is_string($payload['code'])) {
    sendJson(['ok' => false, 'error' => 'expected JSON {"code": "..."}'], 400);
}

if (isset($payload['request']) && !is_array($payload['request'])) {
    sendJson(['ok' => false, 'error' => '"request" must be an object'], 400);
}

$request = $payload['request'] ?? [];
$timeoutMs = isset($payload['timeoutMs']) && is_numeric($payload['timeoutMs']) ? (int) $payload['timeoutMs'] : null;

sendJson($runner->run($payload['code'], $request, $timeoutMs));
