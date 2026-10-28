<?php
// CLI-only ledger fixture. All state is supplied by disposable test directories.
require dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries/snappymail/loginabuselimiter.php';
$input = json_decode(stream_get_contents(STDIN), true, 8, JSON_THROW_ON_ERROR);
$limiter = new \SnappyMail\LoginAbuseLimiter($input['directory'], 'synthetic-ledger-secret');
$result = [];
foreach ($input['operations'] as $operation) {
    if ('timed-reserve' === $operation['action']) {
        $started = microtime(true);
        $ticket = $limiter->reserve('mail', '192.0.2.10', ['synthetic.example.test', 993, 'fixture@example.test']);
        $result[] = ['started' => $started, 'finished' => microtime(true), 'ticket' => $ticket];
        continue;
    }
    $result[] = 'release' === $operation['action']
        ? $limiter->release($operation['ticket'])
        : $limiter->reserve($operation['realm'] ?? 'mail', $operation['source'] ?? '192.0.2.10',
            $operation['identity'] ?? ['synthetic.example.test', 993, 'fixture@example.test']);
}
echo json_encode($result, JSON_THROW_ON_ERROR);
