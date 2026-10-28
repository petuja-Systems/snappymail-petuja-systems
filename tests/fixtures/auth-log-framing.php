<?php
// CLI-only logger tests. Disabled PHP 8 native functions are replaced, never OS syslog.
if ('cli' !== PHP_SAPI || PHP_VERSION_ID < 80000 || count($argv) !== 3
    || function_exists('openlog') || function_exists('syslog') || function_exists('closelog')) {
    exit(2);
}
if (!function_exists('openlog')) {
    function openlog($name, $flags, $facility) { return true; }
    function syslog($level, $message) { $GLOBALS['auth_syslog'][] = $message; return true; }
    function closelog() { return true; }
}
$repo = dirname(__DIR__, 2);
$directory = $argv[2];
define('APP_INDEX_ROOT_PATH', $directory . '/');
define('APP_DATA_FOLDER_PATH', $directory . '/data/');
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
$_SERVER['HTTP_HOST'] = $_SERVER['SERVER_NAME'] = 'fixture.test';
require $repo . '/snappymail/v/0.0.0/include.php';

class AuthLogFramingFixture extends \RainLoop\Actions
{
    public function __construct(string $directory, string $format)
    {
        $this->oConfig = new class($directory, $format) {
            private string $directory;
            private string $format;
            public function __construct(string $directory, string $format) {
                $this->directory = $directory; $this->format = $format;
            }
            public function Get($section, $key, $default = null) {
                $values = ['auth_logging' => true, 'path' => $this->directory,
                    'auth_logging_filename' => 'auth.log', 'auth_logging_format' => $this->format];
                return $values[$key] ?? $default;
            }
        };
    }
    public function getAccountFromToken(bool $throw = true): ?\RainLoop\Model\Account { return null; }
    public function record(?\RainLoop\Model\Account $account, string $login, bool $admin): void {
        $this->LoggerAuthHelper($account, $login, $admin);
    }
    public function ordinary(string $format, array $values): string { return $this->compileLogParams($format, null, $values); }
    public function filename(string $value): string { return $this->compileLogFileName($value); }
}
function fixtureAccount(string $value, bool $allFields = false): \RainLoop\Model\MainAccount
{
    $domain = new \RainLoop\Model\Domain('fixture.test');
    $domain->ImapSettings()->host = $allFields ? $value : 'imap.fixture.test';
    $domain->ImapSettings()->port = 143;
    $domain->SmtpSettings()->host = $allFields ? $value : 'smtp.fixture.test';
    $domain->SmtpSettings()->port = 25;
    $account = new \RainLoop\Model\MainAccount();
    $account->setCredentials($domain, $allFields ? $value : 'alice@fixture.test',
        $value, new \SnappyMail\SensitiveString(''), $allFields ? $value : 'alice.smtp');
    return $account;
}
function matcherHosts(string $file, string $message): array
{
    preg_match('/^failregex\s*=\s*(.+)$/m', file_get_contents($file), $pattern);
    // Only numeric synthetic IPv4/IPv6 peers are used; this is not a Fail2ban engine.
    $expression = str_replace('<HOST>', '(?<peer>[0-9a-fA-F:.]+)', rtrim($pattern[1]));
    preg_match_all('~' . str_replace('~', '\~', $expression) . '~', $message, $matches);
    return $matches['peer'];
}
function recordCase(string $directory, string $format, string $peer, string $value,
    string $path, bool $allFields = false): array
{
    $_SERVER['REMOTE_ADDR'] = $peer;
    $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.71';
    $_SERVER['HTTP_X_REAL_IP'] = '198.51.100.72';
    $_SERVER['HTTP_CLIENT_IP'] = '198.51.100.73';
    $_SERVER['HTTP_HOST'] = $allFields ? $value : 'fixture.test';
    file_put_contents($directory . '/auth.log', '');
    $GLOBALS['auth_syslog'] = [];
    $actions = new AuthLogFramingFixture($directory, $format);
    $actions->record('account' === $path ? fixtureAccount($value, $allFields) : null,
        'account' === $path ? '' : $value, 'admin' === $path);
    return [file_get_contents($directory . '/auth.log'), $GLOBALS['auth_syslog']];
}
$default = '[{date:Y-m-d H:i:s}] Auth failed: ip={request:ip} user={imap:login} host={imap:host} port={imap:port}';
$mode = $argv[1];
$checks = [];
if ('records' === $mode) {
    $values = ['alice', 'müller+tag@fixture.test', "local\r\nfixture", 'literal\\x20 value', "malformed\xff\x85\r\nfixture",
        '{request:domain}{smtp:login}', 'context Auth failed: ip=203.0.113.9 user=fixture host=local port=143'];
    for ($i = 0; $i < 32; ++$i) { $values[] = 'local' . chr($i) . 'fixture'; }
    $values[] = "local\x7ffixture";
    for ($i = 128; $i < 160; ++$i) { $values[] = 'local' . "\xc2" . chr($i) . 'fixture'; }
    $values[] = "local\u{2028}fixture"; $values[] = "local\u{2029}fixture";
    $formats = [$default, 'context={user:login} ' . $default,
        'Auth failed: user={user:login} ip={request:ip} host={imap:host} port={imap:port}',
        $default . "\r\noperator\tcontext\0"];
    $checks = ['one_file_record' => true, 'one_captured_syslog' => true, 'no_sink_controls' => true,
        'file_matcher_trusted_peer' => true, 'journal_matcher_trusted_peer' => true, 'supported_format_matches' => true];
    $cases = 0;
    foreach (['192.0.2.20', '2001:db8::20'] as $peer) {
        foreach (['account', 'mail', 'admin'] as $path) {
            foreach ($formats as $index => $format) {
                foreach ($values as $value) {
                    [$file, $syslog] = recordCase($directory, $format, $peer, $value, $path);
                    $checks['one_file_record'] &= substr_count($file, "\n") === 1 && substr($file, -1) === "\n";
                    $checks['one_captured_syslog'] &= count($syslog) === 1;
                    $body = substr($file, 0, -1);
                    $checks['no_sink_controls'] &= !preg_match('/[\x00-\x1f\x7f]|\xC2[\x80-\x9F]|\xE2\x80[\xA8\xA9]/', $body . implode('', $syslog));
                    $fileHosts = matcherHosts($repo . '/fail2ban/filter.d/snappymail-log.conf', $body);
                    $journalHosts = matcherHosts($repo . '/fail2ban/filter.d/snappymail-fpm-journal.conf', $syslog[0]);
                    $checks['file_matcher_trusted_peer'] &= count(array_diff($fileHosts, [$peer])) === 0;
                    $checks['journal_matcher_trusted_peer'] &= $journalHosts === [$peer];
                    $checks['supported_format_matches'] &= 2 === $index ? $fileHosts === [] : $fileHosts === [$peer];
                    ++$cases;
                }
            }
        }
    }
    $checks['matrix_cases'] = $cases;
} elseif ('fields' === $mode) {
    $format = '{request:ip}|{user:ip}|{request:domain}|{request:domain-clear}|{imap:login}|{smtp:login}'
        . '|{imap:host}|{imap:port}|{smtp:host}|{smtp:port}|{user:email}|{user:login}|{user:domain}|{user:domain-clear}';
    $value = "local value\r\nnext@domain value.test";
    $checks = ['all_dynamic_fields_single_line' => true, 'field_delimiters_and_peers_preserved' => true,
        'field_representation_reversible' => true, 'file_and_syslog_login_parity' => true];
    foreach (['account', 'mail', 'admin'] as $path) {
        [$file, $syslog] = recordCase($directory, $format, '2001:db8::20', $value, $path, true);
        $fields = explode('|', rtrim($file, "\n"));
        $checks['all_dynamic_fields_single_line'] &= !preg_match('/[\x00-\x1f\x7f ]/', rtrim($file, "\n"));
        $checks['field_delimiters_and_peers_preserved'] &= count($fields) === 14 && $fields[0] === '2001:db8::20' && $fields[1] === '2001:db8::20';
        $checks['field_representation_reversible'] &= stripcslashes($fields[4]) === $value;
        $checks['file_and_syslog_login_parity'] &= substr($syslog[0], strpos($syslog[0], ' user=') + 6) === $fields[4];
    }
} elseif ('ordinary' === $mode) {
    [$file, $syslog] = recordCase($directory, $default, '192.0.2.20', 'müller+tag', 'account');
    $checks['ordinary_file_format'] = (bool) preg_match('/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Auth failed: ip=192\.0\.2\.20 user=müller\+tag host=imap\.fixture\.test port=143\n$/', $file);
    $checks['ordinary_syslog_format'] = $syslog === ['Auth failed: ip=192.0.2.20 user=müller+tag'];
    $actions = new AuthLogFramingFixture($directory, $default);
    $raw = "ordinary value\r\n\\literal";
    $checks['default_compiler_unchanged'] = $actions->ordinary('prefix={fixture}', ['{fixture}' => $raw]) === 'prefix=' . $raw;
    $checks['filename_unchanged'] = $actions->filename(' auth logs/../hello !().txt ') === 'authlogs/./hello!().txt';
    [$file] = recordCase($directory, 'Auth failed: ip={request:ip} user={imap:login}', '192.0.2.20', 'literal\\x20 value', 'admin');
    $encoded = substr(rtrim($file, "\n"), strpos($file, ' user=') + 6);
    $checks['backslash_space_unambiguous'] = stripcslashes($encoded) === 'literal\\x20 value';
} else { exit(2); }
foreach ($checks as $name => $value) {
    if ('matrix_cases' !== $name) { $checks[$name] = (bool) $value; }
}
echo json_encode($checks, JSON_THROW_ON_ERROR);
