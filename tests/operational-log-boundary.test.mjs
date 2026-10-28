import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const php = process.env.PHP_BINARY || 'php';
const app = path.join(root, 'snappymail/v/0.0.0');
const quote = value => "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
const run = args => spawnSync(php, args, { cwd: root, encoding: 'utf8', input: '', timeout: 20000 });
async function temporary(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'petuja-m7-log-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('M7-F3 actual dispatcher and both error sinks omit private data while retaining diagnostics', async t => {
    const directory = await temporary(t);
    const config = path.join(directory, 'data/_data_/_default_/configs');
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, 'application.ini'),
        '[logs]\nenable = 1\nlevel = 7\nfilename = "operational.log"\nhide_passwords = On\njson_response_write_limit = 0\n');
    const result = run(['-d', 'zend.exception_ignore_args=0', '-d', 'display_errors=0',
        '-d', 'log_errors=1', '-d', 'error_log=' + path.join(directory, 'php.log'),
        path.join(root, 'tests/fixtures/operational-log-boundary.php'), directory]);
    assert.equal(result.error, undefined, 'local fixture must execute');
    assert.equal(result.status, 0, 'local fixture must complete without dumping diagnostic values');
    let checks;
    try { checks = JSON.parse(result.stdout); } catch { assert.fail('fixture must return boolean-only JSON'); }
    assert.ok(Object.keys(checks).length >= 25);
    for (const [name, value] of Object.entries(checks)) {
        assert.equal(value, true, name);
    }
});

test('M7-F3 argument protection precedes operator code and unavailable native controls fail closed', async t => {
    const directory = await temporary(t);
    const entered = path.join(directory, 'operator-entered');
    const operator = String.raw`<?php
function localDiagnostic($value) { throw new RuntimeException('Synthetic diagnostic'); }
$value = bin2hex(random_bytes(8));
try { localDiagnostic($value); } catch (Throwable $error) {}
file_put_contents(ENTERED, 'ok');
echo json_encode(['enabled' => ini_get('zend.exception_ignore_args') === '1',
    'arguments_absent' => !array_key_exists('args', $error->getTrace()[0]),
    'message_retained' => $error->getMessage() === 'Synthetic diagnostic']);
exit;
`;
    await writeFile(path.join(directory, 'include.php'), operator.replace('ENTERED', quote(entered)));
    const caller = path.join(directory, 'caller.php');
    await writeFile(caller, '<?php define("APP_INDEX_ROOT_PATH", ' + quote(directory + '/') + '); require '
        + quote(path.join(app, 'include.php')) + ';');
    const normal = run(['-d', 'zend.exception_ignore_args=0', caller]);
    assert.equal(normal.status, 0);
    assert.deepEqual(JSON.parse(normal.stdout), { enabled: true, arguments_absent: true, message_retained: true });
    await access(entered);
    for (const disabled of ['ini_set', 'ini_get']) {
        await rm(entered, { force: true });
        const blocked = run(['-d', 'zend.exception_ignore_args=0', '-d', 'disable_functions=' + disabled, caller]);
        assert.equal(blocked.error, undefined);
        assert.equal(blocked.status, 1, 'unavailable protection must stop before operator code');
        assert.match(blocked.stdout, /security configuration is unavailable/);
        assert.doesNotMatch(blocked.stderr, /Fatal error|Stack trace/);
        await assert.rejects(access(entered), { code: 'ENOENT' });
    }
});

test('M7-F3 CLI help stays inert and failed protection precedes credential prompts', () => {
    const script = path.join(app, 'imapsync.php');
    const help = run([script, '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /OPTIONS\/credentials/);
    const blocked = run(['-d', 'zend.exception_ignore_args=0', '-d', 'disable_functions=ini_set',
        script, '--host1', '127.0.0.1', '--justconnect']);
    assert.equal(blocked.error, undefined);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /security configuration is unavailable/);
    assert.doesNotMatch(blocked.stdout, /user1:|password1:/);
    assert.doesNotMatch(blocked.stderr, /Fatal error|Stack trace/);
});
