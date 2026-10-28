import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { demoContactsConfiguration, detectPdoSqlite } from '../scripts/dev-demo-contacts.mjs';
import { createSyntheticImapServer } from '../scripts/synthetic-imap-server.mjs';
import { createPrivateTestTempRoot } from './fixtures/private-test-temp.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const php = process.env.PHP_BINARY || 'php';
const isWindows = 'win32' === process.platform;
const testTemporaryRoot = await createPrivateTestTempRoot(test, 'upload-csrf');
const inert = Buffer.from('Synthetic upload fixture\n');
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
const crossSite = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe',
	Origin: 'https://fixture.invalid' };

class CookieJar {
	cookies = new Map();
	none = false;
	secure = false;
	header() { return [...this.cookies].map(([key, value]) => key + '=' + value).join('; '); }
	update(headers) {
		for (const cookie of headers['set-cookie'] || []) {
			const [pair, ...attributes] = cookie.split(';');
			const index = pair.indexOf('=');
			this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
			this.none ||= attributes.some(value => /^samesite=none$/i.test(value.trim()));
			this.secure ||= attributes.some(value => /^secure$/i.test(value.trim()));
		}
	}
}

// Raw HTTP preserves the explicit metadata; Node fetch can replace Sec-Fetch-Mode.
// The jar deliberately forwards synthetic Secure cookies over our own loopback HTTP.
// This exercises server invariants, not browser cookie delivery or CORS behavior.
async function request(base, route, { jar, token, method = 'GET', fields, file, metadata = sameOrigin } = {}) {
	const headers = { ...metadata, Accept: 'application/json' };
	if (jar) headers.Cookie = jar.header();
	if (undefined !== token) headers['X-SM-Token'] = token;
	let body;
	if (file) {
		const form = new FormData();
		form.append('uploader', new Blob([file.bytes], { type: file.type }), file.name);
		for (const [key, value] of Object.entries(fields || {})) form.append(key, value);
		const encoded = new Response(form);
		headers['Content-Type'] = encoded.headers.get('content-type');
		body = Buffer.from(await encoded.arrayBuffer());
	} else if (fields) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
		body = Buffer.from(new URLSearchParams(fields).toString());
	}
	if (body) headers['Content-Length'] = String(body.length);
	return new Promise((resolve, reject) => {
		const outgoing = httpRequest(new URL(route, base), { method, headers }, response => {
			const chunks = [];
			let size = 0;
			response.on('error', reject);
			response.on('aborted', () => reject(new Error('Local response aborted')));
			response.on('data', chunk => {
				size += chunk.length;
				if (size > 2 * 1024 * 1024) response.destroy(new Error('Local response exceeds fixture limit'));
				else chunks.push(chunk);
			});
			response.on('end', () => {
				jar?.update(response.headers);
				let json;
				try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
				resolve({ status: response.statusCode, json });
			});
		});
		outgoing.on('error', reject);
		outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Local request timed out')));
		outgoing.end(body);
	});
}

async function startPhp(dataRoot) {
	const reservation = createServer();
	await new Promise((resolve, reject) => {
		reservation.once('error', reject);
		reservation.listen(0, '127.0.0.1', resolve);
	});
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const child = spawn(php, ['-d', 'display_errors=0', '-S', '127.0.0.1:' + port,
		'-t', repo, path.join(repo, 'tests/fixtures/two-factor-router.php')], {
		cwd: repo, env: { ...process.env, PETUJA_TEST_DATA_PATH: dataRoot }, stdio: 'ignore'
	});
	const server = { base: 'http://127.0.0.1:' + port, stop: async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await new Promise(resolve => child.once('exit', resolve));
		}
	} };
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null || child.signalCode !== null) break;
		try {
			if (200 === (await request(server.base, '/?/AppData')).status) return server;
		} catch {}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	await server.stop();
	throw new Error('Synthetic PHP server did not start');
}

async function filesBelow(root, wanted) {
	const found = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const name = path.join(root, entry.name);
		if (entry.isDirectory()) found.push(...await filesBelow(name, wanted));
		else if (entry.isFile() && wanted(name)) found.push(name);
	}
	return found;
}

async function snapshot(dataRoot, database) {
	const files = await filesBelow(dataRoot, name => name.split(path.sep).includes('.files'));
	const result = spawnSync(php, ['-r', '$db=new PDO("sqlite:".$argv[1]); echo (int)$db->query("SELECT COUNT(*) FROM rainloop_ab_contacts WHERE deleted=0")->fetchColumn();', database],
		{ encoding: 'utf8', timeout: 10000 });
	assert.equal(result.status, 0, 'synthetic SQLite state is readable');
	assert.match(result.stdout, /^\d+$/);
	return { files: files.sort(), rows: Number(result.stdout) };
}

test('native multipart uploads require POST and current CSRF tokens before account file/contact mutation', {
	timeout: isWindows ? 300000 : 60000
}, async t => {
	const modules = spawnSync(php, ['-m'], { encoding: 'utf8' });
	if (modules.status !== 0 || !detectPdoSqlite(php).available
		|| ['intl', 'mbstring', 'openssl'].some(name => !new RegExp('^' + name + '$', 'im').test(modules.stdout))) {
		t.skip('PHP with native login and PDO SQLite extensions is required');
		return;
	}
	const root = await mkdtemp(path.join(testTemporaryRoot, 'petuja-upload-csrf-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dataRoot = path.join(root, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configPath = path.join(privateRoot, 'configs/application.ini');
	const password = randomBytes(24).toString('base64url');
	const imap = createSyntheticImapServer({ expectedPassword: password });
	let server;
	try {
		await Promise.all(['configs', 'domains', 'cache'].map(name => mkdir(path.join(privateRoot, name), { recursive: true })));
		await imap.listen();
		const domain = JSON.parse(await readFile(path.join(repo, 'snappymail/v/0.0.0/app/domains/default.json')));
		Object.assign(domain.IMAP, { host: '127.0.0.1', port: imap.port, type: 0 });
		await writeFile(path.join(privateRoot, 'domains/default.json'), JSON.stringify(domain));
		const configure = async (allowCrossSite, requireTwoFactor = false) => writeFile(configPath,
			demoContactsConfiguration('[plugins]\nenable = Off\n[security]\ncookie_samesite = "None"\n'
				+ 'require_two_factor_auth = ' + (requireTwoFactor ? 'On' : 'Off') + '\n'
				+ (allowCrossSite ? 'secfetch_allow = "mode=navigate,dest=iframe,site=cross-site"\n' : '')
				+ '[version]\ntwo_factor_policy_migration = 1\n[login]\nfault_delay = 0\n', { available: true }));
		await configure(false);
		server = await startPhp(dataRoot);
		const jar = new CookieJar();
		const guest = await request(server.base, '/?/AppData', { jar });
		const guestToken = guest.json?.System?.token;
		assert.match(guestToken, /^0-/);
		const login = await request(server.base, '/?/Json', { jar, token: guestToken, method: 'POST',
			fields: { Action: 'Login', Email: 'upload-' + randomBytes(8).toString('hex') + '@example.test', Password: password, signMe: '0' } });
		const token = login.json?.Result?.System?.token;
		assert.match(token, /^1-/, 'synthetic login response: ' + JSON.stringify(login.json));
		assert.equal(jar.none && jar.secure, true, 'supported None cookies retain Secure');
		const contacts = () => request(server.base, '/?/Json', { jar, token, method: 'POST', fields: { Action: 'Contacts' } });
		assert.equal((await contacts()).json?.Result?.Count, 0);
		const databases = await filesBelow(dataRoot, name => path.basename(name) === 'AddressBook.sqlite');
		assert.equal(databases.length, 1);
		const database = databases[0];
		const state = () => snapshot(dataRoot, database);
		const beforeDefault = await state();
		const denied = await request(server.base, '/?/Upload', { jar, method: 'POST', metadata: crossSite,
			file: { name: 'fixture.txt', bytes: inert, type: 'text/plain' } });
		assert.equal(denied.status, 403, 'default Fetch boundary remains in force');
		assert.deepEqual(await state(), beforeDefault);
		await server.stop();
		await configure(true);
		server = await startPhp(dataRoot);
		const cases = [
			['missing', {}, 101], ['wrong_header', { token: 'synthetic-invalid' }, 101],
			['wrong_body', { fields: { XToken: 'synthetic-invalid' } }, 101],
			['malformed_body', { fields: { 'XToken[]': token } }, 101],
			['old_guest_token', { token: guestToken }, 101],
			['header_wins', { token: 'synthetic-invalid', fields: { XToken: token } }, 101],
			['empty_header_wins', { token: '', fields: { XToken: token } }, 101],
			['missing_metadata_token_missing', { metadata: {} }, 101],
			...['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(method => ['method_' + method, { method, token }, 102]),
			['valid_header', { token }, 0], ['valid_body', { fields: { XToken: token } }, 0],
			['valid_header_wins', { token, fields: { XToken: 'synthetic-invalid' } }, 0]
		];
		for (const route of ['Upload', 'UploadContacts']) {
			for (const [name, options, code] of cases) {
				const before = await state();
				const method = options.method || 'POST';
				const contact = route === 'UploadContacts';
				const bytes = contact ? Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Synthetic Entry\r\nEMAIL:'
					+ name + '@example.test\r\nEND:VCARD\r\n') : inert;
				const result = await request(server.base, '/?/' + route, { jar, method, metadata: crossSite, ...options,
					file: method === 'POST' ? { name: contact ? 'fixture.vcf' : 'fixture.txt', bytes,
						type: contact ? 'text/vcard' : 'text/plain' } : undefined });
				const label = route + '/' + name;
				assert.equal(result.status, 200, label + ' retains JSON envelope');
				assert.equal(result.json?.code || 0, code, label + ' response=' + JSON.stringify(result.json));
				const after = await state();
				if (code) {
					assert.equal(result.json?.Result, false, label);
					assert.deepEqual(after, before, label + ' cannot mutate account storage');
				} else if (contact) {
					assert.equal(result.json?.Result, 1, label);
					assert.equal(after.rows, before.rows + 1, label);
					assert.deepEqual(after.files, before.files, 'contact upload spool is cleared');
				} else {
					assert.equal(after.files.length, before.files.length + 1, label);
					const added = after.files.find(file => !before.files.includes(file));
					assert.deepEqual(await readFile(added), inert, label);
					assert.ok(result.json?.Result?.Attachment?.tempName, label);
				}
			}
		}
		assert.equal((await contacts()).json?.Result?.Count, 3, 'native API sees exactly the valid imports');
		const anonymous = new CookieJar();
		const anonymousData = await request(server.base, '/?/AppData', { jar: anonymous });
		for (const route of ['Upload', 'UploadContacts']) {
			const before = await state();
			const result = await request(server.base, '/?/' + route, { jar: anonymous,
				token: anonymousData.json?.System?.token, method: 'POST',
				file: { name: 'fixture.txt', bytes: inert, type: 'text/plain' } });
			assert.equal(result.status, 200, 'the existing unauthenticated response envelope is preserved');
			if (route === 'Upload') assert.deepEqual(result.json?.Result, []);
			else assert.equal(result.json?.Result, false);
			assert.deepEqual(await state(), before);
		}
		await server.stop();
		await configure(true, true);
		server = await startPhp(dataRoot);
		for (const route of ['Upload', 'UploadContacts']) {
			const before = await state();
			const result = await request(server.base, '/?/' + route, { jar, token, method: 'POST',
				file: { name: 'fixture.txt', bytes: inert, type: 'text/plain' } });
			assert.equal(result.status, 403, 'pending enrollment remains authoritative over a valid token');
			assert.deepEqual(await state(), before);
		}
	} finally {
		await server?.stop();
		await imap.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('both first-party Jua uploaders read current tokens at send time and retain progress/completion', async () => {
	const requests = [];
	const context = vm.createContext({ document: {}, console, FormData,
		XMLHttpRequest: class {
			upload = {};
			headers = {};
			open(method, url) { this.method = method; this.url = url; }
			setRequestHeader(name, value) { this.headers[name] = value; }
			send(body) { this.body = body; requests.push(this); }
		}, rl: { settings: { app: () => context.currentToken } } });
	vm.runInContext(await readFile(path.join(repo, 'vendors/jua/jua.js'), 'utf8'), context);
	for (const [view, route] of [['Compose', 'Upload'], ['Contacts', 'UploadContacts']]) {
		const source = await readFile(path.join(repo, 'dev/View/Popup/' + view + '.js'), 'utf8');
		const callback = source.match(/headers: (\(\) => \(\{[^\n]+\}\))/)?.[1];
		assert.ok(callback, view + ' supplies a request-time header callback');
		context.callback = vm.runInContext(callback, context);
		context.currentToken = 'synthetic-initial';
		const uploader = new context.Jua({ action: '/?/' + route, headers: context.callback });
		const progress = [], completed = [];
		uploader.on('onProgress', (...args) => progress.push(args)).on('onComplete', (...args) => completed.push(args));
		for (const value of ['synthetic-current-a', 'synthetic-current-b']) {
			context.currentToken = value;
			const id = view + value;
			assert.equal(uploader.uploadTask(id, { file: new Blob([inert]) }), true);
			const xhr = requests.at(-1);
			assert.equal(xhr.method, 'POST');
			assert.equal(xhr.url, '/?/' + route);
			assert.equal(xhr.headers['X-SM-Token'], value);
			assert.equal(await xhr.body.get('uploader').text(), inert.toString());
			xhr.upload.onprogress({ lengthComputable: true, loaded: 1, total: inert.length });
			Object.assign(xhr, { readyState: 4, status: 200, responseText: '{"Result":true}' });
			xhr.onreadystatechange();
			assert.equal(completed.at(-1)[1], true);
			assert.equal(completed.at(-1)[2].Result, true);
		}
		assert.equal(progress.length, 2);
		assert.equal(completed.length, 2);
	}
});
