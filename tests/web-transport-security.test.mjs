import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const php = process.env.PHP_BINARY || 'php';

async function environment(t) {
	const probe = spawnSync(php, ['-r', 'exit(extension_loaded("intl") && extension_loaded("mbstring") && extension_loaded("openssl") ? 0 : 1);']);
	if (probe.status !== 0) { t.skip('PHP intl, mbstring and OpenSSL are required'); return null; }
	const data = await mkdtemp(path.join(tmpdir(), 'petuja-web-transport-'));
	let child;
	t.after(async () => {
		try {
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM');
				await new Promise(resolve => child.once('exit', resolve));
			}
		} finally {
			await rm(data, { recursive: true, force: true });
		}
	});
	const configs = path.join(data, '_data_', '_default_', 'configs');
	await mkdir(configs, { recursive: true });
	await writeFile(path.join(configs, 'application.ini'), '[plugins]\nenable = Off\n[debug]\nenable = Off\n');
	const reservation = createServer();
	await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	child = spawn(php, ['-d', 'display_errors=0', '-S', '127.0.0.1:' + port,
		'-t', root, path.join(root, 'tests/fixtures/web-transport-security.php')], {
		cwd: root, env: { ...process.env, PETUJA_TEST_DATA_PATH: data }, stdio: ['ignore', 'pipe', 'pipe']
	});
	// Runtime diagnostics stay local; they can include newly generated fixture state.
	child.stdout.resume();
	child.stderr.resume();
	const base = 'http://127.0.0.1:' + port;
	const request = (options = {}, headers = {}) => fetch(base + '/?' + new URLSearchParams(options), {
		redirect: 'manual', signal: AbortSignal.timeout(15000), headers
	});
	for (let attempt = 0; attempt < 80; attempt++) {
		assert.equal(child.exitCode, null, 'synthetic PHP server remains running');
		try {
			const response = await request();
			if (response.ok) { await response.arrayBuffer(); return request; }
			await response.arrayBuffer();
		} catch { /* The owned loopback listener may still be starting. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('synthetic transport PHP server did not become ready');
}

const cookies = response => response.headers.getSetCookie().filter(value => /^m7_transport(?:~\d+)?=/.test(value));
const hasSecure = cookie => /;\s*secure(?:;|$)/i.test(cookie);

test('native bootstrap trusts server TLS metadata and ignores request scheme headers or port-only hints', { timeout: 60000 }, async t => {
	const request = await environment(t);
	if (!request) return;
	for (const [names, secure] of [
		[['on', 'upper-on', 'one', 'scheme', 'upper-scheme', 'offload', 'off-scheme'], true],
		[['http', 'port443', 'off', 'upper-off', 'empty', 'unknown', 'padded', 'array', 'boolean', 'integer', 'scheme-array'], false]
	]) {
		for (const name of names) {
			const response = await request({ case: name });
			assert.equal(response.status, 200, name);
			assert.deepEqual(await response.json(), { transport: secure, withoutProxy: secure,
				scheme: secure ? 'https' : 'http', normalizedHttps: secure ? 'on' : null, cookieSecure: secure }, name);
			assert.equal(response.headers.has('strict-transport-security'), secure, name);
			assert.equal(cookies(response).length, 1, name);
			assert.equal(hasSecure(cookies(response)[0]), secure, name);
			const page = await request({ case: name, mode: 'page', force: '1' });
			assert.equal(page.status, secure ? 200 : 302, name);
			assert.equal(page.headers.has('strict-transport-security'), secure, name);
			if (!secure) assert.match(page.headers.get('location'), /^https:\/\/127\.0\.0\.1:/);
			await page.arrayBuffer();
		}
	}
	for (const headers of [
		{ 'X-Forwarded-Proto': 'https' }, { 'X-Forwarded-Proto': 'HtTpS' },
		{ 'X-Forwarded-Ssl': 'on' }, { 'X-Forwarded-Proto': 'https, http' },
		{ 'X-Forwarded-Proto': 'https', 'X-Forwarded-Ssl': 'off' },
		{ 'Request-Scheme': 'https', Forwarded: 'proto=https' }
	]) {
		const response = await request({ mode: 'page', force: '1' }, headers);
		assert.equal(response.status, 302, 'caller headers cannot suppress HTTPS enforcement');
		assert.equal(response.headers.has('strict-transport-security'), false);
		await response.arrayBuffer();
		const inspect = await request({}, headers);
		assert.equal((await inspect.json()).transport, false);
		const emitted = cookies(inspect);
		assert.equal(emitted.length, 1);
		assert.equal(emitted.every(cookie => !hasSecure(cookie)), true);
	}
});

test('native and inline crypt cookie Secure policy agrees without promoting cookie overrides into TLS', { timeout: 60000 }, async t => {
	const request = await environment(t);
	if (!request) return;
	for (const [options, secure, transport] of [
		[{}, false, false], [{ case: 'on' }, true, true], [{ case: 'offload' }, true, true],
		[{ secure: '1' }, true, false], [{ sameSite: 'None' }, true, false],
		[{ sameSite: 'none' }, true, false], [{ sameSite: 'nOnE' }, true, false],
		[{ sameSite: 'Lax' }, false, false]
	]) {
		for (const mode of ['inspect', 'clear', 'split']) {
			const response = await request({ ...options, mode });
			assert.equal(response.status, 200);
			const result = await response.json();
			assert.equal(result.transport, transport);
			assert.equal(result.cookieSecure, secure);
			assert.equal(response.headers.has('strict-transport-security'), transport);
			const emitted = cookies(response);
			assert.equal(emitted.length, mode === 'split' ? 3 : 1);
			for (const cookie of emitted) {
				assert.equal(hasSecure(cookie), secure);
				assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
				assert.match(cookie, /;\s*path=\/(?:;|$)/i);
			}
			if (mode === 'clear') assert.match(emitted[0], /expires=/i);
		}
		const page = await request({ ...options, mode: 'page' });
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.equal(html.includes('samesite=' + (options.sameSite || 'Strict').toLowerCase() + (secure ? ';secure' : '') + '"'), true);
		const enforced = await request({ ...options, mode: 'page', force: '1' });
		assert.equal(enforced.status, transport ? 200 : 302, 'cookie-only overrides do not assert TLS');
		await enforced.arrayBuffer();
	}
});

test('synthetic writable-window storage fallback adds Secure on HTTPS while retaining its Strict cookie and HTTP behavior', async () => {
	const source = (await readFile(path.join(root, 'dev/Storage/Client.js'), 'utf8')).replaceAll('export function ', 'function ');
	for (const protocol of ['http:', 'https:']) {
		for (const failed of [false, true]) {
			const sandbox = { location: { protocol }, document: { cookie: '' }, console: { error() {} },
				localStorage: { setItem() { if (failed) throw new Error('synthetic unavailable storage'); }, getItem() { return null; }, removeItem() {} } };
			sandbox.window = sandbox;
			vm.runInNewContext('"use strict";\n' + source, sandbox);
			if (!failed) { assert.equal(sandbox.document.cookie, ''); continue; }
			sandbox.localStorage.setItem('synthetic-sentinel', 'harmless');
			const cookie = sandbox.document.cookie;
			assert.equal(hasSecure(cookie), protocol === 'https:');
			assert.match(cookie, /;path=\/;samesite=strict/i);
			assert.match(cookie, /;expires=/i);
			assert.deepEqual(JSON.parse(decodeURIComponent(cookie.split(';')[0].slice('localStorage='.length))), { 'synthetic-sentinel': 'harmless' });
		}
	}
});

test('development Nginx passes its native TLS flag without trusting a forwarding header', async () => {
	const nginx = await readFile(path.join(root, '.docker/dev/nginx/default.conf'), 'utf8');
	assert.deepEqual([...nginx.matchAll(/fastcgi_param\s+HTTPS\s+([^;]+);/g)].map(match => match[1]), ['$https if_not_empty']);
	assert.doesNotMatch(nginx, /fastcgi_param\s+HTTPS\s+\$http_/);
});
