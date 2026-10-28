import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/external-image-public-destination.php', import.meta.url));
const execute = promisify(execFile);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

async function run(mode, input, backend = 'curl', proxy = '') {
	const flags = ['-d', 'display_errors=0', '-d', 'log_errors=0'];
	const disabled = ['header'];
	if ('policy' === mode) disabled.push('dns_get_record');
	if (input.oldCurl) disabled.push('curl_version');
	if ('service-denied' === mode && 'socket' === backend) disabled.push('curl_init');
	flags.push('-d', 'disable_functions=' + disabled.join(','));
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (/(^|_)proxy$/i.test(key)) delete env[key];
	if (proxy) Object.assign(env, { http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '', no_proxy: '' });
	const child = spawn(process.env.PHP_BINARY || 'php', [...flags, fixture, mode, JSON.stringify(input)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	const output = [], errors = [];
	child.stdout.on('data', data => output.push(data));
	child.stderr.on('data', data => errors.push(data));
	const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
	const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
	clearTimeout(timer);
	const stdout = Buffer.concat(output), stderr = Buffer.concat(errors).toString();
	assert.equal(code, 0, stderr);
	return mode.startsWith('service-') ? { body: stdout, ...JSON.parse(stderr) } : JSON.parse(stdout);
}

async function listen(t, server, host = '127.0.0.1') {
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
	t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
	return server.address().port;
}

test('public-image policy classifies special addresses without DNS or connections', async () => {
	const denied = ['0.0.0.0', '0.255.255.255', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1',
		'169.254.1.1', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.31.196.1',
		'192.52.193.1', '192.88.99.1', '192.168.1.1', '192.175.48.1', '198.18.0.1', '198.19.255.255',
		'198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
		'::', '::1', '::127.0.0.1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '64:ff9b::808:808', '64:ff9b:1::1',
		'100::1', '2001::1', '2001:1ff:ffff::1', '2001:db8::1', '2002:808:808::1', '2620:4f:8000::1',
		'3fff::1', '3fff:fff:ffff::1', '5f00::1', 'fc00::1', 'fe80::1', 'ff02::1', 'fe80::1%lo0', 'invalid'];
	const allowed = ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255',
		'172.32.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255', '2001:4860:4860::8888', '2606:4700:4700::1111'];
	const results = await run('policy', [...denied, ...allowed].map(address => ({ address })));
	results.forEach((result, i) => { assert.equal(result.public, i >= denied.length, [...denied, ...allowed][i]); assert.deepEqual(result.queries, []); });
});

test('public-image URI and DNS decisions are strict, bounded and fail closed', async () => {
	const A = ip => ({ type: 'A', ip });
	const AAAA = ipv6 => ({ type: 'AAAA', ipv6 });
	const CNAME = (host, target) => ({ type: 'CNAME', host, target });
	const addresses = { 'images.example.test#address': [A('8.8.8.8'), AAAA('2001:4860:4860::8888'), A('8.8.8.8')] };
	const cases = [
		{ url: 'hTtPs://IMAGES.EXAMPLE.TEST.:00443/a%20b?q=1#ignored', records: addresses },
		{ url: 'http://8.8.8.8?x=1' }, { url: 'HTTPS://[2001:4860:4860::8888]/' },
		{ url: 'https://bücher.example.test/', records: { 'xn--bcher-kva.example.test#address': [A('8.8.8.8')] } },
		{ url: 'https://images.example.test/', records: { 'images.example.test#address': [CNAME('images.example.test', 'alias.example.test'), { ...A('8.8.8.8'), host: 'alias.example.test' }] } },
		{ url: 'https://images.example.test/', records: { 'images.example.test#alias': [CNAME('images.example.test.', 'alias.example.test.'), CNAME('alias.example.test', 'terminal.example.test')], 'alias.example.test#address': [AAAA('2001:4860:4860::8888')] } },
		{ url: 'http://images.example.test/%0d%0a', records: addresses }
	];
	const malformed = ['file:///tmp/synthetic.png', 'ftp://images.example.test/', '//images.example.test/',
		'http://user:synthetic@images.example.test/', 'http://@images.example.test/', 'http://images.example.test\\@other.example.test/',
		'http://images.example.test:0/', 'http://images.example.test:65536/',
		'http://images.example.test:+80/', 'http://images.example.test:/', 'http://images.example.test:000080/',
		'http://images%2eexample.test/', 'http://images.example.test\r\nX-Test: x', 'http://images.example.test /',
		'http://[::ffff:8.8.8.8]/', 'http://[fe80::1%25lo0]/', 'http://[2001:4860:4860::8888]suffix/',
		'http://127.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://0x7f.0.0.1/',
		'http://127.000.000.001/', 'http://１２７。０。０。１/', 'http://localhost/', 'http://images..example.test/',
		'http://-images.example.test/', 'http://images.example.test../', 'http://[::1]/', 'http://10.0.0.1/'];
	const failures = malformed.map(url => ({ url, records: addresses }));
	for (const rows of [false, [], [A('127.0.0.1')], [A('8.8.8.8'), A('10.0.0.1')], [A('8.8.8.8'), AAAA('::1')],
		[A('8.8.8.8'), AAAA('::ffff:8.8.8.8')], [A('invalid')], [{ type: 'AAAA', ipv6: '8.8.8.8' }], [{ type: 'TXT', txt: 'synthetic' }], Array.from({ length: 65 }, () => A('8.8.8.8'))]) {
		failures.push({ url: 'https://images.example.test/', records: { 'images.example.test#address': rows } });
	}
	failures.push({ url: 'https://images.example.test/', records: { 'images.example.test#alias': [CNAME('other.example.test', 'alias.example.test')] } });
	failures.push({ url: 'https://images.example.test/', records: { 'images.example.test#alias': [CNAME('images.example.test', 'alias.example.test'), CNAME('images.example.test', 'other.example.test')] } });
	failures.push({ url: 'https://images.example.test/', records: { 'images.example.test#alias': [CNAME('images.example.test', 'alias.example.test')], 'alias.example.test#alias': [CNAME('alias.example.test', 'images.example.test')] } });
	failures.push({ url: 'https://images.example.test/', records: { 'images.example.test#alias': [CNAME('images.example.test', '127.0.0.1')] } });
	const chain = {};
	for (let i = 0; i < 9; ++i) chain['n' + i + '.example.test#alias'] = [CNAME('n' + i + '.example.test', 'n' + (i + 1) + '.example.test')];
	chain['n9.example.test#address'] = [A('8.8.8.8')];
	failures.push({ url: 'https://n0.example.test/', records: chain });
	failures.push({ url: 'https://images.example.test/', records: addresses, deadlineChecks: 1 });
	const results = await run('policy', [...cases, ...failures]);
	for (let i = 0; i < cases.length; ++i) assert.ok(results[i].destination, 'ordinary decision ' + i);
	assert.equal(results[0].destination.uri, 'https://images.example.test/a%20b?q=1');
	assert.deepEqual(results[0].destination.addresses, ['8.8.8.8', '2001:4860:4860::8888']);
	assert.equal(results[1].destination.uri, 'http://8.8.8.8/?x=1');
	assert.equal(results[3].destination.host, 'xn--bcher-kva.example.test');
	assert.equal(results[5].queries.length, 3);
	assert.equal(results[6].destination.uri, cases[6].url, 'encoded path bytes remain inert');
	results.slice(cases.length).forEach((result, i) => assert.equal(result.rejected, true, 'denied decision ' + i));
	assert.equal(results.at(-2).queries.length, 16, 'alias chain has fixed bound');
	assert.equal(results.at(-1).checks, 2, 'deadline checked after native resolver returns');
});

test('both native transports pin synthetic loopback snapshots and check every redirect', { timeout: 30000 }, async t => {
	const hits = [], proxyHits = [];
	let port;
	const server = httpServer((req, res) => {
		hits.push({ host: req.headers.host, path: req.url });
		if ('/denied' === req.url) res.writeHead(302, { Location: 'http://127.0.0.1:' + port + '/never' });
		else if ('/redirect' === req.url) res.writeHead(302, { Location: 'http://second.example.test:' + port + '/image' });
		else if ('/relative' === req.url) res.writeHead(302, { Location: '/image' });
		else if ('/loop' === req.url) res.writeHead(302, { Location: '/loop' });
		else res.writeHead(200, { 'Content-Type': 'image/png' });
		res.end('ok');
	});
	port = await listen(t, server);
	const proxyPort = await listen(t, httpServer((req, res) => { proxyHits.push(req.url); res.writeHead(502).end(); }));
	for (const backend of ['curl', 'socket']) {
		for (const path of ['/image', '/redirect', '/relative', '/denied', '/loop']) {
			const result = await run('request', { backend, port, url: 'http://images.example.test:' + port + path }, backend, 'http://127.0.0.1:' + proxyPort);
			assert.equal(result.backend, 'SnappyMail\\HTTP\\Request\\' + ('curl' === backend ? 'CURL' : 'Socket'));
			if ('/denied' === path) { assert.equal(result.rejected, true); assert.equal(result.policyCalls.length, 2); }
			else if ('/loop' === path) { assert.equal(result.status, 302); assert.equal(result.policyCalls.length, 3); }
			else { assert.equal(result.status, 200); assert.equal(result.body, 'ok'); assert.equal(result.policyCalls.length, '/image' === path ? 1 : 2); }
		}
	}
	assert.equal(proxyHits.length, 0, 'environment proxy cannot choose the connection destination');
	assert.ok(hits.every(hit => ['images.example.test:' + port, 'second.example.test:' + port].includes(hit.host)));
	assert.ok(hits.some(hit => hit.host.startsWith('second.')));
	assert.ok(hits.every(hit => '/never' !== hit.path));
	const previousHits = hits.length;
	assert.equal((await run('request', { backend: 'curl', port, oldCurl: true, url: 'http://images.example.test:' + port + '/old-hostname' })).rejected, true);
	assert.equal(hits.length, previousHits, 'unsupported hostname pinning fails before connection');
	const literal = await run('request', { backend: 'curl', port, oldCurl: true, literal: true, url: 'http://127.0.0.1:' + port + '/literal' }, 'curl', 'http://127.0.0.1:' + proxyPort);
	assert.equal(literal.status, 200, 'canonical literal needs no DNS-pinning capability');
	assert.equal(hits.at(-1).host, '127.0.0.1:' + port);
	assert.equal(proxyHits.length, 0);
});

test('pinned native HTTPS preserves original Host, SNI, chain and hostname checks', { timeout: 40000 }, async t => {
	const work = await mkdtemp(join(tmpdir(), 'public-image-tls-'));
	t.after(() => rm(work, { recursive: true, force: true }));
	const openssl = async args => execute('openssl', args.map(value => value.startsWith('@') ? join(work, value.slice(1)) : value), { timeout: 10000 });
	await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '@ca.key', '-out', '@ca.pem', '-days', '1', '-subj', '/CN=synthetic-image-CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
	await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', '@leaf.key', '-out', '@leaf.csr', '-subj', '/CN=images.example.test']);
	await writeFile(join(work, 'leaf.ext'), 'subjectAltName=DNS:images.example.test\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n');
	await openssl(['x509', '-req', '-in', '@leaf.csr', '-CA', '@ca.pem', '-CAkey', '@ca.key', '-CAcreateserial', '-out', '@leaf.pem', '-days', '1', '-extfile', '@leaf.ext']);
	const key = await readFile(join(work, 'leaf.key')), cert = await readFile(join(work, 'leaf.pem'));
	const hits = [];
	const server = httpsServer({ key, cert }, (req, res) => { hits.push({ host: req.headers.host, sni: req.socket.servername }); res.end('secure'); });
	server.on('tlsClientError', () => {});
	const port = await listen(t, server);
	for (const backend of ['curl', 'socket']) {
		const input = { backend, port, url: 'hTtPs://images.example.test:' + port + '/image', ca: join(work, 'ca.pem') };
		const trusted = await run('request', input);
		assert.equal(trusted.status, 200, backend + ' trusted synthetic CA succeeds');
		assert.equal(trusted.final, 'https://images.example.test:' + port + '/image');
		assert.equal((await run('request', { ...input, ca: '' })).rejected, true, backend + ' untrusted chain rejected');
		assert.equal((await run('request', { ...input, url: input.url.replace('images.', 'wrong.') })).rejected, true, backend + ' hostname mismatch rejected');
	}
	assert.deepEqual(hits, Array.from({ length: 2 }, () => ({ host: 'images.example.test:' + port, sni: 'images.example.test' })));
	const v6 = httpServer((req, res) => res.end(req.headers.host));
	const v6port = await listen(t, v6, '::1');
	for (const backend of ['curl', 'socket']) {
		const result = await run('request', { backend, port: v6port, family: 'ipv6', url: 'http://images.example.test:' + v6port + '/' });
		assert.equal(result.status, 200, backend + ' pinned IPv6 snapshot');
		assert.equal(result.body, 'images.example.test:' + v6port);
	}
});

test('proxy service method denies local destinations and old validators before cache or egress', { timeout: 20000 }, async t => {
	let hits = 0;
	const port = await listen(t, httpServer((req, res) => { ++hits; res.writeHead(200, { 'Content-Type': 'image/png' }).end(png); }));
	for (const backend of ['curl', 'socket']) {
		for (const variant of [{ validator: 'old' }, { validator: 'new' }, { legacy: true }, { malformed: true }, { authenticated: false }, { enabled: false }]) {
			const result = await run('service-denied', { url: 'http://127.0.0.1:' + port + '/synthetic.png', ...variant }, backend);
			assert.equal(result.status, 404);
			assert.equal(result.body.length, 0);
			assert.deepEqual(result.events, []);
			assert.ok(!result.headers.some(header => /^X-Content-/i.test(header)));
			assert.equal(result.backend, 'SnappyMail\\HTTP\\Request\\' + ('curl' === backend ? 'CURL' : 'Socket'));
		}
	}
	assert.equal(hits, 0, 'denied fixture receives zero requests');
});

test('proxy success and native ETag checks follow policy, transfer and MIME acceptance', async () => {
	const url = 'https://images.example.test/synthetic.png';
	for (const validator of ['', 'old', 'new']) {
		const result = await run('service-contract', { url, validator });
		assert.equal(result.status, 'new' === validator ? 304 : 200);
		assert.deepEqual(result.events.map(event => event[0]), 'new' === validator ? ['policy', 'fetch', 'cache-check'] : ['policy', 'fetch', 'cache-check', 'cache']);
		assert.equal(result.events[0][1], true);
		assert.equal(result.events[1][1], 2);
		assert.ok(result.events[2][1].startsWith('external-image-public-v1:'));
		assert.deepEqual(result.body, 'new' === validator ? Buffer.alloc(0) : png);
		assert.ok(!result.headers.includes('Cache-Control: private') || 'new' !== validator, '304 retains previous public-cache metadata');
		if ('new' !== validator) {
			assert.ok(result.headers.includes('Content-Type: image/png'));
			assert.ok(result.headers.includes('Cache-Control: public'));
			assert.ok(result.headers.includes('X-Content-Redirect-Location: ' + url));
		}
	}
	for (const variant of [{ status: 404 }, { body: 'text' }]) {
		const result = await run('service-contract', { url, ...variant });
		assert.equal(result.status, 404);
		assert.deepEqual(result.events.map(event => event[0]), ['policy', 'fetch']);
		assert.equal(result.body.length, 0);
	}
	const source = await readFile(new URL('../dev/Common/Links.js', import.meta.url), 'utf8');
	const context = vm.createContext({ doc: { location: { pathname: '/mail/' } }, btoa: value => Buffer.from(value, 'binary').toString('base64') });
	vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('export const', 'const') + '\nglobalThis.fixtureProxy = proxy;', context);
	const link = context.fixtureProxy(url);
	assert.ok(link.startsWith('/mail/?/ProxyExternal/public-v1/'));
	assert.equal(Buffer.from(link.split('/').at(-1), 'base64url').toString(), url);
});
