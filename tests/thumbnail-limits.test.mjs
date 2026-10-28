import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/thumbnail-limits.php');
const php = process.env.PHP_BINARY || 'php';
const cap = 8 * 1024 * 1024;
function run(...args) {
	const result = spawnSync(php, [fixture, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return JSON.parse(result.stdout);
}
const probe = run('probe');

test('M7.11 native geometry arithmetic rejects invalid bounds without decoding', () => {
	const result = spawnSync(php, ['-n', fixture, 'preflight'], { cwd: root, encoding: 'utf8', timeout: 5000 });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), Array(8).fill(true));
});

test('M7.11 direct GD stream factory bounds materialization before image inspection', { skip: !probe.gd }, () => {
	const result = run('direct-stream');
	assert.ok(result.error);
	assert.equal(result.position, cap + 1);
	assert.ok(result.read <= cap + 8192);
});

test('M7.11 rejected headers and oversized source never reach the thumbnail decoder', { skip: !probe.gd }, () => {
	for (const name of ['overflow', 'edge', 'pixels', 'zero', 'malformed', 'svg', 'oversize']) {
		const result = run('spy', name);
		assert.equal(result.calls, 0, name);
		assert.ok(result.error, name);
		if (name === 'oversize') {
			assert.equal(result.position, cap + 1);
			assert.ok(result.read <= cap + 8192, 'bounded stream prefetch');
			assert.ok(result.read < cap + 16384, 'remaining source is not consumed');
		}
	}
});

test('M7.11 exact bounds and MIME-decoded normal input reach the decoder once', { skip: !probe.gd }, () => {
	for (const name of ['normal', 'exact-geometry', 'exact-edge', 'exact-bytes', 'base64', 'quoted-printable', 'orientation']) {
		const result = run('spy', name);
		assert.equal(result.error, null, name);
		assert.equal(result.calls, 1, name);
		if (name === 'exact-bytes') { assert.equal(result.decoderBytes, cap); }
		if (name === 'orientation') { assert.deepEqual(result.steps[0], ['rotate', 90]); }
		assert.deepEqual(result.steps.at(-2), ['crop', 48, 48]);
		assert.deepEqual(result.steps.at(-1), ['strip']);
	}
});

test('M7.11 small native raster thumbnails retain centered 48x48 PNG output', { skip: !probe.gd }, () => {
	for (const format of ['png', 'gif', 'jpeg', 'webp', 'wide']) {
		if (format === 'webp' && !(probe.types & 32)) { continue; }
		const result = run('native', format);
		assert.deepEqual([result.width, result.height, result.type], [48, 48, 3], format);
		assert.ok(result.center.green > result.center.red, format + ' centered subject preserved');
	}
});

test('M7.11 raw endpoint preserves pass-through and rejects transformation safely', { skip: !probe.gd, timeout: 20000 }, async () => {
	const reservation = net.createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
	const server = spawn(php, ['-S', '127.0.0.1:' + port, fixture], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	server.stderr.on('data', (data) => { stderr += data; });
	try {
		await new Promise((resolve, reject) => {
			server.stderr.on('data', () => { if (stderr.includes('Development Server')) { resolve(); } });
			server.once('error', reject);
			server.once('exit', (code) => reject(new Error('PHP server exited ' + code + ': ' + stderr)));
			setTimeout(() => reject(new Error('PHP fixture startup timed out: ' + stderr)), 5000).unref();
		});
		for (const mode of ['view', 'download']) {
			const response = await fetch('http://127.0.0.1:' + port + '/?mode=' + mode);
			assert.equal(response.status, 200, stderr);
			assert.equal(response.headers.get('content-type'), 'image/png');
			assert.match(response.headers.get('content-disposition'), mode === 'download' ? /^attachment/ : /^inline/);
			assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('synthetic-attachment\0original'));
		}
		for (const mode of ['oversize', 'rotate']) {
			const response = await fetch('http://127.0.0.1:' + port + '/?mode=' + mode);
			assert.equal(response.status, 500, stderr);
			assert.equal(await response.text(), '');
		}
		const unauthorized = await fetch('http://127.0.0.1:' + port + '/?mode=unauthorized');
		assert.equal(unauthorized.status, 403);
		assert.equal(unauthorized.headers.get('x-fixture-mail-callback'), null);
		const thumbnail = await fetch('http://127.0.0.1:' + port + '/?mode=thumbnail');
		assert.equal(thumbnail.status, 200, stderr);
		assert.equal(thumbnail.headers.get('content-type'), 'image/png');
		const png = Buffer.from(await thumbnail.arrayBuffer());
		assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
		assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [48, 48]);
	} finally {
		server.kill('SIGTERM');
		if (server.exitCode === null) { await once(server, 'exit'); }
	}
});
