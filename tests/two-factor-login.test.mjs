import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSyntheticImapServer } from '../scripts/synthetic-imap-server.mjs';
import {
	windowsPowerShellEnvironment,
	windowsPowerShellExecutable
} from './fixtures/windows-acl.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const isWindows = 'win32' === process.platform;
const windowsAclScript = path.join(repositoryRoot,
	'snappymail/v/0.0.0/app/libraries/snappymail/storage/accountpath-acl.ps1');
const windowsPowerShell = isWindows
	? windowsPowerShellExecutable(process.env.SystemRoot || process.env.SYSTEMROOT)
	: '';
const windowsEnvironment = isWindows ? windowsPowerShellEnvironment(process.env) : process.env;
let testTemporaryRoot = tmpdir();
if (isWindows) {
	testTemporaryRoot = path.join(homedir(), '.petuja-email-two-factor-login-tests-' + process.pid + '-' + randomUUID());
	const prepared = spawnSync(windowsPowerShell, [
		'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
		'-File', windowsAclScript, '-Operation', 'PrepareDemoRoot', '-Path', testTemporaryRoot
	], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		env: windowsEnvironment,
		timeout: 15000,
		windowsHide: true
	});
	try {
		await access(testTemporaryRoot);
		test.after(() => rm(testTemporaryRoot, { recursive: true, force: true }));
	} catch {
		// Preparation failed before creating the unique scratch directory.
	}
	assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
	assert.equal(prepared.stdout.trim(), 'CREATED');
}

function createTemporaryDirectory(prefix) {
	return mkdtemp(path.join(testTemporaryRoot, prefix));
}
// Leading and trailing spaces prove that the challenge backend preserves the
// same raw password bytes as the deployed Login action.
const testPassword = ' sec02-test-password ';
const testSecret = 'JBSWY3DPEHPK3PXP';
const testRecoveryCodes = '987654321 876543219';
const factorLimiterRealm = 'two-factor';
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

	copy() {
		const copy = new CookieJar();
		for (const [name, value] of this.#cookies) {
			copy.set(name, value);
		}
		return copy;
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
	const imap = createSyntheticImapServer({ expectedPassword: testPassword, greeting: 'isolated M1C fixture' });
	await imap.listen();
	t.after(() => imap.close());
	return imap;
}

async function startPhpServer(t, environment) {
	const modules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8' });
	if (modules.error || 0 !== modules.status) {
		t.skip('PHP CLI is unavailable: ' + (modules.error?.message || modules.stderr));
		return null;
	}
	for (const name of ['intl', 'mbstring', 'openssl']) {
		if (!new RegExp('^' + name + '$', 'im').test(modules.stdout)) {
			t.skip('PHP ' + name + ' extension is unavailable');
			return null;
		}
	}

	const port = await reserveLocalPort();
	const router = path.join(repositoryRoot, 'tests', 'fixtures', 'two-factor-router.php');
	const child = spawn(phpBinary, [
		'-d', 'display_errors=0',
		'-S', '127.0.0.1:' + port,
		'-t', repositoryRoot,
		router
	], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PETUJA_TEST_DATA_PATH: environment.dataRoot,
			PETUJA_TEST_LOGIN_POLICY_STATE: environment.policyStatePath,
			PETUJA_TEST_FAIL_TWO_FACTOR_WRITE_FILE: environment.failTwoFactorWritePath
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
	let lastProbe = '';
	while (Date.now() < deadline) {
		if (null !== child.exitCode || null !== child.signalCode) {
			assert.fail('PHP test server exited early:\n' + output);
		}
		try {
			const response = await fetch(baseUrl + '/?/AppData', { headers: testHeaders });
			if (response.ok) {
				return baseUrl;
			}
			lastProbe = 'HTTP ' + response.status + ': ' + (await response.text()).slice(0, 1000);
		} catch (error) {
			// Wait for the local PHP server to bind its port.
			lastProbe = error.message;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('PHP test server did not start:\n' + output + '\nLast probe: ' + lastProbe);
}

async function createEnvironment(t, { faultDelay = 0, forceTwoFactor = false } = {}) {
	const temporaryRoot = await createTemporaryDirectory('petuja-m1c-login-');
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configRoot = path.join(privateRoot, 'configs');
	const domainsRoot = path.join(privateRoot, 'domains');
	const policyStatePath = path.join(temporaryRoot, 'policy-state.json');
	const failTwoFactorWritePath = path.join(temporaryRoot, 'fail-two-factor-write');
	const imap = await startImapServer(t);
	await mkdir(configRoot, { recursive: true });
	await mkdir(path.join(privateRoot, 'cache'), { recursive: true });
	await mkdir(domainsRoot, { recursive: true });
	const domain = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imap.port;
	domain.IMAP.type = 0;
	await writeFile(path.join(domainsRoot, 'default.json'), JSON.stringify(domain));
	await writeFile(policyStatePath, JSON.stringify({ mode: 'disabled' }));
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[plugins]',
		'enable = 1',
		'enabled_list = "login-external,m1c-login-fixture,login-public-password-policy"',
		'',
		'[security]',
		'require_two_factor_auth = ' + (forceTwoFactor ? 'On' : 'Off'),
		'',
		'[version]',
		'two_factor_policy_migration = 1',
		'',
		'[login]',
		'fault_delay = ' + faultDelay,
		'',
		'[logs]',
		'enable = 1',
		'level = 6',
		'filename = "m1c-two-factor.log"',
		'json_response_write_limit = 0',
		''
	].join('\n'));
	const environment = { dataRoot, policyStatePath, failTwoFactorWritePath, imap };
	const baseUrl = await startPhpServer(t, environment);
	return { ...environment, baseUrl, temporaryRoot };
}

async function request(baseUrl, route, { jar, token, method = 'GET', fields, body, redirect = 'manual' } = {}) {
	const headers = { ...testHeaders };
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
		// A redirect response intentionally has no JSON body.
	}
	if (json && undefined === json.code && Object.hasOwn(json, 'Result')) {
		json.code = 0;
	}
	return { response, text, json, elapsedMs: performance.now() - started };
}

async function guestSession(baseUrl, jar = new CookieJar()) {
	const result = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(result.response.status, 200, result.text.slice(0, 300));
	assert.match(result.json?.System?.token || '', /^0-/);
	return { jar, token: result.json.System.token };
}

async function login(baseUrl, email, { jar, token, code, signMe = false, password = testPassword } = {}) {
	const fields = {
		Action: 'Login',
		Email: email,
		Password: password,
		signMe: signMe ? '1' : '0'
	};
	if (undefined !== code) {
		fields.totp_code = code;
	}
	const result = await request(baseUrl, '/?/Json', { jar, token, method: 'POST', fields });
	if (result.json?.code === 0) {
		result.appData = result.json.Result;
	}
	return result;
}

async function createSsoHash(baseUrl, email, password = testPassword) {
	const result = await request(baseUrl, '/__test/sso-hash', {
		method: 'POST',
		fields: { Email: email, Password: password }
	});
	assert.equal(result.response.status, 200, result.text.slice(0, 300));
	assert.match(result.json?.hash || '', /^[a-f0-9]{40}$/i,
		'the isolated fixture must create a native one-time SSO hash');
	return result.json.hash;
}

async function twoFactorAction(baseUrl, jar, token, action, fields = {}) {
	return request(baseUrl, '/?/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: action, ...fields }
	});
}

function assertAbortResponseShape(response) {
	assert.deepEqual(Object.keys(response.json).sort(), ['Action', 'Result', 'code', 'epoch']);
	assert.equal(response.json.Action, 'TwoFactorLoginAbort');
	assert.equal(response.json.Result, true);
	assert.equal(response.json.code, 0);
	assert.equal(Number.isInteger(response.json.epoch), true);
}

async function beginChallenge(environment, account, guest, signMe = false) {
	return twoFactorAction(environment.baseUrl, guest.jar, guest.token, 'TwoFactorLoginBegin', {
		Email: account.email,
		Password: testPassword,
		signMe: signMe ? '1' : '0'
	});
}

async function verifyChallenge(environment, account, guest, challenge, code, baseUrl = environment.baseUrl) {
	return twoFactorAction(baseUrl, guest.jar, guest.token, 'TwoFactorLoginVerify', {
		Email: account.email,
		Password: testPassword,
		Challenge: challenge,
		Code: code
	});
}

async function storedRecords(dataRoot, folderName) {
	const files = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ('ENOENT' !== error.code) {
				throw error;
			}
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === folderName) {
					for (const stored of await readdir(entryPath, { withFileTypes: true })) {
						if (stored.isFile()) {
							files.push(path.join(entryPath, stored.name));
						}
					}
				} else {
					await walk(entryPath);
				}
			}
		}
	}
	await walk(dataRoot);
	return files;
}

async function storedFilesNamed(dataRoot, fileName) {
	const files = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ('ENOENT' !== error.code) {
				throw error;
			}
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
			} else if (entry.isFile() && entry.name === fileName) {
				files.push(entryPath);
			}
		}
	}
	await walk(dataRoot);
	return files;
}

async function sessionKey(dataRoot, sessionCookie) {
	const storedSalt = (await readFile(path.join(dataRoot, 'SALT.php'), 'utf8')).trim();
	const appSalt = createHash('md5').update(storedSalt + '_default_' + storedSalt).digest('hex');
	return createHash('sha1').update('Session' + appSalt + sessionCookie + 'Token' + appSalt).digest('hex');
}

async function sessionRecordPath(dataRoot, sessionCookie) {
	const key = await sessionKey(dataRoot, sessionCookie);
	return (await storedRecords(dataRoot, '.sessions'))
		.find(file => path.basename(file) === key) || null;
}

async function sessionAuthBindingPath(dataRoot, sessionCookie) {
	const key = 'auth-' + await sessionKey(dataRoot, sessionCookie);
	return (await storedRecords(dataRoot, '.sessions'))
		.find(file => path.basename(file) === key) || null;
}

async function accountSessionFiles(recordPath) {
	try {
		return (await readdir(path.join(path.dirname(recordPath), '.sessions')))
			.map(name => path.join(path.dirname(recordPath), '.sessions', name));
	} catch (error) {
		if ('ENOENT' === error.code) {
			return [];
		}
		throw error;
	}
}

async function challengeRecordPath(dataRoot, challenge) {
	const hash = createHash('sha256').update(challenge).digest('hex');
	return (await storedRecords(dataRoot, '.sessions'))
		.find(file => path.basename(file).includes(hash)) || null;
}

async function factorAttemptCount(dataRoot, email) {
	const statePath = path.join(dataRoot, '_data_', '_default_', 'login-abuse', 'state.json');
	const state = JSON.parse(await readFile(statePath, 'utf8'));
	const storedSalt = (await readFile(path.join(dataRoot, 'SALT.php'), 'utf8')).trim();
	const appSalt = createHash('md5').update(storedSalt + '_default_' + storedSalt).digest('hex');
	const accountKey = createHmac('sha256', appSalt)
		.update(JSON.stringify([factorLimiterRealm, 'account', [email]]))
		.digest('hex');
	return Object.keys(state.buckets[accountKey] || {}).length;
}

async function pathExists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function base32Decode(secret) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const output = [];
	for (const char of secret.replace(/=+$/, '').toUpperCase()) {
		value = (value << 5) | alphabet.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			output.push((value >>> (bits -= 8)) & 0xff);
		}
	}
	return Buffer.from(output);
}

function totp(secret, timestamp = Date.now()) {
	const counter = BigInt(Math.floor(timestamp / 30000));
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(counter);
	const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const number = ((digest[offset] & 0x7f) << 24)
		| (digest[offset + 1] << 16)
		| (digest[offset + 2] << 8)
		| digest[offset + 3];
	return String(number % 1000000).padStart(6, '0');
}

async function nextTotp(secret) {
	const counter = Math.floor(Date.now() / 30000);
	while (Math.floor(Date.now() / 30000) === counter) {
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return totp(secret);
}

function invalidTotp(secret) {
	const now = Date.now();
	const accepted = new Set(Array.from({ length: 11 }, (_, index) => index - 5)
		.map(offset => totp(secret, now + offset * 30000)));
	for (let value = 0; value < 1000000; ++value) {
		const code = String(value).padStart(6, '0');
		if (!accepted.has(code)) {
			return code;
		}
	}
	assert.fail('a six-digit code outside the current TOTP window must exist');
}

async function createEnabledAccount(environment) {
	const email = 'm1c-' + randomBytes(6).toString('hex') + '@sec02.test';
	const guest = await guestSession(environment.baseUrl);
	const loginResult = await login(environment.baseUrl, email, guest);
	assert.equal(loginResult.json?.code, 0, JSON.stringify(loginResult.json));
	const setup = await twoFactorAction(environment.baseUrl, guest.jar, loginResult.appData.System.token, 'TwoFactorSetup');
	assert.equal(setup.json?.code, 0, JSON.stringify(setup.json));
	const records = await storedFilesNamed(environment.dataRoot, 'two_factor');
	const loadedRecords = await Promise.all(records.map(async recordPath => ({
		path: recordPath,
		record: JSON.parse(await readFile(recordPath, 'utf8'))
	})));
	const matchingRecord = loadedRecords.find(({ record }) => record.User === email);
	assert.ok(matchingRecord, 'the created account must have a persisted factor record');
	const recordPath = matchingRecord.path;
	const record = {
		...matchingRecord.record,
		User: email,
		Enable: true,
		Secret: testSecret,
		BackupCodes: testRecoveryCodes
	};
	const logout = await twoFactorAction(environment.baseUrl, guest.jar, loginResult.appData.System.token, 'Logout');
	assert.equal(logout.json?.code, 0, JSON.stringify(logout.json));
	await writeFile(recordPath, JSON.stringify(record));
	return { email, recordPath, record };
}

function legacyV2SignMeCookie(dataRoot, cookie) {
	const result = spawnSync(phpBinary, [
		path.join(repositoryRoot, 'tests', 'fixtures', 'sec23-race-plugin', 'legacy-signme-cookie.php'),
		repositoryRoot,
		dataRoot,
		cookie,
		'v2'
	], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

async function assertNoNormalAuthority(environment, jar, accountRecordPath) {
	for (const name of ['smaccount', 'smadditional', 'smremember']) {
		assert.equal(jar.get(name), undefined, name + ' must not exist before factor success');
	}
	const session = jar.get('smsession');
	if (session) {
		assert.equal(await sessionRecordPath(environment.dataRoot, session), null,
			'a guest/pre-auth smsesson must not have an account SESSION row');
		assert.equal(await sessionAuthBindingPath(environment.dataRoot, session), null,
			'a guest/pre-auth session must not have an auth binding');
	}
	const allSessionFiles = accountRecordPath
		? await accountSessionFiles(accountRecordPath)
		: await storedRecords(environment.dataRoot, '.sessions');
	assert.equal(allSessionFiles.some(file => path.basename(file).startsWith('auth-')), false,
		'pre-auth state must not create an authenticated account binding');
}

test('M1C preserves native no-2FA login and delays enabled-factor authority until proof', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t, { faultDelay: 1 });
	if (!environment.baseUrl) {
		return;
	}

	const ordinaryEmail = 'm1c-normal-' + randomBytes(5).toString('hex') + '@sec02.test';
	const ordinaryGuest = await guestSession(environment.baseUrl);
	const ordinary = await login(environment.baseUrl, ordinaryEmail, { ...ordinaryGuest, signMe: true });
	assert.equal(ordinary.json?.code, 0, JSON.stringify(ordinary.json));
	assert.equal(ordinary.appData?.Auth, true);
	assert.ok(ordinaryGuest.jar.get('smaccount'));
	assert.ok(ordinaryGuest.jar.get('smremember'), 'no-2FA signMe behavior remains normal');

	const legacySessionGuest = await guestSession(environment.baseUrl);
	const loginsBeforePluginRoute = environment.imap.logins.length;
	const legacySession = await request(environment.baseUrl, '/?M1CTrustedLogin', {
		jar: legacySessionGuest.jar,
		method: 'POST',
		fields: { Email: 'm1c-legacy@example.test', Password: testPassword, LegacySession: '1' }
	});
	assert.equal(legacySession.response.status, 200);
	assert.equal(legacySession.json, null, 'a plugin-only trusted-login Part route must not be dispatched');
	assert.equal(legacySessionGuest.jar.get('smaccount'), undefined);
	assert.equal(environment.imap.logins.length, loginsBeforePluginRoute,
		'an unregistered plugin Part action must not reach IMAP');

	const invalidGuest = await guestSession(environment.baseUrl);
	const invalid = await login(environment.baseUrl, ordinaryEmail, {
		...invalidGuest,
		password: 'wrong-local-password'
	});
	assert.equal(invalid.json?.code, 102);
	assert.ok(invalid.elapsedMs >= 900, 'invalid public primary credentials retain fault_delay');
	assert.equal(invalidGuest.jar.get('smaccount'), undefined);

	const account = await createEnabledAccount(environment);
	const legacyGuest = await guestSession(environment.baseUrl);
	const passwordOnly = await login(environment.baseUrl, account.email, {
		...legacyGuest,
		signMe: true
	});
	assert.equal(passwordOnly.json?.code, 102, 'password-only login is generic failure for an enabled factor');
	assert.ok(passwordOnly.elapsedMs >= 900, 'missing second factor retains fault_delay');
	await assertNoNormalAuthority(environment, legacyGuest.jar, account.recordPath);
	const wrongFactorGuest = await guestSession(environment.baseUrl);
	const wrongFactor = await login(environment.baseUrl, account.email, {
		...wrongFactorGuest,
		code: '000000'
	});
	assert.equal(wrongFactor.json?.code, 102, 'a wrong inline factor remains a generic login failure');
	assert.ok(wrongFactor.elapsedMs >= 900, 'wrong second factor retains fault_delay');
	await assertNoNormalAuthority(environment, wrongFactorGuest.jar, account.recordPath);

	const verifiedGuest = await guestSession(environment.baseUrl);
	const legacyTotp = totp(testSecret);
	const verified = await login(environment.baseUrl, account.email, {
		...verifiedGuest,
		code: legacyTotp,
		signMe: true
	});
	assert.equal(verified.json?.code, 0, JSON.stringify(verified.json));
	assert.equal(verified.appData?.Auth, true);
	assert.ok(verifiedGuest.jar.get('smremember'), 'legacy signMe is issued after successful TOTP');
	const sessionPath = await sessionRecordPath(environment.dataRoot, verifiedGuest.jar.get('smsession'));
	const bindingPath = await sessionAuthBindingPath(environment.dataRoot, verifiedGuest.jar.get('smsession'));
	assert.ok(sessionPath);
	assert.match(await readFile(sessionPath, 'utf8'), /^verified:[a-f0-9-]{36}$/i,
		'the SESSION assurance must bind to the current factor generation');
	assert.ok(bindingPath, 'account cookie is bound to the newly issued verified session');
	const logs = await readFile(path.join(environment.dataRoot, '_data_', '_default_', 'logs', 'm1c-two-factor.log'), 'utf8');
	for (const secret of [testPassword, testPassword.trim(), legacyTotp]) {
		assert.equal(logs.includes(secret), false, 'legacy login must not log passwords or TOTP values');
	}
});

test('M1E rejects unknown and generation-stale session assurance', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const ordinaryEmail = 'm1e-unknown-' + randomBytes(6).toString('hex') + '@sec02.test';
	const ordinaryGuest = await guestSession(environment.baseUrl);
	const ordinaryLogin = await login(environment.baseUrl, ordinaryEmail, ordinaryGuest);
	assert.equal(ordinaryLogin.json?.code, 0, JSON.stringify(ordinaryLogin.json));
	const unknownSessionPath = await sessionRecordPath(environment.dataRoot, ordinaryGuest.jar.get('smsession'));
	assert.ok(unknownSessionPath);
	await writeFile(unknownSessionPath, 'mail-admin');
	const unknownAssurance = await request(environment.baseUrl, '/?/AppData', { jar: ordinaryGuest.jar });
	assert.equal(unknownAssurance.json?.Auth, false, 'unknown nonempty assurance must fail closed');
	assert.equal(await pathExists(unknownSessionPath), false, 'the malformed authority row must be revoked');

	const account = await createEnabledAccount(environment);
	const factorGuest = await guestSession(environment.baseUrl);
	const verifiedLogin = await login(environment.baseUrl, account.email, {
		...factorGuest,
		code: totp(testSecret)
	});
	assert.equal(verifiedLogin.json?.code, 0, JSON.stringify(verifiedLogin.json));
	const sessionPath = await sessionRecordPath(environment.dataRoot, factorGuest.jar.get('smsession'));
	assert.ok(sessionPath);
	await writeFile(sessionPath, 'verified');
	const oldFormatAssurance = await request(environment.baseUrl, '/?/AppData', { jar: factorGuest.jar });
	assert.equal(oldFormatAssurance.json?.Auth, false,
		'the old unbound verified marker must not satisfy an enabled factor');
	assert.equal(await pathExists(sessionPath), false);
});

test('M1E factor generation changes revoke live session authority', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const guest = await guestSession(environment.baseUrl);
	const verified = await login(environment.baseUrl, account.email, {
		...guest,
		code: totp(testSecret)
	});
	assert.equal(verified.json?.code, 0, JSON.stringify(verified.json));
	const factor = JSON.parse(await readFile(account.recordPath, 'utf8'));
	const oldGeneration = factor.FactorGeneration;
	factor.FactorGeneration = randomUUID();
	await writeFile(account.recordPath, JSON.stringify(factor));
	const stale = await request(environment.baseUrl, '/?/AppData', { jar: guest.jar });
	assert.equal(stale.json?.Auth, false,
		'a session verified under an older factor generation must not retain mailbox authority');
	assert.notEqual(oldGeneration, factor.FactorGeneration);
});

test('M1E Remember-Me v3 rejects stale factor generations and keeps current restores one-use', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const staleAccount = await createEnabledAccount(environment);
	const staleGuest = await guestSession(environment.baseUrl);
	const staleLogin = await login(environment.baseUrl, staleAccount.email, {
		...staleGuest,
		code: totp(testSecret),
		signMe: true
	});
	assert.equal(staleLogin.json?.code, 0, JSON.stringify(staleLogin.json));
	const staleRemember = staleGuest.jar.get('smremember');
	assert.ok(staleRemember);
	const changedFactor = JSON.parse(await readFile(staleAccount.recordPath, 'utf8'));
	changedFactor.FactorGeneration = randomUUID();
	await writeFile(staleAccount.recordPath, JSON.stringify(changedFactor));
	const staleRestoreJar = new CookieJar();
	staleRestoreJar.set('smremember', staleRemember);
	const staleRestore = await request(environment.baseUrl, '/?/AppData', { jar: staleRestoreJar });
	assert.equal(staleRestore.json?.Auth, false,
		'a Remember-Me bearer bound to an older factor generation must not restore authority');
	assert.equal(staleRestoreJar.get('smaccount'), undefined);
	assert.equal(staleRestoreJar.get('smremember'), undefined);
	assert.equal(await sessionRecordPath(environment.dataRoot, staleRestoreJar.get('smsession')), null,
		'a rejected stale bearer must not leave an authenticated SESSION row');

	const currentAccount = await createEnabledAccount(environment);
	const currentGuest = await guestSession(environment.baseUrl);
	const currentLogin = await login(environment.baseUrl, currentAccount.email, {
		...currentGuest,
		code: totp(testSecret),
		signMe: true
	});
	assert.equal(currentLogin.json?.code, 0, JSON.stringify(currentLogin.json));
	const copiedRemember = currentGuest.jar.get('smremember');
	assert.ok(copiedRemember);
	const currentRestoreJar = new CookieJar();
	currentRestoreJar.set('smremember', copiedRemember);
	const restored = await request(environment.baseUrl, '/?/AppData', { jar: currentRestoreJar });
	assert.equal(restored.json?.Auth, true, 'a current generation-bound Remember-Me token must restore');
	const restoredSessionPath = await sessionRecordPath(environment.dataRoot, currentRestoreJar.get('smsession'));
	assert.ok(restoredSessionPath);
	assert.match(await readFile(restoredSessionPath, 'utf8'), /^verified:[a-f0-9-]{36}$/i);
	const replayJar = new CookieJar();
	replayJar.set('smremember', copiedRemember);
	const replay = await request(environment.baseUrl, '/?/AppData', { jar: replayJar });
	assert.equal(replay.json?.Auth, false, 'a copied pre-rotation Remember-Me token must remain one-use');
	assert.equal((await request(environment.baseUrl, '/?/AppData', { jar: currentRestoreJar })).json?.Auth, true,
		'a copied-cookie replay must not revoke the active rotated lineage or session');
});

test('M1E safely downgrades v2 Remember-Me without a factor and rejects unbound verified v2', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const ordinaryEmail = 'm1e-v2-primary-' + randomBytes(6).toString('hex') + '@sec02.test';
	const ordinaryGuest = await guestSession(environment.baseUrl);
	const ordinaryLogin = await login(environment.baseUrl, ordinaryEmail, {
		...ordinaryGuest,
		signMe: true
	});
	assert.equal(ordinaryLogin.json?.code, 0, JSON.stringify(ordinaryLogin.json));
	const v2Primary = legacyV2SignMeCookie(environment.dataRoot, ordinaryGuest.jar.get('smremember'));
	const v2PrimaryJar = new CookieJar();
	v2PrimaryJar.set('smremember', v2Primary);
	const restoredPrimary = await request(environment.baseUrl, '/?/AppData', { jar: v2PrimaryJar });
	assert.equal(restoredPrimary.json?.Auth, true,
		'a v2 primary assurance can migrate safely while no second factor is active');
	assert.notEqual(v2PrimaryJar.get('smremember'), v2Primary,
		'safe legacy restoration must rotate into the current v3 cookie and server record');

	const account = await createEnabledAccount(environment);
	const enabledGuest = await guestSession(environment.baseUrl);
	const enabledLogin = await login(environment.baseUrl, account.email, {
		...enabledGuest,
		code: totp(testSecret),
		signMe: true
	});
	assert.equal(enabledLogin.json?.code, 0, JSON.stringify(enabledLogin.json));
	const v2Verified = legacyV2SignMeCookie(environment.dataRoot, enabledGuest.jar.get('smremember'));
	const v2VerifiedJar = new CookieJar();
	v2VerifiedJar.set('smremember', v2Verified);
	const rejectedVerified = await request(environment.baseUrl, '/?/AppData', { jar: v2VerifiedJar });
	assert.equal(rejectedVerified.json?.Auth, false,
		'a v2 verified marker without a generation cannot satisfy an enabled factor');
	assert.equal(v2VerifiedJar.get('smaccount'), undefined);
	assert.equal(v2VerifiedJar.get('smremember'), undefined);
});

test('M1D native Begin and Verify preserve selected language and Remember Me', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const ordinaryGuest = await guestSession(environment.baseUrl),
		ordinaryEmail = 'm1d-' + randomBytes(6).toString('hex') + '@sec02.test',
		ordinary = await twoFactorAction(environment.baseUrl, ordinaryGuest.jar, ordinaryGuest.token,
			'TwoFactorLoginBegin', {
				Email: ordinaryEmail,
				Password: testPassword,
				signMe: '1',
				language: 'de'
			});
	assert.equal(ordinary.json?.code, 0, JSON.stringify(ordinary.json));
	assert.equal(ordinary.json.Result.Auth, true);
	assert.equal(ordinary.json.Result.language, 'de',
		'the selected language is saved before the successful Begin AppData is built');
	assert.ok(ordinaryGuest.jar.get('smremember'), 'Begin preserves the Remember Me intent for no-factor login');

	const enabled = await createEnabledAccount(environment),
		factorGuest = await guestSession(environment.baseUrl),
		started = await beginChallenge(environment, enabled, factorGuest, true);
	assert.equal(started.json?.code, 0, JSON.stringify(started.json));
	assert.equal(started.json.Result.RequiresTwoFactor, true);
	assert.equal(factorGuest.jar.get('smremember'), undefined,
		'Remember Me is not issued before the factor proof');
	const verified = await twoFactorAction(environment.baseUrl, factorGuest.jar, factorGuest.token,
		'TwoFactorLoginVerify', {
			Email: enabled.email,
			Password: testPassword,
			Challenge: started.json.Result.Challenge,
			Code: totp(testSecret),
			language: 'fr'
		});
	assert.equal(verified.json?.code, 0, JSON.stringify(verified.json));
	assert.equal(verified.json.Result.Auth, true);
	assert.equal(verified.json.Result.language, 'fr',
		'the selected language is saved only with final factor-authenticated AppData');
	assert.ok(factorGuest.jar.get('smremember'),
		'The challenge-held Remember Me intent is issued only after Verify');
});

test('M1D password-only and factor login retain logout and relogin behavior', { timeout: 120000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const ordinaryEmail = 'm1d-relogin-' + randomBytes(6).toString('hex') + '@sec02.test';
	const ordinaryGuest = await guestSession(environment.baseUrl);
	const ordinaryLogin = await login(environment.baseUrl, ordinaryEmail, ordinaryGuest);
	assert.equal(ordinaryLogin.json?.code, 0, JSON.stringify(ordinaryLogin.json));
	assert.equal(ordinaryLogin.json?.Result?.Auth, true, 'password-only login remains available');
	const ordinaryAppData = await request(environment.baseUrl, '/?/AppData', { jar: ordinaryGuest.jar });
	const ordinaryLogout = await twoFactorAction(environment.baseUrl, ordinaryGuest.jar,
		ordinaryAppData.json.System.token, 'Logout');
	assert.equal(ordinaryLogout.json?.code, 0, JSON.stringify(ordinaryLogout.json));
	assert.equal(ordinaryGuest.jar.get('smaccount'), undefined);
	const ordinaryRetryGuest = await guestSession(environment.baseUrl);
	const ordinaryRetry = await login(environment.baseUrl, ordinaryEmail, ordinaryRetryGuest);
	assert.equal(ordinaryRetry.json?.code, 0, JSON.stringify(ordinaryRetry.json));
	assert.equal(ordinaryRetry.json?.Result?.Auth, true, 'password-only relogin succeeds after logout');

	const account = await createEnabledAccount(environment);
	const factorGuest = await guestSession(environment.baseUrl);
	const started = await beginChallenge(environment, account, factorGuest);
	assert.equal(started.json?.code, 0, JSON.stringify(started.json));
	const wrong = await verifyChallenge(environment, account, factorGuest,
		started.json.Result.Challenge, invalidTotp(testSecret));
	assert.equal(wrong.json?.code, 102, 'wrong factor retains the generic authentication failure');
	await assertNoNormalAuthority(environment, factorGuest.jar, account.recordPath);
	const correct = await verifyChallenge(environment, account, factorGuest,
		started.json.Result.Challenge, totp(testSecret));
	assert.equal(correct.json?.code, 0, JSON.stringify(correct.json));
	assert.equal(correct.json?.Result?.Auth, true, 'enabled-factor login succeeds after a valid proof');

	const authenticatedData = await request(environment.baseUrl, '/?/AppData', { jar: factorGuest.jar });
	const factorLogout = await twoFactorAction(environment.baseUrl, factorGuest.jar,
		authenticatedData.json.System.token, 'Logout');
	assert.equal(factorLogout.json?.code, 0, JSON.stringify(factorLogout.json));
	assert.equal(factorGuest.jar.get('smaccount'), undefined);
	const factorRetryGuest = await guestSession(environment.baseUrl);
	const factorRetryStart = await beginChallenge(environment, account, factorRetryGuest);
	assert.equal(factorRetryStart.json?.code, 0, JSON.stringify(factorRetryStart.json));
	const factorRetry = await verifyChallenge(environment, account, factorRetryGuest,
		factorRetryStart.json.Result.Challenge, await nextTotp(testSecret));
	assert.equal(factorRetry.json?.code, 0, JSON.stringify(factorRetry.json));
	assert.equal(factorRetry.json?.Result?.Auth, true, 'factor relogin succeeds with the next unused TOTP step');
});

test('M1C challenge is opaque and guest-bound; TOTP finalizes once and delays signMe', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const guest = await guestSession(environment.baseUrl);
	const started = await beginChallenge(environment, account, guest, true);
	assert.equal(started.json?.code, 0, JSON.stringify(started.json));
	const result = started.json.Result;
	assert.equal(result.RequiresTwoFactor, true);
	assert.match(result.Challenge, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(result.Account, account.email);
	assert.ok(result.ExpiresAt > Math.floor(Date.now() / 1000));
	await assertNoNormalAuthority(environment, guest.jar, account.recordPath);
	const preAuthAppData = await request(environment.baseUrl, '/?/AppData', { jar: guest.jar });
	assert.equal(preAuthAppData.json?.Auth, false);
	assert.equal('accountHash' in preAuthAppData.json, false);

	const stateFiles = await storedRecords(environment.dataRoot, '.sessions');
	const challengeHash = createHash('sha256').update(result.Challenge).digest('hex');
	const challengeFile = stateFiles.find(file => path.basename(file).includes(challengeHash));
	assert.ok(challengeFile, 'the challenge is stored under its digest in account SESSION storage');
	const challengeState = JSON.parse(await readFile(challengeFile, 'utf8'));
	assert.deepEqual({
		Attempts: challengeState.Attempts,
		Status: challengeState.Status,
		SignMe: challengeState.SignMe,
		Version: challengeState.Version
	}, { Attempts: 0, Status: 'active', SignMe: true, Version: 1 });
	assert.equal(result.ExpiresAt - challengeState.CreatedAt, 300,
		'the server-side challenge lifetime is exactly five minutes');
	for (const secret of [testPassword, testPassword.trim(), testSecret, testRecoveryCodes.split(' ')[0], result.Challenge]) {
		assert.equal((await readFile(challengeFile, 'utf8')).includes(secret), false,
			'challenge record must not persist credential or raw challenge material');
	}

	const replayGuest = { jar: guest.jar.copy(), token: guest.token };
	const verified = await verifyChallenge(environment, account, guest, result.Challenge, totp(testSecret));
	assert.equal(verified.json?.code, 0, JSON.stringify(verified.json));
	assert.equal(verified.json?.Result?.Auth, true);
	assert.ok(guest.jar.get('smaccount'));
	assert.ok(guest.jar.get('smremember'), 'stored signMe intent is applied only after factor success');
	assert.equal(await pathExists(challengeFile), false, 'successful challenge state is cleaned up');
	const replay = await verifyChallenge(environment, account, replayGuest, result.Challenge, totp(testSecret));
	assert.equal(replay.json?.code, 102, 'a consumed challenge cannot finalize twice');
	assert.equal(replayGuest.jar.get('smaccount'), undefined);
});

test('M1C legacy totp_code login shares the bounded challenge attempt ledger', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const account = await createEnabledAccount(environment);
	const guest = await guestSession(environment.baseUrl);
	let initialSession;
	for (let attempt = 0; attempt < 5; ++attempt) {
		const result = await login(environment.baseUrl, account.email, {
			...guest,
			code: 0 === attempt ? '' : '000000'
		});
		assert.equal(result.json?.code, 102, 'wrong or missing inline proof fails generically');
		if (0 === attempt) {
			initialSession = guest.jar.get('smsession');
			assert.ok(initialSession, 'the first compatibility attempt establishes the guest binding');
		}
		assert.equal(guest.jar.get('smsession'), initialSession,
			'the unauthenticated guest binding survives so retries cannot reset attempts');
		await assertNoNormalAuthority(environment, guest.jar, account.recordPath);
	}

	const challengeRecords = [];
	for (const file of await storedRecords(environment.dataRoot, '.sessions')) {
		try {
			const value = JSON.parse(await readFile(file, 'utf8'));
			if (value?.ChallengeHash && value?.AccountHash
				&& Number.isInteger(value.Attempts) && 'string' === typeof value.Status) {
				challengeRecords.push(value);
			}
		} catch {
			// SESSION rows for auth and token bindings are plain strings.
		}
	}
	assert.equal(challengeRecords.length, 1, 'legacy retries reuse one opaque server challenge');
	assert.equal(challengeRecords[0].Attempts, 5);
	assert.equal(challengeRecords[0].Status, 'exhausted');

	const correctAfterExhaustion = await login(environment.baseUrl, account.email, {
		...guest,
		code: totp(testSecret),
		signMe: true
	});
	assert.equal(correctAfterExhaustion.json?.code, 102, 'exhaustion rejects further inline proof');
	assert.equal(guest.jar.get('smremember'), undefined);
	await assertNoNormalAuthority(environment, guest.jar, account.recordPath);
});

test('M1C-R1 Abort cannot reset the same-context factor attempt budget', {
	timeout: process.platform === 'win32' ? 300000 : 180000
}, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);

	const pristineGuest = await guestSession(environment.baseUrl);
	const pristineBegin = await beginChallenge(environment, account, pristineGuest, true);
	assert.equal(pristineBegin.json?.code, 0, JSON.stringify(pristineBegin.json));
	const pristineId = pristineBegin.json.Result.Challenge;
	const pristinePath = await challengeRecordPath(environment.dataRoot, pristineId);
	assert.ok(pristinePath);
	const pristineAbort = await twoFactorAction(environment.baseUrl, pristineGuest.jar, pristineGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: pristineId });
	assert.equal(pristineAbort.json?.code, 0, JSON.stringify(pristineAbort.json));
	assertAbortResponseShape(pristineAbort);
	assert.equal(await pathExists(pristinePath), false,
		'a matching active challenge with no consumed attempts is cleanly cancelled');
	const pristineReplacement = await beginChallenge(environment, account, pristineGuest, true);
	assert.equal(pristineReplacement.json?.code, 0, JSON.stringify(pristineReplacement.json));
	assert.notEqual(pristineReplacement.json.Result.Challenge, pristineId,
		'clean cancellation permits a new challenge before the old TTL');
	assert.equal(JSON.parse(await readFile(
		await challengeRecordPath(environment.dataRoot, pristineReplacement.json.Result.Challenge), 'utf8'
	)).Attempts, 0);
	await assertNoNormalAuthority(environment, pristineGuest.jar, account.recordPath);

	const oneAttemptGuest = await guestSession(environment.baseUrl);
	const oneAttemptBegin = await beginChallenge(environment, account, oneAttemptGuest);
	assert.equal(oneAttemptBegin.json?.code, 0);
	const oneAttemptId = oneAttemptBegin.json.Result.Challenge;
	assert.equal((await verifyChallenge(environment, account, oneAttemptGuest, oneAttemptId, 'invalid!code')).json?.code, 102);
	const oneAttemptPath = await challengeRecordPath(environment.dataRoot, oneAttemptId);
	const oneAttemptState = await readFile(oneAttemptPath, 'utf8');
	assert.equal(JSON.parse(oneAttemptState).Attempts, 1);
	const oneAttemptAbort = await twoFactorAction(environment.baseUrl, oneAttemptGuest.jar, oneAttemptGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: oneAttemptId });
	assert.equal(oneAttemptAbort.json?.code, 0, 'Abort keeps its generic success response');
	assertAbortResponseShape(oneAttemptAbort);
	assert.equal(await pathExists(oneAttemptPath), true,
		'Abort retains a challenge after any factor attempt has been consumed');
	assert.equal(await readFile(oneAttemptPath, 'utf8'), oneAttemptState,
		'Abort preserves the attempt count and original expiry exactly');
	const oneAttemptResume = await beginChallenge(environment, account, oneAttemptGuest);
	assert.equal(oneAttemptResume.json?.code, 0);
	assert.equal(oneAttemptResume.json.Result.Challenge, oneAttemptId);
	assert.equal(await readFile(oneAttemptPath, 'utf8'), oneAttemptState,
		'resuming does not reset attempts or extend the challenge expiry');
	await assertNoNormalAuthority(environment, oneAttemptGuest.jar, account.recordPath);

	const exhaustedGuest = await guestSession(environment.baseUrl);
	const exhaustedBegin = await beginChallenge(environment, account, exhaustedGuest);
	assert.equal(exhaustedBegin.json?.code, 0);
	const exhaustedId = exhaustedBegin.json.Result.Challenge;
	for (let attempt = 0; attempt < 5; ++attempt) {
		assert.equal((await verifyChallenge(environment, account, exhaustedGuest, exhaustedId, 'invalid!code')).json?.code, 102);
	}
	const exhaustedPath = await challengeRecordPath(environment.dataRoot, exhaustedId);
	const exhaustedOriginal = await readFile(exhaustedPath, 'utf8');
	assert.equal(JSON.parse(exhaustedOriginal).Status, 'exhausted');
	const exhaustedAbort = await twoFactorAction(environment.baseUrl, exhaustedGuest.jar, exhaustedGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: exhaustedId });
	assert.equal(exhaustedAbort.json?.code, 0);
	assertAbortResponseShape(exhaustedAbort);
	assert.equal(await pathExists(exhaustedPath), true,
		'Abort preserves the exhausted ledger until its original expiry');
	assert.equal(await readFile(exhaustedPath, 'utf8'), exhaustedOriginal);
	assert.equal((await beginChallenge(environment, account, exhaustedGuest)).json?.code, 102,
		'an exhausted challenge stays unavailable after Abort');
	await assertNoNormalAuthority(environment, exhaustedGuest.jar, account.recordPath);

	const expiredState = JSON.parse(await readFile(exhaustedPath, 'utf8'));
	expiredState.CreatedAt = Math.floor(Date.now() / 1000) - 301;
	expiredState.ExpiresAt = expiredState.CreatedAt + 300;
	await writeFile(exhaustedPath, JSON.stringify(expiredState));
	const expiredAbort = await twoFactorAction(environment.baseUrl, exhaustedGuest.jar, exhaustedGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: exhaustedId });
	assert.equal(expiredAbort.json?.code, 0);
	assertAbortResponseShape(expiredAbort);
	assert.equal(await pathExists(exhaustedPath), false,
		'Abort may clean up a matching challenge after the original expiry');
	const afterExpiry = await beginChallenge(environment, account, exhaustedGuest);
	assert.equal(afterExpiry.json?.code, 0, JSON.stringify(afterExpiry.json));
	assert.notEqual(afterExpiry.json.Result.Challenge, exhaustedId,
		'a fresh five-attempt challenge is available only after expiry cleanup');
	await assertNoNormalAuthority(environment, exhaustedGuest.jar, account.recordPath);

	const bindingGuest = await guestSession(environment.baseUrl);
	const bindingBegin = await beginChallenge(environment, account, bindingGuest);
	assert.equal(bindingBegin.json?.code, 0);
	const bindingId = bindingBegin.json.Result.Challenge;
	assert.equal((await verifyChallenge(environment, account, bindingGuest, bindingId, 'invalid!code')).json?.code, 102);
	const bindingPath = await challengeRecordPath(environment.dataRoot, bindingId);
	const bindingBefore = await readFile(bindingPath, 'utf8');
	const otherGuest = await guestSession(environment.baseUrl);
	const crossAbort = await twoFactorAction(environment.baseUrl, otherGuest.jar, otherGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: bindingId });
	assert.equal(crossAbort.json?.code, 0, 'cross-session Abort has the same non-enumerating response');
	assertAbortResponseShape(crossAbort);
	assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore,
		'a different guest/session cannot change the attempt ledger');
	await assertNoNormalAuthority(environment, otherGuest.jar, account.recordPath);
	const wrongAccountAbort = await twoFactorAction(environment.baseUrl, bindingGuest.jar, bindingGuest.token,
		'TwoFactorLoginAbort', {
			Account: 'm1c-wrong-' + randomBytes(5).toString('hex') + '@sec02.test',
			Challenge: bindingId
		});
	assert.equal(wrongAccountAbort.json?.code, 0, 'wrong-account Abort has the same non-enumerating response');
	assertAbortResponseShape(wrongAccountAbort);
	assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore,
		'a wrong account cannot change the challenge ledger');
	const badCsrfAbort = await twoFactorAction(environment.baseUrl, bindingGuest.jar, 'invalid-m1c-csrf',
		'TwoFactorLoginAbort', { Account: account.email, Challenge: bindingId });
	assert.notEqual(badCsrfAbort.json?.code, 0);
	assert.equal(badCsrfAbort.text.includes(bindingId), false);
	assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore,
		'wrong CSRF cannot change the attempt ledger');
	assert.equal((await beginChallenge(environment, account, bindingGuest)).json?.Result?.Challenge, bindingId);
	await assertNoNormalAuthority(environment, bindingGuest.jar, account.recordPath);

	const malformedGuest = await guestSession(environment.baseUrl);
	const malformedBegin = await beginChallenge(environment, account, malformedGuest);
	assert.equal(malformedBegin.json?.code, 0);
	const malformedId = malformedBegin.json.Result.Challenge;
	const malformedPath = await challengeRecordPath(environment.dataRoot, malformedId);
	await writeFile(malformedPath, '{');
	const malformedAbort = await twoFactorAction(environment.baseUrl, malformedGuest.jar, malformedGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: malformedId });
	assert.equal(malformedAbort.json?.code, 0, 'malformed stored challenge state does not change Abort response shape');
	assertAbortResponseShape(malformedAbort);
	assert.equal(await readFile(malformedPath, 'utf8'), '{',
		'malformed challenge state is left untouched by Abort');
	const missingAbort = await twoFactorAction(environment.baseUrl, malformedGuest.jar, malformedGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: 'A'.repeat(43) });
	assert.equal(missingAbort.json?.code, 0, 'missing challenge state remains non-enumerating');
	assertAbortResponseShape(missingAbort);
	await assertNoNormalAuthority(environment, malformedGuest.jar, account.recordPath);

	const legacyGuest = await guestSession(environment.baseUrl);
	const legacyFailure = await login(environment.baseUrl, account.email, { ...legacyGuest, code: 'invalid!code' });
	assert.equal(legacyFailure.json?.code, 102);
	await assertNoNormalAuthority(environment, legacyGuest.jar, account.recordPath);
	const legacyBegin = await beginChallenge(environment, account, legacyGuest);
	assert.equal(legacyBegin.json?.code, 0);
	const legacyId = legacyBegin.json.Result.Challenge;
	const legacyPath = await challengeRecordPath(environment.dataRoot, legacyId);
	assert.equal(JSON.parse(await readFile(legacyPath, 'utf8')).Attempts, 1,
		'legacy totp_code failure and native Begin share one attempt ledger');
	const legacyAbort = await twoFactorAction(environment.baseUrl, legacyGuest.jar, legacyGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: legacyId });
	assert.equal(legacyAbort.json?.code, 0);
	const legacyResume = await beginChallenge(environment, account, legacyGuest);
	assert.equal(legacyResume.json?.code, 0);
	assert.equal(legacyResume.json.Result.Challenge, legacyId);
	assert.equal(JSON.parse(await readFile(legacyPath, 'utf8')).Attempts, 1,
		'native Abort cannot reset attempts consumed by the legacy compatibility path');
	await assertNoNormalAuthority(environment, legacyGuest.jar, account.recordPath);

	const fourAttemptAccount = await createEnabledAccount(environment);
	const fourAttemptGuest = await guestSession(environment.baseUrl);
	const fourAttemptBegin = await beginChallenge(environment, fourAttemptAccount, fourAttemptGuest, true);
	assert.equal(fourAttemptBegin.json?.code, 0);
	const fourAttemptId = fourAttemptBegin.json.Result.Challenge;
	for (let attempt = 0; attempt < 4; ++attempt) {
		assert.equal((await verifyChallenge(environment, fourAttemptAccount, fourAttemptGuest, fourAttemptId, 'invalid!code')).json?.code, 102);
	}
	const fourAttemptPath = await challengeRecordPath(environment.dataRoot, fourAttemptId);
	assert.equal(JSON.parse(await readFile(fourAttemptPath, 'utf8')).Attempts, 4);
	const fourAttemptAbort = await twoFactorAction(environment.baseUrl, fourAttemptGuest.jar, fourAttemptGuest.token,
		'TwoFactorLoginAbort', { Account: fourAttemptAccount.email, Challenge: fourAttemptId });
	assert.equal(fourAttemptAbort.json?.code, 0);
	assertAbortResponseShape(fourAttemptAbort);
	const fourAttemptResume = await beginChallenge(environment, fourAttemptAccount, fourAttemptGuest);
	assert.equal(fourAttemptResume.json?.code, 0);
	assert.equal(fourAttemptResume.json.Result.Challenge, fourAttemptId);
	assert.equal(JSON.parse(await readFile(fourAttemptPath, 'utf8')).Attempts, 4,
		'a resumed challenge retains its four consumed attempts');
	await assertNoNormalAuthority(environment, fourAttemptGuest.jar, fourAttemptAccount.recordPath);
	const fifthAttempt = await verifyChallenge(environment, fourAttemptAccount, fourAttemptGuest, fourAttemptId, totp(testSecret));
	assert.equal(fifthAttempt.json?.code, 0, JSON.stringify(fifthAttempt.json));
	assert.equal(fifthAttempt.json?.Result?.Auth, true,
		'a correct factor can use the one remaining attempt and finalize');
	assert.ok(fourAttemptGuest.jar.get('smremember'),
		'Remember-Me intent from the original challenge is applied only after fifth-attempt success');
});

test('M1C recovery code is consumed once and failed persistence never authenticates', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const guest = await guestSession(environment.baseUrl);
	const started = await beginChallenge(environment, account, guest);
	assert.equal(started.json?.code, 0);
	const challenge = started.json.Result.Challenge;
	const recoveryLogin = await verifyChallenge(environment, account, guest, challenge, '987654321');
	assert.equal(recoveryLogin.json?.code, 0, JSON.stringify(recoveryLogin.json));
	assert.equal(JSON.parse(await readFile(account.recordPath, 'utf8')).BackupCodes, '876543219');

	const replayGuest = await guestSession(environment.baseUrl);
	const replayStart = await beginChallenge(environment, account, replayGuest);
	assert.equal(replayStart.json?.code, 0);
	const replay = await verifyChallenge(environment, account, replayGuest, replayStart.json.Result.Challenge, '987654321');
	assert.equal(replay.json?.code, 102, 'a removed recovery code cannot authenticate through a new challenge');
	assert.equal(replayGuest.jar.get('smaccount'), undefined);

	const failureEnvironment = await createEnvironment(t);
	if (!failureEnvironment.baseUrl) {
		return;
	}
	const failureAccount = await createEnabledAccount(failureEnvironment);
	await writeFile(failureEnvironment.failTwoFactorWritePath, 'fail');
	const failureGuest = await guestSession(failureEnvironment.baseUrl);
	const failureStart = await beginChallenge(failureEnvironment, failureAccount, failureGuest);
	assert.equal(failureStart.json?.code, 0);
	const failedConsume = await verifyChallenge(
		failureEnvironment,
		failureAccount,
		failureGuest,
		failureStart.json.Result.Challenge,
		'987654321'
	);
	assert.equal(failedConsume.json?.code, 102);
	assert.equal(failureGuest.jar.get('smaccount'), undefined,
		'recovery persistence failure cannot issue account authority');
	assert.equal(JSON.parse(await readFile(failureAccount.recordPath, 'utf8')).BackupCodes, testRecoveryCodes,
		'failed persistence leaves the authoritative recovery record intact');
	assert.equal(await factorAttemptCount(failureEnvironment.dataRoot, failureAccount.email), 0,
		'a valid recovery proof with failed persistence is not charged as a failed factor');
	const totpFailureGuest = await guestSession(failureEnvironment.baseUrl);
	const totpFailureStart = await beginChallenge(failureEnvironment, failureAccount, totpFailureGuest);
	assert.equal(totpFailureStart.json?.code, 0);
	const failedTotpConsume = await verifyChallenge(
		failureEnvironment,
		failureAccount,
		totpFailureGuest,
		totpFailureStart.json.Result.Challenge,
		totp(testSecret)
	);
	assert.equal(failedTotpConsume.json?.code, 102,
		'a valid TOTP must not authenticate when replay-counter persistence cannot be confirmed');
	assert.equal(totpFailureGuest.jar.get('smaccount'), undefined);
	assert.equal(JSON.parse(await readFile(failureAccount.recordPath, 'utf8')).LastTotpCounter, null,
		'failed replay-state persistence must leave the prior factor record unchanged');
	assert.equal(await factorAttemptCount(failureEnvironment.dataRoot, failureAccount.email), 0,
		'a valid TOTP proof with failed persistence is not charged as a failed factor');
});

test('M1C bounds attempts and rejects expired, replayed, malformed, cross-session, and CSRF-invalid challenges', { timeout: 120000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const methodGuest = await guestSession(environment.baseUrl);
	for (const action of ['TwoFactorLoginBegin', 'TwoFactorLoginVerify', 'TwoFactorLoginAbort']) {
		const getAction = await request(environment.baseUrl, '/?/Json/unused/' + action.toLowerCase(), {
			jar: methodGuest.jar,
			method: 'GET'
		});
		assert.notEqual(getAction.json?.code, 0, action + ' must reject GET and case-variant action-path dispatch');
	}
	const missingCsrf = await request(environment.baseUrl, '/?/Json', {
		jar: methodGuest.jar,
		method: 'POST',
		fields: { Action: 'TwoFactorLoginBegin', Email: account.email, Password: testPassword }
	});
	assert.notEqual(missingCsrf.json?.code, 0, 'challenge creation requires the ordinary JSON CSRF token');
	await assertNoNormalAuthority(environment, methodGuest.jar, account.recordPath);

	const attemptGuest = await guestSession(environment.baseUrl);
	const attemptStart = await beginChallenge(environment, account, attemptGuest);
	assert.equal(attemptStart.json?.code, 0);
	const attemptId = attemptStart.json.Result.Challenge;
	for (let attempt = 0; attempt < 5; ++attempt) {
		const code = 0 === attempt ? '' : (1 === attempt ? 'invalid!code' : '000000');
		const failed = await verifyChallenge(environment, account, attemptGuest, attemptId, code);
		assert.equal(failed.json?.code, 102, 'wrong, missing, and malformed factors are generic failures');
	}
	const attemptFiles = await storedRecords(environment.dataRoot, '.sessions');
	const attemptPath = attemptFiles.find(file => path.basename(file).includes(
		createHash('sha256').update(attemptId).digest('hex')));
	assert.ok(attemptPath);
	const exhausted = JSON.parse(await readFile(attemptPath, 'utf8'));
	assert.equal(exhausted.Attempts, 5);
	assert.equal(exhausted.Status, 'exhausted');
	assert.equal((await beginChallenge(environment, account, attemptGuest)).json?.code, 102,
		'exhausted challenge cannot be replaced before original expiry');
	assert.equal(attemptGuest.jar.get('smaccount'), undefined);

	const expiredGuest = await guestSession(environment.baseUrl);
	const expiredStart = await beginChallenge(environment, account, expiredGuest);
	assert.equal(expiredStart.json?.code, 0);
	const expiredId = expiredStart.json.Result.Challenge;
	const expiredPath = (await storedRecords(environment.dataRoot, '.sessions'))
		.find(file => path.basename(file).includes(createHash('sha256').update(expiredId).digest('hex')));
	const expiredState = JSON.parse(await readFile(expiredPath, 'utf8'));
	expiredState.CreatedAt = Math.floor(Date.now() / 1000) - 301;
	expiredState.ExpiresAt = expiredState.CreatedAt + 300;
	await writeFile(expiredPath, JSON.stringify(expiredState));
	const expired = await verifyChallenge(environment, account, expiredGuest, expiredId, totp(testSecret));
	assert.equal(expired.json?.code, 102);
	assert.equal(await pathExists(expiredPath), false, 'observed expired challenge is removed');
	assert.equal(expiredGuest.jar.get('smaccount'), undefined);

	const crossGuest = await guestSession(environment.baseUrl);
	const crossStart = await beginChallenge(environment, account, crossGuest);
	assert.equal(crossStart.json?.code, 0);
	const stolenId = crossStart.json.Result.Challenge;
	const otherGuest = await guestSession(environment.baseUrl);
	const stolen = await verifyChallenge(environment, account, otherGuest, stolenId, totp(testSecret));
	assert.equal(stolen.json?.code, 102, 'a stolen id is insufficient without original guest and CSRF context');
	assert.equal(otherGuest.jar.get('smaccount'), undefined);
	const owner = await verifyChallenge(environment, account, crossGuest, stolenId, totp(testSecret));
	assert.equal(owner.json?.code, 0, 'a cross-context attempt does not consume the owner challenge');

	const tamperedGuest = await guestSession(environment.baseUrl);
	const tamperedStart = await beginChallenge(environment, account, tamperedGuest);
	assert.equal(tamperedStart.json?.code, 0);
	const tamperedId = tamperedStart.json.Result.Challenge;
	const alteredId = (tamperedId[0] === 'A' ? 'B' : 'A') + tamperedId.slice(1);
	assert.equal((await verifyChallenge(environment, account, tamperedGuest, alteredId, totp(testSecret))).json?.code, 102);
	const tamperedPath = (await storedRecords(environment.dataRoot, '.sessions'))
		.find(file => path.basename(file).includes(createHash('sha256').update(tamperedId).digest('hex')));
	const tamperedState = JSON.parse(await readFile(tamperedPath, 'utf8'));
	tamperedState.CsrfHash = '0'.repeat(64);
	await writeFile(tamperedPath, JSON.stringify(tamperedState));
	const tampered = await verifyChallenge(environment, account, tamperedGuest, tamperedId, totp(testSecret));
	assert.equal(tampered.json?.code, 102, 'tampered challenge state fails closed');
	assert.equal(tamperedGuest.jar.get('smaccount'), undefined);

	const csrfGuest = await guestSession(environment.baseUrl);
	const badCsrf = await twoFactorAction(environment.baseUrl, csrfGuest.jar, 'invalid-m1c-csrf', 'TwoFactorLoginBegin', {
		Email: account.email,
		Password: testPassword
	});
	assert.notEqual(badCsrf.json?.code, 0);
	assert.equal(badCsrf.text.includes('invalid-m1c-csrf'), false);
	assert.equal(csrfGuest.jar.get('smaccount'), undefined);
});

test('M1D cumulative factor budget survives fresh guest contexts and blocks a correct proof at the limit', { timeout: 180000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const otherAccount = await createEnabledAccount(environment);
	const wrongFactors = [invalidTotp(testSecret), '', 'invalid!code', '111111111', '0000000'];

	for (let context = 0; context < 2; ++context) {
		const guest = await guestSession(environment.baseUrl);
		const started = await beginChallenge(environment, account, guest);
		assert.equal(started.json?.code, 0, JSON.stringify(started.json));
		for (let attempt = 0; attempt < 5; ++attempt) {
			const failed = await verifyChallenge(environment, account, guest, started.json.Result.Challenge,
				0 === attempt ? invalidTotp(testSecret) : wrongFactors[attempt]);
			assert.equal(failed.json?.code, 102, 'wrong and malformed factors retain the generic response');
		}
		const challengePath = await challengeRecordPath(environment.dataRoot, started.json.Result.Challenge);
		assert.equal(JSON.parse(await readFile(challengePath, 'utf8')).Attempts, 5,
			'the existing five-attempt challenge bound remains active in every fresh context');
		await assertNoNormalAuthority(environment, guest.jar, account.recordPath);
	}

	const blockedGuest = await guestSession(environment.baseUrl);
	const blockedStart = await beginChallenge(environment, account, blockedGuest);
	assert.equal(blockedStart.json?.code, 0, 'correct primary authentication can still begin a fresh challenge');
	const blockedCorrectProof = await verifyChallenge(
		environment, account, blockedGuest, blockedStart.json.Result.Challenge, totp(testSecret)
	);
	assert.equal(blockedCorrectProof.json?.code, 102,
		'a fresh guest context cannot use a correct factor after the account budget is exhausted');
	await assertNoNormalAuthority(environment, blockedGuest.jar, account.recordPath);
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 10,
		'the cumulative budget contains only the ten failed factor proofs');

	const otherGuest = await guestSession(environment.baseUrl);
	const otherStart = await beginChallenge(environment, otherAccount, otherGuest);
	assert.equal(otherStart.json?.code, 0);
	const otherSuccess = await verifyChallenge(
		environment, otherAccount, otherGuest, otherStart.json.Result.Challenge, totp(testSecret)
	);
	assert.equal(otherSuccess.json?.code, 0, 'abuse against one account does not consume another account budget');
	assert.equal(otherSuccess.json?.Result?.Auth, true);
});

test('M1D concurrent fresh-context factor attempts cannot race past the account budget', { timeout: 180000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const workerUrls = [
		environment.baseUrl,
		await startPhpServer(t, environment),
		await startPhpServer(t, environment)
	];
	assert.ok(workerUrls.every(Boolean), 'all synthetic PHP workers must start');

	const contexts = [];
	for (let index = 0; index < 12; ++index) {
		const baseUrl = workerUrls[index % workerUrls.length];
		const guest = await guestSession(baseUrl);
		const started = await twoFactorAction(baseUrl, guest.jar, guest.token, 'TwoFactorLoginBegin', {
			Email: account.email,
			Password: testPassword
		});
		assert.equal(started.json?.code, 0, JSON.stringify(started.json));
		contexts.push({ baseUrl, guest, challenge: started.json.Result.Challenge });
	}

	const wrongCode = invalidTotp(testSecret);
	const results = await Promise.all(contexts.map(({ baseUrl, guest, challenge }) =>
		verifyChallenge(environment, account, guest, challenge, wrongCode, baseUrl)));
	assert.ok(results.every(result => result.json?.code === 102),
		'all failed factor attempts keep the generic authentication response');
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 10,
		'concurrent requests cannot reserve more than ten account factor attempts');
	const challengeAttempts = await Promise.all(contexts.map(async ({ challenge }) => {
		const record = await challengeRecordPath(environment.dataRoot, challenge);
		assert.ok(record, 'each failed request retains its challenge record');
		return JSON.parse(await readFile(record, 'utf8')).Attempts;
	}));
	assert.equal(challengeAttempts.filter(attempts => 1 === attempts).length, 10,
		'the ten admitted wrong proofs update their local challenge counters');
	assert.equal(challengeAttempts.filter(attempts => 0 === attempts).length, 2,
		'limiter-denied requests do not reach factor verification');
	await Promise.all(contexts.map(({ guest }) =>
		assertNoNormalAuthority(environment, guest.jar, account.recordPath)));
});

test('M1D Abort and expired-challenge replacement do not reset factor failures', { timeout: 120000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const firstGuest = await guestSession(environment.baseUrl);
	const firstStart = await beginChallenge(environment, account, firstGuest);
	assert.equal(firstStart.json?.code, 0);
	const firstId = firstStart.json.Result.Challenge;
	assert.equal((await verifyChallenge(environment, account, firstGuest, firstId, 'invalid!code')).json?.code, 102);
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 1);

	const abort = await twoFactorAction(environment.baseUrl, firstGuest.jar, firstGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: firstId });
	assert.equal(abort.json?.code, 0);
	assertAbortResponseShape(abort);
	const resumed = await beginChallenge(environment, account, firstGuest);
	assert.equal(resumed.json?.code, 0);
	assert.equal(resumed.json.Result.Challenge, firstId,
		'Abort resumes the same challenge while its original lifetime remains active');
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 1,
		'Abort does not refund or reset the account-wide factor failure');

	const secondGuest = await guestSession(environment.baseUrl);
	const secondStart = await beginChallenge(environment, account, secondGuest);
	assert.equal(secondStart.json?.code, 0);
	assert.equal((await verifyChallenge(environment, account, secondGuest,
		secondStart.json.Result.Challenge, invalidTotp(testSecret))).json?.code, 102);
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 2,
		'a new guest and challenge share the same account-wide budget');

	const firstPath = await challengeRecordPath(environment.dataRoot, firstId);
	const expiredState = JSON.parse(await readFile(firstPath, 'utf8'));
	expiredState.CreatedAt = Math.floor(Date.now() / 1000) - 301;
	expiredState.ExpiresAt = expiredState.CreatedAt + 300;
	await writeFile(firstPath, JSON.stringify(expiredState));
	const expiredAbort = await twoFactorAction(environment.baseUrl, firstGuest.jar, firstGuest.token,
		'TwoFactorLoginAbort', { Account: account.email, Challenge: firstId });
	assert.equal(expiredAbort.json?.code, 0);
	assert.equal(await pathExists(firstPath), false, 'an expired challenge can be cleaned up');
	const replacement = await beginChallenge(environment, account, firstGuest);
	assert.equal(replacement.json?.code, 0);
	assert.notEqual(replacement.json.Result.Challenge, firstId,
		'expiry permits a new local challenge without replacing the factor limiter state');
	assert.equal((await verifyChallenge(environment, account, firstGuest,
		replacement.json.Result.Challenge, '111111111')).json?.code, 102);
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 3,
		'expired challenge replacement retains the prior account-wide failures');
	await assertNoNormalAuthority(environment, firstGuest.jar, account.recordPath);
});

test('M1D successful TOTP and recovery proofs do not remain charged as failed attempts', { timeout: 180000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const firstGuest = await guestSession(environment.baseUrl);
	const firstStart = await beginChallenge(environment, account, firstGuest);
	assert.equal(firstStart.json?.code, 0);
	for (let attempt = 0; attempt < 5; ++attempt) {
		assert.equal((await verifyChallenge(environment, account, firstGuest,
			firstStart.json.Result.Challenge, invalidTotp(testSecret))).json?.code, 102);
	}
	const secondGuest = await guestSession(environment.baseUrl);
	const secondStart = await beginChallenge(environment, account, secondGuest, true);
	assert.equal(secondStart.json?.code, 0);
	for (let attempt = 0; attempt < 3; ++attempt) {
		assert.equal((await verifyChallenge(environment, account, secondGuest,
			secondStart.json.Result.Challenge, invalidTotp(testSecret))).json?.code, 102);
	}
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 8);

	const totpSuccess = await verifyChallenge(
		environment, account, secondGuest, secondStart.json.Result.Challenge, totp(testSecret)
	);
	assert.equal(totpSuccess.json?.code, 0, JSON.stringify(totpSuccess.json));
	assert.ok(secondGuest.jar.get('smremember'), 'Remember-Me is issued only after valid factor assurance');
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 8,
		'a successful TOTP reservation is refunded without deleting prior failures');

	const recoveryGuest = await guestSession(environment.baseUrl);
	const recoveryStart = await beginChallenge(environment, account, recoveryGuest);
	assert.equal(recoveryStart.json?.code, 0);
	const recoverySuccess = await verifyChallenge(
		environment, account, recoveryGuest, recoveryStart.json.Result.Challenge, '987654321'
	);
	assert.equal(recoverySuccess.json?.code, 0, JSON.stringify(recoverySuccess.json));
	assert.equal(JSON.parse(await readFile(account.recordPath, 'utf8')).BackupCodes, '876543219',
		'a successful recovery proof remains single-use');
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 8,
		'a successful recovery reservation is also refunded');

	const replayGuest = await guestSession(environment.baseUrl);
	const replayStart = await beginChallenge(environment, account, replayGuest);
	assert.equal(replayStart.json?.code, 0);
	assert.equal((await verifyChallenge(environment, account, replayGuest,
		replayStart.json.Result.Challenge, '987654321')).json?.code, 102,
	'a consumed recovery code is counted as a failed factor proof');
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 9);

	const lastGuest = await guestSession(environment.baseUrl);
	const lastStart = await beginChallenge(environment, account, lastGuest);
	assert.equal(lastStart.json?.code, 0);
	assert.equal((await verifyChallenge(environment, account, lastGuest,
		lastStart.json.Result.Challenge, invalidTotp(testSecret))).json?.code, 102);
	assert.equal(await factorAttemptCount(environment.dataRoot, account.email), 10,
		'the account-wide budget still admits ten failed proofs after two valid proofs');
});

test('M1C forced enrollment remains pending and invalid factor state fails closed', { timeout: 90000 }, async t => {
	const forced = await createEnvironment(t, { forceTwoFactor: true });
	if (!forced.baseUrl) {
		return;
	}
	const email = 'm1c-forced-' + randomBytes(5).toString('hex') + '@sec02.test';
	const guest = await guestSession(forced.baseUrl);
	const started = await beginChallenge(forced, { email }, guest, true);
	assert.equal(started.json?.code, 0, JSON.stringify(started.json));
	assert.equal(started.json?.Result?.SetupTwoFactor, true);
	assert.equal(started.json?.Result?.RequiresTwoFactor, undefined,
		'unenrolled mandatory accounts use M1B pending enrollment, not an enabled-factor challenge');
	assert.ok(guest.jar.get('smaccount'));
	assert.ok(guest.jar.get('smremember'), 'existing restricted pending Remember-Me behavior is preserved');
	const pendingPath = await sessionRecordPath(forced.dataRoot, guest.jar.get('smsession'));
	assert.ok(pendingPath);
	assert.equal(await readFile(pendingPath, 'utf8'), 'pending');
	const protectedAction = await twoFactorAction(forced.baseUrl, guest.jar, started.json.Result.System.token, 'SettingsUpdate');
	assert.equal(protectedAction.json?.code, 102, 'SEC-02 still blocks ordinary account settings while pending');

	const optional = await createEnvironment(t);
	if (!optional.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(optional);
	await writeFile(account.recordPath, '{"User":');
	const corruptGuest = await guestSession(optional.baseUrl);
	const corruptLogin = await login(optional.baseUrl, account.email, { ...corruptGuest, code: totp(testSecret) });
	assert.equal(corruptLogin.json?.code, 102);
	await assertNoNormalAuthority(optional, corruptGuest.jar, account.recordPath);
	const corruptChallenge = await beginChallenge(optional, account, await guestSession(optional.baseUrl));
	assert.equal(corruptChallenge.json?.code, 102, 'corrupt two_factor state is not treated as disabled');
});

test('M1C plugin login routes are absent and native enabled-factor login remains protected', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const loginsBeforePluginRoutes = environment.imap.logins.length;
	const trustedJar = new CookieJar();
	const trusted = await request(environment.baseUrl, '/?M1CTrustedLogin', {
		jar: trustedJar,
		method: 'POST',
		fields: { Email: account.email, Password: testPassword }
	});
	assert.equal(trusted.response.status, 200);
	assert.equal(trusted.json, null, 'the custom trusted-login Part route must not be dispatched');
	assert.equal(trustedJar.get('smaccount'), undefined);
	assert.equal(trustedJar.get('smremember'), undefined);
	assert.equal(environment.imap.logins.length, loginsBeforePluginRoutes,
		'a custom trusted-login route must not reach the mailbox backend');

	const externalJar = new CookieJar();
	const external = await request(environment.baseUrl, '/?ExternalLogin', {
		jar: externalJar,
		method: 'POST',
		fields: { Email: account.email, Password: testPassword, Output: 'json' }
	});
	assert.equal(external.response.status, 200);
	assert.equal(external.json, null, 'the plugin-only ExternalLogin Part route must not be dispatched');
	assert.equal(externalJar.get('smaccount'), undefined);
	assert.equal(externalJar.get('smremember'), undefined);
	assert.equal(environment.imap.logins.length, loginsBeforePluginRoutes,
		'plugin-only login routes must not reach the mailbox backend');
	await assert.rejects(readFile(environment.policyStatePath + '.calls', 'utf8'), { code: 'ENOENT' },
		'public-password callbacks must not run through native or plugin-only login paths');

	const beginGuest = await guestSession(environment.baseUrl);
	const begin = await beginChallenge(environment, account, beginGuest);
	assert.equal(begin.json?.code, 0);
	const challenge = begin.json.Result.Challenge;
	const verifyGuest = { jar: beginGuest.jar.copy(), token: beginGuest.token };
	const code = totp(testSecret);
	const verified = await verifyChallenge(environment, account, beginGuest, challenge, code);
	assert.equal(verified.json?.code, 0);
	const logs = await readFile(path.join(environment.dataRoot, '_data_', '_default_', 'logs', 'm1c-two-factor.log'), 'utf8');
	for (const secret of [testPassword, testPassword.trim(), testSecret, testRecoveryCodes.split(' ')[0], code, challenge]) {
		assert.equal(logs.includes(secret), false, 'sensitive value must not appear in logs');
	}
	assert.ok(logs.includes('[two-factor request body omitted]'));
	assert.ok(logs.includes('[two-factor response body omitted]'));
	assert.equal(verifyGuest.jar.get('smaccount'), undefined);
});

test('M1C native SSO preserves ordinary login and rejects enabled-factor authority without proof', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const ordinaryEmail = 'm1c-sso-' + randomBytes(5).toString('hex') + '@sec02.test';
	const ordinaryHash = await createSsoHash(environment.baseUrl, ordinaryEmail);
	const ordinaryJar = new CookieJar();
	const ordinarySso = await request(environment.baseUrl,
		'/?Sso&hash=' + encodeURIComponent(ordinaryHash), { jar: ordinaryJar });
	assert.equal(ordinarySso.response.status, 302);
	assert.equal(ordinarySso.response.headers.get('location'), './');
	assert.ok(ordinaryJar.get('smaccount'), 'native SSO must issue the ordinary account token');
	assert.ok(ordinaryJar.get('smsession'), 'native SSO must bind an authenticated session');
	assert.equal(ordinaryJar.get('smremember'), undefined, 'native SSO must not create Remember-Me state');
	assert.equal((await request(environment.baseUrl, '/?/AppData', { jar: ordinaryJar })).json?.Auth, true);

	const account = await createEnabledAccount(environment);
	const accountSessions = await accountSessionFiles(account.recordPath);
	const enabledHash = await createSsoHash(environment.baseUrl, account.email);
	const enabledJar = new CookieJar();
	const enabledSso = await request(environment.baseUrl,
		'/?Sso&hash=' + encodeURIComponent(enabledHash), { jar: enabledJar });
	assert.equal(enabledSso.response.status, 302);
	assert.equal(enabledSso.response.headers.get('location'), './');
	assert.equal(enabledJar.get('smaccount'), undefined,
		'native LoginProcess must not issue account authority when enabled 2FA proof is absent');
	assert.equal(enabledJar.get('smremember'), undefined);
	assert.deepEqual(await accountSessionFiles(account.recordPath), accountSessions,
		'rejected native SSO must not leave an authenticated session or binding');
	assert.equal((await request(environment.baseUrl, '/?/AppData', { jar: enabledJar })).json?.Auth, false);
	await assert.rejects(readFile(environment.policyStatePath + '.calls', 'utf8'), { code: 'ENOENT' },
		'native SSO must not invoke removed generic credential or public-password hooks');
});

test('M1C blocks enabled-factor accounts from additional-account authority', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const protectedAccount = await createEnabledAccount(environment);
	const parentEmail = 'm1c-parent-' + randomBytes(6).toString('hex') + '@sec02.test';
	const parentGuest = await guestSession(environment.baseUrl);
	const parentLogin = await login(environment.baseUrl, parentEmail, parentGuest);
	assert.equal(parentLogin.json?.code, 0, JSON.stringify(parentLogin.json));
	const parentToken = parentLogin.appData.System.token;

	const enabledAdd = await twoFactorAction(environment.baseUrl, parentGuest.jar, parentToken, 'AccountSetup', {
		email: protectedAccount.email,
		password: testPassword,
		new: '1'
	});
	assert.notEqual(enabledAdd.json?.code, 0,
		'a factor-enabled mailbox cannot be saved as a secondary account using only its password');
	assert.equal(parentGuest.jar.get('smadditional'), undefined);

	const record = JSON.parse(await readFile(protectedAccount.recordPath, 'utf8'));
	record.Enable = false;
	await writeFile(protectedAccount.recordPath, JSON.stringify(record));
	const addWhileDisabled = await twoFactorAction(environment.baseUrl, parentGuest.jar, parentToken, 'AccountSetup', {
		email: protectedAccount.email,
		password: testPassword,
		new: '1'
	});
	assert.equal(addWhileDisabled.json?.code, 0, JSON.stringify(addWhileDisabled.json));
	const switchWhileDisabled = await twoFactorAction(
		environment.baseUrl,
		parentGuest.jar,
		parentToken,
		'AccountSwitch',
		{ Email: protectedAccount.email }
	);
	assert.equal(switchWhileDisabled.json?.code, 0, JSON.stringify(switchWhileDisabled.json));
	assert.equal(switchWhileDisabled.json?.Result?.Email, protectedAccount.email);
	assert.ok(parentGuest.jar.get('smadditional'), 'non-factor secondary accounts retain normal switching');

	record.Enable = true;
	await writeFile(protectedAccount.recordPath, JSON.stringify(record));
	const restoredAppData = await request(environment.baseUrl, '/?/AppData', { jar: parentGuest.jar });
	assert.equal(restoredAppData.json?.Email, parentEmail,
		'a restored secondary cookie cannot retain authority after its account enables 2FA');
	assert.equal(parentGuest.jar.get('smadditional'), undefined);

	const switchAfterEnable = await twoFactorAction(
		environment.baseUrl,
		parentGuest.jar,
		parentToken,
		'AccountSwitch',
		{ Email: protectedAccount.email }
	);
	assert.notEqual(switchAfterEnable.json?.code, 0,
		'a stored secondary account must stop switching after its factor becomes enabled');
	assert.equal(parentGuest.jar.get('smadditional'), undefined);

	const mailboxOperation = await twoFactorAction(
		environment.baseUrl,
		parentGuest.jar,
		parentToken,
		'AccountUnread',
		{ email: protectedAccount.email }
	);
	assert.notEqual(mailboxOperation.json?.code, 0,
		'stored-account mailbox operations must also fail closed for an enabled factor');

	record.User = 'm1c-mismatched-account@sec02.test';
	await writeFile(protectedAccount.recordPath, JSON.stringify(record));
	const switchWithCorruptFactor = await twoFactorAction(
		environment.baseUrl,
		parentGuest.jar,
		parentToken,
		'AccountSwitch',
		{ Email: protectedAccount.email }
	);
	assert.notEqual(switchWithCorruptFactor.json?.code, 0,
		'a corrupt or account-mismatched target factor record must also deny secondary authority');
});

test('M1E recovery code is consumed once across simultaneous PHP workers', { timeout: 120000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const legacyFactorRecord = JSON.parse(await readFile(account.recordPath, 'utf8'));
	delete legacyFactorRecord.FactorGeneration;
	delete legacyFactorRecord.TotpGeneration;
	delete legacyFactorRecord.LastTotpCounter;
	await writeFile(account.recordPath, JSON.stringify(legacyFactorRecord));
	const secondBaseUrl = await startPhpServer(t, environment);
	const leftGuest = await guestSession(environment.baseUrl);
	const rightGuest = await guestSession(secondBaseUrl);
	const leftBegin = await beginChallenge(environment, account, leftGuest);
	const rightBegin = await twoFactorAction(secondBaseUrl, rightGuest.jar, rightGuest.token, 'TwoFactorLoginBegin', {
		Email: account.email,
		Password: testPassword
	});
	assert.equal(leftBegin.json?.code, 0, JSON.stringify(leftBegin.json));
	assert.equal(rightBegin.json?.code, 0, JSON.stringify(rightBegin.json));
	const recoveryCode = testRecoveryCodes.split(' ')[0];
	const [left, right] = await Promise.all([
		verifyChallenge(environment, account, leftGuest, leftBegin.json.Result.Challenge,
			recoveryCode, environment.baseUrl),
		verifyChallenge(environment, account, rightGuest, rightBegin.json.Result.Challenge,
			recoveryCode, secondBaseUrl)
	]);
	assert.equal([left, right].filter(result => result.json?.code === 0).length, 1,
		'the same recovery code can authenticate at most one worker');
	assert.equal([left, right].filter(result => result.json?.code === 102).length, 1);
	const saved = JSON.parse(await readFile(account.recordPath, 'utf8'));
	assert.equal(saved.BackupCodes, testRecoveryCodes.split(' ').slice(1).join(' '));
	assert.match(saved.FactorGeneration, /^[a-f0-9-]{36}$/i,
		'successful recovery proof lazily migrates the assurance generation');
	assert.match(saved.TotpGeneration, /^[a-f0-9-]{36}$/i,
		'successful recovery proof lazily initializes the replay domain');
});

test('M1E native and legacy login paths serialize one recovery code', { timeout: 120000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const secondBaseUrl = await startPhpServer(t, environment);
	const nativeGuest = await guestSession(environment.baseUrl);
	const legacyGuest = await guestSession(secondBaseUrl);
	const nativeBegin = await beginChallenge(environment, account, nativeGuest);
	assert.equal(nativeBegin.json?.code, 0, JSON.stringify(nativeBegin.json));
	const recoveryCode = testRecoveryCodes.split(' ')[0];
	const [native, legacy] = await Promise.all([
		verifyChallenge(environment, account, nativeGuest, nativeBegin.json.Result.Challenge,
			recoveryCode, environment.baseUrl),
		login(secondBaseUrl, account.email, { ...legacyGuest, code: recoveryCode })
	]);
	assert.equal([native, legacy].filter(result => result.json?.code === 0).length, 1,
		'native challenge verification and legacy totp_code login share one account-wide recovery boundary');
	assert.equal([native, legacy].filter(result => result.json?.code === 102).length, 1);
	assert.equal(JSON.parse(await readFile(account.recordPath, 'utf8')).BackupCodes,
		testRecoveryCodes.split(' ').slice(1).join(' '));
});

test('M1E one TOTP step cannot authenticate two independent challenges', { timeout: 120000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const firstGuest = await guestSession(environment.baseUrl);
	const secondGuest = await guestSession(environment.baseUrl);
	const firstBegin = await beginChallenge(environment, account, firstGuest);
	const secondBegin = await beginChallenge(environment, account, secondGuest);
	assert.equal(firstBegin.json?.code, 0);
	assert.equal(secondBegin.json?.code, 0);
	const code = totp(testSecret);
	const first = await verifyChallenge(environment, account, firstGuest, firstBegin.json.Result.Challenge, code);
	assert.equal(first.json?.code, 0, JSON.stringify(first.json));
	const second = await verifyChallenge(environment, account, secondGuest, secondBegin.json.Result.Challenge, code);
	assert.equal(second.json?.code, 102, 'the accepted account-wide TOTP counter cannot be replayed through another challenge');
	assert.equal(secondGuest.jar.get('smaccount'), undefined);
});

test('M1E simultaneous TOTP proofs across PHP workers have one winner', { timeout: 120000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const secondBaseUrl = await startPhpServer(t, environment);
	const leftGuest = await guestSession(environment.baseUrl);
	const rightGuest = await guestSession(secondBaseUrl);
	const leftBegin = await beginChallenge(environment, account, leftGuest);
	const rightBegin = await twoFactorAction(secondBaseUrl, rightGuest.jar, rightGuest.token, 'TwoFactorLoginBegin', {
		Email: account.email,
		Password: testPassword
	});
	assert.equal(leftBegin.json?.code, 0);
	assert.equal(rightBegin.json?.code, 0);
	const code = totp(testSecret);
	const [left, right] = await Promise.all([
		verifyChallenge(environment, account, leftGuest, leftBegin.json.Result.Challenge, code, environment.baseUrl),
		verifyChallenge(environment, account, rightGuest, rightBegin.json.Result.Challenge, code, secondBaseUrl)
	]);
	assert.equal([left, right].filter(result => result.json?.code === 0).length, 1,
		'account-level locking and counter persistence must permit one worker to consume this TOTP step');
	assert.equal([left, right].filter(result => result.json?.code === 102).length, 1);
	const saved = JSON.parse(await readFile(account.recordPath, 'utf8'));
	assert.equal(Number.isInteger(saved.LastTotpCounter), true);
	assert.equal(typeof saved.TotpGeneration, 'string');
});

test('M1C concurrent challenge redemption finalizes in at most one PHP worker', { timeout: 90000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await createEnabledAccount(environment);
	const guest = await guestSession(environment.baseUrl);
	const started = await beginChallenge(environment, account, guest);
	assert.equal(started.json?.code, 0);
	const challenge = started.json.Result.Challenge;
	const secondBaseUrl = await startPhpServer(t, environment);
	if (!secondBaseUrl) {
		return;
	}
	const leftGuest = { jar: guest.jar.copy(), token: guest.token };
	const rightGuest = { jar: guest.jar.copy(), token: guest.token };
	const results = await Promise.all([
		verifyChallenge(environment, account, leftGuest, challenge, totp(testSecret), environment.baseUrl),
		verifyChallenge(environment, account, rightGuest, challenge, totp(testSecret), secondBaseUrl)
	]);
	assert.equal(results.filter(result => result.json?.code === 0).length, 1,
		'the account lock and consumed-state write permit only one finalizer');
	assert.equal(results.filter(result => result.json?.code === 102).length, 1);
	const winner = leftGuest.jar.get('smaccount') ? leftGuest : rightGuest;
	const loser = leftGuest.jar.get('smaccount') ? rightGuest : leftGuest;
	assert.ok(winner.jar.get('smsession'));
	assert.equal(loser.jar.get('smaccount'), undefined);
	assert.equal((await request(environment.baseUrl, '/?/AppData', { jar: winner.jar })).json?.Auth, true);
	assert.equal((await request(environment.baseUrl, '/?/AppData', { jar: loser.jar })).json?.Auth, false);
});


test('M7.9 ambiguous legacy storage cannot become an unenrolled login', { timeout: 60000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) { return; }
	const guest = await guestSession(environment.baseUrl);
	const legacyRoot = path.join(environment.dataRoot, '_data_', '_default_', 'storage', 'sec02.test', 'reader-notes');
	await mkdir(legacyRoot, { recursive: true });
	const factorPath = path.join(legacyRoot, 'two_factor');
	await writeFile(factorPath, 'synthetic-legacy-factor-state');
	for (const email of ['reader+notes@sec02.test', 'reader-notes@sec02.test']) {
		const result = await login(environment.baseUrl, email, { ...guest, signMe: true });
		assert.notEqual(result.json?.code, 0, 'ambiguous ownership must not authenticate');
		await assertNoNormalAuthority(environment, guest.jar);
	}
	assert.equal(await readFile(factorPath, 'utf8'), 'synthetic-legacy-factor-state');
	assert.deepEqual(await storedRecords(environment.dataRoot, '.sessions'), []);
});

test('M7.9 unknown challenge cleanup does not allocate an account identity', { timeout: 60000 }, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) { return; }
	const guest = await guestSession(environment.baseUrl);
	const namespace = path.join(environment.dataRoot, '_data_', '_default_', 'storage-v2');
	const owners = async () => {
		try { return JSON.parse(await readFile(path.join(namespace, '.identity.json'), 'utf8')).owners; }
		catch (error) { if (error.code === 'ENOENT') { return {}; } throw error; }
	};
	const before = await owners();
	const result = await twoFactorAction(environment.baseUrl, guest.jar, guest.token,
		'TwoFactorLoginAbort', { Account: 'unknown-cleanup@sec02.test', Challenge: 'A'.repeat(43) });
	assertAbortResponseShape(result);
	assert.deepEqual(await owners(), before, 'non-authenticating cleanup must not reserve an account');
	assert.deepEqual((await readdir(namespace)).filter(name => /^[a-f0-9]{64}$/.test(name)), []);
	assert.equal(await pathExists(path.join(environment.dataRoot, '_data_', '_default_', 'storage', '.signme-locks')), false);
	await assertNoNormalAuthority(environment, guest.jar);
});
