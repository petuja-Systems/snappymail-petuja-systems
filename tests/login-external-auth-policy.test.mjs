import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSyntheticImapServer } from '../scripts/synthetic-imap-server.mjs';
import { createPrivateTestTempRoot } from './fixtures/private-test-temp.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = 'win32' === process.platform;
const phpBinary = process.env.PHP_BINARY || 'php';
const testEmail = 'sec16-user@example.test';
const testPassword = 'sec16-local-password';
const testTemporaryRoot = await createPrivateTestTempRoot(test, 'auth-policy');
const testHeaders = {
	'Accept': 'application/json',
	'Sec-Fetch-Dest': 'empty',
	'Sec-Fetch-Mode': 'cors',
	'Sec-Fetch-Site': 'same-origin'
};

class CookieJar {
	#cookies = new Map();

	header() {
		return [...this.#cookies].map(([name, value]) => name + '=' + value).join('; ');
	}

	get(name) {
		return this.#cookies.get(name);
	}

	set(name, value) {
		this.#cookies.set(name, value);
	}

	names() {
		return [...this.#cookies.keys()];
	}

	update(response) {
		const setCookie = response.headers.getSetCookie?.()
			?? (response.headers.get('set-cookie') || '').split(/,\s*(?=[^;,\s]+=)/);

		for (const cookie of setCookie) {
			const [pair, ...attributes] = cookie.split(';');
			const separator = pair.indexOf('=');
			if (separator < 1) {
				continue;
			}
			const name = pair.slice(0, separator).trim();
			const value = pair.slice(separator + 1).trim();
			const expired = attributes.some(attribute => /^max-age=0$/i.test(attribute.trim()));
			if (!value || expired) {
				this.#cookies.delete(name);
			} else {
				this.#cookies.set(name, value);
			}
		}
	}
}

async function reserveLocalPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

async function startImapServer(t) {
	const server = createSyntheticImapServer({
		expectedPassword: testPassword,
		greeting: 'isolated SEC-16 fixture'
	});
	const port = await server.listen();
	t.after(() => server.close());
	return { port, logins: server.logins };
}

async function startPhpServer(t, dataRoot, policyStatePath) {
	const phpModules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8' });
	if (phpModules.error || 0 !== phpModules.status) {
		t.skip('PHP CLI is unavailable: ' + (phpModules.error?.message || phpModules.stderr));
		return null;
	}
	for (const moduleName of ['intl', 'mbstring', 'openssl']) {
		if (!new RegExp('^' + moduleName + '$', 'im').test(phpModules.stdout)) {
			t.skip('PHP ' + moduleName + ' extension is unavailable');
			return null;
		}
	}

	const port = await reserveLocalPort();
	const routerPath = path.join(repositoryRoot, 'tests', 'fixtures', 'two-factor-router.php');
	const child = spawn(phpBinary, [
		'-d', 'display_errors=0',
		'-S', '127.0.0.1:' + port,
		'-t', repositoryRoot,
		routerPath
	], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PETUJA_TEST_DATA_PATH: dataRoot,
			PETUJA_TEST_LOGIN_POLICY_STATE: policyStatePath
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
	child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await new Promise(resolve => child.once('exit', resolve));
		}
	});

	const baseUrl = 'http://127.0.0.1:' + port;
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (null !== child.exitCode || null !== child.signalCode) {
			assert.fail('PHP test server exited early:\n' + output);
		}
		try {
			const response = await fetch(baseUrl + '/?/AppData', { headers: testHeaders });
			if (response.ok) {
				return { baseUrl, phpOutput: () => output };
			}
		} catch {
			// The PHP test server is still starting.
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('PHP test server did not start:\n' + output);
}

async function createEnvironment(t, { policyFixture = false, forceTwoFactor = false, faultDelay = 0 } = {}) {
	const temporaryRoot = await mkdtemp(path.join(testTemporaryRoot, 'petuja-sec16-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configRoot = path.join(privateRoot, 'configs');
	const domainRoot = path.join(privateRoot, 'domains');
	const policyStatePath = path.join(temporaryRoot, 'policy-state.json');
	const imap = await startImapServer(t);
	await mkdir(configRoot, { recursive: true });
	await mkdir(path.join(privateRoot, 'cache'), { recursive: true });
	await mkdir(domainRoot, { recursive: true });
	const enabledPlugins = ['login-external'];
	if (policyFixture) {
		enabledPlugins.push('login-public-password-policy');
	}
	const domain = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imap.port;
	domain.IMAP.type = 0;
	await writeFile(path.join(domainRoot, 'example.test.json'), JSON.stringify(domain));
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[plugins]',
		'enable = 1',
		'enabled_list = "' + enabledPlugins.join(',') + '"',
		'',
		'[security]',
		'require_two_factor_auth = ' + (forceTwoFactor ? 'On' : 'Off'),
		'',
		'[version]',
		'two_factor_policy_migration = 1',
		'',
		'[login]',
		'fault_delay = ' + faultDelay,
		''
	].join('\n'));
	await writeFile(policyStatePath, JSON.stringify({ mode: 'disabled' }));
	const server = await startPhpServer(t, dataRoot, policyStatePath);
	if (!server) {
		return null;
	}
	return {
		...server,
		dataRoot,
		imap,
		policyStatePath,
		applicationConfigPath: path.join(configRoot, 'application.ini')
	};
}

async function setPolicyMode(environment, mode) {
	await writeFile(environment.policyStatePath, JSON.stringify({ mode }));
}

async function setFaultDelay(environment, seconds) {
	const config = await readFile(environment.applicationConfigPath, 'utf8');
	await writeFile(environment.applicationConfigPath, config.replace(/fault_delay = \d+/, 'fault_delay = ' + seconds));
}

async function request(baseUrl, route, { jar, token, method = 'GET', fields, body, redirect = 'manual', headers: extraHeaders } = {}) {
	const headers = { ...testHeaders, ...extraHeaders };
	if (jar?.header()) {
		headers.Cookie = jar.header();
	}
	if (undefined !== token) {
		headers['X-SM-Token'] = token;
	}
	if (fields) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
		body = new URLSearchParams(fields);
	}
	const started = performance.now();
	const response = await fetch(baseUrl + route, { method, headers, body, redirect });
	jar?.update(response);
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// Redirect mode intentionally has no JSON response.
	}
	return { response, text, json, elapsedMs: performance.now() - started };
}

async function guestToken(environment, jar = new CookieJar()) {
	const result = await request(environment.baseUrl, '/?/AppData', { jar });
	assert.equal(result.response.status, 200, result.text.slice(0, 300));
	assert.match(result.json?.System?.token || '', /^0-/);
	return { jar, token: result.json.System.token };
}

async function externalLogin(environment, fields, { jar = new CookieJar(), redirect = 'manual' } = {}) {
	return request(environment.baseUrl, '/?ExternalLogin', {
		jar,
		method: 'POST',
		fields,
		redirect
	});
}

async function normalLogin(environment, fields, { jar = new CookieJar(), token } = {}) {
	if (!token) {
		({ jar, token } = await guestToken(environment, jar));
	}
	const result = await request(environment.baseUrl, '/?/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'Login', ...fields }
	});
	if (result.json && undefined === result.json.code && Object.hasOwn(result.json, 'Result')) {
		result.json.code = 0;
	}
	return result;
}

async function storageFilesNamed(directory, folderName) {
	const files = [];
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ('ENOENT' !== error.code) {
			throw error;
		}
		return files;
	}
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (folderName === entry.name) {
				for (const stored of await readdir(entryPath, { withFileTypes: true })) {
					if (stored.isFile()) {
						files.push(path.join(entryPath, stored.name));
					}
				}
			} else {
				files.push(...await storageFilesNamed(entryPath, folderName));
			}
		}
	}
	return files;
}

async function assertNoAuthenticatedResidue(environment, jar, existingSessions = []) {
	for (const name of ['smaccount', 'smsession', 'smadditional', 'smremember']) {
		assert.equal(jar.get(name), undefined, name + ' must not be issued for a rejected login');
	}
	assert.deepEqual(await storageFilesNamed(environment.dataRoot, '.sessions'), existingSessions,
		'rejected login must not leave new server-side SESSION rows or auth bindings');
	const appData = await request(environment.baseUrl, '/?/AppData', { jar });
	assert.equal(appData.json?.Auth, false, 'a rejected login must not authorize protected AppData');
}

test('SEC-16 native public-password login keeps Core protections and ignores plugin interception', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t, { policyFixture: true });
	if (!environment) {
		return;
	}

	await setPolicyMode(environment, 'required');
	const jar = new CookieJar();
	const { token } = await guestToken(environment, jar);
	const normal = await normalLogin(environment, { Email: testEmail, Password: testPassword }, { jar, token });
	assert.equal(normal.response.status, 200);
	assert.equal(normal.json?.code, 0, normal.text.slice(0, 300));
	assert.equal(normal.json?.Result?.Auth, true,
		'an installed generic public-password hook must not replace native credential and factor checks');
	assert.ok(jar.get('smaccount'), 'native login must issue the ordinary account session');
	await assert.rejects(readFile(environment.policyStatePath + '.calls', 'utf8'), { code: 'ENOENT' },
		'auth, action-parameter, route, JSON, AppData, and CSP hooks must remain inert');

	const externalJar = new CookieJar();
	const externalRoute = await externalLogin(environment, {
		Email: testEmail,
		Password: testPassword,
		Output: 'json'
	}, { jar: externalJar });
	assert.equal(externalRoute.response.status, 200);
	assert.equal(externalRoute.json, null,
		'the plugin-only ExternalLogin route must not be dispatched by retained Core');
	assert.equal(externalJar.get('smaccount'), undefined);
	assert.equal((await request(environment.baseUrl, '/?/AppData', { jar: externalJar })).json?.Auth, false);
	await assert.rejects(readFile(environment.policyStatePath + '.calls', 'utf8'), { code: 'ENOENT' },
		'calling the retired plugin route must not invoke any registered generic hook');
});

test('SEC-16 configured failure delay covers native public-password failures only', {
	timeout: isWindows ? 90000 : 30000
}, async t => {
	const environment = await createEnvironment(t, { faultDelay: 1 });
	if (!environment) {
		return;
	}
	await setFaultDelay(environment, 0);
	const baselineJar = new CookieJar();
	const { token: baselineToken } = await guestToken(environment, baselineJar);
	const baselineSuccess = await normalLogin(environment, {
		Email: testEmail,
		Password: testPassword
	}, { jar: baselineJar, token: baselineToken });
	assert.equal(baselineSuccess.json?.code, 0, baselineSuccess.text.slice(0, 300));
	const baselineLogout = await request(environment.baseUrl, '/?/Json', {
		jar: baselineJar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(baselineLogout.json?.Result, true, JSON.stringify(baselineLogout.json));
	assert.deepEqual(await storageFilesNamed(environment.dataRoot, '.sessions'), [],
		'the no-delay baseline session is removed before rejected-login checks');
	await setFaultDelay(environment, 1);

	const cases = [
		['backend authentication failure', { Email: testEmail, Password: 'incorrect' }],
		['malformed email', { Email: 'invalid-address', Password: 'incorrect' }],
		['missing password', { Email: testEmail }],
		['domain failure', { Email: 'user@missing.test', Password: testPassword }]
	];
	for (const [label, fields] of cases) {
		const jar = new CookieJar();
		const { token } = await guestToken(environment, jar);
		const result = await normalLogin(environment, fields, { jar, token });
		assert.notEqual(result.json?.code, 0, label);
		assert.ok(result.elapsedMs >= 800, label + ' must receive the configured minimum failure delay; got ' + result.elapsedMs + 'ms');
		await assertNoAuthenticatedResidue(environment, jar);
	}

	const successJar = new CookieJar();
	const { token } = await guestToken(environment, successJar);
	const successful = await normalLogin(environment, {
		Email: testEmail,
		Password: testPassword
	}, { jar: successJar, token });
	assert.equal(successful.json?.code, 0, successful.text.slice(0, 300));
	assert.equal(successful.json?.Result?.Auth, true);
	assert.ok(successful.elapsedMs < baselineSuccess.elapsedMs + 800,
		'successful native login must not receive the configured failure delay; baseline '
			+ baselineSuccess.elapsedMs + 'ms, configured ' + successful.elapsedMs + 'ms');
});

test('SEC-16 forced two-factor enrollment remains pending on native login', {
	timeout: isWindows ? 90000 : 30000
}, async t => {
	const environment = await createEnvironment(t, { forceTwoFactor: true });
	if (!environment) {
		return;
	}
	const jar = new CookieJar();
	const { token } = await guestToken(environment, jar);
	const login = await normalLogin(environment, {
		Email: testEmail,
		Password: testPassword
	}, { jar, token });
	assert.equal(login.json?.code, 0, login.text.slice(0, 300));
	assert.equal(login.json?.Result?.Auth, true);
	assert.equal(login.json?.Result?.SetupTwoFactor, true,
		'native login must retain the server-side pending enrollment state');
	const restrictedAction = await request(environment.baseUrl, '/?/Json', {
		jar,
		token: login.json?.Result?.System?.token,
		method: 'POST',
		fields: { Action: 'SettingsUpdate', language: 'en' }
	});
	assert.notEqual(restrictedAction.json?.code, 0,
		'a pending native session must remain barred from ordinary authenticated actions');
});

function abusePath(environment) {
	return path.join(environment.dataRoot, '_data_', '_default_', 'login-abuse', 'state.json');
}

async function expireAbuseBudget(environment) {
	const file = abusePath(environment);
	const state = JSON.parse(await readFile(file, 'utf8'));
	for (const events of Object.values(state.buckets)) {
		for (const id of Object.keys(events)) events[id] = Math.floor(Date.now() / 1000) - 1;
	}
	await writeFile(file, JSON.stringify(state));
}

test('M7.4 native public login shares atomic account budgets across actions, workers and normalized identities', {
	timeout: isWindows ? 90000 : 30000
}, async t => {
	const environment = await createEnvironment(t);
	if (!environment) return;
	const config = await readFile(environment.applicationConfigPath, 'utf8');
	await writeFile(environment.applicationConfigPath, config.replace('[login]', '[login]\ndefault_domain = "example.test"'));
	const domains = path.join(environment.dataRoot, '_data_', '_default_', 'domains');
	const domain = JSON.parse(await readFile(path.join(domains, 'example.test.json'), 'utf8'));
	domain.IMAP.shortLogin = true;
	domain.IMAP.stripLogin = '+';
	await writeFile(path.join(domains, 'example.test.json'), JSON.stringify(domain));
	await writeFile(path.join(domains, 'alias.test.alias'), 'example.test');
	const second = await startPhpServer(t, environment.dataRoot, environment.policyStatePath);
	const variants = ['sec16-user@example.test', ' SEC16-USER@EXAMPLE.TEST ', 'sec16-user', 'sec16-user@alias.test', 'sec16-+user@example.test'];
	const actions = ['Login', 'TwoFactorLoginBegin', 'TwoFactorLoginVerify'];
	const guests = await Promise.all(Array.from({ length: 14 }, (_, n) => guestToken({ baseUrl: n % 2 ? second.baseUrl : environment.baseUrl })));
	const responses = await Promise.all(guests.map((guest, n) => request(n % 2 ? second.baseUrl : environment.baseUrl, '/?/Json', {
		...guest, method: 'POST',
		fields: { Action: actions[n % actions.length], Email: variants[n % variants.length], Password: 'incorrect-local-fixture' },
		headers: { 'X-Forwarded-For': '192.0.2.' + (n + 1), 'X-Real-IP': '198.51.100.' + (n + 1), 'Client-IP': '203.0.113.' + (n + 1) }
	})));
	assert.ok(responses.every(result => result.json?.code === 102), responses.map(result => result.text).join('\n'));
	assert.equal(environment.imap.logins.length, 10, 'only the bounded admitted requests reach synthetic IMAP');
	assert.ok(environment.imap.logins.every(user => user === 'sec16-user'), 'configured variants really share the backend identity');
	for (let n = 0; n < guests.length; ++n) await assertNoAuthenticatedResidue(environment, guests[n].jar);
	const before = await readFile(abusePath(environment), 'utf8');
	const blocked = await normalLogin(environment, { Email: testEmail, Password: testPassword });
	assert.equal(blocked.json?.code, 102, 'even valid credentials are rejected generically while the budget is exhausted');
	assert.equal(environment.imap.logins.length, 10);
	assert.equal(await readFile(abusePath(environment), 'utf8'), before, 'rejected requests cannot extend the window');
	await expireAbuseBudget(environment);
	const recovered = await normalLogin(environment, { Email: testEmail, Password: testPassword, SignMe: '1' });
	assert.equal(recovered.json?.Result?.Auth, true, recovered.text);
});

test('M7.4 successful primary auth preserves other failures and server outages refund admission', {
	timeout: isWindows ? 90000 : 30000
}, async t => {
	const environment = await createEnvironment(t);
	if (!environment) return;
	await normalLogin(environment, { Email: testEmail, Password: 'incorrect-local-fixture' });
	const before = JSON.parse(await readFile(abusePath(environment), 'utf8'));
	const success = await normalLogin(environment, { Email: 'other@example.test', Password: testPassword });
	assert.equal(success.json?.Result?.Auth, true, success.text);
	assert.deepEqual(JSON.parse(await readFile(abusePath(environment), 'utf8')), before,
		'a successful different account must not clear source or victim failures');
	const domains = path.join(environment.dataRoot, '_data_', '_default_', 'domains');
	const domain = JSON.parse(await readFile(path.join(domains, 'example.test.json'), 'utf8'));
	domain.IMAP.port = await reserveLocalPort(); // closed loopback port, no unrelated host
	await writeFile(path.join(domains, 'example.test.json'), JSON.stringify(domain));
	const outage = await normalLogin(environment, { Email: testEmail, Password: testPassword });
	assert.equal(outage.json?.code, 104, outage.text);
	assert.deepEqual(JSON.parse(await readFile(abusePath(environment), 'utf8')), before, 'connection failures refund only their own reservation');
	await writeFile(abusePath(environment), '{invalid fixture state');
	const logins = environment.imap.logins.length;
	const unavailable = await normalLogin(environment, { Email: testEmail, Password: testPassword });
	assert.equal(unavailable.json?.code, 102);
	assert.equal(environment.imap.logins.length, logins, 'unavailable accounting never starts primary authentication');
});

test('M7.4 admin login shares its configured identity budget, retains CSRF and recovers on expiry', {
	timeout: isWindows ? 90000 : 30000
}, async t => {
	const environment = await createEnvironment(t);
	if (!environment) return;
	const hash = spawnSync(phpBinary, ['-r', 'echo password_hash("synthetic-admin-password", PASSWORD_DEFAULT);'], { encoding: 'utf8' });
	assert.equal(hash.status, 0, hash.stderr);
	const config = await readFile(environment.applicationConfigPath, 'utf8');
	await writeFile(environment.applicationConfigPath, config.replace('[security]', '[security]\nadmin_login = "synthetic-admin"\nadmin_password = "' + hash.stdout.trim() + '"\nadmin_totp = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"'));
	const currentCode = () => {
		const counter = Buffer.alloc(8);
		counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
		// RFC test secret, matching the synthetic base32 configuration above.
		const digest = createHmac('sha1', '12345678901234567890').update(counter).digest();
		return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
	};
	const attempt = async (login, password, csrf = true, code = '') => {
		const guest = await guestToken(environment);
		const response = await request(environment.baseUrl, '/?/admin/Json', {
			jar: guest.jar, token: csrf ? guest.token : 'invalid-fixture-token', method: 'POST',
			fields: { Action: 'AdminLogin', Login: login, Password: password, TOTP: code }
		});
		return { ...response, jar: guest.jar };
	};
	const csrf = await attempt('synthetic-admin', 'synthetic-admin-password', false);
	assert.notEqual(csrf.json?.code, 0);
	await assert.rejects(readFile(abusePath(environment)), { code: 'ENOENT' }, 'CSRF rejection happens before accounting/authentication');
	const invalidFactor = await attempt('synthetic-admin', 'synthetic-admin-password', true, 'invalid-fixture-code');
	assert.equal(invalidFactor.json?.code, 102, invalidFactor.text);
	assert.equal(invalidFactor.jar.get('smadmin'), undefined, 'a correct password with an invalid admin factor creates no authority');
	for (let n = 0; n < 9; ++n) {
		const result = await attempt(n % 2 ? 'synthetic-admin' : 'wrong-fixture-name', 'incorrect-local-fixture');
		assert.equal(result.json?.code, 102, result.text);
		assert.equal(result.jar.get('smadmin'), undefined);
	}
	const blocked = await attempt('synthetic-admin', 'synthetic-admin-password', true, currentCode());
	assert.equal(blocked.json?.code, 102);
	assert.equal(blocked.jar.get('smadmin'), undefined);
	await expireAbuseBudget(environment);
	const recovered = await attempt('synthetic-admin', 'synthetic-admin-password', true, currentCode());
	assert.equal(recovered.json?.Result?.Auth, true, recovered.text);
	assert.ok(recovered.jar.get('smadmin'), 'successful full proof issues the actual admin cookie');
});
