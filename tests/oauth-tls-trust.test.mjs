import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('retained OAuth library verifies provider TLS before sending a token', { timeout: 60000 }, async t => {
	const fixture = fileURLToPath(new URL('./fixtures/http-tls-trust.py', import.meta.url));
	const { stdout } = await promisify(execFile)(process.env.PYTHON || 'python3', [fixture, '--oauth'], { timeout: 55000 });
	const results = JSON.parse(stdout);
	await t.test('untrusted or wrong-host servers receive no application request', () => {
		for (const name of ['self_signed', 'unknown_CA', 'wrong_host', 'wrong_host_default']) {
			assert.deepEqual(results[name], { rejected: true }, name);
		}
		assert.equal(results.untrusted_application_requests, 0);
	});
	await t.test('system trust and an explicit CA preserve token-bearing requests', () => {
		assert.deepEqual(results.system_trust, { status: 200 });
		assert.deepEqual(results.custom_CA, { status: 200 });
	});
});
