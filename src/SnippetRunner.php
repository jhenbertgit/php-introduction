<?php

declare(strict_types=1);

namespace App;

use RuntimeException;

/**
 * Runs a PHP snippet in isolation and reports what happened.
 *
 * Two consumers use it: the interactive documentation (public/docs/runner.php) and the
 * interactive course (public/course/run.php). Both are for local learning, not public
 * servers — see README.md in the repository root for the switches that disable it.
 *
 * What it does to a snippet:
 *   - optionally simulates a web request (method, $_GET, $_POST, $_SESSION)
 *   - injects the project autoloader when the code references an App\ class
 *   - lints with `php -l`, so a parse error reads as a compile error
 *   - executes in a throwaway directory with the PHP CLI, capped in time, memory and output
 *
 * Process spawning, sockets and mail are disabled for the snippet itself, and open_basedir
 * keeps it inside its scratch directory plus the project root.
 */
final class SnippetRunner
{
    public const VERSION = 2;

    private const MAX_CODE_BYTES = 65536;
    private const MAX_OUTPUT_BYTES = 65536;
    private const DEFAULT_TIMEOUT_MS = 5000;
    private const MAX_TIMEOUT_MS = 10000;

    /** Functions a learning snippet never needs, and a hostile one would. */
    private const BLOCKED_FUNCTIONS = [
        'exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen',
        'pcntl_exec', 'pcntl_fork', 'pcntl_signal',
        'curl_init', 'curl_exec', 'curl_multi_exec', 'fsockopen', 'pfsockopen',
        'stream_socket_client', 'stream_socket_server', 'socket_create', 'socket_connect',
        'mail', 'dl', 'chown', 'chmod', 'chgrp',
    ];

    public function __construct(
        private readonly string $appRoot,
        private readonly ?string $markerDir = null,
    ) {
    }

    public static function fromRequest(): self
    {
        $root = getenv('APP_ROOT');
        $appRoot = rtrim(
            is_string($root) && $root !== '' ? $root : dirname(__DIR__),
            '/\\',
        );

        return new self($appRoot, __DIR__ . '/../public/course');
    }

    // -------------------------------------------------------------- state ---

    public function isDisabled(): bool
    {
        if (getenv('PHP_DOCS_RUNNER') === 'off' || getenv('PHP_SNIPPET_RUNNER') === 'off') {
            return true;
        }

        return $this->markerDir !== null && is_file($this->markerDir . '/runner.disabled');
    }

    public function phpCli(): ?string
    {
        $candidates = [];

        $fromEnv = getenv('PHP_DOCS_PHP_BIN') ?: getenv('PHP_SNIPPET_PHP_BIN');
        if (is_string($fromEnv) && $fromEnv !== '') {
            $candidates[] = $fromEnv;
        }

        $windows = DIRECTORY_SEPARATOR === '\\';
        $candidates[] = '/usr/local/bin/php';
        $candidates[] = PHP_BINDIR . ($windows ? '\\php.exe' : '/php');

        // Under a CLI SAPI PHP_BINARY is the interpreter itself.
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
     * @return array<string, mixed>
     */
    public function describe(): array
    {
        $php = $this->phpCli();
        $version = $php === null
            ? null
            : trim((string) @shell_exec(escapeshellarg($php) . ' -r "echo PHP_VERSION;"'));

        return [
            'ok' => !$this->isDisabled() && $php !== null,
            'runner' => self::VERSION,
            'php' => $version,
            'appRoot' => $this->appRoot,
            'autoload' => is_file($this->autoloadPath()),
            'disabled' => $this->isDisabled(),
        ];
    }

    // --------------------------------------------------------------- flow ---

    /**
     * @param array<string, mixed> $request simulated request: method, get, post, session
     * @return array<string, mixed>
     */
    public function run(string $code, array $request = [], ?int $timeoutMs = null): array
    {
        $php = $this->phpCli();
        if ($php === null) {
            return $this->failure('no php CLI binary found on this server');
        }
        if (strlen($code) > self::MAX_CODE_BYTES) {
            return $this->failure('snippet is larger than ' . self::MAX_CODE_BYTES . ' bytes', 413);
        }

        $timeoutMs = $timeoutMs === null
            ? self::DEFAULT_TIMEOUT_MS
            : max(500, min(self::MAX_TIMEOUT_MS, $timeoutMs));

        $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'snippet-' . bin2hex(random_bytes(8));
        if (!@mkdir($dir, 0700, true) && !is_dir($dir)) {
            return $this->failure('could not create a scratch directory', 500);
        }

        try {
            $snippetPath = $dir . DIRECTORY_SEPARATOR . 'snippet.php';
            file_put_contents($snippetPath, $this->compose($code, $request));

            $ini = $this->iniArguments($dir, $timeoutMs);

            $lint = $this->execute(array_merge([$php], $ini, ['-l', $snippetPath]), $dir, 10_000);
            if ($lint['code'] !== 0) {
                return [
                    'ok' => false,
                    'stage' => 'lint',
                    'timeout' => false,
                    'php' => PHP_VERSION,
                    'compile' => [
                        'stdout' => '',
                        'stderr' => $this->tidy($lint['stderr'] . $lint['stdout'], $snippetPath, $dir),
                        'ms' => $lint['ms'],
                    ],
                    'output' => null,
                ];
            }

            $run = $this->execute(array_merge([$php], $ini, [$snippetPath]), $dir, $timeoutMs);

            return [
                'ok' => !$run['timedOut'] && $run['code'] === 0,
                'stage' => 'run',
                'timeout' => $run['timedOut'],
                'php' => PHP_VERSION,
                'compile' => ['stdout' => '', 'stderr' => '', 'ms' => $lint['ms']],
                'output' => [
                    'stdout' => $this->tidy($run['stdout'], $snippetPath, $dir),
                    'stderr' => $this->tidy($run['stderr'], $snippetPath, $dir),
                    'code' => $run['code'],
                    'ms' => $run['ms'],
                    'timedOut' => $run['timedOut'],
                ],
            ];
        } finally {
            foreach (glob($dir . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($dir);
        }
    }

    // ------------------------------------------------------------ building --

    private function compose(string $code, array $request): string
    {
        $code = $this->normalise($code);
        $code = $this->injectAutoload($code);

        if ($request === []) {
            return $code;
        }
        // `declare(strict_types=1)` must stay the first statement, so a simulated request
        // cannot be prepended to such a snippet.
        if (preg_match('/^\s*<\?php\s*declare\s*\(/i', $code)) {
            return $code;
        }

        $preamble = $this->requestPreamble($request);
        $body = preg_replace('/^\s*<\?php\s*/i', '', $code, 1) ?? $code;

        return $preamble . "<?php\n" . $body;
    }

    private function normalise(string $code): string
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

    private function injectAutoload(string $code): string
    {
        $autoload = $this->autoloadPath();
        if (!is_file($autoload)) {
            return $code;
        }
        // Multi-file examples declare a namespace; a statement before it would be a fatal.
        if (preg_match('/(?:^|\n)\s*namespace\s+[^;{]+;/i', $code)) {
            return $code;
        }
        if (!preg_match('/(?:use|new|extends|implements|instanceof)\s+App\\\\|App\\\\[A-Z]/', $code)) {
            return $code;
        }

        $offset = strspn($code, " \t\r\n");
        if (substr($code, $offset, 5) !== '<?php') {
            return $code;
        }

        $body = substr($code, $offset + 5);
        $insertAt = 0;
        while (preg_match('/\G\s*(?:declare\s*\([^;]*\)\s*;|namespace\s+[^;{]+;)/i', $body, $m, 0, $insertAt)) {
            $insertAt += strlen($m[0]);
        }

        $require = 'require ' . var_export($autoload, true) . ';';
        $patched = substr($body, 0, $insertAt) . "\n" . $require . "\n" . substr($body, $insertAt);

        return substr($code, 0, $offset + 5) . $patched;
    }

    /**
     * @param array<string, mixed> $request
     */
    private function requestPreamble(array $request): string
    {
        $method = strtoupper((string) ($request['method'] ?? 'GET'));
        $json = static fn (mixed $value): string => var_export(json_encode($value ?: new \stdClass()), true);

        $lines = [
            '<?php',
            '$_SERVER["REQUEST_METHOD"] = ' . var_export($method, true) . ';',
            '$_SERVER["HTTP_HOST"] = "localhost";',
            '$_SERVER["REQUEST_URI"] = "/";',
            '$_SERVER["REMOTE_ADDR"] = "127.0.0.1";',
            '$_GET = json_decode(' . $json($request['get'] ?? []) . ', true) ?: [];',
            '$_POST = json_decode(' . $json($request['post'] ?? []) . ', true) ?: [];',
            '$_REQUEST = array_merge($_GET, $_POST);',
        ];

        if (array_key_exists('session', $request)) {
            $lines[] = 'session_start();';
            $lines[] = '$_SESSION = json_decode(' . $json($request['session'] ?? []) . ', true) ?: [];';
        }

        $lines[] = '?>';

        return implode("\n", $lines) . "\n";
    }

    /**
     * @return list<string>
     */
    private function iniArguments(string $dir, int $timeoutMs): array
    {
        // The value is quoted because ";" separates paths on Windows and would otherwise
        // be read as the start of an ini comment, dropping every path but the first.
        $openBasedir = '"' . implode(PATH_SEPARATOR, array_filter([$dir, $this->appRoot])) . '"';

        return [
            '-d', 'display_errors=stderr',
            '-d', 'display_startup_errors=stderr',
            '-d', 'error_reporting=E_ALL',
            '-d', 'log_errors=0',
            '-d', 'memory_limit=128M',
            '-d', 'max_execution_time=' . (int) ceil($timeoutMs / 1000),
            '-d', 'session.save_path=' . $dir,
            '-d', 'session.use_cookies=0',
            '-d', 'sys_temp_dir=' . $dir,
            '-d', 'upload_tmp_dir=' . $dir,
            '-d', 'open_basedir=' . $openBasedir,
            '-d', 'disable_functions=' . implode(',', self::BLOCKED_FUNCTIONS),
            '-d', 'assert.exception=1',
        ];
    }

    private function autoloadPath(): string
    {
        return $this->appRoot . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php';
    }

    /**
     * @param list<string> $args
     * @return array{code: int, stdout: string, stderr: string, ms: int, timedOut: bool}
     */
    private function execute(array $args, string $cwd, int $timeoutMs): array
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

            return ['code' => -1, 'stdout' => '', 'stderr' => 'could not start ' . $args[0], 'ms' => 0, 'timedOut' => false];
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

        $stdout = (string) @file_get_contents($outFile, false, null, 0, self::MAX_OUTPUT_BYTES);
        $stderr = (string) @file_get_contents($errFile, false, null, 0, self::MAX_OUTPUT_BYTES);
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

    /** Replace scratch paths with a familiar filename and drop simulation artefacts. */
    private function tidy(string $text, string $snippetPath, string $dir): string
    {
        $text = str_replace([$snippetPath, $dir . DIRECTORY_SEPARATOR], ['snippet.php', ''], $text);

        return (string) preg_replace(
            '/^.*(?:Ignoring session_start\(\)|A session had already been started).*$\n?/mi',
            '',
            $text,
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function failure(string $message, int $status = 400): array
    {
        unset($status);

        return ['ok' => false, 'error' => $message, 'stage' => 'request', 'timeout' => false, 'php' => PHP_VERSION, 'compile' => null, 'output' => null];
    }
}
