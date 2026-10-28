import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);

test('HTTP transports enforce TLS trust and contain redirect credentials', { timeout: 60000 }, async t => {
	const fixture = fileURLToPath(new URL('./fixtures/http-tls-trust.py', import.meta.url));
	const { stdout } = await execute(process.env.PYTHON || 'python3', [fixture], { timeout: 55000 });
	const results = JSON.parse(stdout);
	for (const kind of ['curl', 'socket']) {
		await t.test(kind + ' rejects untrusted certificates and hostname mismatch', () => {
			for (const name of ['self_signed', 'unknown_CA', 'wrong_host']) {
				assert.deepEqual(results[kind][name], { rejected: true }, name);
			}
		});
		await t.test(kind + ' accepts configured trust and preserves direct HTTP', () => {
			for (const name of ['system_trust', 'custom_CA', 'plain_HTTP', 'same_origin_auth', 'mixed_scheme_direct', 'mixed_scheme_redirect']) {
				assert.deepEqual(results[kind][name], { status: 200 }, name);
			}
			assert.deepEqual(results[kind].explicit_self_signed, { status: 200 }, 'explicit legacy control remains functional');
			assert.deepEqual(results[kind].explicit_wrong_host, { rejected: true }, 'explicit control retains hostname checks');
		});
		await t.test(kind + ' stops credential forwarding and HTTPS downgrade before egress', () => {
			for (const name of ['cross_origin_header', 'cross_origin_auth', 'downgrade']) {
				assert.deepEqual(results[kind][name], { rejected: true }, name);
				assert.equal(results[kind][name + '_target_hit'], false, name);
			}
			assert.deepEqual(results[kind].no_follow, { status: 302 });
			assert.equal(results[kind].no_follow_target_hit, false);
		});
		await t.test(kind + ' preserves anonymous redirects without sharing authentication between clients', () => {
			assert.deepEqual(results[kind].anonymous_redirect, { status: 200 });
			assert.equal(results[kind].anonymous_redirect_target_hit, true);
			assert.deepEqual(results[kind].separate_client, { status: 200 });
			assert.equal(results[kind].cached_auth_leaked, false);
		});
	}
	await t.test('CardDAV caller keeps strict TLS verification with saved credentials', () => {
		for (const kind of ['carddav', 'carddav-socket']) {
			assert.deepEqual(results[kind].self_signed, { rejected: true }, kind);
			assert.deepEqual(results[kind].wrong_host, { rejected: true }, kind);
			assert.deepEqual(results[kind].trusted, { status: 200 }, kind);
			assert.deepEqual(results[kind].mixed_scheme, { status: 200 }, kind);
		}
	});
});
