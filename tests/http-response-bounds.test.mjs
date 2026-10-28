import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/http-response-bounds.php', import.meta.url));
const hash = body => createHash('sha256').update(body).digest('hex');
const exact = 'x'.repeat(1024);
const over = exact + 'x';
const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a.vcf</d:href><d:propstat><d:prop><d:getetag>one</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
const xmlExact = xml.replace('</d:multistatus>', '<!--' + ' '.repeat(1024 - xml.length - 7) + '--></d:multistatus>');

function framed(body, headers = '', status = '200 OK') {
	return Buffer.concat([Buffer.from('HTTP/1.1 ' + status + '\r\nConnection: close\r\n' + headers + '\r\n'), Buffer.from(body)]);
}
async function startFixture(t) {
	const server = createServer(socket => {
		let request = '';
		socket.on('error', () => {});
		socket.on('data', data => {
			request += data.toString();
			if (!request.includes('\r\n\r\n')) return;
			socket.removeAllListeners('data');
			const uri = request.split(' ')[1];
			const [kind, amount = 'exact'] = uri.slice(1).split('/');
			if ('drip' === kind) {
				socket.write(framed('x', 'Content-Length: 3\r\n'));
				const second = setTimeout(() => socket.write('x'), 700);
				const third = setTimeout(() => socket.end('x'), 1400);
				socket.once('close', () => { clearTimeout(second); clearTimeout(third); });
				return;
			}
			const body = 'over' === amount ? over : exact;
			let response;
			switch (kind) {
			case 'length': response = framed(body, 'Content-Length: ' + body.length + '\r\n'); break;
			case 'eof': response = framed(body); break;
			case 'chunk': response = framed(body.length.toString(16) + '\r\n' + body + '\r\n0\r\nX-Trailer: yes\r\n\r\n', 'Transfer-Encoding: chunked\r\n'); break;
			case 'split': response = framed('200;safe=yes\r\n' + exact.slice(0, 512) + '\r\n200\r\n' + exact.slice(512) + '\r\n0\r\n\r\n', 'Transfer-Encoding: chunked\r\n'); break;
			case 'largechunk': response = framed('6000\r\n' + 'x'.repeat(24576) + '\r\n0\r\n\r\n', 'Transfer-Encoding: chunked\r\n'); break;
			case 'gzip': {
				const zipped = gzipSync(body);
				response = framed(zipped, 'Content-Encoding: gzip\r\nContent-Length: ' + zipped.length + '\r\n'); break;
			}
			case 'badgzip': response = framed('invalid', 'Content-Encoding: gzip\r\nContent-Length: 7\r\n'); break;
			case 'short': response = framed('small', 'Content-Length: 20\r\n'); break;
			case 'badlength': response = framed('small', 'Content-Length: invalid\r\n'); break;
			case 'conflict': response = framed('small', 'Content-Length: 5\r\nContent-Length: 7\r\n'); break;
			case 'badchunk': response = framed('Z\r\nsmall\r\n0\r\n\r\n', 'Transfer-Encoding: chunked\r\n'); break;
			case 'overflowchunk': response = framed('ffffffffffffffffffffffffffffffff\r\n', 'Transfer-Encoding: chunked\r\n'); break;
			case 'shortchunk': response = framed('20\r\nsmall', 'Transfer-Encoding: chunked\r\n'); break;
			case 'badterminator': response = framed('5\r\nsmallXX0\r\n\r\n', 'Transfer-Encoding: chunked\r\n'); break;
			case 'headers': response = framed('small', ('X-Large: ' + 'h'.repeat(1000) + '\r\n').repeat(66)); break;
			case 'chunkmetadata': response = framed(('1;safe=' + 'a'.repeat(33000) + '\r\nx\r\n').repeat(2) + '0\r\n\r\n', 'Transfer-Encoding: chunked\r\n'); break;
			case 'error': response = framed('e'.repeat(1024 * 1024 + 1), '', '502 Bad Gateway'); break;
			case 'stale': response = Buffer.from('HTTP/1.1 200 OK\r\nX-Stale: must-not-survive\r\nContent-Length: 5\r\n'); break;
			case 'head': response = framed('', 'Content-Length: 9999999\r\n'); break;
			case 'empty': response = framed('', '', '204 No Content'); break;
			case 'interim': response = Buffer.concat([Buffer.from('HTTP/1.1 100 Continue\r\nX-Interim: yes\r\n\r\n'), framed('ok', 'Content-Length: 2\r\n')]); break;
			case 'redirect': response = framed('redirect-body-with-extra-tail', 'Location: /final\r\n', '302 Found'); break;
			case 'final': response = framed('ok', 'Content-Length: 2\r\n'); break;
			case 'dav': {
				const listing = 'over' === amount ? xmlExact.replace('-->', ' -->') : xmlExact;
				response = framed(listing, 'Content-Length: ' + listing.length + '\r\n', '207 Multi-Status'); break;
			}
			default: response = framed('', 'Content-Length: 0\r\n');
			}
			socket.end(response);
		});
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	t.after(() => new Promise(resolve => server.close(resolve)));
	return 'http://127.0.0.1:' + server.address().port;
}
async function run(backend, cases) {
	const child = spawn(process.env.PHP_BINARY || 'php', ['-d', 'display_errors=0', fixture, backend, JSON.stringify(cases)], { stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '', stderr = '';
	child.stdout.on('data', chunk => { stdout += chunk; });
	child.stderr.on('data', chunk => { stderr += chunk; });
	const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
	assert.equal(exit, 0, stderr);
	const results = JSON.parse(stdout);
	assert.ok(results.every(result => result.backend === 'SnappyMail\\HTTP\\Request\\' + ('curl' === backend ? 'CURL' : 'Socket')),
		'the requested backend must actually run; no silent factory fallback');
	return results;
}
for (const backend of ['curl', 'socket']) {
	test(backend + ' bounds complete buffered and streamed responses without partial success', { timeout: 20000 }, async t => {
		const base = await startFixture(t);
		const cases = [];
		for (const stream of [false, true]) {
			for (const kind of ['length', 'eof', 'chunk']) {
				for (const amount of ['exact', 'over']) cases.push({ url: base + '/' + kind + '/' + amount, stream, expect: amount === 'exact' });
			}
			cases.push({ url: base + '/split', stream, expect: true });
		}
		for (const amount of ['exact', 'over']) cases.push({ url: base + '/gzip/' + amount, expect: amount === 'exact' });
		cases.push({ url: base + '/length/over', limit: 0, expect: true, length: 1025 });
		cases.push({ url: base + '/largechunk', limit: 0, stream: true, expect: true, length: 24576 });
		for (const invalid of [-1, 0.5, '0', 'invalid', 1e30]) cases.push({ url: base + '/length/exact', limit: invalid, expect: false });
		const results = await run(backend, cases);
		assert.equal(results.length, cases.length);
		results.forEach((result, i) => {
			const item = cases[i];
			assert.equal(result.ok, item.expect, JSON.stringify({ backend, item, result }));
			assert.equal(result.pgp_default_kb, 1024, 'keyserver bodies inherit the finite default');
			assert.ok(result.bytes <= (item.length ?? 1024), 'no over-limit stream output');
			if (item.expect) {
				assert.equal(result.bytes, item.length ?? 1024);
				assert.equal(result.hash, hash('x'.repeat(item.length ?? 1024)));
			}
		});
	});
	test(backend + ' rejects incomplete framing, failed writes and stale headers; preserves redirects and DAV', { timeout: 20000 }, async t => {
		const base = await startFixture(t);
		const failures = ['short', 'badlength', 'conflict', 'badchunk', 'overflowchunk', 'shortchunk', 'badterminator', 'headers', 'badgzip', 'stale'];
		const cases = failures.map(kind => ({ url: base + '/' + kind }));
		cases.push({ url: base + '/final' });
		cases.push({ url: base + '/length/exact', stream: 'fail' });
		cases.push({ url: base + '/length/exact', stream: 'short' });
		cases.push({ url: base + '/head', method: 'HEAD' });
		cases.push({ url: base + '/empty' });
		cases.push({ url: base + '/interim' });
		cases.push({ url: base + '/redirect', stream: true, redirects: 1 });
		cases.push({ url: base + '/dav/exact', dav: true });
		cases.push({ url: base + '/dav/over', dav: true });
		cases.push({ url: base + '/gzip/exact', stream: true });
		cases.push({ url: base + '/length/exact', stream: 'pipe' });
		cases.push({ url: base + '/redirect', stream: 'pipe', redirects: 1 });
		cases.push({ url: base + '/error', stream: true, limit: 0 });
		cases.push({ url: base + '/drip' });
		cases.push({ url: base + '/length/exact', stream: 'partial' });
		if ('socket' === backend) {
			cases.push({ url: base + '/chunkmetadata', stream: true });
			cases.push({ url: base + '/chunkmetadata', stream: true, limit: 0 });
		}
		const results = await run(backend, cases);
		failures.forEach((kind, i) => assert.equal(results[i].ok, false, kind + ': ' + JSON.stringify(results[i])));
		const rest = results.slice(failures.length);
		assert.equal(rest[0].ok, true);
		assert.equal(rest[0].stale_header, null);
		assert.equal(rest[1].ok, false);
		assert.equal(rest[2].ok, true, 'positive short writes must be completed');
		assert.equal(rest[2].bytes, 1024);
		assert.equal(rest[3].ok, true);
		assert.equal(rest[3].bytes, 0);
		assert.equal(rest[4].ok, true);
		assert.equal(rest[4].bytes, 0);
		assert.equal(rest[5].ok, true);
		assert.equal(rest[5].hash, hash('ok'));
		assert.equal(rest[6].ok, true);
		assert.equal(rest[6].bytes, 2);
		assert.equal(rest[6].hash, hash('ok'));
		assert.equal(rest[7].dav_default_kb, 1024);
		assert.equal(rest[7].ok, true);
		assert.equal(rest[7].entries, 1);
		assert.equal(rest[8].ok, false);
		assert.equal(rest[9].ok, false, 'streamed gzip remains unsupported; no decoding feature');
		assert.equal(rest[10].ok, true, 'single-response pipes remain supported');
		assert.equal(rest[10].bytes, 1024);
		assert.equal(rest[10].hash, hash(exact));
		assert.equal(rest[11].ok, false, 'a pipe cannot erase an emitted redirect body');
		assert.equal(rest[12].ok, false, 'zero permits only successful Core archive bodies to be unlimited');
		assert.ok(rest[12].bytes <= 1024 * 1024, 'non-200 output remains bounded');
		assert.equal(rest[13].ok, false, 'small arriving parts cannot extend the overall timeout');
		assert.equal(rest[14].ok, false, 'a positive partial write followed by failure is controlled');
		assert.equal(rest[14].bytes, 3);
		assert.equal(rest[14].counted_bytes, 3, 'emitted bytes are counted even when a later write fails');
		if ('socket' === backend) {
			assert.equal(rest[15].ok, false, 'finite Socket responses bound cumulative chunk metadata');
			assert.ok(rest[15].bytes <= 1);
			assert.equal(rest[16].ok, true, 'successful unlimited archives permit many bounded chunk lines');
			assert.equal(rest[16].hash, hash('xx'));
		}
	});
}
