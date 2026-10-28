import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = Buffer.from('synthetic-attachment\0original');
let server, directory, port;
before(async () => {
	directory = await mkdtemp(path.join(tmpdir(), 'petuja-raw-response-'));
	const configs = path.join(directory, 'data/_data_/_default_/configs');
	await mkdir(configs, { recursive: true });
	await writeFile(path.join(configs, 'application.ini'), '[plugins]\nenable = Off\n[logs]\nenable = Off\n');
	const reservation = net.createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	port = reservation.address().port;
	await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
	server = spawn(process.env.PHP_BINARY || 'php', ['-d', 'display_errors=0', '-S', '127.0.0.1:' + port,
		path.join(root, 'tests/fixtures/raw-response-boundary.php')],
	{ cwd: root, env: { ...process.env, M7_RAW_FIXTURE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe'] });
	await new Promise((resolve, reject) => {
		let output = '';
		server.stderr.on('data', data => {
			output += data;
			if (output.includes('Development Server')) resolve();
		});
		server.once('error', reject);
		server.once('exit', () => reject(new Error('PHP fixture exited during startup')));
		setTimeout(() => reject(new Error('PHP fixture startup timed out')), 5000).unref();
	});
});
after(async () => {
	if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
	if (directory) await rm(directory, { recursive: true, force: true });
});
function request(params = {}, headers = {}, hashOnly = false) {
	return new Promise((resolve, reject) => {
		const req = http.get({ hostname: '127.0.0.1', port, path: '/?' + new URLSearchParams(params), headers }, response => {
			const chunks = [], hash = createHash('sha256');
			let length = 0;
			response.on('data', chunk => { length += chunk.length; hash.update(chunk); if (!hashOnly) chunks.push(chunk); });
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
				raw: response.rawHeaders, body: Buffer.concat(chunks), length, sha256: hash.digest('hex') }));
			response.on('error', reject);
		});
		req.setTimeout(5000, () => req.destroy(new Error('Local Raw fixture timed out')));
		req.on('error', reject);
	});
}
function policies(response, name = 'content-security-policy') {
	return response.raw.filter((value, index) => index % 2 && response.raw[index - 1].toLowerCase() === name);
}

test('RawView downloads active and unknown MIME types without changing source bytes', async () => {
	for (const type of ['image/svg+xml', 'IMAGE/SVG+XML; charset=UTF-8', 'text/html', 'application/xhtml+xml',
		'application/xml', 'text/xml', 'application/xslt+xml', 'application/x-unknown', 'audio/x-mpegurl', '']) {
		for (const field of ['type', 'keyType']) {
			const response = await request({ [field]: type });
			assert.equal(response.status, 200, type);
			assert.match(response.headers['content-disposition'], /^attachment;/, field + ': ' + type);
			assert.deepEqual(response.body, original);
		}
	}
	const svg = await request({ name: 'synthetic.SVGZ', svg: 1 });
	assert.match(svg.headers['content-disposition'], /^attachment;/);
	assert.match(svg.headers['content-type'], /^image\/svg\+xml/);
	assert.match(svg.body.toString(), /^<svg /);
});

test('single decoded ranges have inclusive bounds, safe parsing and coherent cache preconditions', async () => {
	for (const encoding of ['', 'base64', 'quoted-printable']) {
		for (const [range, start, end] of [['bytes=2-5', 2, 5], ['bytes=0-0', 0, 0],
			['bytes=4-4', 4, 4], ['bytes=2-', 2, original.length - 1],
			['bytes=-4', original.length - 4, original.length - 1],
			['bytes=0-999', 0, original.length - 1], ['BYTES=0002-0005', 2, 5]]) {
			const response = await request({ type: 'application/pdf', encoding }, { Range: range });
			assert.equal(response.status, 206, encoding + ': ' + range);
			assert.deepEqual(response.body, original.subarray(start, end + 1));
			assert.equal(response.headers['content-length'], String(end - start + 1));
			assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${original.length}`);
		}
	}
	for (const range of ['bytes=9-2', 'bytes=2-5,8-9', 'items=2-5', 'bytes=-', 'bytes=2-5junk',
		'bytes=999999999999999999999999-']) {
		const response = await request({}, { Range: range });
		assert.equal(response.status, 200, range);
		assert.deepEqual(response.body, original);
		assert.equal(response.headers['content-range'], undefined);
	}
	for (const range of ['bytes=999-', 'bytes=-0']) {
		const response = await request({}, { Range: range });
		assert.equal(response.status, 416);
		assert.equal(response.body.length, 0);
		assert.equal(response.headers['content-range'], 'bytes */' + original.length);
	}
	const empty = await request({ count: 0 }, { Range: 'bytes=0-0' });
	assert.equal(empty.status, 416);
	assert.equal(empty.headers['content-range'], 'bytes */0');
	const normal = await request();
	for (const validator of ['0', '"different"', 'W/' + normal.headers.etag, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
		const response = await request({}, { Range: 'bytes=2-5', 'If-Range': validator });
		assert.equal(response.status, 200);
		assert.deepEqual(response.body, original);
	}
	assert.equal((await request({}, { Range: 'bytes=2-5', 'If-Range': normal.headers.etag })).status, 206);
	const cached = await request({}, { Range: 'bytes=2-5', 'If-None-Match': normal.headers.etag });
	assert.equal(cached.status, 304);
	assert.equal(cached.headers['x-fixture-mail-callback'], undefined);
});

let statsId = 0;
async function stats(id) {
	for (let attempt = 0; attempt < 100; ++attempt) {
		try { return JSON.parse(await readFile(path.join(directory, 'stats-' + id + '.json'), 'utf8')); }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('Synthetic Raw statistics were not written');
}
function generatedHash(size) {
	const pattern = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
	const block = Buffer.concat(Array(32).fill(pattern)), hash = createHash('sha256');
	while (size > 0) { const count = Math.min(size, block.length); hash.update(block.subarray(0, count)); size -= count; }
	return hash.digest('hex');
}
test('actual Service Raw streams full views, downloads, plain and files through bounded identity output', async () => {
	for (const compress of [false, true]) {
		for (const params of [{}, { action: 'Download' }, { action: 'ViewAsPlain' }, { fileHash: 1 }]) {
			const id = 'stream-' + ++statsId, size = 65536;
			const response = await request({ service: 1, count: size, stats: id,
				type: 'image/png', ...params, ...(compress ? { compress: 1 } : {}) },
			{ 'Accept-Encoding': 'gzip, br' }, true);
			assert.equal(response.status, 200);
			assert.equal(response.length, size);
			assert.equal(response.sha256, generatedHash(size));
			assert.equal(response.headers['content-encoding'], undefined);
			assert.equal(response.headers['content-length'], undefined);
			assert.equal(response.headers['x-content-type-options'], 'nosniff');
			assert.equal(response.headers['x-xss-protection'], '1; mode=block');
			assert.match(policies(response).at(-1), /default-src 'none'/);
			const observed = await stats(id);
			assert.equal(observed.read, size);
			assert.equal(observed.closed, true);
			assert.ok(observed.firstOutputRead > 0 && observed.firstOutputRead < size, JSON.stringify(observed));
			assert.ok(observed.maxRead <= 8192 && observed.outputChunk <= 8192, JSON.stringify(observed));
			assert.ok(observed.serviceRetained < 8192, JSON.stringify(observed));
			assert.equal(observed.stageBytes, 0);
			assert.equal(observed.resources, 0);
		}
	}
	const range = await request({ service: 1, type: 'application/pdf', compress: 1, encoding: 'base64' },
		{ Range: 'bytes=2-5', 'Accept-Encoding': 'gzip, br' });
	assert.equal(range.status, 206);
	assert.equal(range.headers['content-encoding'], undefined);
	assert.equal(range.headers['content-length'], '4');
	assert.deepEqual(range.body, original.subarray(2, 6));
});

test('range staging has a hard budget, replays complete larger bodies and fails closed on read error', async () => {
	const limit = 8 * 1024 * 1024;
	for (const encoding of ['', 'base64', 'quoted-printable']) {
		for (const size of [limit, limit + 1]) {
			const id = 'budget-' + ++statsId;
			const response = await request({ service: 1, count: size, encoding, stats: id, type: 'application/pdf' },
				{ Range: 'bytes=0-' }, true);
			assert.equal(response.status, size === limit ? 206 : 200);
			assert.equal(response.length, size);
			assert.equal(response.sha256, generatedHash(size));
			if (size > limit) {
				assert.equal(response.headers['accept-ranges'], 'none');
				assert.equal(response.headers['content-range'], undefined);
				assert.equal(response.headers['content-length'], undefined);
			} else assert.equal(response.headers['content-range'], `bytes 0-${size - 1}/${size}`);
			const observed = await stats(id);
			assert.ok(observed.stageBytes > 0 && observed.stageBytes <= limit + 1, JSON.stringify(observed));
			assert.ok(observed.outputChunk <= 8192 && observed.serviceRetained < 8192, JSON.stringify(observed));
			// A whole 8 MiB decoded PHP string cannot fit this extra-allocation budget.
			assert.ok(observed.peakExtra <= 4 * 1024 * 1024, JSON.stringify(observed));
			assert.equal(observed.resources, 0);
			assert.equal(observed.closed, true);
		}
		const id = 'failure-' + ++statsId;
		const failed = await request({ service: 1, count: 65536, encoding, failRead: 1, stats: id }, { Range: 'bytes=2-5' });
		assert.equal(failed.status, 500);
		assert.equal(failed.length, 0);
		assert.equal(failed.headers['content-range'], undefined);
		const observed = await stats(id);
		assert.equal(observed.resources, 0);
		assert.equal(observed.closed, true);
	}
});

test('RawView preserves supported inline MIME types, PDF fallback and safe filename headers', async () => {
	for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
		'image/tiff', 'image/x-icon', 'image/vnd.microsoft.icon', 'application/pdf', 'audio/mpeg', 'audio/mp4', 'audio/ogg',
		'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/x-flac', 'audio/aac', 'audio/webm',
		'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
		'IMAGE/PNG; charset=binary']) {
		const response = await request({ type, name: 'synthetic.dat' });
		assert.equal(response.status, 200, type);
		assert.match(response.headers['content-disposition'], /^inline;/, type);
		assert.equal(response.headers['content-type'], type);
		assert.deepEqual(response.body, original);
	}
	const pdf = await request({ type: 'application/octet-stream', name: 'synthetic.pdf' });
	assert.match(pdf.headers['content-disposition'], /^inline;/);
	assert.equal(pdf.headers['content-type'], 'application/pdf');
	// The selected response type controls disposition; these bytes remain inert.
	for (const [type, keyType, expected] of [['image/png', 'image/svg+xml', 'attachment'],
		['image/svg+xml', 'image/png', 'inline']]) {
		const response = await request({ type, keyType, name: 'synthetic.svg', keyName: 'selected.png' });
		assert.equal(response.headers['content-type'], keyType);
		assert.ok(response.headers['content-disposition'].startsWith(expected + '; filename="selected.png"'));
		assert.deepEqual(response.body, original);
	}
	const name = await request({ type: 'image/png', name: 'ü"\r\n/synthetic.png' });
	assert.match(name.headers['content-disposition'], /^inline;.*filename\*=utf-8''/i);
	assert.ok(!/[\r\n]/.test(name.headers['content-disposition']));
});

test('native Raw routes retain download, plain, account, range, cache and bounded-thumbnail contracts', async () => {
	for (const type of ['image/png', 'image/svg+xml']) {
		for (const params of [{ action: 'Download' }, { fileHash: 1, keyType: type }]) {
			const response = await request({ type, ...params });
			assert.match(response.headers['content-disposition'], /^attachment;/);
			assert.deepEqual(response.body, original);
		}
	}
	const plain = await request({ action: 'ViewAsPlain', type: 'text/html' });
	assert.match(plain.headers['content-type'], /^text\/plain/);
	assert.deepEqual(plain.body, original);
	const denied = await request({ unauthorized: 1, type: 'image/png' });
	assert.equal(denied.headers['x-fixture-mail-callback'], undefined);
	assert.equal(denied.body.length, 0);
	const params = { type: 'image/png' };
	const normal = await request(params);
	assert.match(normal.headers['cache-control'], /private/);
	assert.ok(normal.headers.etag);
	const cached = await request(params, { 'If-None-Match': normal.headers.etag });
	assert.equal(cached.status, 304);
	assert.equal(cached.headers['x-fixture-mail-callback'], undefined);
	const range = await request(params, { Range: 'bytes=2-' });
	assert.equal(range.status, 206);
	assert.deepEqual(range.body, original.subarray(2));
	const thumbnail = await request({ action: 'ViewThumbnail', type: 'image/png', png: 1 });
	assert.equal(thumbnail.status, 200);
	assert.equal(thumbnail.headers['content-type'], 'image/png');
	assert.deepEqual([thumbnail.body.readUInt32BE(16), thumbnail.body.readUInt32BE(20)], [48, 48]);
	const unsupported = await request({ action: 'ViewThumbnail', type: 'image/svg+xml', svg: 1 });
	assert.equal(unsupported.status, 500);
	assert.equal(unsupported.body.length, 0);
});

test('Raw appends strict enforced CSP and retains configured framing and debug policy mode', async () => {
	for (const framing of [false, true]) {
		for (const debug of [false, true]) {
			const response = await request({ type: 'image/png', ...(framing ? { framing: 1 } : {}), ...(debug ? { debug: 1 } : {}) });
			const enforced = policies(response);
			const global = debug ? policies(response, 'content-security-policy-report-only') : enforced.slice(0, 1);
			assert.equal(enforced.length, debug ? 1 : 2);
			assert.equal(global.length, 1);
			assert.match(enforced.at(-1), /default-src 'none'/);
			for (const directive of ['script-src', 'child-src', 'object-src', 'base-uri', 'form-action']) {
				assert.ok(enforced.at(-1).includes(directive + " 'none'"));
			}
			if (framing) {
				assert.match(global[0], /frame-ancestors 'self'/);
				assert.equal(response.headers['x-frame-options'], undefined);
			} else assert.equal(response.headers['x-frame-options'], 'DENY');
			assert.equal(response.headers['x-content-type-options'], 'nosniff');
			assert.equal(response.headers['referrer-policy'], 'no-referrer');
		}
	}
});
