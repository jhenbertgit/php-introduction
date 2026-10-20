<?php

declare(strict_types=1);

/**
 * Snippet runner for the interactive documentation (public/docs).
 *
 * POST JSON { "code": "...", "request": { "method": "POST", "post": {...} }, "timeoutMs": 5000 }
 * -> { ok, stage, timeout, php, compile: {stderr}, output: {stdout, stderr, code, ms} }
 *
 * The work lives in App\SnippetRunner; this file only validates the request and shapes
 * the response. Disable it with PHP_DOCS_RUNNER=off or by creating runner.disabled next
 * to this file.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
if (is_file($autoload)) {
    require $autoload;
}

/**
 * @param array<string, mixed> $payload
 */
function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

if (!class_exists(\App\SnippetRunner::class)) {
    respond(['ok' => false, 'error' => 'App\SnippetRunner is missing — run composer install'], 500);
}

$runner = new \App\SnippetRunner(dirname(__DIR__, 2), __DIR__);

if (isset($_GET['ping'])) {
    respond($runner->describe());
}

if ($runner->isDisabled()) {
    respond(['ok' => false, 'error' => 'the snippet runner is disabled on this server'], 403);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(['ok' => false, 'error' => 'POST required'], 405);
}

$header = $_SERVER['HTTP_X_PHP_DOCS_RUNNER'] ?? $_SERVER['HTTP_X_SNIPPET_RUNNER'] ?? '';
if ($header !== '1') {
    respond(['ok' => false, 'error' => 'missing X-PHP-Docs-Runner header'], 400);
}

$raw = file_get_contents('php://input', false, null, 0, 131073);
if ($raw === false) {
    respond(['ok' => false, 'error' => 'could not read the request body'], 400);
}

$payload = json_decode($raw, true);
if (!is_array($payload) || !isset($payload['code']) || !is_string($payload['code'])) {
    respond(['ok' => false, 'error' => 'expected JSON {"code": "..."}'], 400);
}

$request = isset($payload['request']) && is_array($payload['request']) ? $payload['request'] : [];
$timeoutMs = isset($payload['timeoutMs']) && is_numeric($payload['timeoutMs']) ? (int) $payload['timeoutMs'] : null;

respond($runner->run($payload['code'], $request, $timeoutMs));
