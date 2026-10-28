import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const php = process.env.PHP_BINARY || 'php';
for (const [mode, name] of [
    ['records', 'M7-F4 one physical auth record and trusted matcher target across malformed fields and templates'],
    ['fields', 'M7-F4 all dynamic auth fields share file and captured syslog framing'],
    ['ordinary', 'M7-F4 ordinary UTF8, peer, non-auth compiler and filename behavior stay compatible']
]) {
    test(name, async t => {
        const version = spawnSync(php, ['-r', 'echo PHP_VERSION_ID;'], { encoding: 'utf8' });
        assert.equal(version.status, 0);
        if (Number(version.stdout) < 80000) {
            t.skip('Safe native syslog replacement requires PHP 8; no OS syslog is used');
            return;
        }
        const directory = await mkdtemp(path.join(tmpdir(), 'petuja-auth-log-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const result = spawnSync(php, ['-d', 'disable_functions=openlog,syslog,closelog',
            path.join(root, 'tests/fixtures/auth-log-framing.php'), mode, directory],
        { cwd: root, encoding: 'utf8', timeout: 30000 });
        assert.equal(result.error, undefined, 'local logger fixture must execute');
        assert.equal(result.status, 0, 'local logger fixture must finish without exposing raw log values');
        let checks;
        try { checks = JSON.parse(result.stdout); } catch { assert.fail('fixture must return only boolean/count JSON'); }
        for (const [key, value] of Object.entries(checks)) {
            if (key === 'matrix_cases') {
                assert.equal(value, 1776, 'matrix must cover both IP families, all three producers, four templates and 74 values');
            } else {
                assert.equal(value, true, key);
            }
        }
    });
}
