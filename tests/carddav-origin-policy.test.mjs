import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/carddav-origin-policy.php', import.meta.url));
async function probe(kind, input) {
	const { stdout } = await execute(process.env.PHP_BINARY || 'php', [
		'-d', 'display_errors=stderr', ...(kind === 'socket' ? ['-d', 'disable_functions=curl_init'] : []),
		fixture, kind, JSON.stringify(input)
	], { timeout: 20000, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
		http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
	return JSON.parse(stdout);
}

test('CardDAV URI identity normalizes IDNA, scheme, effective port and private hosts without DNS', async () => {
	const cases = [
		['HTTPS://BÜCHER.example.:443/a/../book/', 'https://xn--bcher-kva.example/book/'],
		['http://carddav:80/', 'http://carddav/'],
		['https://[FD00:0:0::1]:443/', 'https://[fd00::1]/'],
		['http://127.0.0.1:8080/book/', 'http://127.0.0.1:8080/book/']
	];
	assert.deepEqual(await probe('pure', cases.map(([url]) => ({ url }))), cases.map(([, expected]) => expected));
	const bad = ['http://user:secret@localhost/', 'http://localhost%2f.other/', 'http://localhost\\other/',
		'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://localhost:0/',
		'http://localhost:65536/', 'http://[fe80::1%25lo0]/', 'http:///path', 'file:///fixture',
		'http://localhost/\npath', 'http://localhost/#fragment', 'http://-bad/'];
	assert.deepEqual(await probe('pure', bad.map(url => ({ url }))), bad.map(() => ({ rejected: true })));
});

test('CardDAV operator policy uses exact origins, rejects malformed lists and preserves explicit private approval', async () => {
	const cases = [
		['http://localhost/book/', '', false],
		['http://localhost/book/', 'http://localhost', true],
		['http://localhost/book/', 'https://localhost', false],
		['http://localhost:8080/book/', 'http://localhost', false],
		['https://BÜCHER.example/book/|Personal', ' HTTPS://xn--bcher-kva.example:443/ ', true],
		['https://child.example.test/', 'https://example.test', false],
		['http://127.0.0.1:8080/book/', 'http://127.0.0.1:8080, https://example.test', true],
		['https://[fd00::1]/book/', 'https://[fd00::1]:443/', true],
		['carddav/book/', 'https://carddav', true],
		['fruux.com/book/', 'https://dav.fruux.com', true],
		['icloud.com/book/', 'https://contacts.icloud.com', true],
		['gmail.com/book/', 'https://google.com', true],
		['gmail.com.other/book/', 'https://google.com.other', false],
		...['http://localhost,', 'http://localhost, invalid', 'http://localhost/book', 'http://localhost?x',
			'http://localhost#fragment', 'http://user@localhost', 'http://*.localhost', 'http://localhost/a/..'].map(allowed => ['http://localhost/', allowed, false])
	];
	assert.deepEqual(await probe('pure', cases.map(([url, allowed]) => ({ url, allowed }))), cases.map(([, , value]) => value));
});

test('CardDAV relative references follow response path and query semantics', async () => {
	const base = 'https://carddav/a/b/entry?old';
	const cases = [['next', '/a/b/next'], ['../principal/', '/a/principal/'], ['/books/', '/books/'],
		['?new', '/a/b/entry?new'], ['', '/a/b/entry?old'], ['./', '/a/b/'], ['../../..', '/'],
		['../x//y/../', '/a/x//'], ['//CARDDAV:443/books/', '/books/']];
	assert.deepEqual(await probe('pure', cases.map(([url]) => ({ base, url }))),
		cases.map(([, suffix]) => 'https://carddav' + suffix));
});

const xml = (href, property = '') => '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">'
	+ '<d:response><d:href>' + href + '</d:href><d:propstat><d:prop>' + property
	+ '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
const book = '<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype>';
async function server(t, handler) {
	const requests = [];
	const service = createServer((request, response) => {
		requests.push({ path: request.url, authenticated: !!request.headers.authorization });
		request.resume();
		request.on('end', () => {
			if (!request.headers.authorization) {
				response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="synthetic-dav"' });
				response.end();
			} else handler(request, response);
		});
	});
	await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => service.close(resolve)));
	return { url: 'http://127.0.0.1:' + service.address().port, requests };
}

test('native DAV backends retain initial origin for requests, redirects and every parsed href', { timeout: 60000 }, async t => {
	for (const backend of ['curl', 'socket']) await t.test(backend, async t => {
		const other = await server(t, (request, response) => { response.writeHead(207); response.end(xml('/')); });
		let scenario = 'relative';
		const local = await server(t, (request, response) => {
			if ('/redirect/start' === request.url) {
				response.writeHead(301, { Location: 'cross-redirect' === scenario ? other.url + '/foreign/' : '../parse/final/' });
				response.end(); return;
			}
			response.writeHead(207, { 'Content-Type': 'application/xml' });
			const foreign = 'protocol-relative' === scenario ? other.url.slice(5) + '/foreign/'
				: ('uppercase-foreign' === scenario ? other.url.replace('http:', 'HTTP:') : other.url) + '/foreign/';
			response.end(xml('foreign-root' === scenario ? foreign : ('missing-root' === scenario ? '' : './child.vcf'),
				'<d:current-user-principal><d:href>' + (['foreign-principal', 'protocol-relative', 'uppercase-foreign'].includes(scenario)
					? foreign : ('missing-nested' === scenario ? '' : '../principal/')) + '</d:href></d:current-user-principal>'
				+ ('foreign-home' === scenario ? '<c:addressbook-home-set><d:href>' + foreign + '</d:href></c:addressbook-home-set>' : '')));
		});
		const run = input => probe(backend, { base: local.url + '/base/', ...input });
		const relative = await run({ action: 'propfind', reference: '/parse/entry' });
		assert.equal(relative.backend, 'SnappyMail\\HTTP\\Request\\' + (backend === 'curl' ? 'CURL' : 'Socket'));
		assert.equal(relative.properties[local.url + '/parse/child.vcf']['{DAV:}current-user-principal']['{DAV:}href'], local.url + '/principal/');
		const redirected = await run({ action: 'propfind', reference: '/redirect/start' });
		assert.equal(redirected.properties[local.url + '/parse/final/child.vcf']['{DAV:}current-user-principal']['{DAV:}href'], local.url + '/parse/principal/');
		for (scenario of ['foreign-root', 'foreign-principal', 'foreign-home', 'protocol-relative', 'uppercase-foreign',
			'missing-root', 'missing-nested', 'cross-redirect']) {
			const result = await run({ action: 'propfind', reference: scenario === 'cross-redirect' ? '/redirect/start' : '/parse/entry' });
			assert.equal(result.rejected, true, scenario);
		}
		const count = local.requests.length;
		for (const reference of [other.url + '/foreign/', other.url.slice(5) + '/foreign/', 'HTTP://user@127.0.0.1/']) {
			assert.equal((await run({ action: 'request', reference })).rejected, true);
		}
		assert.equal(local.requests.length, count, 'invalid direct request is rejected before egress');
		assert.equal(other.requests.length, 0, 'foreign origin receives neither requests nor synthetic credentials');
		assert.ok(local.requests.some(item => item.authenticated), 'ordinary approved local origin authenticates');
	});
});

test('native CardDAV discovery reuses the approved initial client and keeps separately approved origins isolated', { timeout: 60000 }, async t => {
	for (const backend of ['curl', 'socket']) await t.test(backend, async t => {
		const other = await server(t, (request, response) => { response.writeHead(207); response.end(xml('/foreign/', book)); });
		let foreign = false;
		let sameFallback = false;
		const local = await server(t, (request, response) => {
			if (sameFallback) {
				response.writeHead('/.well-known/carddav' === request.url ? 404 : 207, { 'Content-Type': 'application/xml' });
				response.end(xml('/same/')); return;
			}
			response.writeHead(207, { 'Content-Type': 'application/xml' });
			if ('/.well-known/carddav' === request.url) response.end(xml('/.well-known/carddav',
				'<d:current-user-principal><d:href>' + (foreign ? other.url + '/principal/' : '../principals/user/') + '</d:href></d:current-user-principal>'));
			else if ('/principals/user/' === request.url) response.end(xml('./', '<c:addressbook-home-set><d:href>../../books/</d:href></c:addressbook-home-set>'));
			else if ('/books/' === request.url) response.end(xml('personal/', book));
			else if ('/books/personal/' === request.url) response.end(xml('./', book));
			else response.end(xml(request.url));
		});
		const input = { base: local.url + '/', action: 'discovery', allowed: local.url + ',' + other.url };
		const success = await probe(backend, input);
		assert.equal(success.path, local.url + '/books/personal/');
		assert.equal(success.backend, 'SnappyMail\\HTTP\\Request\\' + (backend === 'curl' ? 'CURL' : 'Socket'));
		foreign = true;
		assert.equal((await probe(backend, input)).rejected, true);
		assert.equal(other.requests.length, 0, 'second operator-approved origin still gets no discovery requests or credentials');
		sameFallback = true;
		assert.equal((await probe(backend, { ...input, base: local.url + '/same/' })).path, null);
		assert.equal(local.requests.filter(item => item.authenticated && item.path === '/same/').length, 2,
			'same-path discovery fallback keeps only the existing initial check and fallback request');
		const count = local.requests.length;
		assert.equal((await probe(backend, { ...input, allowed: '' })).path, null);
		assert.equal(local.requests.length, count, 'revoked existing configuration makes zero requests');
	});
});
