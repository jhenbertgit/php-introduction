<?php

declare(strict_types=1);

/**
 * Snippet runner for the interactive PHP documentation.
 *
 * POST JSON { "code": "...", "timeoutMs": 5000 } -> lints (php -l) and runs the
 * snippet in a throwaway directory with the PHP CLI, returning stdout/stderr.
 *
 * This executes code. It is meant for the local learning app:
 *   - disable it anywhere else by setting PHP_DOCS_RUNNER=off or creating
 *     public/docs/runner.disabled
 *   - it refuses requests that do not carry the X-PHP-Docs-Runner header
 *   - process spawning, sockets and mail are disabled for snippets
 *   - open_basedir limits snippets to their temp directory and the app root
 *   - wall clock timeout, memory limit and output caps are enforced here, not by
 *     the snippet
 */

const RUNNER_VERSION = 1;
const MAX_CODE_BYTES = 65536;
const MAX_OUTPUT_BYTES = 65536;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 10000;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

/**
 * @param array<string, mixed> $payload
 */
function respond(array $payload, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function appRoot(): string
{
    $fromEnv = getenv('PHP_DOCS_APP_ROOT');
    if (is_string($fromEnv) && $fromEnv !== '') {
        return rtrim($fromEnv, '/\\');
    }

    // public/docs/runner.php -> project root
    return dirname(__DIR__, 2);
}

function isDisabled(): bool
{
    if (getenv('PHP_DOCS_RUNNER') === 'off') {
        return true;
    }

    return is_file(__DIR__ . '/runner.disabled');
}

/**
 * The Apache module image does not expose the CLI through PHP_BINARY, so look for it.
 */
function phpCli(): ?string
{
    $candidates = [];

    $fromEnv = getenv('PHP_DOCS_PHP_BIN');
    if (is_string($fromEnv) && $fromEnv !== '') {
        $candidates[] = $fromEnv;
    }

    $windows = DIRECTORY_SEPARATOR === '\\';
    $candidates[] = '/usr/local/bin/php';
    $candidates[] = PHP_BINDIR . ($windows ? '\\php.exe' : '/php');
    $candidates[] = PHP_BINDIR . '/php';

    // Under a CLI SAPI (php -S) PHP_BINARY is the interpreter itself.
    if (str_contains(strtolower(basename(PHP_BINARY)), 'php')) {
        $candidates[] = PHP_BINARY;
    }

    foreach ($candidates as $candidate) {
        if (@is_file($candidate) && @is_executable($candidate)) {
            return $candidate;
        }
    }

    return null;
}

/**
 * Run a command with a wall clock limit, capturing output through files so large or
 * interleaved streams cannot deadlock on pipes.
 *
 * @param list<string> $args
 * @return array{code: int, stdout: string, stderr: string, ms: int, timedOut: bool}
 */
function runProcess(array $args, string $cwd, int $timeoutMs): array
{
    $started = microtime(true);
    $outFile = tempnam($cwd, 'out');
    $errFile = tempnam($cwd, 'err');

    $descriptors = [
        0 => ['file', DIRECTORY_SEPARATOR === '\\' ? 'NUL' : '/dev/null', 'r'],
        1 => ['file', $outFile, 'w'],
        2 => ['file', $errFile, 'w'],
    ];

    $process = @proc_open($args, $descriptors, $pipes, $cwd);
    if (!is_resource($process)) {
        @unlink($outFile);
        @unlink($errFile);
        return [
            'code' => -1,
            'stdout' => '',
            'stderr' => 'could not start ' . $args[0],
            'ms' => 0,
            'timedOut' => false,
        ];
    }

    $timedOut = false;
    $exitCode = -1;
    $deadline = $started + ($timeoutMs / 1000);

    while (true) {
        $status = proc_get_status($process);
        if (!($status['running'] ?? false)) {
            $exitCode = (int) ($status['exitcode'] ?? -1);
            break;
        }
        if (microtime(true) >= $deadline) {
            $timedOut = true;
            @proc_terminate($process, 9);
            $waited = 0;
            while ($waited < 200_000) {
                $status = proc_get_status($process);
                if (!($status['running'] ?? false)) {
                    break;
                }
                usleep(20_000);
                $waited += 20_000;
            }
            break;
        }
        usleep(10_000);
    }

    proc_close($process);

    $stdout = (string) @file_get_contents($outFile, false, null, 0, MAX_OUTPUT_BYTES);
    $stderr = (string) @file_get_contents($errFile, false, null, 0, MAX_OUTPUT_BYTES);
    @unlink($outFile);
    @unlink($errFile);

    return [
        'code' => $exitCode,
        'stdout' => $stdout,
        'stderr' => $stderr,
        'ms' => (int) round((microtime(true) - $started) * 1000),
        'timedOut' => $timedOut,
    ];
}

/**
 * Snippets are usually fragments: add an opening tag unless the code is already PHP or
 * is a full page with embedded PHP.
 */
function normaliseCode(string $code): string
{
    $trimmed = ltrim($code);

    if ($trimmed === '') {
        return "<?php\n";
    }
    if (str_starts_with($trimmed, '<?php') || str_starts_with($trimmed, '<?=')) {
        return $code;
    }
    if (str_contains($code, '<?php') || str_contains($code, '<?=')) {
        return $code;
    }

    return "<?php\n" . $code;
}

/**
 * Load the application's own classes so examples such as
 * `use App\GradeCalculator;` work without a require line.
 *
 * This is injected into the snippet rather than prepended with auto_prepend_file:
 * `declare(strict_types=1)` and `namespace` must be the very first statement of a file,
 * so a prepended include would break every snippet that starts with one.
 */
function injectAutoload(string $code, string $autoloadPath): string
{
    if (!is_file($autoloadPath)) {
        return $code;
    }
    // Multi-file examples declare their own namespace and reference sibling files that
    // only exist in a real project; adding the app autoloader there helps nobody and
    // would put a statement before the namespace declaration.
    if (preg_match('/(?:^|\n)\s*namespace\s+[^;{]+;/i', $code)) {
        return $code;
    }

    // Only inject when a class in the App\ namespace is actually referenced. A snippet
    // that merely declares `namespace App\Models;` names it too, and injecting there
    // would put a statement before the namespace declaration.
    $probe = preg_replace('/\bnamespace\s+[^;{]+;/i', '', $code) ?? $code;
    if (!preg_match('/(?:use|new|extends|implements|instanceof|\()\s*App\\\\|App\\\\[A-Z]/', $probe)) {
        return $code;
    }

    $offset = strspn($code, " \t\r\n");
    if (substr($code, $offset, 5) !== '<?php') {
        return $code;
    }

    $body = substr($code, $offset + 5);

    // `declare(strict_types=1);` and `namespace X;` must stay at the top of the file,
    // so the require goes after them, never before.
    $insertAt = 0;
    while (preg_match('/\G\s*(?:declare\s*\([^;]*\)\s*;|namespace\s+[^;{]+;)/i', $body, $m, 0, $insertAt)) {
        $insertAt += strlen($m[0]);
    }

    $require = 'require ' . var_export($autoloadPath, true) . ';';
    $patched = substr($body, 0, $insertAt) . "\n" . $require . "\n" . substr($body, $insertAt);

    return substr($code, 0, $offset + 5) . $patched;
}

// ------------------------------------------------------------------ request --

$disabled = isDisabled();
$php = phpCli();

if (isset($_GET['ping'])) {
    $version = $php === null ? null : trim((string) shell_exec(escapeshellarg($php) . ' -r "echo PHP_VERSION;"'));
    respond([
        'ok' => !$disabled && $php !== null,
        'runner' => RUNNER_VERSION,
        'php' => $version,
        'appRoot' => appRoot(),
        'autoload' => is_file(appRoot() . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php'),
        'disabled' => $disabled,
    ]);
}

if ($disabled) {
    respond(['ok' => false, 'error' => 'the snippet runner is disabled on this server'], 403);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(['ok' => false, 'error' => 'POST required'], 405);
}

if (($_SERVER['HTTP_X_PHP_DOCS_RUNNER'] ?? '') !== '1') {
    respond(['ok' => false, 'error' => 'missing X-PHP-Docs-Runner header'], 400);
}

if ($php === null) {
    respond(['ok' => false, 'error' => 'no php CLI binary found on this server'], 500);
}

$raw = file_get_contents('php://input', false, null, 0, MAX_CODE_BYTES + 1);
if ($raw === false) {
    respond(['ok' => false, 'error' => 'could not read the request body'], 400);
}
if (strlen($raw) > MAX_CODE_BYTES) {
    respond(['ok' => false, 'error' => 'snippet is larger than ' . MAX_CODE_BYTES . ' bytes'], 413);
}

$payload = json_decode($raw, true);
if (!is_array($payload) || !isset($payload['code']) || !is_string($payload['code'])) {
    respond(['ok' => false, 'error' => 'expected JSON {"code": "..."}'], 400);
}

$timeoutMs = DEFAULT_TIMEOUT_MS;
if (isset($payload['timeoutMs']) && is_numeric($payload['timeoutMs'])) {
    $timeoutMs = max(500, min(MAX_TIMEOUT_MS, (int) $payload['timeoutMs']));
}

$code = injectAutoload(normaliseCode($payload['code']), appRoot() . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php');

// --------------------------------------------------------------------- work --

$appRoot = appRoot();
$dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'php-docs-' . bin2hex(random_bytes(8));
if (!@mkdir($dir, 0700, true) && !is_dir($dir)) {
    respond(['ok' => false, 'error' => 'could not create a scratch directory'], 500);
}

$cleanup = static function (string $dir): void {
    foreach (glob($dir . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($dir);
};

$snippetPath = $dir . DIRECTORY_SEPARATOR . 'snippet.php';
file_put_contents($snippetPath, $code);

// The value is quoted because ";" separates paths on Windows and would otherwise be
// read as the start of an ini comment, silently dropping every path but the first.
$openBasedir = '"' . implode(PATH_SEPARATOR, array_filter([$dir, $appRoot])) . '"';
$disabledFunctions = implode(',', [
    'exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen',
    'pcntl_exec', 'pcntl_fork', 'pcntl_signal',
    'curl_init', 'curl_exec', 'curl_multi_exec', 'fsockopen', 'pfsockopen',
    'stream_socket_client', 'stream_socket_server', 'socket_create', 'socket_connect',
    'mail', 'dl', 'chown', 'chmod', 'chgrp',
]);

$iniArgs = [
    '-d', 'display_errors=stderr',
    '-d', 'display_startup_errors=stderr',
    '-d', 'error_reporting=E_ALL',
    '-d', 'log_errors=0',
    '-d', 'memory_limit=128M',
    '-d', 'max_execution_time=' . (int) ceil($timeoutMs / 1000),
    '-d', 'session.save_path=' . $dir,
    '-d', 'sys_temp_dir=' . $dir,
    '-d', 'upload_tmp_dir=' . $dir,
    '-d', 'open_basedir=' . $openBasedir,
    '-d', 'disable_functions=' . $disabledFunctions,
    '-d', 'assert.exception=1',
];

// Lint first, so a parse error reads as a compile error rather than a runtime one.
$lint = runProcess(array_merge([$php], $iniArgs, ['-l', $snippetPath]), $dir, 10_000);

if ($lint['code'] !== 0) {
    $cleanup($dir);
    respond([
        'ok' => false,
        'stage' => 'lint',
        'timeout' => false,
        'php' => PHP_VERSION,
        'compile' => [
            'stdout' => '',
            'stderr' => trim(str_replace($snippetPath, 'snippet.php', $lint['stderr'] . $lint['stdout'])),
            'ms' => $lint['ms'],
        ],
        'output' => null,
    ]);
}

$run = runProcess(array_merge([$php], $iniArgs, [$snippetPath]), $dir, $timeoutMs);

$cleanup($dir);

$stderr = str_replace([$snippetPath, $dir . DIRECTORY_SEPARATOR], ['snippet.php', ''], $run['stderr']);
$stdout = str_replace($dir . DIRECTORY_SEPARATOR, '', $run['stdout']);

$ok = !$run['timedOut'] && $run['code'] === 0;

respond([
    'ok' => $ok,
    'stage' => 'run',
    'timeout' => $run['timedOut'],
    'php' => PHP_VERSION,
    'compile' => ['stdout' => '', 'stderr' => '', 'ms' => $lint['ms']],
    'output' => [
        'stdout' => $stdout,
        'stderr' => $stderr,
        'code' => $run['code'],
        'ms' => $run['ms'],
        'timedOut' => $run['timedOut'],
    ],
]);
