import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { watch as watchFiles } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
	testTemporaryRoot = path.join(homedir(), '.petuja-email-two-factor-tests-' + process.pid + '-' + randomUUID());
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

function runWindowsAclHelper(operation, target, privateBase) {
	return spawnSync(windowsPowerShell, [
		'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
		'-File', windowsAclScript, '-Operation', operation, '-Path', target,
		'-PrivateBase', privateBase
	], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		env: windowsEnvironment,
		timeout: 15000,
		windowsHide: true
	});
}

const testPassword = 'sec02-test-password';
const testAdminLogin = 'sec02-admin';
const testAdminPassword = 'sec02-test-admin-password';
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

	delete(name) {
		this.#cookies.delete(name);
	}

	copy(names) {
		const copy = new CookieJar();
		for (const [cookieName, value] of this.#cookies) {
			if (names.some(name => cookieName === name || cookieName.startsWith(name + '~'))) {
				copy.set(cookieName, value);
			}
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
	const server = createServer(socket => {
		socket.write('* OK [CAPABILITY IMAP4rev1 LOGIN] isolated SEC-02 fixture\r\n');
		let pending = '';
		socket.on('data', chunk => {
			pending += chunk.toString('utf8');
			while (pending.includes('\n')) {
				const end = pending.indexOf('\n');
				const line = pending.slice(0, end).replace(/\r$/, '');
				pending = pending.slice(end + 1);
				const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
				if (!match) {
					continue;
				}
				const [, tag, rawCommand, rawArguments = ''] = match;
				const command = rawCommand.toUpperCase();
				if ('CAPABILITY' === command) {
					socket.write('* CAPABILITY IMAP4rev1 LOGIN\r\n' + tag + ' OK capability\r\n');
				} else if ('LOGIN' === command) {
					const args = [...rawArguments.matchAll(/"((?:[^"]|"")*)"|(\S+)/g)]
						.map(item => (item[1] ?? item[2]).replace(/""/g, '"'));
					if (testPassword === args[1]) {
						socket.write(tag + ' OK [CAPABILITY IMAP4rev1] authenticated\r\n');
					} else {
						socket.write(tag + ' NO invalid fixture password\r\n');
					}
				} else if ('LOGOUT' === command) {
					socket.write('* BYE fixture logout\r\n' + tag + ' OK logout\r\n');
				} else if ('LIST' === command) {
					socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n' + tag + ' OK list\r\n');
				} else if ('SELECT' === command || 'EXAMINE' === command) {
					socket.write('* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] valid\r\n'
						+ tag + ' OK [READ-WRITE] selected\r\n');
				} else {
					socket.write(tag + ' OK fixture\r\n');
				}
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(() => new Promise(resolve => server.close(() => resolve())));
	return server.address().port;
}

async function startPhpServer(t, dataRoot, extraEnv = {}) {
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
		env: { ...process.env, PETUJA_TEST_DATA_PATH: dataRoot, ...extraEnv },
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
				return baseUrl;
			}
		} catch {
			// The local PHP server is still starting.
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('PHP test server did not start:\n' + output);
}

async function startSec23PhpServer(t, dataRoot, extraEnv = {}) {
	return startPhpServer(t, dataRoot, {
		PETUJA_TEST_SEC23_STORAGE: '1',
		...extraEnv
	});
}

async function createEnvironment(t, forceTwoFactor, messageReadDelayOverride = null, extraEnv = {}, extraApplicationConfig = [], stalePluginMarkerPath = '') {
	const temporaryRoot = await createTemporaryDirectory('petuja-two-factor-');
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const actualStalePluginMarkerPath = stalePluginMarkerPath
		? (true === stalePluginMarkerPath ? path.join(temporaryRoot, 'stale-two-factor-plugin-loaded') : stalePluginMarkerPath)
		: '';
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configRoot = path.join(privateRoot, 'configs');
	const domainRoot = path.join(privateRoot, 'domains');
	const imapPort = await startImapServer(t);
	await mkdir(configRoot, { recursive: true });
	await mkdir(path.join(privateRoot, 'cache'), { recursive: true });
	await mkdir(domainRoot, { recursive: true });
	if (isWindows) {
		const storageRoot = path.join(privateRoot, 'storage');
		await mkdir(storageRoot);
		const acl = runWindowsAclHelper('VerifyStoragePath', storageRoot, privateRoot);
		assert.equal(acl.status, 0, acl.stderr + acl.stdout);
	}
	if (actualStalePluginMarkerPath) {
		const pluginRoot = path.join(privateRoot, 'plugins');
		const stalePluginPath = path.join(pluginRoot, 'two-factor-auth');
		await mkdir(pluginRoot, { recursive: true });
		await mkdir(stalePluginPath, { recursive: true });
		await writeFile(path.join(stalePluginPath, 'index.php'), [
			'<?php',
			'@file_put_contents((string) getenv("PETUJA_TEST_STALE_2FA_MARKER"), "loaded");',
			'class TwoFactorAuthPlugin extends \\RainLoop\\Plugins\\AbstractPlugin {',
			'\tconst NAME = "Stale Two-Factor Fixture";',
			'\tpublic function Init() : void { $this->addHook("filter.app-data", function() {}); }',
			'}'
		].join('\n'));
		extraEnv = { ...extraEnv, PETUJA_TEST_STALE_2FA_MARKER: actualStalePluginMarkerPath };
	}
	const domain = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imapPort;
	domain.IMAP.type = 0;
	await writeFile(path.join(domainRoot, 'default.json'), JSON.stringify(domain));
	const pluginConfigPath = path.join(configRoot, 'plugin-two-factor-auth.json');
	if (undefined !== forceTwoFactor) {
		await writeFile(pluginConfigPath, JSON.stringify({ plugin: { force_two_factor_auth: forceTwoFactor } }));
	}
	const adminPasswordHash = spawnSync(phpBinary, [
		'-r', `echo password_hash('${testAdminPassword}', PASSWORD_DEFAULT);`
	], { encoding: 'utf8' }).stdout?.trim() || '';
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[plugins]',
		'enable = 1',
		'enabled_list = "two-factor-auth"',
		'',
		'[security]',
		'admin_login = "' + testAdminLogin + '"',
		'admin_password = "' + adminPasswordHash + '"',
		...(null !== messageReadDelayOverride ? [
			'',
			'[webmail]',
			'message_read_delay = ' + messageReadDelayOverride
		] : []),
		...extraApplicationConfig,
		''
	].join('\n'));
	const baseUrl = await startPhpServer(t, dataRoot, extraEnv);
	return {
		baseUrl,
		pluginConfigPath,
		applicationConfigPath: path.join(configRoot, 'application.ini'),
		dataRoot,
		stalePluginMarkerPath: actualStalePluginMarkerPath,
		temporaryRoot
	};
}

async function createSec23Environment(t) {
	const temporaryRoot = await createTemporaryDirectory('petuja-sec23-race-');
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configRoot = path.join(privateRoot, 'configs');
	const domainRoot = path.join(privateRoot, 'domains');
	const imapPort = await startImapServer(t);
	await mkdir(configRoot, { recursive: true });
	await mkdir(path.join(privateRoot, 'cache'), { recursive: true });
	await mkdir(domainRoot, { recursive: true });
	if (isWindows) {
		const storageRoot = path.join(privateRoot, 'storage');
		await mkdir(storageRoot);
		const acl = runWindowsAclHelper('VerifyStoragePath', storageRoot, privateRoot);
		assert.equal(acl.status, 0, acl.stderr + acl.stdout);
	}
	const domain = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imapPort;
	domain.IMAP.type = 0;
	await writeFile(path.join(domainRoot, 'default.json'), JSON.stringify(domain));
	const baseUrl = await startSec23PhpServer(t, dataRoot);
	return { baseUrl, dataRoot, temporaryRoot };
}

async function storedRecords(dataRoot, folderName) {
	const records = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (folderName === entry.name) {
					for (const stored of await readdir(entryPath, { withFileTypes: true })) {
						if (stored.isFile()) {
							records.push(path.join(entryPath, stored.name));
						}
					}
				} else {
					await walk(entryPath);
				}
			}
		}
	}
	await walk(dataRoot);
	return records;
}

async function storedFilesNamed(directory, fileName) {
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
			files.push(...await storedFilesNamed(entryPath, fileName));
		} else if (entry.isFile() && entry.name === fileName) {
			files.push(entryPath);
		}
	}
	return files;
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

async function sessionRecordPath(dataRoot, sessionCookie) {
	const storedSalt = (await readFile(path.join(dataRoot, 'SALT.php'), 'utf8')).trim();
	const appSalt = createHash('md5').update(storedSalt + '_default_' + storedSalt).digest('hex');
	const sessionKey = createHash('sha1')
		.update('Session' + appSalt + sessionCookie + 'Token' + appSalt)
		.digest('hex');
	return (await storedRecords(dataRoot, '.sessions'))
		.find(recordPath => path.basename(recordPath) === sessionKey) || null;
}

async function sessionAuthBindingPath(dataRoot, sessionCookie) {
	const storedSalt = (await readFile(path.join(dataRoot, 'SALT.php'), 'utf8')).trim();
	const appSalt = createHash('md5').update(storedSalt + '_default_' + storedSalt).digest('hex');
	const sessionKey = createHash('sha1')
		.update('Session' + appSalt + sessionCookie + 'Token' + appSalt)
		.digest('hex');
	return (await storedRecords(dataRoot, '.sessions'))
		.find(recordPath => path.basename(recordPath) === 'auth-' + sessionKey) || null;
}

async function pathExists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(filePath, timeoutMs = 10000) {
	if (await pathExists(filePath)) {
		return;
	}
	await new Promise((resolve, reject) => {
		let done = false;
		const finish = callback => value => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				watcher.close();
				callback(value);
			}
		};
		const onFound = finish(resolve);
		const onError = finish(reject);
		const watcher = watchFiles(path.dirname(filePath), () => {
			pathExists(filePath).then(found => found && onFound(), onError);
		});
		watcher.on('error', onError);
		const timer = setTimeout(() => onError(new Error('Timed out waiting for fixture barrier: ' + filePath)), timeoutMs);
		pathExists(filePath).then(found => found && onFound(), onError);
	});
}

function startStorageLockFixture(dataRoot, email, mode, barrierDir) {
	const child = spawn(phpBinary, [
		'-d', 'display_errors=0',
		path.join(repositoryRoot, 'tests', 'fixtures', 'sec23-race-plugin', 'storage-lock.php'),
		repositoryRoot,
		dataRoot,
		email,
		mode,
		barrierDir
	], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
	child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
	return { child, get output() { return output; } };
}

function legacySignMeCookie(dataRoot, cookie) {
	const result = spawnSync(phpBinary, [
		path.join(repositoryRoot, 'tests', 'fixtures', 'sec23-race-plugin', 'legacy-signme-cookie.php'),
		repositoryRoot,
		dataRoot,
		cookie
	], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
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

function probeFailingStorage(dataRoot, email, storageName, key) {
	const result = spawnSync(phpBinary, [
		path.join(repositoryRoot, 'tests', 'fixtures', 'sec23-race-plugin', 'storage-failure-probe.php'),
		repositoryRoot,
		dataRoot,
		email,
		storageName,
		key
	], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PETUJA_TEST_DATA_PATH: dataRoot,
			PETUJA_TEST_STORAGE_FAIL_REVOCATION: '1'
		},
		encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return JSON.parse(result.stdout.trim());
}

async function waitForChildExit(child, timeoutMs = 10000) {
	if (null !== child.exitCode || null !== child.signalCode) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Timed out waiting for PHP fixture process')), timeoutMs);
		child.once('exit', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

async function request(baseUrl, route, { jar, token, method = 'GET', fields, json } = {}) {
	const headers = { ...testHeaders };
	const cookie = jar?.header();
	if (cookie) {
		headers.Cookie = cookie;
	}
	if (undefined !== token) {
		headers['X-SM-Token'] = token;
	}
	let body;
	if (json) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(json);
	} else if (fields) {
		body = new URLSearchParams(fields);
	}
	const response = await fetch(baseUrl + route, { method, headers, body });
	jar?.update(response);
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (parsed && undefined === parsed.code && Object.hasOwn(parsed, 'Result')) {
		parsed.code = 0;
	}
	return { response, text, json: parsed };
}

async function requestGetJsonBody(baseUrl, route, { jar, json } = {}) {
	const body = JSON.stringify(json);
	const url = new URL(baseUrl + route);
	const cookie = jar?.header();
	const headers = {
		...testHeaders,
		'Content-Type': 'application/json',
		'Content-Length': String(Buffer.byteLength(body))
	};
	if (cookie) {
		headers.Cookie = cookie;
	}
	const result = await new Promise((resolve, reject) => {
		const req = httpRequest(url, { method: 'GET', headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode,
				text: Buffer.concat(chunks).toString('utf8')
			}));
		});
		req.on('error', reject);
		req.end(body);
	});
	let parsed;
	try {
		parsed = JSON.parse(result.text);
	} catch {
		parsed = null;
	}
	return { ...result, json: parsed };
}

async function guestSession(baseUrl) {
	const jar = new CookieJar();
	const appData = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(appData.response.status, 200, appData.text.slice(0, 300));
	assert.match(appData.json?.System?.token || '', /^0-/);
	return { jar, token: appData.json.System.token };
}

async function login(baseUrl, email, { jar, token, code, signMe = false } = {}) {
	const fields = {
		Action: 'Login',
		Email: email,
		Password: testPassword,
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

async function nativeTwoFactorAction(baseUrl, jar, token, action, fields = {}) {
	return request(baseUrl, '/?/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: action, ...fields }
	});
}

async function setNativeTwoFactorPolicy(baseUrl, jar, token, required) {
	const adminLogin = await request(baseUrl, '/?/admin/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'AdminLogin', Login: testAdminLogin, Password: testAdminPassword }
	});
	assert.equal(adminLogin.json?.code, 0, JSON.stringify(adminLogin.json));
	const adminToken = adminLogin.json?.Result?.System?.token;
	assert.match(adminToken || '', /^[01]-/);
	return request(baseUrl, '/?/admin/Json', {
		jar,
		token: adminToken,
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: String(required) }
	});
}

async function createSeededTwoFactorAccount(baseUrl, dataRoot) {
	const email = 'native-m1a-' + randomBytes(6).toString('hex') + '@sec02.test';
	const guest = await guestSession(baseUrl);
	const initialLogin = await login(baseUrl, email, { jar: guest.jar, token: guest.token });
	assert.equal(initialLogin.json?.code, 0, JSON.stringify(initialLogin.json));
	const token = initialLogin.appData.System.token;
	const created = await nativeTwoFactorAction(baseUrl, guest.jar, token, 'TwoFactorSetup');
	assert.equal(created.json?.code, 0, JSON.stringify(created.json));
	const records = await storedFilesNamed(dataRoot, 'two_factor');
	assert.equal(records.length, 1, 'native 2FA must persist the record under CONFIG/two_factor');
	const recordPath = records[0];
	const record = JSON.parse(await readFile(recordPath, 'utf8'));
	assert.equal(record.User, email);
	assert.equal(record.Enable, false);
	assert.match(record.Secret, /^[A-Z2-7]+=*$/);
	assert.equal(record.BackupCodes.trim().split(/\s+/).length, 8);
	assert.ok(record.BackupCodes.trim().split(/\s+/).every(code => /^\d{9}$/.test(code)));
	return {
		email,
		jar: guest.jar,
		token,
		recordPath,
		record
	};
}

async function beginForcedEnrollment(baseUrl, dataRoot, email, { signMe = false } = {}) {
	const guest = await guestSession(baseUrl);
	const loginResult = await login(baseUrl, email, { jar: guest.jar, token: guest.token, signMe });
	assert.equal(loginResult.json?.code, 0, JSON.stringify(loginResult.json));
	assert.equal(loginResult.appData?.SetupTwoFactor, true, 'forced policy must keep this session in enrollment');
	const token = loginResult.appData.System.token;
	const setup = await nativeTwoFactorAction(baseUrl, guest.jar, token, 'TwoFactorSetup');
	assert.equal(setup.json?.code, 0, JSON.stringify(setup.json));
	const records = await storedFilesNamed(dataRoot, 'two_factor');
	const matches = await Promise.all(records.map(async recordPath => ({
		recordPath,
		record: JSON.parse(await readFile(recordPath, 'utf8'))
	})));
	const accountRecord = matches.find(({ record }) => record.User === email);
	assert.ok(accountRecord, 'the pending account must have a persisted setup record');
	return {
		jar: guest.jar,
		guestToken: guest.token,
		token,
		recordPath: accountRecord.recordPath,
		secret: setup.json.Result.Secret
	};
}

function makeLegacyTwoFactorRecord(dataRoot, format, record) {
	const result = spawnSync(phpBinary, [
		path.join(repositoryRoot, 'tests', 'fixtures', 'two-factor-legacy-record.php'),
		repositoryRoot,
		dataRoot,
		format,
		JSON.stringify(record)
	], { cwd: repositoryRoot, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return Buffer.from(result.stdout.trim(), 'base64');
}

function probeRecoveryConsumptionFailure(dataRoot, email, record) {
	const result = spawnSync(phpBinary, [
		path.join(repositoryRoot, 'tests', 'fixtures', 'two-factor-consumption-failure.php'),
		repositoryRoot,
		dataRoot,
		email,
		JSON.stringify(record)
	], { cwd: repositoryRoot, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return JSON.parse(result.stdout.trim());
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

function totpWindow(secret, timestamp = Date.now()) {
	const counter = Math.floor(timestamp / 30000);
	return [-1, 0, 1].map(offset => totp(secret, (counter + offset) * 30000));
}

function wrongTotp(secret) {
	const code = totp(secret);
	return code.slice(0, 5) + (code[5] === '9' ? '0' : String(Number(code[5]) + 1));
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

test('M1A native core preserves enabled JSON records and consumes recovery codes once', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, false);
	if (!baseUrl) {
		return;
	}
	const account = await createSeededTwoFactorAccount(baseUrl, dataRoot);
	const secret = 'JBSWY3DPEHPK3PXP';
	const recoveryCodes = '123456789 234567891';
	const record = {
		...account.record,
		Enable: true,
		Secret: secret,
		BackupCodes: recoveryCodes,
		QRCode: 'legacy-qr-value'
	};
	await writeFile(account.recordPath, JSON.stringify(record));

	const staleInfo = await nativeTwoFactorAction(baseUrl, account.jar, account.token, 'TwoFactorState');
	assert.notEqual(staleInfo.json?.code, 0,
		'a password-only session cannot remain usable after an enabled factor appears');

	const totpGuest = await guestSession(baseUrl);
	const totpLogin = await login(baseUrl, account.email, {
		jar: totpGuest.jar,
		token: totpGuest.token,
		code: totp(secret)
	});
	assert.equal(totpLogin.json?.code, 0, JSON.stringify(totpLogin.json));
	const info = await nativeTwoFactorAction(
		baseUrl,
		totpGuest.jar,
		totpLogin.appData.System.token,
		'TwoFactorState'
	);
	assert.equal(info.json?.code, 0, JSON.stringify(info.json));
	assert.equal(info.json?.Result?.Status, 'enabled');
	assert.equal(info.json?.Result?.Enabled, true);
	assert.equal(info.json?.Result?.Secret, undefined, 'the normal info route must not expose the TOTP secret');
	assert.equal(info.json?.Result?.BackupCodes, undefined, 'ordinary state must not expose recovery codes');

	assert.equal('accountHash' in totpLogin.appData, true);
	let saved = JSON.parse(await readFile(account.recordPath, 'utf8'));
	assert.equal(saved.Secret, secret, 'TOTP login must preserve the enrolled secret');
	assert.equal(saved.BackupCodes, recoveryCodes, 'TOTP login must preserve all unused recovery codes');
	assert.equal(saved.Enable, true);

	const recoveryGuest = await guestSession(baseUrl);
	const recoveryLogin = await login(baseUrl, account.email, {
		jar: recoveryGuest.jar,
		token: recoveryGuest.token,
		code: '123456789'
	});
	assert.equal(recoveryLogin.json?.code, 0, JSON.stringify(recoveryLogin.json));
	saved = JSON.parse(await readFile(account.recordPath, 'utf8'));
	assert.equal(saved.Secret, secret);
	assert.equal(saved.Enable, true);
	assert.equal(saved.BackupCodes, '234567891', 'consumption must persist the unused code and remove only the used code');
	assert.equal(saved.QRCode, 'legacy-qr-value', 'consumption must retain supported legacy fields');

	const replayGuest = await guestSession(baseUrl);
	const replayLogin = await login(baseUrl, account.email, {
		jar: replayGuest.jar,
		token: replayGuest.token,
		code: '123456789'
	});
	assert.equal(replayLogin.json?.code, 102, 'a consumed recovery code must fail on replay');
	assert.equal(replayGuest.jar.get('smaccount'), undefined);
});

test('M1A accepts disabled setup records in JSON and supported legacy encodings', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, true);
	if (!baseUrl) {
		return;
	}
	const account = await createSeededTwoFactorAccount(baseUrl, dataRoot);
	const record = { ...account.record };
	delete record.FactorGeneration;
	delete record.TotpGeneration;
	delete record.LastTotpCounter;
	assert.equal(record.Enable, false);
	const formats = ['serialized', 'encrypted-json', 'encrypted-serialized'];
	for (const format of formats) {
		await writeFile(account.recordPath, makeLegacyTwoFactorRecord(dataRoot, format, record));
		const info = await nativeTwoFactorAction(baseUrl, account.jar, account.token, 'TwoFactorState');
		assert.equal(info.json?.code, 0, format + ': ' + JSON.stringify(info.json));
		assert.equal(info.json?.Result?.Status, 'disabled', format + ' must remain a valid setup record');
		assert.equal(info.json?.Result?.Enabled, false, format + ' must remain disabled until proof');
	}

	const pendingSessionPath = await sessionRecordPath(dataRoot, account.jar.get('smsession'));
	assert.ok(pendingSessionPath);
	assert.equal(await readFile(pendingSessionPath, 'utf8'), 'pending',
		'forced enrollment completion must run only from the server-bound pending session');
	const completed = await nativeTwoFactorAction(baseUrl, account.jar, account.token, 'TwoFactorCompleteEnrollment', {
		Code: totp(record.Secret)
	});
	assert.equal(completed.json?.code, 0, JSON.stringify(completed.json));
	assert.equal(completed.json?.Result, true);
	const saved = JSON.parse(await readFile(account.recordPath, 'utf8'));
	assert.equal(saved.Enable, true);
	assert.equal(saved.Secret, record.Secret, 'completion must preserve the existing setup secret');
	assert.equal(saved.BackupCodes, record.BackupCodes, 'completion must preserve every unused recovery code');
	assert.match(saved.FactorGeneration, /^[a-f0-9-]{36}$/i,
		'a successful legacy proof lazily creates a strict assurance generation');
	assert.match(saved.TotpGeneration, /^[a-f0-9-]{36}$/i,
		'a successful legacy proof lazily creates a replay identity');
	assert.equal(Number.isInteger(saved.LastTotpCounter), true,
		'a successful enrollment proof persists its consumed counter');
});

test('M1A rejects corrupt and account-mismatched records instead of treating them as disabled', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, false);
	if (!baseUrl) {
		return;
	}
	const account = await createSeededTwoFactorAccount(baseUrl, dataRoot);
	await writeFile(account.recordPath, '{"User":');
	const restrictedAppData = await request(baseUrl, '/?/AppData', { jar: account.jar });
	assert.equal(restrictedAppData.json?.Auth, false, 'a corrupt state must restrict an existing authenticated session');
	assert.equal('accountHash' in restrictedAppData.json, false);
	assert.equal(restrictedAppData.json?.SetupTwoFactor, false,
		'a corrupt state must not be presented as an enrollment opportunity');
	assert.equal(restrictedAppData.json?.RequireTwoFactor, false,
		'a corrupt optional record must not change the configured login UX');
	const corruptGuest = await guestSession(baseUrl);
	const corruptLogin = await login(baseUrl, account.email, { jar: corruptGuest.jar, token: corruptGuest.token });
	assert.equal(corruptLogin.json?.code, 102, 'a corrupt state must fail closed at login');
	assert.equal(corruptGuest.jar.get('smaccount'), undefined);

	const invalidRecords = [
		['missing User', { ...account.record, User: undefined }],
		['missing Secret', { User: account.email, Enable: false, BackupCodes: account.record.BackupCodes }],
		['wrong Enable type', { ...account.record, Enable: 'false' }],
		['wrong BackupCodes type', { ...account.record, BackupCodes: [] }],
		['wrong QRCode type', { ...account.record, QRCode: {} }],
		['malformed factor generation', { ...account.record, FactorGeneration: 'unknown' }],
		['malformed TOTP generation', { ...account.record, TotpGeneration: [] }],
		['malformed TOTP counter type', { ...account.record, LastTotpCounter: '1234' }],
		['negative TOTP counter', { ...account.record, LastTotpCounter: -1 }]
	];
	for (const [description, record] of invalidRecords) {
		await writeFile(account.recordPath, JSON.stringify(record));
		const restricted = await request(baseUrl, '/?/AppData', { jar: account.jar });
		assert.equal(restricted.json?.Auth, false, description + ' must restrict an existing session');
		assert.equal('accountHash' in restricted.json, false, description + ' must not expose mailbox data');
	}

	const mismatchedRecord = { ...account.record, User: 'different-account@sec02.test' };
	await writeFile(account.recordPath, JSON.stringify(mismatchedRecord));
	const mismatchGuest = await guestSession(baseUrl);
	const mismatchLogin = await login(baseUrl, account.email, {
		jar: mismatchGuest.jar,
		token: mismatchGuest.token,
		code: totp(account.record.Secret)
	});
	assert.equal(mismatchLogin.json?.code, 102, 'a User/account mismatch must fail closed');
	assert.equal(mismatchGuest.jar.get('smaccount'), undefined);
});

test('M1A legacy deserialization cannot instantiate objects and failed recovery persistence fails closed', { timeout: 60000 }, async t => {
	const markerPath = path.join(tmpdir(), 'petuja-two-factor-wakeup-' + randomBytes(8).toString('hex'));
	t.after(() => rm(markerPath, { force: true }));
	const { baseUrl, dataRoot } = await createEnvironment(t, false, null, {
		PETUJA_TEST_UNSERIALIZE_MARKER: markerPath
	});
	if (!baseUrl) {
		return;
	}
	const account = await createSeededTwoFactorAccount(baseUrl, dataRoot);
	const authSource = await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/UserAuth.php'), 'utf8');
	assert.equal(await pathExists(path.join(repositoryRoot, 'plugins', 'two-factor-auth')), false,
		'the retired plugin package must not be present in the runtime tree');
	assert.ok(authSource.includes('->ConsumeRecoveryCode'), 'native authentication must consume recovery codes');

	const unsafePayload = makeLegacyTwoFactorRecord(dataRoot, 'serialized-object', account.record);
	await writeFile(account.recordPath, unsafePayload);
	const unsafeGuest = await guestSession(baseUrl);
	const unsafeLogin = await login(baseUrl, account.email, { jar: unsafeGuest.jar, token: unsafeGuest.token });
	assert.equal(unsafeLogin.json?.code, 102, 'serialized objects are invalid two-factor records');
	assert.equal(await pathExists(markerPath), false, 'safe decoding must not execute __wakeup');

	const enabledRecord = {
		...account.record,
		Enable: true,
		Secret: 'JBSWY3DPEHPK3PXP',
		BackupCodes: '123456789 234567891'
	};
	const failure = probeRecoveryConsumptionFailure(dataRoot, account.email, enabledRecord);
	assert.equal(failure.verifyBefore, true, 'the fixture must begin with a valid recovery code');
	assert.equal(failure.consume, false, 'the native core must fail closed when persistence rejects removal');
	assert.equal(failure.totpFallback, false, 'a nine-digit recovery code cannot pass the six-digit TOTP verifier');
	assert.equal(failure.recordAfter.BackupCodes, enabledRecord.BackupCodes,
		'a failed write must leave the authoritative record unchanged');
});

async function settingsUpdate(baseUrl, jar, token) {
	return request(baseUrl, '/?/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'SettingsUpdate', hourCycle: '24' }
	});
}

async function updateSettings(baseUrl, jar, token, settings) {
	return request(baseUrl, '/?/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'SettingsUpdate', ...settings }
	});
}

test('mandatory 2FA enrollment restricts real authenticated service dispatch until a TOTP-proven fresh login', {
	timeout: process.platform === 'win32' ? 600000 : 180000
}, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, true);
	if (!baseUrl) {
		return;
	}
	const email = 'mandatory-' + randomBytes(6).toString('hex') + '@sec02.test';
	let { jar, token } = await guestSession(baseUrl);

	const pendingLogin = await login(baseUrl, email, { jar, token, signMe: true });
	assert.equal(pendingLogin.json?.code, 0, JSON.stringify(pendingLogin.json));
	assert.equal(pendingLogin.appData?.Auth, true);
	assert.equal(pendingLogin.appData?.RequireTwoFactor, true);
	assert.equal(pendingLogin.appData?.SetupTwoFactor, true);
	assert.equal('accountHash' in pendingLogin.appData, false, 'pending AppData must omit mailbox account data');
	assert.equal('ContactsSync' in pendingLogin.appData, false);
	assert.ok(jar.get('smremember'), 'the fixture should cover remembered pending state');
	const otherPendingGuest = await guestSession(baseUrl);
	const otherPendingLogin = await login(baseUrl, email, {
		...otherPendingGuest,
		signMe: true
	});
	assert.equal(otherPendingLogin.json?.code, 0, JSON.stringify(otherPendingLogin.json));
	const otherPendingRemember = otherPendingGuest.jar.get('smremember');
	assert.ok(otherPendingRemember);
	jar.delete('smaccount');
	jar.delete('smsession');
	const rememberedPendingAppData = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(rememberedPendingAppData.json?.SetupTwoFactor, true,
		'a pending remembered session must remain restricted after restoration');
	assert.equal('accountHash' in rememberedPendingAppData.json, false);
	token = rememberedPendingAppData.json.System.token;
	const pendingAppData = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(pendingAppData.json?.Auth, true);
	assert.equal(pendingAppData.json?.SetupTwoFactor, true);
	assert.equal('accountHash' in pendingAppData.json, false);
	assert.equal('Capa' in pendingAppData.json, false);
	assert.deepEqual(Object.keys(pendingAppData.json).sort(), [
		'Auth', 'Email', 'RequireTwoFactor', 'SetupTwoFactor', 'StaticLibsJs',
		'System', 'allowLanguagesOnLogin', 'clientLanguage', 'language', 'loadingDescription',
		'mainEmail', 'title'
	].sort(), 'pending AppData exposes only the approved enrollment bootstrap shape');
	assert.deepEqual(Object.keys(pendingAppData.json.System).sort(), [
		'customLogoutLink', 'languages', 'petujaEmailSnappyMailVersion', 'petujaEmailVersion',
		'token', 'version', 'webPath', 'webVersionPath'
	].sort());
	assert.equal(Object.hasOwn(pendingAppData.json, 'Plugins'), false,
		'pending AppData has no generic plugin configuration field');
	assert.equal(Object.hasOwn(pendingAppData.json, 'PluginsLink'), false,
		'pending AppData has no generic plugin asset endpoint');
	const adminPathAppData = await request(baseUrl, '/?/admin/AppData', { jar });
	assert.equal(adminPathAppData.json?.Auth, true);
	assert.equal(adminPathAppData.json?.SetupTwoFactor, true);
	assert.equal('accountHash' in adminPathAppData.json, false,
		'the admin path AppData service must not expose pending mailbox capabilities');
	const unauthenticatedAdminAction = await request(baseUrl, '/?/admin/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'AdminPluginGetTwoFactorInfo' }
	});
	assert.equal(unauthenticatedAdminAction.json?.code, 102,
		'an Admin-prefixed action without an admin session must fail the core admin check');
	const adminLogin = await request(baseUrl, '/?/admin/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'AdminLogin', Login: testAdminLogin, Password: testAdminPassword }
	});
	assert.equal(adminLogin.json?.code, 0, JSON.stringify(adminLogin.json));
	assert.equal(adminLogin.json?.Result?.Auth, true, 'the isolated fixture should establish a valid admin session');
	const authenticatedAdminAppData = await request(baseUrl, '/?/admin/AdminAppData', { jar });
	assert.equal(authenticatedAdminAppData.json?.Auth, true,
		'a pending mailbox must not disable the separately authenticated admin bootstrap');

	await t.test('mailbox, settings, contacts, send, and account-switch JSON actions are denied', async () => {
		for (const action of ['SettingsUpdate', 'FolderList', 'MessageList', 'Message', 'SendMessage', 'Contacts', 'AccountSetup', 'AccountSwitch']) {
			const denied = await request(baseUrl, '/?/Json', {
				jar,
				token,
				method: 'POST',
				fields: { Action: action }
			});
			assert.equal(denied.json?.code, 102, action + ': ' + JSON.stringify(denied.json));
		}
	});

	await t.test('JSON body and GET action-path dispatch cannot bypass the pending gate', async () => {
		const directJson = await request(baseUrl, '/?/Json', {
			jar,
			token,
			method: 'POST',
			json: { Action: 'SettingsUpdate', hourCycle: '24' }
		});
		assert.equal(directJson.json?.code, 102, JSON.stringify(directJson.json));
		const getAction = await request(baseUrl, '/?/Json/unused/SettingsUpdate', {
			jar,
			method: 'GET'
		});
		assert.equal(getAction.json?.code, 102, JSON.stringify(getAction.json));

		for (const action of [
			'twofactorSetup',
			'pluginGetTwoFactorInfo',
			'PluginGetTwoFactorInfoSuffix',
			'PluginTwoFactorAuthGetTwoFactorInfo',
			'DoPluginGetTwoFactorInfo',
			'SettingsUpdateExtra'
		]) {
			const variant = await request(baseUrl, '/?/Json', {
				jar,
				token,
				method: 'POST',
				fields: { Action: action }
			});
			assert.equal(variant.json?.code, 102, action + ': ' + JSON.stringify(variant.json));
		}

		const lowerCaseActionPath = await request(baseUrl, '/?/Json/unused/pluginGetTwoFactorInfo', {
			jar,
			method: 'GET'
		});
		assert.equal(lowerCaseActionPath.json?.code, 102, JSON.stringify(lowerCaseActionPath.json));

		const adminRouteMailboxAction = await request(baseUrl, '/?/admin/Json', {
			jar,
			token,
			method: 'POST',
			fields: { Action: 'SettingsUpdate', hourCycle: '24' }
		});
		assert.equal(adminRouteMailboxAction.json?.code, 102,
			'mailbox actions dispatched through ActionsAdmin must retain the pending gate even with a valid admin session');
	});

	await t.test('authenticated non-JSON routes are denied', async () => {
		for (const route of [
			'/?/Raw/Message',
			'/?/ProxyExternal/fixture',
			'/?/ProxyExternal/public-v1/fixture',
			'/?/Upload',
			'/?/Plugins/User/fixture',
			'/?/admin/Raw/Message',
			'/?/admin/ProxyExternal/fixture',
			'/?/admin/ProxyExternal/public-v1/fixture',
			'/?/admin/Plugins/User/fixture'
		]) {
			const denied = await request(baseUrl, route, {
				jar,
				token,
				method: 'POST',
				fields: { Action: 'Upload' }
			});
			assert.ok(denied.response.status >= 400,
				route + ' must remain inaccessible to a pending account: HTTP ' + denied.response.status);
			if (route.includes('/public-v1/')) {
				assert.equal(denied.response.status, 403, 'new proxy namespace is denied by the native gate on POST');
				assert.match(denied.text, /Two-factor enrollment is required before accessing this service/);
				const deniedGet = await request(baseUrl, route, { jar, method: 'GET' });
				assert.equal(deniedGet.response.status, 403,
					'new proxy namespace retains the native pending-account gate on GET');
				assert.match(deniedGet.text, /Two-factor enrollment is required before accessing this service/);
			}
		}
	});

	const info = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorState');
	assert.equal(info.json?.code, 0, JSON.stringify(info.json));
	assert.equal(info.json?.Result?.Status, 'missing');
	assert.equal(info.json?.Result?.Secret, undefined);
	assert.equal(info.json?.Result?.BackupCodes, undefined);
	const separateVerify = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorEnable', { Code: '123456' });
	assert.equal(separateVerify.json?.code, 102, 'pending sessions cannot use the normal enable action');
	const clearPending = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorClear');
	assert.equal(clearPending.json?.code, 102, 'pending enrollment cannot be cleared to escape policy');
	const disablePending = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorDisable');
	assert.equal(disablePending.json?.code, 102, 'pending enrollment cannot invoke the normal disable action');

	const created = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorSetup');
	assert.equal(created.json?.code, 0, JSON.stringify(created.json));
	const firstSecret = created.json.Result.Secret;
	const firstSecretProof = totp(firstSecret);
	let regenerated = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorSetup');
	assert.equal(regenerated.json?.code, 0, JSON.stringify(regenerated.json));
	let secret = regenerated.json.Result.Secret;
	assert.equal(secret, firstSecret, 'reopening setup must resume, not rotate an incomplete factor');
	assert.deepEqual(regenerated.json.Result.BackupCodes, created.json.Result.BackupCodes,
		'reopening setup must preserve the pending recovery codes');
	regenerated = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorSetup', { Restart: '1' });
	assert.equal(regenerated.json?.code, 0, JSON.stringify(regenerated.json));
	secret = regenerated.json.Result.Secret;
	assert.notEqual(secret, firstSecret, 'only an explicit restart replaces the pending secret');
	assert.equal(totpWindow(secret).includes(firstSecretProof), false,
		'a TOTP proof for the replaced secret must not complete the new setup');
	assert.match(secret || '', /^[A-Z2-7]+=*$/);
	assert.ok(regenerated.json.Result.BackupCodes);

	const stateDuringSetup = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorState');
	assert.equal(stateDuringSetup.json?.Result?.Status, 'disabled');
	assert.equal(stateDuringSetup.json?.Result?.Secret, undefined,
		'ordinary state must not expose a pending secret');
	assert.equal(stateDuringSetup.json?.Result?.BackupCodes, undefined,
		'ordinary state must not expose pending recovery codes');
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 102,
		'creating a secret alone must not unlock mailbox access');

	const createViaGet = await request(baseUrl, '/?/Json/unused/TwoFactorSetup', {
		jar,
		method: 'GET'
	});
	assert.equal(createViaGet.json?.code, 102, JSON.stringify(createViaGet.json));
	const createWithoutCsrf = await request(baseUrl, '/?/Json', {
		jar,
		method: 'POST',
		fields: { Action: 'TwoFactorSetup' }
	});
	assert.notEqual(createWithoutCsrf.json?.code, 0, 'setup must require the native JSON CSRF token');

	const nakedEnable = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorEnable');
	assert.equal(nakedEnable.json?.code, 102, JSON.stringify(nakedEnable.json));
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 102,
		'creating a secret or calling Enable without proof must leave the mailbox restricted');

	const wrongCompletion = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorCompleteEnrollment', {
		Code: wrongTotp(secret)
	});
	assert.equal(wrongCompletion.json?.code, 102, JSON.stringify(wrongCompletion.json));
	const missingCompletionCode = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorCompleteEnrollment');
	assert.equal(missingCompletionCode.json?.code, 102, JSON.stringify(missingCompletionCode.json));
	const replacedSecretProof = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorCompleteEnrollment', {
		Code: firstSecretProof
	});
	assert.equal(replacedSecretProof.json?.code, 102,
		'a TOTP proof for a replaced secret must not complete enrollment');
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 102);
	const pendingAuthCookie = jar.get('smaccount');
	const pendingSessionCookie = jar.get('smsession');
	const pendingRememberCookie = jar.get('smremember');

	const completion = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorCompleteEnrollment', {
		Code: totp(secret)
	});
	assert.equal(completion.json?.code, 0, JSON.stringify(completion.json));
	assert.equal(completion.json?.Result, true);
	assert.equal(jar.get('smaccount'), undefined, 'completion must invalidate the pending account token');
	assert.equal(jar.get('smsession'), undefined, 'completion must invalidate the pending session identifier');
	assert.equal(jar.get('smremember'), undefined, 'completion must invalidate a pending remembered-login token');
	const replayedPendingJar = new CookieJar();
	replayedPendingJar.set('smaccount', pendingAuthCookie);
	replayedPendingJar.set('smsession', pendingSessionCookie);
	assert.notEqual((await settingsUpdate(baseUrl, replayedPendingJar, token)).json?.code, 0,
		'a copied pre-enrollment token must remain invalid after completion');
	const replayedRememberJar = new CookieJar();
	replayedRememberJar.set('smremember', pendingRememberCookie);
	const replayedRememberAppData = await request(baseUrl, '/?/AppData', { jar: replayedRememberJar });
	assert.equal(replayedRememberAppData.json?.Auth, false,
		'a copied pending remember-me token must not restore authentication after completion');
	assert.notEqual((await settingsUpdate(baseUrl, replayedRememberJar, token)).json?.code, 0);
	const otherPendingRestoreJar = new CookieJar();
	otherPendingRestoreJar.set('smremember', otherPendingRemember);
	const completedElsewhereRestore = await request(baseUrl, '/?/AppData', { jar: otherPendingRestoreJar });
	assert.equal(completedElsewhereRestore.json?.Auth, false,
		'a pending Remember-Me session from another browser must not survive enrollment completion');

	const postEnrollmentGuest = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(postEnrollmentGuest.json?.Auth, false);
	token = postEnrollmentGuest.json.System.token;

	const missingCode = await login(baseUrl, email, { jar, token });
	assert.equal(missingCode.json?.code, 102, JSON.stringify(missingCode.json));
	assert.equal(jar.get('smaccount'), undefined);
	assert.ok(jar.get('smsession'), 'the guest session may remain for bounded pre-auth retries');
	assert.equal((await request(baseUrl, '/?/AppData', { jar })).json?.Auth, false,
		'the guest session cookie alone does not grant mailbox authority');
	assert.equal(jar.get('smremember'), undefined);
	assert.notEqual((await settingsUpdate(baseUrl, jar, token)).json?.code, 0,
		'failed TOTP login must leave no reusable mailbox authentication');

	const wrongCode = await login(baseUrl, email, { jar, token, code: wrongTotp(secret) });
	assert.equal(wrongCode.json?.code, 102, JSON.stringify(wrongCode.json));
	assert.equal(jar.get('smaccount'), undefined);
	assert.ok(jar.get('smsession'), 'wrong factor retains only the guest session binding');

	const acceptedLogin = await login(baseUrl, email, { jar, token, code: await nextTotp(secret), signMe: true });
	assert.equal(acceptedLogin.json?.code, 0, JSON.stringify(acceptedLogin.json));
	assert.equal(acceptedLogin.appData?.SetupTwoFactor, false);
	assert.equal('accountHash' in acceptedLogin.appData, true,
		'a fresh password plus valid TOTP login must produce normal account AppData');
	token = acceptedLogin.appData.System.token;
	const normalApi = await settingsUpdate(baseUrl, jar, token);
	assert.equal(normalApi.json?.code, 0, JSON.stringify(normalApi.json));
	jar.delete('smaccount');
	jar.delete('smsession');
	const rememberedVerifiedAppData = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(rememberedVerifiedAppData.json?.Auth, true);
	assert.equal('accountHash' in rememberedVerifiedAppData.json, true,
		'a remembered session created after verified TOTP must retain existing access semantics');
	token = rememberedVerifiedAppData.json.System.token;

	const clearFactor = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorClear');
	assert.equal(clearFactor.json?.code, 102, 'forced policy must not let an enrolled user clear the factor');
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 0,
		'rejecting factor removal must preserve the current verified session');
	const disableFactor = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorDisable');
	assert.equal(disableFactor.json?.code, 102, 'forced policy must not let an enrolled user disable the factor');
	const additionalEmail = 'additional-' + randomBytes(6).toString('hex') + '@sec02.test';
	const addAdditionalAccount = await request(baseUrl, '/?/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'AccountSetup', email: additionalEmail, password: testPassword, new: '1' }
	});
	assert.equal(addAdditionalAccount.json?.code, 0, JSON.stringify(addAdditionalAccount.json));
	const switchAdditionalAccount = await request(baseUrl, '/?/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: 'AccountSwitch', Email: additionalEmail }
	});
	assert.equal(switchAdditionalAccount.json?.code, 0, JSON.stringify(switchAdditionalAccount.json));
	assert.ok(jar.get('smadditional'), 'the fixture should establish a real additional-account selection');

	const logoutAuthCookie = jar.get('smaccount');
	const logoutSessionCookie = jar.get('smsession');
	const logoutRememberCookie = jar.get('smremember');
	const logoutAdditionalCookie = jar.get('smadditional');
	const logoutSessionRecord = await sessionRecordPath(dataRoot, logoutSessionCookie);
	assert.ok(logoutSessionRecord, 'the verified SESSION record should exist before logout');
	assert.match(await readFile(logoutSessionRecord, 'utf8'), /^verified:[a-f0-9-]{36}$/i);
	const logoutCookieSnapshot = jar.copy(['smaccount', 'smsession', 'smctoken', 'smadditional']);
	const copiedCookies = logoutCookieSnapshot.copy(['smaccount', 'smsession', 'smctoken', 'smadditional']);
	const copiedAppData = await request(baseUrl, '/?/AppData', { jar: copiedCookies });
	assert.equal(copiedAppData.json?.Auth, true,
		'the copied pre-logout authentication/session cookies should work before logout');

	const otherSession = await guestSession(baseUrl);
	const otherLogin = await login(baseUrl, email, {
		jar: otherSession.jar,
		token: otherSession.token,
		code: await nextTotp(secret)
	});
	assert.equal(otherLogin.json?.code, 0, JSON.stringify(otherLogin.json));
	const otherSessionRecord = await sessionRecordPath(dataRoot, otherSession.jar.get('smsession'));
	assert.ok(otherSessionRecord);
	assert.notEqual(otherSessionRecord, logoutSessionRecord, 'independent sessions must have separate records');
	assert.match(await readFile(otherSessionRecord, 'utf8'), /^verified:[a-f0-9-]{36}$/i);

	const logout = await request(baseUrl, '/?/Json', {
		jar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(logout.json?.code, 0, JSON.stringify(logout.json));
	const copiedReplayJar = logoutCookieSnapshot.copy(['smaccount', 'smsession', 'smctoken', 'smadditional']);
	const copiedReplay = await request(baseUrl, '/?/AppData', { jar: copiedReplayJar });
	assert.equal(copiedReplay.json?.Auth, false,
		'a copied verified auth/session pair must fail immediately after main logout');
	assert.equal(await pathExists(logoutSessionRecord), false, 'logout must delete this exact SESSION record');
	assert.equal(await pathExists(otherSessionRecord), true, 'logout must preserve the independent SESSION record');
	const mixedSessionLogoutJar = logoutCookieSnapshot.copy(['smaccount', 'smctoken']);
	mixedSessionLogoutJar.set('smsession', otherSession.jar.get('smsession'));
	const mixedSessionLogout = await request(baseUrl, '/?/Json', {
		jar: mixedSessionLogoutJar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(mixedSessionLogout.json?.code, 0, JSON.stringify(mixedSessionLogout.json));
	assert.equal(await pathExists(otherSessionRecord), true,
		'an old auth cookie must not revoke another session when paired with its session cookie');
	const missingAuthLogoutJar = new CookieJar();
	missingAuthLogoutJar.set('smsession', otherSession.jar.get('smsession'));
	const missingAuthLogout = await request(baseUrl, '/?/Json', {
		jar: missingAuthLogoutJar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(missingAuthLogout.json?.code, 0, JSON.stringify(missingAuthLogout.json));
	const missingSessionLogoutJar = otherSession.jar.copy(['smaccount', 'smctoken']);
	const missingSessionLogout = await request(baseUrl, '/?/Json', {
		jar: missingSessionLogoutJar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(missingSessionLogout.json?.code, 0, JSON.stringify(missingSessionLogout.json));
	const malformedAuthLogoutJar = new CookieJar();
	malformedAuthLogoutJar.set('smaccount', 'not-a-valid-secure-token');
	malformedAuthLogoutJar.set('smctoken', otherSession.jar.get('smctoken'));
	malformedAuthLogoutJar.set('smsession', otherSession.jar.get('smsession'));
	const malformedAuthLogout = await request(baseUrl, '/?/Json', {
		jar: malformedAuthLogoutJar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(malformedAuthLogout.json?.code, 0, JSON.stringify(malformedAuthLogout.json));
	assert.equal(await pathExists(otherSessionRecord), true,
		'missing or malformed auth state must not revoke another session');
	assert.equal((await request(baseUrl, '/?/AppData', { jar: otherSession.jar })).json?.Auth, true,
		'a second session for the same mailbox must remain authenticated');
	const copiedRememberJar = new CookieJar();
	copiedRememberJar.set('smremember', logoutRememberCookie);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: copiedRememberJar })).json?.Auth, false,
		'a copied pre-logout SignMe token must not restore authentication');
	assert.equal(jar.get('smaccount'), undefined);
	assert.equal(jar.get('smsession'), undefined, 'main logout must clear the current session cookie');
	assert.equal(jar.get('smadditional'), undefined, 'main logout must clear the selected additional account');
	assert.equal(jar.get('smremember'), undefined);
	assert.ok(logoutAuthCookie && logoutSessionCookie && logoutRememberCookie && logoutAdditionalCookie);
	const repeatedLogout = await request(baseUrl, '/?/Json', {
		jar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(repeatedLogout.json?.code, 0, 'repeated logout must remain harmless');
	const freshGuestSessionCookie = 'prelogin-' + randomBytes(16).toString('hex');
	jar.set('smsession', freshGuestSessionCookie);
	const freshGuest = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(freshGuest.json?.Auth, false);
	assert.equal(jar.get('smsession'), freshGuestSessionCookie);
	assert.notEqual(jar.get('smsession'), logoutSessionCookie,
		'a later login must use a fresh session cookie instead of reusing the revoked key');
	const staleAuthWithGuestSession = logoutCookieSnapshot.copy(['smaccount', 'smctoken']);
	staleAuthWithGuestSession.set('smsession', freshGuestSessionCookie);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: staleAuthWithGuestSession })).json?.Auth, false,
		'a copied old auth cookie with a new unauthenticated session cookie must fail');
	const freshLogin = await login(baseUrl, email, {
		jar,
		token: freshGuest.json.System.token,
		code: await nextTotp(secret)
	});
	assert.equal(freshLogin.json?.code, 0, JSON.stringify(freshLogin.json));
	assert.notEqual(jar.get('smsession'), freshGuestSessionCookie,
		'successful authentication must rotate the pre-login session cookie');
	assert.notEqual(jar.get('smsession'), logoutSessionCookie,
		'successful authentication must not reuse a revoked session cookie');
	assert.equal((await request(baseUrl, '/?/AppData', { jar: copiedCookies })).json?.Auth, false,
		'the copied pre-logout pair must remain invalid after a later login');
	const staleAuthOnly = logoutCookieSnapshot.copy(['smaccount', 'smctoken']);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: staleAuthOnly })).json?.Auth, false,
		'a copied auth cookie without a session must not authenticate after logout');
	const staleSessionOnly = new CookieJar();
	staleSessionOnly.set('smsession', logoutSessionCookie);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: staleSessionOnly })).json?.Auth, false,
		'a copied revoked session cookie without an auth cookie must not authenticate');
	const staleAdditionalOnly = logoutCookieSnapshot.copy(['smadditional', 'smctoken']);
	const additionalOnlyReplay = await request(baseUrl, '/?/AppData', { jar: staleAdditionalOnly });
	assert.notEqual(additionalOnlyReplay.json?.Auth, true,
		'a copied additional-account cookie without the main bearer state must not authenticate');
	assert.ok(additionalOnlyReplay.response.status < 500,
		'a copied additional-account cookie must not produce a server error: '
		+ additionalOnlyReplay.response.status + ' ' + additionalOnlyReplay.text.slice(0, 500));
	const staleAuthAndAdditional = logoutCookieSnapshot.copy(['smaccount', 'smctoken', 'smadditional']);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: staleAuthAndAdditional })).json?.Auth, false,
		'old main and additional-account cookies without a session must not authenticate');
	const staleAuthWithFreshSession = logoutCookieSnapshot.copy(['smaccount', 'smctoken']);
	assert.equal((await request(baseUrl, '/?/AppData', { jar })).json?.Auth, true,
		'the fresh login must establish an authenticated new session before testing token mixing');
	const freshSessionCookie = jar.get('smsession');
	assert.ok(freshSessionCookie, 'fresh login must retain its current session cookie');
	staleAuthWithFreshSession.set('smsession', freshSessionCookie);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: staleAuthWithFreshSession })).json?.Auth, false,
		'a copied old auth cookie must not bind to the later fresh-login session');

	const reusedSessionJar = new CookieJar();
	reusedSessionJar.set('smsession', logoutSessionCookie);
	const reusedSessionGuest = await request(baseUrl, '/?/AppData', { jar: reusedSessionJar });
	assert.equal(reusedSessionGuest.json?.Auth, false);
	const reusedSessionLogin = await login(baseUrl, email, {
		jar: reusedSessionJar,
		token: reusedSessionGuest.json.System.token,
		code: await nextTotp(secret)
	});
	assert.equal(reusedSessionLogin.json?.code, 0, JSON.stringify(reusedSessionLogin.json));
	assert.notEqual(reusedSessionJar.get('smsession'), logoutSessionCookie,
		'login must rotate a copied revoked session value instead of reviving it');
	assert.equal(await pathExists(logoutSessionRecord), false,
		'login with a copied revoked session cookie must not recreate the old SESSION record');

});

test('M1D forced enrollment factor failures accumulate across guest sessions and successful proofs are refunded', {
	timeout: 180000
}, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, true);
	if (!baseUrl) {
		return;
	}

	const successfulEmail = 'enrollment-budget-success-' + randomBytes(6).toString('hex') + '@sec02.test';
	const firstSuccessContext = await beginForcedEnrollment(baseUrl, dataRoot, successfulEmail);
	for (let attempt = 0; attempt < 5; ++attempt) {
		const result = await nativeTwoFactorAction(baseUrl, firstSuccessContext.jar, firstSuccessContext.token,
			'TwoFactorCompleteEnrollment', { Code: invalidTotp(firstSuccessContext.secret) });
		assert.equal(result.json?.code, 102, 'an invalid setup proof must be rejected generically');
	}
	assert.equal(await factorAttemptCount(dataRoot, successfulEmail), 5);

	const secondSuccessContext = await beginForcedEnrollment(baseUrl, dataRoot, successfulEmail);
	assert.notEqual(secondSuccessContext.guestToken, firstSuccessContext.guestToken,
		'a fresh guest context must receive a new CSRF token');
	assert.notEqual(secondSuccessContext.jar.get('smsession'), firstSuccessContext.jar.get('smsession'),
		'a fresh guest context must receive a new session');
	assert.equal(secondSuccessContext.secret, firstSuccessContext.secret,
		'reauthentication must resume the existing first-time setup secret');
	for (let attempt = 0; attempt < 4; ++attempt) {
		const result = await nativeTwoFactorAction(baseUrl, secondSuccessContext.jar, secondSuccessContext.token,
			'TwoFactorCompleteEnrollment', { Code: invalidTotp(secondSuccessContext.secret) });
		assert.equal(result.json?.code, 102, 'the account budget must continue in the new context');
	}
	assert.equal(await factorAttemptCount(dataRoot, successfulEmail), 9);

	const completed = await nativeTwoFactorAction(baseUrl, secondSuccessContext.jar, secondSuccessContext.token,
		'TwoFactorCompleteEnrollment', { Code: totp(secondSuccessContext.secret) });
	assert.equal(completed.json?.code, 0, JSON.stringify(completed.json));
	assert.equal(completed.json?.Result, true, 'valid first-time setup must work before exhaustion');
	assert.equal(secondSuccessContext.jar.get('smaccount'), undefined,
		'successful forced enrollment must preserve the pending-session logout boundary');
	assert.equal(JSON.parse(await readFile(secondSuccessContext.recordPath, 'utf8')).Enable, true);
	assert.equal(await factorAttemptCount(dataRoot, successfulEmail), 9,
		'a successful setup proof must refund its reservation without removing earlier failures');

	const exhaustedEmail = 'enrollment-budget-exhausted-' + randomBytes(6).toString('hex') + '@sec02.test';
	const firstFailureContext = await beginForcedEnrollment(baseUrl, dataRoot, exhaustedEmail, { signMe: true });
	const malformedCodes = ['', 'not-a-totp-code'];
	for (let attempt = 0; attempt < 5; ++attempt) {
		const code = attempt < malformedCodes.length ? malformedCodes[attempt] : invalidTotp(firstFailureContext.secret);
		const result = await nativeTwoFactorAction(baseUrl, firstFailureContext.jar, firstFailureContext.token,
			'TwoFactorCompleteEnrollment', { Code: code });
		assert.equal(result.json?.code, 102, 'empty, malformed, and incorrect TOTP proofs must fail generically');
	}
	assert.equal(await factorAttemptCount(dataRoot, exhaustedEmail), 5,
		'malformed and empty public API submissions consume the same factor budget');

	const secondFailureContext = await beginForcedEnrollment(baseUrl, dataRoot, exhaustedEmail);
	assert.notEqual(secondFailureContext.guestToken, firstFailureContext.guestToken);
	assert.notEqual(secondFailureContext.jar.get('smsession'), firstFailureContext.jar.get('smsession'));
	assert.equal(secondFailureContext.secret, firstFailureContext.secret,
		'forced enrollment resumes the same disabled factor after a fresh password login');
	for (let attempt = 0; attempt < 5; ++attempt) {
		const result = await nativeTwoFactorAction(baseUrl, secondFailureContext.jar, secondFailureContext.token,
			'TwoFactorCompleteEnrollment', { Code: invalidTotp(secondFailureContext.secret) });
		assert.equal(result.json?.code, 102);
	}
	assert.equal(await factorAttemptCount(dataRoot, exhaustedEmail), 10,
		'ten failed enrollment proofs exhaust the account-wide temporary budget');

	const blockedCorrectProof = await nativeTwoFactorAction(baseUrl, secondFailureContext.jar, secondFailureContext.token,
		'TwoFactorCompleteEnrollment', { Code: totp(secondFailureContext.secret) });
	assert.equal(blockedCorrectProof.json?.code, 102,
		'a correct proof in an existing pending session must remain blocked after cumulative exhaustion');
	const exhaustedRecord = JSON.parse(await readFile(secondFailureContext.recordPath, 'utf8'));
	assert.equal(exhaustedRecord.Enable, false, 'exhaustion must not enable the factor');
	assert.equal(exhaustedRecord.LastTotpCounter, null, 'a denied proof must not consume a TOTP counter');
	const restricted = await request(baseUrl, '/?/AppData', { jar: secondFailureContext.jar });
	assert.equal(restricted.json?.SetupTwoFactor, true);
	assert.equal('accountHash' in restricted.json, false,
		'exhaustion must leave an existing password-only session restricted to enrollment');
	assert.equal((await settingsUpdate(baseUrl, secondFailureContext.jar, restricted.json.System.token)).json?.code, 102,
		'exhaustion must not grant ordinary mailbox API access');
	assert.equal(await factorAttemptCount(dataRoot, exhaustedEmail), 10,
		'a limiter-denied valid proof is not added as an eleventh failure');

	const blockedLegacyGuest = await guestSession(baseUrl);
	const blockedLegacyLogin = await login(baseUrl, exhaustedEmail, blockedLegacyGuest);
	assert.equal(blockedLegacyLogin.json?.code, 102,
		'legacy password login must not mint a new pending session after cumulative exhaustion');
	assert.equal(blockedLegacyGuest.jar.get('smaccount'), undefined,
		'exhausted pending login must not issue an account authority cookie');
	assert.equal(blockedLegacyGuest.jar.get('smremember'), undefined,
		'exhausted pending login must not issue Remember-Me authority');

	const blockedNativeGuest = await guestSession(baseUrl);
	const blockedNativeLogin = await nativeTwoFactorAction(baseUrl, blockedNativeGuest.jar, blockedNativeGuest.token,
		'TwoFactorLoginBegin', { Email: exhaustedEmail, Password: testPassword, signMe: '1' });
	assert.equal(blockedNativeLogin.json?.code, 102,
		'native password login must not mint a new pending session after cumulative exhaustion');
	assert.equal(blockedNativeGuest.jar.get('smaccount'), undefined);
	assert.equal(blockedNativeGuest.jar.get('smremember'), undefined);

	const pendingRememberCookie = firstFailureContext.jar.get('smremember');
	assert.ok(pendingRememberCookie, 'the fixture must retain a pending Remember-Me lineage for retry');
	const pendingRememberRecord = (await storedRecords(dataRoot, '.sign_me'))[0];
	assert.ok(pendingRememberRecord);
	const blockedRememberGuest = new CookieJar();
	blockedRememberGuest.set('smremember', pendingRememberCookie);
	const blockedRememberRestore = await request(baseUrl, '/?/AppData', { jar: blockedRememberGuest });
	assert.equal(blockedRememberRestore.json?.Auth, false,
		'exhausted pending Remember-Me redemption must not mint a session');
	assert.equal(blockedRememberGuest.get('smaccount'), undefined);
	assert.equal(blockedRememberGuest.get('smremember'), pendingRememberCookie,
		'temporary limiter denial must preserve the Remember-Me cookie for retry after the window');
	assert.equal(await pathExists(pendingRememberRecord), true,
		'temporary limiter denial must preserve the Remember-Me server lineage');
});

test('M1D forced enrollment fails closed when the cumulative limiter cannot persist', { timeout: 90000 }, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, true);
	if (!baseUrl) {
		return;
	}

	const email = 'enrollment-budget-storage-' + randomBytes(6).toString('hex') + '@sec02.test';
	const enrollment = await beginForcedEnrollment(baseUrl, dataRoot, email, { signMe: true });
	const temporaryLedgerPath = path.join(dataRoot, '_data_', '_default_', 'login-abuse', 'state.tmp');
	assert.equal(await pathExists(temporaryLedgerPath), false,
		'the API fixture must be able to force the atomic ledger publication path to fail');
	await mkdir(temporaryLedgerPath);
	let result;
	try {
		const rememberedJar = new CookieJar();
		rememberedJar.set('smremember', enrollment.jar.get('smremember'));
		const blockedRestore = await request(baseUrl, '/?/AppData', { jar: rememberedJar });
		assert.equal(blockedRestore.json?.Auth, false,
			'unavailable cumulative limiter persistence must reject pending Remember-Me redemption');
		assert.equal(rememberedJar.get('smaccount'), undefined);
		assert.ok(rememberedJar.get('smremember'),
			'a temporary storage outage must preserve the Remember-Me cookie for retry');
		result = await nativeTwoFactorAction(baseUrl, enrollment.jar, enrollment.token,
			'TwoFactorCompleteEnrollment', { Code: totp(enrollment.secret) });
	} finally {
		try {
			await chmod(temporaryLedgerPath, 0o700);
		} catch {
			// The failed API reservation may not have changed the directory mode.
		}
		await rm(temporaryLedgerPath, { recursive: true, force: true });
	}
	assert.equal(result.json?.code, 102, 'unavailable limiter persistence must reject even a valid setup proof');
	assert.equal(JSON.parse(await readFile(enrollment.recordPath, 'utf8')).Enable, false,
		'failed admission must not verify or enable the factor');
	assert.equal(await factorAttemptCount(dataRoot, email), 0,
		'failed admission must not leave an unconfirmed factor reservation in the ledger');
	const restricted = await request(baseUrl, '/?/AppData', { jar: enrollment.jar });
	assert.equal('accountHash' in restricted.json, false,
		'a ledger failure must leave the pending session without mailbox authority');
	assert.equal((await settingsUpdate(baseUrl, enrollment.jar, restricted.json.System.token)).json?.code, 102);
});

test('main logout revokes only the current pending session and tolerates partial cookies', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, true);
	if (!baseUrl) {
		return;
	}
	const email = 'logout-' + randomBytes(6).toString('hex') + '@sec02.test';
	const first = await guestSession(baseUrl);
	const firstLogin = await login(baseUrl, email, {
		jar: first.jar,
		token: first.token,
		signMe: true
	});
	assert.equal(firstLogin.json?.code, 0, JSON.stringify(firstLogin.json));
	assert.equal(firstLogin.appData?.SetupTwoFactor, true);
	const originalAppData = await request(baseUrl, '/?/AppData', { jar: first.jar });
	assert.equal(originalAppData.json?.Auth, true, 'original pre-logout cookie jar should remain authenticated');
	const copiedCookies = first.jar.copy(['smaccount', 'smsession', 'smctoken']);
	assert.equal(copiedCookies.get('smaccount'), first.jar.get('smaccount'));
	assert.equal(copiedCookies.get('smsession'), first.jar.get('smsession'));
	assert.equal(copiedCookies.get('smctoken'), first.jar.get('smctoken'));
	const copiedAppData = await request(baseUrl, '/?/AppData', { jar: copiedCookies });
	assert.equal(copiedAppData.json?.Auth, true,
		'copied pre-logout pending auth/session cookies should work before logout');
	const firstSessionCookie = first.jar.get('smsession');
	const firstSessionRecord = await sessionRecordPath(dataRoot, firstSessionCookie);
	assert.ok(firstSessionRecord, 'the pending SESSION record should exist before logout');
	assert.equal(await readFile(firstSessionRecord, 'utf8'), 'pending');
	const rememberCookie = first.jar.get('smremember');
	const signMeRecords = await storedRecords(dataRoot, '.sign_me');
	assert.equal(signMeRecords.length, 1, 'the fixture should contain the current browser SignMe record');

	const second = await guestSession(baseUrl);
	const secondLogin = await login(baseUrl, email, {
		jar: second.jar,
		token: second.token
	});
	assert.equal(secondLogin.json?.code, 0, JSON.stringify(secondLogin.json));
	const secondSessionRecord = await sessionRecordPath(dataRoot, second.jar.get('smsession'));
	assert.ok(secondSessionRecord);
	assert.notEqual(secondSessionRecord, firstSessionRecord);

	const domainPath = path.join(dataRoot, '_data_', '_default_', 'domains', 'default.json');
	const domainConfiguration = await readFile(domainPath, 'utf8');
	await rm(domainPath);
	const logout = await request(baseUrl, '/?/Json', {
		jar: first.jar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	await writeFile(domainPath, domainConfiguration);
	assert.equal(logout.json?.code, 0, JSON.stringify(logout.json));
	assert.equal(await pathExists(firstSessionRecord), false, 'logout must remove the exact pending SESSION record');
	assert.equal((await request(baseUrl, '/?/AppData', { jar: copiedCookies })).json?.Auth, false,
		'a copied pending auth/session pair must fail immediately after logout');
	assert.equal(await pathExists(secondSessionRecord), true, 'logout must preserve the other current session');
	assert.equal((await request(baseUrl, '/?/AppData', { jar: second.jar })).json?.Auth, true);
	const rememberReplay = new CookieJar();
	rememberReplay.set('smremember', rememberCookie);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: rememberReplay })).json?.Auth, false,
		'a copied pending SignMe token must not restore authentication');
	assert.equal(await pathExists(signMeRecords[0]), false, 'logout must clear this browser SignMe record');
	assert.equal(first.jar.get('smsession'), undefined);
	assert.equal(first.jar.get('smaccount'), undefined);
	assert.equal(first.jar.get('smremember'), undefined);

	const repeatedLogout = await request(baseUrl, '/?/Json', {
		jar: first.jar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(repeatedLogout.json?.code, 0, 'logout without auth cookies should remain idempotent');

	const malformed = new CookieJar();
	malformed.set('smaccount', 'not-a-valid-secure-token');
	malformed.set('smsession', 'untrusted-session-key');
	malformed.set('smadditional', 'not-a-valid-secure-token');
	const malformedLogout = await request(baseUrl, '/?/Json', {
		jar: malformed,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(malformedLogout.json?.code, 0,
		'malformed and partial cookies must not make logout fail: ' + JSON.stringify(malformedLogout.json));
	assert.equal(malformed.get('smaccount'), undefined);
	assert.equal(malformed.get('smsession'), undefined);
	assert.equal(malformed.get('smadditional'), undefined);
});

test('SEC-23 forces fresh login for pre-version Remember-Me cookies and keeps them logout-cleanable', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createSec23Environment(t);
	const email = 'legacy-' + randomBytes(6).toString('hex') + '@sec23.test';
	const legacySession = await guestSession(baseUrl);
	const legacyLogin = await login(baseUrl, email, {
		jar: legacySession.jar,
		token: legacySession.token
	});
	assert.equal(legacyLogin.json?.code, 0, JSON.stringify(legacyLogin.json));
	const legacySessionCookie = legacySession.jar.get('smsession');
	const legacySessionRecord = await sessionRecordPath(dataRoot, legacySessionCookie);
	const legacyAuthBinding = await sessionAuthBindingPath(dataRoot, legacySessionCookie);
	assert.ok(legacySessionRecord, 'the pre-upgrade session row must exist');
	assert.ok(legacyAuthBinding, 'the legacy session must have its matching hash binding');
	const legacyAuthHash = createHash('sha256').update(legacySession.jar.get('smaccount')).digest('hex');
	await writeFile(legacyAuthBinding, legacyAuthHash);
	assert.equal(await readFile(legacyAuthBinding, 'utf8'), legacyAuthHash,
		'the fixture must model the old plain SHA-256 binding format');

	const rememberOrigin = await guestSession(baseUrl);
	const rememberLogin = await login(baseUrl, email, {
		jar: rememberOrigin.jar,
		token: rememberOrigin.token,
		signMe: true
	});
	assert.equal(rememberLogin.json?.code, 0, JSON.stringify(rememberLogin.json));
	const currentRememberCookie = rememberOrigin.jar.get('smremember');
	const legacyRememberCookie = legacySignMeCookie(dataRoot, currentRememberCookie);
	assert.notEqual(legacyRememberCookie, currentRememberCookie);
	const lineageRecord = (await storedRecords(dataRoot, '.sign_me'))[0];
	assert.ok(lineageRecord, 'the pre-version Remember-Me lineage must exist');

	const logoutWithoutRemember = legacySession.jar.copy(['smaccount', 'smsession', 'smctoken']);
	const logout = await request(baseUrl, '/?/Json', {
		jar: logoutWithoutRemember,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(logout.json?.code, 0, JSON.stringify(logout.json));
	assert.equal(await pathExists(legacySessionRecord), false,
		'logout without smremember must revoke the exact legacy SESSION');
	assert.equal(await pathExists(legacyAuthBinding), false,
		'logout without smremember must remove the exact legacy SESSION binding');

	const sessionSnapshot = async () => (await Promise.all((await storedRecords(dataRoot, '.sessions'))
		.map(async record => [record, await readFile(record, 'utf8')]))).sort(([left], [right]) => left.localeCompare(right));
	const beforeRestore = await sessionSnapshot();
	const legacyReplay = new CookieJar();
	legacyReplay.set('smremember', legacyRememberCookie);
	const rejectedRestore = await request(baseUrl, '/?/AppData', { jar: legacyReplay });
	assert.equal(rejectedRestore.json?.Auth, false,
		'a pre-version Remember-Me bearer must fail closed instead of restoring after legacy logout');
	assert.equal(legacyReplay.get('smremember'), undefined,
		'an unsupported old Remember-Me cookie must be cleared from the browser');
	const afterRestore = await sessionSnapshot();
	assert.deepEqual(afterRestore, beforeRestore,
		'rejecting an old Remember-Me cookie must not create or change SESSION state');
	assert.equal(await pathExists(lineageRecord), true,
		'a version rejection must not delete server state without the current cookie schema');

	const legacyExplicitLogout = legacySession.jar.copy(['smaccount', 'smsession', 'smctoken']);
	legacyExplicitLogout.set('smremember', legacyRememberCookie);
	const cleanup = await request(baseUrl, '/?/Json', {
		jar: legacyExplicitLogout,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(cleanup.json?.code, 0, JSON.stringify(cleanup.json));
	assert.equal(await pathExists(lineageRecord), false,
		'legacy cookie parsing must remain available to clear its exact lineage on explicit logout');

	const oldAuthSession = await guestSession(baseUrl);
	const oldAuthLogin = await login(baseUrl, email, {
		jar: oldAuthSession.jar,
		token: oldAuthSession.token
	});
	assert.equal(oldAuthLogin.json?.code, 0, JSON.stringify(oldAuthLogin.json));
	const oldAuthRecord = await sessionRecordPath(dataRoot, oldAuthSession.jar.get('smsession'));
	const oldAuthBinding = await sessionAuthBindingPath(dataRoot, oldAuthSession.jar.get('smsession'));
	assert.ok(oldAuthRecord);
	assert.ok(oldAuthBinding);
	await writeFile(oldAuthBinding,
		createHash('sha256').update(oldAuthSession.jar.get('smaccount')).digest('hex'));
	const oldAuthLogout = oldAuthSession.jar.copy(['smaccount', 'smsession', 'smctoken']);
	assert.equal((await request(baseUrl, '/?/AppData', { jar: oldAuthSession.jar })).json?.Auth, false,
		'a pre-upgrade account cookie with the old matching SHA-256 binding must require fresh login');
	const cleanupOldAuth = await request(baseUrl, '/?/Json', {
		jar: oldAuthLogout,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(cleanupOldAuth.json?.code, 0, JSON.stringify(cleanupOldAuth.json));
	assert.equal(await pathExists(oldAuthRecord), false,
	'explicit logout must still revoke the exact rejected legacy SESSION');
});

test('SEC-23 explicit logout wins a paused SignMe redemption and revokes finalized lineages', {
	timeout: process.platform === 'win32' ? 360000 : 120000
}, async t => {
	const { baseUrl, dataRoot, temporaryRoot } = await createSec23Environment(t);
	for (let iteration = 0; iteration < 3; ++iteration) {
		const email = 'race-' + iteration + '-' + randomBytes(6).toString('hex') + '@sec23.test';
		const first = await guestSession(baseUrl);
		const beforeFirstLogin = new Set(await storedRecords(dataRoot, '.sign_me'));
		const firstLogin = await login(baseUrl, email, {
			jar: first.jar,
			token: first.token,
			signMe: true
		});
		assert.equal(firstLogin.json?.code, 0, JSON.stringify(firstLogin.json));
		assert.ok(first.jar.get('smremember'));
		const firstRecord = (await storedRecords(dataRoot, '.sign_me'))
			.find(record => !beforeFirstLogin.has(record));
		assert.ok(firstRecord, 'the first browser must create a distinct SignMe lineage');

		const second = await guestSession(baseUrl);
		const secondLogin = await login(baseUrl, email, {
			jar: second.jar,
			token: second.token,
			signMe: true
		});
		assert.equal(secondLogin.json?.code, 0, JSON.stringify(secondLogin.json));
		assert.ok(second.jar.get('smremember'));
		const firstSessionRecord = await sessionRecordPath(dataRoot, first.jar.get('smsession'));
		const firstAuthBinding = await sessionAuthBindingPath(dataRoot, first.jar.get('smsession'));
		assert.ok(firstSessionRecord, 'the first password session must exist before the race');
		assert.ok(firstAuthBinding, 'the first password session must have an auth binding before the race');
		const afterSecondLogin = await storedRecords(dataRoot, '.sign_me');
		const secondRecord = afterSecondLogin.find(record => record !== firstRecord);
		assert.ok(secondRecord, 'a second same-account browser must retain an independent SignMe lineage');
		assert.equal(await pathExists(firstRecord), true);
		assert.equal(await pathExists(secondRecord), true);

		const barrierDir = path.join(temporaryRoot, 'barrier-' + iteration);
		await mkdir(barrierDir, { recursive: true });
		const racingUrl = await startSec23PhpServer(t, dataRoot, {
			PETUJA_TEST_SIGNME_BARRIER_EMAIL: email,
			PETUJA_TEST_SIGNME_BARRIER_DIR: barrierDir
		});
		const inFlightRemember = new CookieJar();
		inFlightRemember.set('smremember', first.jar.get('smremember'));
		const redemption = request(racingUrl, '/?/AppData', { jar: inFlightRemember });
		await waitForFile(path.join(barrierDir, 'reached'));

		const logoutCookieNames = 2 === iteration
			? ['smaccount', 'smctoken']
			: ['smaccount', 'smsession', 'smctoken', 'smadditional'];
		const logoutWithoutRemember = first.jar.copy(logoutCookieNames);
		assert.equal(logoutWithoutRemember.get('smremember'), undefined);
		if (2 === iteration) {
			assert.equal(logoutWithoutRemember.get('smsession'), undefined,
				'the final race iteration must exercise logout with a lineage claim but no session cookie');
		}
		const firstLogout = await request(baseUrl, '/?/Json', {
			jar: logoutWithoutRemember,
			method: 'POST',
			fields: { Action: 'Logout' }
		});
		assert.equal(firstLogout.json?.code, 0, JSON.stringify(firstLogout.json));
		assert.equal(await pathExists(firstSessionRecord), 2 === iteration,
			'logout must only remove the exact SESSION row when its cookie is present');
		assert.equal(await pathExists(firstAuthBinding), 2 === iteration,
			'logout must only remove the exact auth binding when its session cookie is present');
		assert.equal(await pathExists(firstRecord), false,
			'explicit logout must clear the exact paused redemption lineage before it returns');
		assert.equal(await pathExists(secondRecord), true,
			'logging out one browser must preserve an independent same-account SignMe lineage');
		if (2 === iteration) {
			assert.equal((await request(baseUrl, '/?/AppData', { jar: first.jar })).json?.Auth, false,
				'a session whose linked lineage was revoked without its logout cookie must no longer authenticate');
		}
		const sessionStateBeforeResume = new Map();
		for (const record of await storedRecords(dataRoot, '.sessions')) {
			sessionStateBeforeResume.set(record, await readFile(record, 'utf8'));
		}
		await writeFile(path.join(barrierDir, 'release'), 'continue');

		const resumedRedemption = await redemption;
		assert.equal(resumedRedemption.response.status, 200, resumedRedemption.text.slice(0, 300));
		assert.equal(resumedRedemption.json?.Auth, false,
			'a redemption paused after reading the old value must fail its locked recheck after logout');
		assert.equal(inFlightRemember.get('smremember'), undefined,
			'a failed redemption must not return a usable replacement Remember-Me cookie');
		assert.equal(inFlightRemember.get('smaccount'), undefined);
		assert.equal(inFlightRemember.get('smsession'), undefined);
		assert.equal(await pathExists(firstRecord), false,
			'the paused request must not recreate the revoked SignMe record');
		assert.equal(await pathExists(secondRecord), true);
		const sessionFilesAfterRace = await storedRecords(dataRoot, '.sessions');
		assert.deepEqual(
			sessionFilesAfterRace.slice().sort(),
			[...sessionStateBeforeResume.keys()].sort(),
			'a failed redemption must not create a SESSION row or auth-binding file'
		);
		for (const [record, value] of sessionStateBeforeResume) {
			assert.equal(await readFile(record, 'utf8'), value,
				'a failed redemption must not mutate another session or its auth binding');
		}

		// Let the independent browser redeem first, then log it out. Its encrypted
		// auth token is bound to the session and carries the lineage claim.
		const secondRemember = new CookieJar();
		secondRemember.set('smremember', second.jar.get('smremember'));
		const secondRestored = await request(baseUrl, '/?/AppData', { jar: secondRemember });
		assert.equal(secondRestored.json?.Auth, true,
			'the independent Remember-Me lineage must remain usable after first-browser logout');
		const restoredSession = await sessionRecordPath(dataRoot, secondRemember.get('smsession'));
		const restoredAuthBinding = await sessionAuthBindingPath(dataRoot, secondRemember.get('smsession'));
		assert.ok(restoredSession, 'SignMe redemption must establish a SESSION row');
		assert.ok(restoredAuthBinding, 'SignMe redemption must bind its auth token to that SESSION');
		assert.equal(await readFile(restoredAuthBinding, 'utf8'),
			'v2:' + createHash('sha256').update(secondRemember.get('smaccount')).digest('hex'));
		const firstLineageUuid = path.basename(firstRecord);
		const secondLineageUuid = path.basename(secondRecord);
		const staleRememberReplay = new CookieJar();
		staleRememberReplay.set('smremember', second.jar.get('smremember'));
		assert.equal((await request(baseUrl, '/?/AppData', { jar: staleRememberReplay })).json?.Auth, false,
			'a copied pre-refresh Remember-Me cookie must not authenticate again');
		assert.equal(staleRememberReplay.get('smremember'), undefined,
			'the stale replay cookie should be cleared');
		assert.equal(await pathExists(secondRecord), true,
			'a stale replay must not revoke the refreshed lineage sharing its UUID');
		assert.equal((await request(baseUrl, '/?/AppData', { jar: secondRemember })).json?.Auth, true,
			'the active refreshed session must survive a stale Remember-Me replay');
		const independentPassword = await guestSession(baseUrl);
		const independentPasswordLogin = await login(baseUrl, email, {
			jar: independentPassword.jar,
			token: independentPassword.token,
			signMe: false
		});
		assert.equal(independentPasswordLogin.json?.code, 0, JSON.stringify(independentPasswordLogin.json));
		assert.equal((await request(baseUrl, '/?/AppData', { jar: independentPassword.jar })).json?.Auth, true);

		const mismatchedLineageLogoutJar = secondRemember.copy(['smaccount', 'smctoken']);
		mismatchedLineageLogoutJar.set('smsession', second.jar.get('smsession'));
		const mismatchedLineageLogout = await request(baseUrl, '/?/Json', {
			jar: mismatchedLineageLogoutJar,
			method: 'POST',
			fields: { Action: 'Logout' }
		});
		assert.notEqual(mismatchedLineageLogout.json?.code, 0,
			'explicit logout must not claim success when the current auth claim and session binding disagree');
		assert.equal(await pathExists(secondRecord), true,
			'a lineage claim paired with another session must not revoke the lineage');
		assert.equal(await pathExists(restoredSession), true,
			'a mismatched bearer must not revoke the restored session');
		assert.equal((await request(baseUrl, '/?/AppData', { jar: secondRemember })).json?.Auth, true);

		const independentPasswordSession = await sessionRecordPath(dataRoot, independentPassword.jar.get('smsession'));
		const independentPasswordBinding = await sessionAuthBindingPath(dataRoot, independentPassword.jar.get('smsession'));
		const independentBindingValue = await readFile(independentPasswordBinding, 'utf8');
		await rm(independentPasswordBinding);
		const unboundMismatchedLogoutJar = secondRemember.copy(['smaccount', 'smctoken']);
		unboundMismatchedLogoutJar.set('smsession', independentPassword.jar.get('smsession'));
		const unboundMismatchedLogout = await request(baseUrl, '/?/Json', {
			jar: unboundMismatchedLogoutJar,
			method: 'POST',
			fields: { Action: 'Logout' }
		});
		assert.notEqual(unboundMismatchedLogout.json?.code, 0,
			'logout must not report success when an unbound SESSION cannot be associated with the claimed lineage');
		assert.equal(await pathExists(secondRecord), true,
			'a signed lineage paired with an unbound independent SESSION must not revoke that lineage');
		assert.equal(await pathExists(independentPasswordSession), true,
			'an unbound mismatched SESSION must not be deleted as if it belonged to the claimed lineage');
		await writeFile(independentPasswordBinding, independentBindingValue);

		await rm(restoredAuthBinding);
		assert.equal(await pathExists(restoredAuthBinding), false,
			'the test must model a legacy SESSION created before auth bindings existed');
		const legacyMixedSessionJar = independentPassword.jar.copy(['smaccount', 'smctoken']);
		legacyMixedSessionJar.set('smsession', secondRemember.get('smsession'));
		const legacyMixedSession = await request(baseUrl, '/?/AppData', { jar: legacyMixedSessionJar });
		assert.equal(legacyMixedSession.json?.Auth, false,
			'an unbound legacy SESSION must not accept another same-account auth cookie');
		assert.equal(await pathExists(restoredSession), true,
			'rejecting an unbound legacy SESSION must not revoke the session row');
		assert.equal(await pathExists(restoredAuthBinding), false,
			'a rejected legacy pairing must not claim the SESSION for the wrong auth cookie');
		secondRemember.delete('smremember');
		const secondLogout = await request(baseUrl, '/?/Json', {
			jar: secondRemember,
			method: 'POST',
			fields: { Action: 'Logout' }
		});
		assert.notEqual(secondLogout.json?.code, 0,
			'logout must not claim success when the exact session binding is missing and the lineage cannot be proven');
		assert.equal(await pathExists(secondRecord), true,
			'a missing binding must not be treated as proof that the session belongs to the claimed lineage');
		assert.equal(await pathExists(restoredSession), true,
			'a missing binding must not authorize deleting the current SESSION row');
		await writeFile(restoredAuthBinding,
			'v2:' + createHash('sha256').update(secondRemember.get('smaccount')).digest('hex'));
		const exactSecondLogout = await request(baseUrl, '/?/Json', {
			jar: secondRemember,
			method: 'POST',
			fields: { Action: 'Logout' }
		});
		assert.equal(exactSecondLogout.json?.code, 0, JSON.stringify(exactSecondLogout.json));
		assert.equal(await pathExists(secondRecord), false,
			'logout from an unbound legacy SESSION must clear its authenticated lineage claim without smremember');
		assert.equal(await pathExists(restoredSession), false,
			'logout from the restored session must remove its exact SESSION row');
		assert.equal((await request(baseUrl, '/?/AppData', { jar: secondRemember })).json?.Auth, false,
			'a finalized Remember-Me session must fail lineage validation after logout');
		assert.equal((await request(baseUrl, '/?/AppData', { jar: second.jar })).json?.Auth, false,
			'a password session linked to the revoked Remember-Me lineage must also fail');
		assert.equal((await request(baseUrl, '/?/AppData', { jar: independentPassword.jar })).json?.Auth, true,
			'revoking one remembered lineage must preserve an independent same-mailbox password session');
		assert.notEqual(secondLineageUuid, firstLineageUuid);
	}
});

test('SEC-23 redemption wins the account lock before logout and leaves its issued session unusable', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot, temporaryRoot } = await createSec23Environment(t);
	const email = 'redemption-wins-' + randomBytes(6).toString('hex') + '@sec23.test';
	const first = await guestSession(baseUrl);
	const firstLogin = await login(baseUrl, email, {
		jar: first.jar,
		token: first.token,
		signMe: true
	});
	assert.equal(firstLogin.json?.code, 0, JSON.stringify(firstLogin.json));
	const firstSignMeRecord = (await storedRecords(dataRoot, '.sign_me'))[0];
	assert.ok(firstSignMeRecord);
	const firstSessionRecord = await sessionRecordPath(dataRoot, first.jar.get('smsession'));
	const firstAuthBinding = await sessionAuthBindingPath(dataRoot, first.jar.get('smsession'));
	assert.ok(firstSessionRecord);
	assert.ok(firstAuthBinding);

	const barrierDir = path.join(temporaryRoot, 'redemption-wins-barrier');
	await mkdir(barrierDir, { recursive: true });
	const redemptionUrl = await startSec23PhpServer(t, dataRoot, {
		PETUJA_TEST_SIGNME_BARRIER_EMAIL: email,
		PETUJA_TEST_SIGNME_LOCKED_BARRIER_DIR: barrierDir
	});
	const logoutUrl = await startSec23PhpServer(t, dataRoot, {
		PETUJA_TEST_SIGNME_LOGOUT_LOCK_ATTEMPT_DIR: barrierDir
	});
	const rememberJar = new CookieJar();
	rememberJar.set('smremember', first.jar.get('smremember'));
	const redemption = request(redemptionUrl, '/?/AppData', { jar: rememberJar });
	await waitForFile(path.join(barrierDir, 'lock-held'));
	assert.equal(await pathExists(firstSignMeRecord), true,
		'the redemption lock holder has not changed the lineage before the barrier releases');

	const logoutJar = first.jar.copy(['smaccount', 'smsession', 'smctoken', 'smadditional']);
	assert.equal(logoutJar.get('smremember'), undefined);
	const logout = request(logoutUrl, '/?/Json', {
		jar: logoutJar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	await waitForFile(path.join(barrierDir, 'logout-lock-attempt'));
	assert.equal(await readFile(path.join(barrierDir, 'logout-lock-attempt'), 'utf8'), 'contended',
		'the redemption must hold the shared account lock when explicit logout reaches its lock acquisition');

	await writeFile(path.join(barrierDir, 'release'), 'continue');
	const [redemptionResult, logoutResult] = await Promise.all([redemption, logout]);
	assert.equal(redemptionResult.json?.Auth, true,
		'the redemption that acquired the lock first may finish before logout');
	assert.equal(logoutResult.json?.code, 0, JSON.stringify(logoutResult.json));
	assert.equal(await pathExists(firstSignMeRecord), false,
		'logout must revoke the refreshed same-UUID Remember-Me record after redemption releases the lock');
	assert.equal(await pathExists(firstSessionRecord), false,
		'logout must remove the password SESSION it received');
	assert.equal(await pathExists(firstAuthBinding), false,
		'logout must remove the password session auth binding it received');

	const redeemedSessionRecord = await sessionRecordPath(dataRoot, rememberJar.get('smsession'));
	const redeemedAuthBinding = await sessionAuthBindingPath(dataRoot, rememberJar.get('smsession'));
	assert.ok(redeemedSessionRecord,
		'the redemption may have finalized its SESSION before the waiting logout acquired the lock');
	assert.ok(redeemedAuthBinding,
		'the redemption may have finalized its auth binding before the waiting logout acquired the lock');
	assert.equal((await request(baseUrl, '/?/AppData', { jar: rememberJar })).json?.Auth, false,
		'a SESSION finalized before logout must still fail because its claimed lineage was revoked');
	assert.equal(await pathExists(redeemedSessionRecord), false,
		'invalid-session cleanup should remove the now-unusable redeemed SESSION');
	assert.equal(await pathExists(redeemedAuthBinding), false,
		'invalid-session cleanup should remove the now-unusable redeemed auth binding');
	const staleReplacement = new CookieJar();
	staleReplacement.set('smremember', rememberJar.get('smremember'));
	assert.equal((await request(baseUrl, '/?/AppData', { jar: staleReplacement })).json?.Auth, false,
		'a Remember-Me cookie returned after the logout linearization point must not restore authentication');
	assert.equal(staleReplacement.get('smremember'), undefined,
		'the unusable replacement Remember-Me cookie should be cleared');
});

test('SEC-23 Remember-Me fails closed with a storage driver that lacks locking', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createSec23Environment(t);
	const email = 'unlocked-' + randomBytes(6).toString('hex') + '@sec23.test';
	const first = await guestSession(baseUrl);
	const firstLogin = await login(baseUrl, email, {
		jar: first.jar,
		token: first.token,
		signMe: true
	});
	assert.equal(firstLogin.json?.code, 0, JSON.stringify(firstLogin.json));
	const signMeRecord = (await storedRecords(dataRoot, '.sign_me'))[0];
	assert.ok(signMeRecord);

	const unlockedUrl = await startSec23PhpServer(t, dataRoot, { PETUJA_TEST_STORAGE_UNSUPPORTED_LOCK: '1' });
	const rememberOnly = new CookieJar();
	rememberOnly.set('smremember', first.jar.get('smremember'));
	const refusedRestore = await request(unlockedUrl, '/?/AppData', { jar: rememberOnly });
	assert.equal(refusedRestore.json?.Auth, false,
		'a driver without the optional lock contract must not establish Remember-Me authentication');
	assert.equal(rememberOnly.get('smaccount'), undefined);
	assert.equal(rememberOnly.get('smsession'), undefined);
	assert.equal(rememberOnly.get('smremember'), undefined);
	assert.equal(await pathExists(signMeRecord), true,
		'an unlocked provider must not perform an uncoordinated cleanup of the SignMe record');

	const unlockedGuest = await guestSession(unlockedUrl);
	const passwordLogin = await login(unlockedUrl, email, {
		jar: unlockedGuest.jar,
		token: unlockedGuest.token,
		signMe: true
	});
	assert.equal(passwordLogin.json?.code, 0, JSON.stringify(passwordLogin.json));
	assert.equal(passwordLogin.appData?.Auth, true,
		'ordinary password login must continue when optional Remember-Me locking is unavailable');
	assert.equal(unlockedGuest.jar.get('smremember'), undefined,
		'unsupported storage must not issue a Remember-Me cookie');
});

test('SEC-23 failed Remember-Me session binding does not authenticate the current request', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createSec23Environment(t);
	const email = 'binding-failure-' + randomBytes(6).toString('hex') + '@sec23.test';
	const first = await guestSession(baseUrl);
	const firstLogin = await login(baseUrl, email, {
		jar: first.jar,
		token: first.token,
		signMe: true
	});
	assert.equal(firstLogin.json?.code, 0, JSON.stringify(firstLogin.json));
	const sessionRecordsBefore = await storedRecords(dataRoot, '.sessions');
	const signMeRecord = (await storedRecords(dataRoot, '.sign_me'))[0];
	assert.ok(signMeRecord);

	const failingUrl = await startSec23PhpServer(t, dataRoot, {
		PETUJA_TEST_STORAGE_FAIL_SESSION_BINDING: '1'
	});
	const rememberJar = new CookieJar();
	rememberJar.set('smremember', first.jar.get('smremember'));
	const refusedRestore = await request(failingUrl, '/?/AppData', { jar: rememberJar });
	assert.equal(refusedRestore.json?.Auth, false,
		'a failed SESSION auth-binding write must not leave the current request authenticated in memory');
	assert.equal(rememberJar.get('smaccount'), undefined);
	assert.equal(rememberJar.get('smsession'), undefined);
	assert.equal(rememberJar.get('smremember'), undefined);
	assert.equal(await pathExists(signMeRecord), false,
		'a failed one-time Remember-Me redemption must revoke the rotated lineage');
	assert.deepEqual(await storedRecords(dataRoot, '.sessions'), sessionRecordsBefore,
		'a failed auth-binding write must not leave a SESSION row or binding behind');
});

test('SEC-23 logout reports unresolved legacy storage deletion and succeeds after recovery', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createSec23Environment(t);
	const email = 'storage-failure-' + randomBytes(6).toString('hex') + '@sec23.test';
	const remembered = await guestSession(baseUrl);
	const rememberedLogin = await login(baseUrl, email, {
		jar: remembered.jar,
		token: remembered.token,
		signMe: true
	});
	assert.equal(rememberedLogin.json?.code, 0, JSON.stringify(rememberedLogin.json));
	const signMeRecord = (await storedRecords(dataRoot, '.sign_me'))[0];
	const rememberedSession = await sessionRecordPath(dataRoot, remembered.jar.get('smsession'));
	const rememberedBinding = await sessionAuthBindingPath(dataRoot, remembered.jar.get('smsession'));
	assert.ok(signMeRecord && rememberedSession && rememberedBinding);

	const failingUrl = await startSec23PhpServer(t, dataRoot, { PETUJA_TEST_STORAGE_FAIL_REVOCATION: '1' });
	const failedRememberLogoutJar = remembered.jar.copy(['smaccount', 'smsession', 'smctoken', 'smadditional', 'smremember']);
	const failedRememberLogout = await request(failingUrl, '/?/Json', {
		jar: failedRememberLogoutJar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.ok(failedRememberLogout.json?.code !== 0 || failedRememberLogout.response.status >= 400,
		'logout must not report success when SignMe deletion is unresolved');
	assert.equal(await pathExists(signMeRecord), true,
		'the failing provider must leave the underlying SIGN_ME file in place');
	assert.equal(await pathExists(rememberedSession), true,
		'failed lineage revocation must not remove the SESSION after its preceding SIGN_ME delete failed');
	assert.equal(await pathExists(rememberedBinding), true,
		'failed lineage revocation must retain the matching SESSION binding');
	assert.deepEqual(probeFailingStorage(dataRoot, email, 'signme', path.basename(signMeRecord)), {
		clear: false,
		get: false,
		underlyingExists: true
	}, 'the legacy driver must reproduce Clear=false/Get=false while the record survives');

	const retryRememberLogout = await request(baseUrl, '/?/Json', {
		jar: remembered.jar.copy(['smaccount', 'smsession', 'smctoken', 'smadditional', 'smremember']),
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(retryRememberLogout.json?.code, 0, JSON.stringify(retryRememberLogout.json));
	assert.equal(await pathExists(signMeRecord), false,
		'a retry against recovered storage must revoke the exact SignMe lineage');
	assert.equal(await pathExists(rememberedSession), false,
		'a retry against recovered storage must revoke the exact SESSION');
	assert.equal(await pathExists(rememberedBinding), false,
		'a retry against recovered storage must revoke the exact auth binding');

	const passwordOnly = await guestSession(baseUrl);
	const passwordLogin = await login(baseUrl, email, {
		jar: passwordOnly.jar,
		token: passwordOnly.token,
		signMe: false
	});
	assert.equal(passwordLogin.json?.code, 0, JSON.stringify(passwordLogin.json));
	const passwordSession = await sessionRecordPath(dataRoot, passwordOnly.jar.get('smsession'));
	const passwordBinding = await sessionAuthBindingPath(dataRoot, passwordOnly.jar.get('smsession'));
	assert.ok(passwordSession && passwordBinding);
	const failedSessionLogout = await request(failingUrl, '/?/Json', {
		jar: passwordOnly.jar.copy(['smaccount', 'smsession', 'smctoken', 'smadditional']),
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.ok(failedSessionLogout.json?.code !== 0 || failedSessionLogout.response.status >= 400,
		'logout must not report success when exact SESSION deletion is unresolved');
	assert.equal(await pathExists(passwordSession), true);
	assert.equal(await pathExists(passwordBinding), true);
	assert.deepEqual(probeFailingStorage(dataRoot, email, 'session', path.basename(passwordSession)), {
		clear: false,
		get: false,
		underlyingExists: true
	}, 'the legacy driver must mask the surviving SESSION row as absent');

	const retrySessionLogout = await request(baseUrl, '/?/Json', {
		jar: passwordOnly.jar.copy(['smaccount', 'smsession', 'smctoken', 'smadditional']),
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(retrySessionLogout.json?.code, 0, JSON.stringify(retrySessionLogout.json));
	assert.equal(await pathExists(passwordSession), false);
	assert.equal(await pathExists(passwordBinding), false);
});

test('SEC-23 FileStorage keeps the account lock stable across DeleteStorage', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot, temporaryRoot } = await createSec23Environment(t);
	assert.ok(baseUrl);
	const email = 'delete-lock-' + randomBytes(6).toString('hex') + '@sec23.test';
	const barrierDir = path.join(temporaryRoot, 'delete-lock-barrier');
	await mkdir(barrierDir, { recursive: true });
	const releaseHolder = async () => {
		if (!await pathExists(path.join(barrierDir, 'release'))) {
			await writeFile(path.join(barrierDir, 'release'), 'release');
		}
	};
	const holder = startStorageLockFixture(dataRoot, email, 'hold', barrierDir);
	t.after(async () => {
		if (null === holder.child.exitCode && null === holder.child.signalCode) {
			holder.child.kill('SIGTERM');
		}
	});
	await waitForFile(path.join(barrierDir, 'lock-held'));
	const signMeRecord = (await storedRecords(dataRoot, '.sign_me'))[0];
	assert.ok(signMeRecord, 'the lock holder must establish account storage');
	const accountRoot = path.dirname(path.dirname(signMeRecord));
	const lockDirectory = path.join(dataRoot, '_data_', '_default_', 'storage', '.signme-locks');
	const lockFile = path.join(lockDirectory, (await readdir(lockDirectory))[0]);
	assert.ok(await pathExists(lockFile), 'the account lock must live outside the recursively deleted account tree');

	const deleter = startStorageLockFixture(dataRoot, email, 'delete', barrierDir);
	t.after(() => {
		if (null === deleter.child.exitCode && null === deleter.child.signalCode) {
			deleter.child.kill('SIGTERM');
		}
	});
	try {
		await waitForFile(path.join(barrierDir, 'delete-lock-probe'));
		assert.equal(await readFile(path.join(barrierDir, 'delete-lock-probe'), 'utf8'), 'contended',
			'DeleteStorage must attempt the same account lock while another process holds it');
		assert.equal(await pathExists(path.join(barrierDir, 'delete-done')), false,
			'DeleteStorage must remain blocked while SignMe work holds the account lock');
		assert.equal(await pathExists(signMeRecord), true,
			'DeleteStorage must not remove account state before acquiring the lock');
		assert.equal(await pathExists(lockFile), true,
			'the stable lock inode must remain linked during account deletion');
	} finally {
		await releaseHolder();
	}

	const holderExit = await waitForChildExit(holder.child);
	assert.equal(holderExit.code, 0, holder.output);
	await waitForFile(path.join(barrierDir, 'delete-done'));
	const deleteExit = await waitForChildExit(deleter.child);
	assert.equal(deleteExit.code, 0, deleter.output);
	assert.equal(await readFile(path.join(barrierDir, 'delete-done'), 'utf8'), 'deleted');
	assert.equal(await pathExists(accountRoot), true, 'DeleteStorage preserves the account ownership skeleton');
	assert.deepEqual(await readdir(accountRoot), [], 'DeleteStorage removes account contents after the holder releases');
	assert.equal(await pathExists(lockFile), true,
		'DeleteStorage must leave the account lock inode linked for future requests');
});

test('M1F migrates the legacy force policy once and keeps native configuration authoritative', { timeout: 90000 }, async t => {
	const cases = [
		{ name: 'legacy true', value: true, expected: true },
		{ name: 'legacy false', value: false, expected: false },
		{ name: 'missing legacy setting', value: undefined, expected: false },
		{ name: 'malformed legacy value', value: 'not-a-boolean', expected: true },
		{ name: 'native false overrides legacy true', value: true, nativeValue: false, expected: false },
		{ name: 'native true overrides legacy false', value: false, nativeValue: true, expected: true }
	];

	for (const item of cases) {
		await t.test(item.name, async subtest => {
			const extraApplicationConfig = undefined === item.nativeValue
				? []
				: ['require_two_factor_auth = ' + (item.nativeValue ? 'On' : 'Off')];
			const { baseUrl, pluginConfigPath, applicationConfigPath, dataRoot } = await createEnvironment(
				subtest,
				item.value,
				null,
				{},
				extraApplicationConfig
			);
			if (!baseUrl) {
				return;
			}
			const legacyBefore = await pathExists(pluginConfigPath)
				? await readFile(pluginConfigPath, 'utf8')
				: null;
			const guest = await guestSession(baseUrl);
			const email = 'm1f-migration-' + randomBytes(5).toString('hex') + '@sec02.test';
			const loginResult = await login(baseUrl, email, { jar: guest.jar, token: guest.token });
			assert.equal(loginResult.json?.code, 0, JSON.stringify(loginResult.json));
			assert.equal(loginResult.appData?.RequireTwoFactor, item.expected);
			assert.equal(loginResult.appData?.SetupTwoFactor, item.expected,
				'policy value must control real native login and enrollment state');

			const applicationConfig = await readFile(applicationConfigPath, 'utf8');
			assert.match(applicationConfig, item.expected
				? /require_two_factor_auth\s*=\s*On/i
				: /require_two_factor_auth\s*=\s*Off/i);
			assert.match(applicationConfig, /two_factor_policy_migration\s*=\s*1/i);
			assert.match(applicationConfig, /enable\s*=\s*1/i,
				'legacy plugin toggle remains on disk but is not used by runtime code');
			assert.match(applicationConfig, /enabled_list\s*=\s*"two-factor-auth"/,
				'legacy enabled-list state remains untouched and inert after the native migration');
			assert.equal(await pathExists(path.join(dataRoot, '_data_', '_default_', 'plugins', 'two-factor-auth')), false,
				'normal authentication must work with no installed two-factor plugin directory');
			assert.equal(await pathExists(pluginConfigPath) ? await readFile(pluginConfigPath, 'utf8') : null, legacyBefore,
				'migration must leave legacy plugin data untouched');

			await writeFile(pluginConfigPath, JSON.stringify({ plugin: { force_two_factor_auth: !item.expected } }));
			const restartedBaseUrl = await startPhpServer(subtest, dataRoot);
			const restartedGuest = await guestSession(restartedBaseUrl);
			const restartedLogin = await login(restartedBaseUrl,
				'm1f-restart-' + randomBytes(5).toString('hex') + '@sec02.test', restartedGuest);
			assert.equal(restartedLogin.json?.code, 0, JSON.stringify(restartedLogin.json));
			assert.equal(restartedLogin.appData?.RequireTwoFactor, item.expected,
				'a process restart and changed stale plugin config must preserve native authority');
		});
	}
});

test('M3B stale enabled plugin files are inert while native login and migrated 2FA remain available', { timeout: 60000 }, async t => {
	const policyStatePath = path.join(tmpdir(), 'petuja-m1f-generic-hook-' + randomBytes(6).toString('hex') + '.json');
	t.after(() => rm(policyStatePath, { force: true }));
	t.after(() => rm(policyStatePath + '.calls', { force: true }));
	await writeFile(policyStatePath, JSON.stringify({ mode: 'required' }));
	const environment = await createEnvironment(t, false, null, {
		PETUJA_TEST_LOGIN_POLICY_STATE: policyStatePath
	}, [], true);
	if (!environment.baseUrl) {
		return;
	}

	const guest = await guestSession(environment.baseUrl);
	const missingCaptcha = await login(environment.baseUrl,
		'm1f-generic-' + randomBytes(5).toString('hex') + '@sec02.test', guest);
	assert.equal(missingCaptcha.json?.code, 0, JSON.stringify(missingCaptcha.json));
	assert.equal(await pathExists(policyStatePath + '.calls'), false,
		'a stale login policy fixture cannot intercept the native password path');
	assert.equal(await pathExists(environment.stalePluginMarkerPath), false,
		'the stale retired package index.php must never be included');

	const accepted = await request(environment.baseUrl, '/?/Json', {
		jar: guest.jar,
		token: missingCaptcha.appData.System.token,
		method: 'POST',
		fields: {
			Action: 'Login',
			Email: 'm1f-generic-' + randomBytes(5).toString('hex') + '@sec02.test',
			Password: testPassword,
			RecaptchaResponse: 'local-test-captcha-response'
		}
	});
	assert.equal(accepted.json?.code, 0, JSON.stringify(accepted.json));
	assert.equal(await pathExists(policyStatePath + '.calls'), false,
		'no generic login policy hook runs even when its expected proof is supplied');
	assert.equal(await pathExists(environment.stalePluginMarkerPath), false);
	const applicationConfig = await readFile(environment.applicationConfigPath, 'utf8');
	assert.match(applicationConfig, /enabled_list\s*=\s*"two-factor-auth"/,
		'the stale enabled-list value is preserved as inert configuration');
});

test('M1F admin force control is authenticated, CSRF protected, strict, and native', { timeout: 60000 }, async t => {
	const { baseUrl, pluginConfigPath, applicationConfigPath } = await createEnvironment(t, false);
	if (!baseUrl) {
		return;
	}
	const guest = await guestSession(baseUrl);
	const unauthenticated = await request(baseUrl, '/?/admin/Json', {
		jar: guest.jar,
		token: guest.token,
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: 'true' }
	});
	assert.notEqual(unauthenticated.json?.code, 0, 'admin authentication is required');

	const adminGuest = await guestSession(baseUrl);
	const adminLogin = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: adminGuest.token,
		method: 'POST',
		fields: { Action: 'AdminLogin', Login: testAdminLogin, Password: testAdminPassword }
	});
	assert.equal(adminLogin.json?.code, 0, JSON.stringify(adminLogin.json));
	assert.equal(adminLogin.json?.Result?.RequireTwoFactor, false,
		'Admin Security bootstrap reads the native policy');
	assert.equal(Object.hasOwn(adminLogin.json.Result, 'pluginsEnable'), false,
		'Admin bootstrap no longer advertises an executable plugin switch');
	const adminToken = adminLogin.json.Result.System.token;
	const adminConfig = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: adminToken,
		method: 'POST',
		fields: { Action: 'AdminSettingsGet' }
	});
	assert.equal(adminConfig.json?.code, 0, JSON.stringify(adminConfig.json));
	assert.equal(Object.hasOwn(adminConfig.json.Result, 'plugins'), false,
		'generic Admin config reads omit stale global plugin settings');
	const stalePluginWrite = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: adminToken,
		method: 'POST',
		json: { Action: 'AdminSettingsSet', config: { plugins: { enable: true, enabled_list: 'stale-plugin' } } }
	});
	assert.notEqual(stalePluginWrite.json?.code, 0,
		'generic Admin config writes cannot alter plugin enablement');
	assert.match(await readFile(applicationConfigPath, 'utf8'), /enabled_list\s*=\s*"two-factor-auth"/);
	const withoutCsrf = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: 'true' }
	});
	assert.notEqual(withoutCsrf.json?.code, 0, 'native admin policy writes require CSRF');
	const wrongCsrf = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: 'm1f-invalid-admin-csrf-token',
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: 'true' }
	});
	assert.notEqual(wrongCsrf.json?.code, 0, 'native admin policy writes reject an incorrect CSRF token');

	const malformed = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: adminToken,
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: 'yes' }
	});
	assert.notEqual(malformed.json?.code, 0, 'malformed boolean input must be rejected');
	assert.match(await readFile(applicationConfigPath, 'utf8'), /require_two_factor_auth\s*=\s*Off/i);
	for (const value of [['true'], { value: true }]) {
		const malformedType = await request(baseUrl, '/?/admin/Json', {
			jar: adminGuest.jar,
			token: adminToken,
			method: 'POST',
			json: { Action: 'AdminSettingsUpdate', RequireTwoFactor: value }
		});
		assert.notEqual(malformedType.json?.code, 0, 'array/object policy input must be rejected');
	}

	const getPolicyUpdate = await requestGetJsonBody(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		json: { Action: 'AdminSettingsUpdate', RequireTwoFactor: true }
	});
	assert.notEqual(getPolicyUpdate.json?.Result, true, 'native admin policy updates require POST');
	const getGenericPolicyUpdate = await requestGetJsonBody(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		json: { Action: 'AdminSettingsSet', config: { security: { require_two_factor_auth: true } } }
	});
	assert.notEqual(getGenericPolicyUpdate.json?.Result, true,
		'the generic Admin config writer must require POST when changing native policy');
	const getAdminActionPathUpdate = await requestGetJsonBody(baseUrl, '/?/admin/Json/AdminSettingsUpdate', {
		jar: adminGuest.jar,
		json: { RequireTwoFactor: true }
	});
	assert.notEqual(getAdminActionPathUpdate.json?.Result, true,
		'GET action-path dispatch must not bypass the native policy POST requirement');
	assert.match(await readFile(applicationConfigPath, 'utf8'), /require_two_factor_auth\s*=\s*Off/i,
		'a rejected GET must leave the policy disabled');

	const enabled = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: adminToken,
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: 'true' }
	});
	assert.equal(enabled.json?.code, 0, JSON.stringify(enabled.json));
	const userGuest = await guestSession(baseUrl);
	const userLogin = await login(baseUrl, 'm1f-admin-' + randomBytes(5).toString('hex') + '@sec02.test', {
		jar: userGuest.jar,
		token: userGuest.token
	});
	assert.equal(userLogin.json?.code, 0, JSON.stringify(userLogin.json));
	assert.equal(userLogin.appData?.SetupTwoFactor, true);
	assert.equal('accountHash' in userLogin.appData, false);

	const pendingAdminWrite = await request(baseUrl, '/?/admin/Json', {
		jar: userGuest.jar,
		token: userLogin.appData.System.token,
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: 'false' }
	});
	assert.notEqual(pendingAdminWrite.json?.code, 0,
		'a pending mailbox session cannot update administrator security policy');
	assert.match(await readFile(applicationConfigPath, 'utf8'), /require_two_factor_auth\s*=\s*On/i);

	const genericMalformed = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: adminToken,
		method: 'POST',
		json: { Action: 'AdminSettingsSet', config: { security: { require_two_factor_auth: 'yes' } } }
	});
	assert.notEqual(genericMalformed.json?.code, 0,
		'the generic Admin config writer must use the same strict boolean contract');

	const nativeOff = await request(baseUrl, '/?/admin/Json', {
		jar: adminGuest.jar,
		token: adminToken,
		method: 'POST',
		json: { Action: 'AdminSettingsSet', config: { security: { require_two_factor_auth: false } } }
	});
	assert.equal(nativeOff.json?.code, 0, JSON.stringify(nativeOff.json));
	await writeFile(pluginConfigPath, JSON.stringify({ plugin: { force_two_factor_auth: true } }));
	const stillOptional = await request(baseUrl, '/?/AppData', { jar: userGuest.jar });
	assert.equal(stillOptional.json?.RequireTwoFactor, false,
		'the native setting remains authoritative after migration even if stale plugin data changes');
});

test('M7-F3 real S/MIME and Admin JSON flows preserve responses without logging secret bodies', { timeout: 60000 }, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, false, null, {}, [
		'', '[logs]', 'enable = 1', 'level = 6', 'filename = "m7-f3-http.log"', 'json_response_write_limit = 0'
	]);
	if (!baseUrl) {
		return;
	}
	const email = 'log-' + randomBytes(6).toString('hex') + '@sec02.test';
	const { jar, token } = await guestSession(baseUrl);
	const authenticated = await login(baseUrl, email, { jar, token });
	assert.equal(authenticated.json?.code, 0);
	const userToken = authenticated.appData.System.token;
	const marker = randomBytes(18).toString('hex');
	const ping = await request(baseUrl, '/?/Json', { jar, token: userToken, method: 'POST',
		json: { Action: 'Ping', nested: { unclassified: marker } } });
	assert.equal(ping.json?.Result, 'Pong');
	const passphrase = randomBytes(18).toString('hex');
	const identity = await request(baseUrl, '/?/Json', { jar, token: userToken, method: 'POST',
		fields: { Action: 'SMimeCreateCertificate', name: 'Local logging fixture', email, passphrase } });
	assert.equal(identity.json?.code, 0, 'local S/MIME identity creation must succeed');
	const privateKey = identity.json?.Result?.pkey;
	assert.equal(typeof privateKey, 'string');
	const exported = await request(baseUrl, '/?/Json', { jar, token: userToken, method: 'POST',
		fields: { Action: 'SMimeExportPrivateKey', privateKey, oldPassphrase: passphrase } });
	assert.equal(exported.json?.code, 0, 'local S/MIME key export must succeed');
	assert.equal(typeof exported.json?.Result, 'string');
	const admin = await request(baseUrl, '/?/admin/Json', { jar, token: userToken, method: 'POST',
		fields: { Action: 'AdminLogin', Login: testAdminLogin, Password: testAdminPassword } });
	assert.equal(admin.json?.code, 0);
	const adminSecret = Array.from(randomBytes(20), value => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[value & 31]).join('');
	const qr = await request(baseUrl, '/?/admin/Json', { jar, token: admin.json.Result.System.token, method: 'POST',
		fields: { Action: 'AdminQRCode', username: testAdminLogin, TOTP: adminSecret } });
	assert.equal(qr.json?.code, 0);
	assert.equal(typeof qr.json?.Result, 'string');
	const qrRow = qr.json.Result.split('\n').find(row => /[█▀▄]/.test(row));
	assert.ok(qrRow, 'the actual Admin QR response must contain its rendered matrix');
	const log = await readFile(path.join(dataRoot, '_data_', '_default_', 'logs', 'm7-f3-http.log'), 'utf8');
	for (const value of [marker, passphrase, adminSecret, qrRow]) {
		assert.equal(log.includes(value), false, 'request and response material must be omitted');
	}
	for (const material of [privateKey, exported.json.Result]) {
		const fragments = material.match(/[A-Za-z0-9]{24,}/g) || [];
		assert.ok(fragments.length > 0, 'the generated key must supply unescaped data fragments');
		for (const fragment of fragments) {
			assert.equal(log.includes(fragment), false, 'generated private key data must not enter logs');
		}
	}
	for (const action of ['SMimeCreateCertificate', 'SMimeExportPrivateKey', 'AdminQRCode']) {
		assert.ok(log.includes('Action: Do' + action), 'safe action metadata must remain');
	}
	assert.ok(log.includes('[request body omitted]') && log.includes('[response body omitted]'));
});

test('optional 2FA preserves password-only login when unenrolled and verifies enable atomically when enabled', {
	timeout: process.platform === 'win32' ? 600000 : 180000
}, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, false, null, {}, [
		'',
		'[logs]',
		'enable = 1',
		'level = 6',
		'filename = "m1b-two-factor.log"',
		'json_response_write_limit = 0'
	]);
	if (!baseUrl) {
		return;
	}
	const email = 'optional-' + randomBytes(6).toString('hex') + '@sec02.test';
	let { jar, token } = await guestSession(baseUrl);
	const initialLogin = await login(baseUrl, email, { jar, token });
	assert.equal(initialLogin.json?.code, 0, JSON.stringify(initialLogin.json));
	assert.equal(initialLogin.appData?.RequireTwoFactor, false);
	assert.equal(initialLogin.appData?.SetupTwoFactor, false);
	token = initialLogin.appData.System.token;
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 0,
		'force-off unenrolled user retains ordinary mailbox API access');

	const forceEnabled = await setNativeTwoFactorPolicy(baseUrl, jar, token, true);
	assert.equal(forceEnabled.json?.code, 0, JSON.stringify(forceEnabled.json));
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 102,
		'enabling force on must restrict an older password-only session');
	const newlyRestricted = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(newlyRestricted.json?.SetupTwoFactor, true);
	assert.equal('accountHash' in newlyRestricted.json, false);
	const forceDisabled = await setNativeTwoFactorPolicy(baseUrl, jar, token, false);
	assert.equal(forceDisabled.json?.code, 0, JSON.stringify(forceDisabled.json));
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 0,
		'disabling force restores optional-mode behavior for an unenrolled session');
	const created = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorSetup');
	assert.equal(created.json?.code, 0, JSON.stringify(created.json));
	const secret = created.json.Result.Secret;
	const backupCode = created.json.Result.BackupCodes.split(/\s+/)[0];
	const setupQrCode = created.json.Result.QRCode;
	assert.ok(setupQrCode);
	const repeatedSetup = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorSetup');
	assert.equal(repeatedSetup.json?.code, 0, JSON.stringify(repeatedSetup.json));
	assert.equal(repeatedSetup.json.Result.Secret, secret, 'refreshing setup must keep the existing incomplete seed');
	const caseVariantSetup = await nativeTwoFactorAction(baseUrl, jar, token, 'twofactorSetup');
	assert.equal(caseVariantSetup.json?.code, 0, JSON.stringify(caseVariantSetup.json));
	assert.equal(caseVariantSetup.json.Result.Secret, secret,
		'PHP action dispatch is case-insensitive, so alternate casing must retain sensitive-response redaction');
	const ordinaryAppData = await request(baseUrl, '/?/AppData', { jar });
	const ordinaryAppDataText = JSON.stringify(ordinaryAppData.json);
	assert.equal(ordinaryAppDataText.includes(secret), false, 'AppData must not expose TOTP secrets');
	assert.equal(ordinaryAppDataText.includes(backupCode), false, 'AppData must not expose recovery codes');
	assert.equal(ordinaryAppDataText.includes(setupQrCode), false, 'AppData must not expose enrollment QR data');
	const setupLogPath = path.join(dataRoot, '_data_', '_default_', 'logs', 'm1b-two-factor.log');
	const setupLogBeforeCsrf = await readFile(setupLogPath, 'utf8');
	const invalidCsrf = await request(baseUrl, '/?/Json', {
		jar,
		token: 'm1b-invalid-csrf-token',
		method: 'POST',
		fields: { Action: 'TwoFactorSetup' }
	});
	assert.notEqual(invalidCsrf.json?.code, 0, 'setup must reject an invalid CSRF token');
	assert.equal(invalidCsrf.text.includes(token), false, 'CSRF errors must not expose the expected token');
	assert.equal(invalidCsrf.text.includes('m1b-invalid-csrf-token'), false,
		'CSRF errors must not expose the submitted token');
	const invalidFormCsrf = await request(baseUrl, '/?/Json', {
		jar,
		method: 'POST',
		fields: { Action: 'TwoFactorSetup', XToken: 'm1b-invalid-form-csrf-token' }
	});
	assert.notEqual(invalidFormCsrf.json?.code, 0, 'setup must reject an invalid form CSRF token');
	assert.equal(invalidFormCsrf.text.includes(token), false, 'form CSRF errors must not expose the expected token');
	assert.equal(invalidFormCsrf.text.includes('m1b-invalid-form-csrf-token'), false,
		'form CSRF errors must not expose the submitted token');
	const setupLog = await readFile(setupLogPath, 'utf8');
	const csrfFailureLog = setupLog.slice(setupLogBeforeCsrf.length);
	const safeSetupLog = [secret, setupQrCode, ...created.json.Result.BackupCodes.split(/\s+/)]
		.reduce((log, value) => value ? log.split(value).join('[redacted]') : log, setupLog);
	assert.deepEqual({
		requestBodyOmitted: setupLog.includes('[two-factor request body omitted]'),
		responseBodyOmitted: setupLog.includes('[two-factor response body omitted]'),
		setupActionLogged: setupLog.includes('DoTwoFactorSetup'),
		logLength: setupLog.length
	}, {
		requestBodyOmitted: true,
		responseBodyOmitted: true,
		setupActionLogged: true,
		logLength: setupLog.length
	}, 'two-factor action log should contain only omission markers: ' + safeSetupLog);
	assert.equal(setupLog.includes(secret), false, 'logs must not contain the TOTP secret');
	assert.equal(setupLog.includes(backupCode), false, 'logs must not contain recovery codes');
	assert.equal(setupLog.includes(setupQrCode), false, 'logs must not contain QR data');
	assert.equal(csrfFailureLog.includes(token), false, 'CSRF failures must not write the expected token to logs');
	assert.equal(csrfFailureLog.includes('m1b-invalid-csrf-token'), false,
		'CSRF failures must not write submitted token values to logs');
	assert.equal(csrfFailureLog.includes('m1b-invalid-form-csrf-token'), false,
		'form CSRF failures must not write submitted token values to logs');
	const wrongProof = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorEnable', {
		Code: wrongTotp(secret)
	});
	assert.equal(wrongProof.json?.code, 102, 'wrong TOTP must be rejected server-side');
	const withoutProof = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorEnable');
	assert.equal(withoutProof.json?.code, 102, JSON.stringify(withoutProof.json));
	const info = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorState');
	assert.equal(info.json?.Result?.Enabled, false, 'an unverified secret must remain disabled');

	const enabled = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorEnable', {
		Code: totp(secret)
	});
	assert.equal(enabled.json?.code, 0, JSON.stringify(enabled.json));
	assert.equal(enabled.json?.Result, true);
	const enabledRecord = JSON.parse(await readFile((await storedFilesNamed(dataRoot, 'two_factor'))[0], 'utf8'));
	const setupAgain = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorSetup');
	assert.equal(setupAgain.json?.code, 102, 'opening setup cannot replace an enabled factor');
	assert.deepEqual(JSON.parse(await readFile((await storedFilesNamed(dataRoot, 'two_factor'))[0], 'utf8')),
		enabledRecord, 'rejected setup must preserve the complete enabled CONFIG record');

	const requireAfterEnrollment = await setNativeTwoFactorPolicy(baseUrl, jar, token, true);
	assert.equal(requireAfterEnrollment.json?.code, 0, JSON.stringify(requireAfterEnrollment.json));
	const verifiedAppData = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(verifiedAppData.json?.Auth, true,
		'the TOTP proof that enabled the factor upgrades this session to verified');
	assert.equal(verifiedAppData.json?.SetupTwoFactor, false,
		'an enrolled account must be sent to password-plus-TOTP login, not re-enrollment');
	assert.equal('accountHash' in verifiedAppData.json, true);
	assert.equal((await settingsUpdate(baseUrl, jar, verifiedAppData.json.System.token)).json?.code, 0);
	const staleAuthCookie = jar.get('smaccount');
	const staleSessionCookie = jar.get('smsession');
	assert.ok(staleAuthCookie && staleSessionCookie, 'the factor-verified session exists before a fresh login attempt');

	const missingRefreshCode = await login(baseUrl, email, {
		jar,
		token: verifiedAppData.json.System.token
	});
	assert.equal(missingRefreshCode.json?.code, 102,
		'an enabled factor must still require TOTP on a fresh login');
	assert.equal(jar.get('smaccount'), undefined);
	assert.equal(jar.get('smsession'), staleSessionCookie,
		'the stale cookie may remain, but its authenticated server-side marker must be revoked');
	const replayJar = new CookieJar();
	replayJar.set('smaccount', staleAuthCookie);
	replayJar.set('smsession', staleSessionCookie);
	assert.notEqual((await settingsUpdate(baseUrl, replayJar, verifiedAppData.json.System.token)).json?.code, 0,
		'failed TOTP refresh must invalidate the old server-side session marker');

	let refreshGuest = await request(baseUrl, '/?/AppData', { jar });
	const wrongRefreshCode = await login(baseUrl, email, {
		jar,
		token: refreshGuest.json.System.token,
		code: wrongTotp(secret)
	});
	assert.equal(wrongRefreshCode.json?.code, 102);
	assert.equal(jar.get('smaccount'), undefined);
	assert.ok(jar.get('smsession'), 'only the unauthenticated session binding remains after a wrong factor');
	assert.equal((await request(baseUrl, '/?/AppData', { jar })).json?.Auth, false);

	refreshGuest = await request(baseUrl, '/?/AppData', { jar });
	const verifiedRefresh = await login(baseUrl, email, {
		jar,
		token: refreshGuest.json.System.token,
		code: await nextTotp(secret)
	});
	assert.equal(verifiedRefresh.json?.code, 0, JSON.stringify(verifiedRefresh.json));
	assert.equal('accountHash' in verifiedRefresh.appData, true);
	token = verifiedRefresh.appData.System.token;
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 0);

	const optionalAgain = await setNativeTwoFactorPolicy(baseUrl, jar, token, false);
	assert.equal(optionalAgain.json?.code, 0, JSON.stringify(optionalAgain.json));

	const logout = await request(baseUrl, '/?/Json', { jar, method: 'POST', fields: { Action: 'Logout' } });
	assert.equal(logout.json?.code, 0);
	const guest = await request(baseUrl, '/?/AppData', { jar });
	token = guest.json.System.token;
	const missingCode = await login(baseUrl, email, { jar, token });
	assert.equal(missingCode.json?.code, 102, JSON.stringify(missingCode.json));
	assert.equal(jar.get('smaccount'), undefined);
	assert.ok(jar.get('smsession'), 'password-only failure retains only the guest pre-auth binding');
	assert.equal((await request(baseUrl, '/?/AppData', { jar })).json?.Auth, false);
	const backupLogin = await login(baseUrl, email, { jar, token, code: backupCode });
	assert.equal(backupLogin.json?.code, 0, JSON.stringify(backupLogin.json));
	const backupLogout = await request(baseUrl, '/?/Json', {
		jar,
		method: 'POST',
		fields: { Action: 'Logout' }
	});
	assert.equal(backupLogout.json?.code, 0);
	const afterBackupGuest = await request(baseUrl, '/?/AppData', { jar });
	token = afterBackupGuest.json.System.token;
	const reusedBackup = await login(baseUrl, email, { jar, token, code: backupCode });
	assert.equal(reusedBackup.json?.code, 102, 'a consumed backup code must remain one-use');
	assert.equal(jar.get('smaccount'), undefined);
	const afterReuseGuest = await request(baseUrl, '/?/AppData', { jar });
	token = afterReuseGuest.json.System.token;
	const successfulLoginCode = await nextTotp(secret);
	const accepted = await login(baseUrl, email, { jar, token, code: successfulLoginCode });
	assert.equal(accepted.json?.code, 0, JSON.stringify(accepted.json));
	token = accepted.appData.System.token;
	assert.equal((await settingsUpdate(baseUrl, jar, token)).json?.code, 0,
		'force-off enrolled account retains TOTP-protected normal login');
	const beforeDisable = JSON.parse(await readFile((await storedFilesNamed(dataRoot, 'two_factor'))[0], 'utf8'));
	const disableWithoutCsrf = await request(baseUrl, '/?/Json', {
		jar,
		method: 'POST',
		fields: { Action: 'TwoFactorDisable' }
	});
	assert.notEqual(disableWithoutCsrf.json?.code, 0, 'disable must require the native JSON CSRF token');
	const disableViaGet = await request(baseUrl, '/?/Json/unused/TwoFactorDisable', {
		jar,
		method: 'GET'
	});
	assert.equal(disableViaGet.json?.code, 102, 'disable must reject GET dispatch');
	const disabled = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorDisable');
	assert.equal(disabled.json?.code, 0, JSON.stringify(disabled.json));
	const afterDisable = JSON.parse(await readFile((await storedFilesNamed(dataRoot, 'two_factor'))[0], 'utf8'));
	assert.equal(afterDisable.Enable, false);
	assert.equal(afterDisable.Secret, beforeDisable.Secret, 'disable must preserve the working secret');
	assert.equal(afterDisable.BackupCodes, beforeDisable.BackupCodes, 'disable must preserve unused recovery codes');
	assert.notEqual(afterDisable.FactorGeneration, beforeDisable.FactorGeneration,
		'disabling a factor rotates the security generation');
	assert.equal(afterDisable.TotpGeneration, beforeDisable.TotpGeneration,
		'disabling the same secret preserves its TOTP replay domain');
	assert.equal(afterDisable.LastTotpCounter, beforeDisable.LastTotpCounter,
		'disabling the same secret preserves the consumed TOTP counter');
	const disabledState = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorState');
	assert.equal(disabledState.json?.Result?.Status, 'disabled');
	const reenabled = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorEnable', {
		Code: await nextTotp(secret)
	});
	assert.equal(reenabled.json?.code, 0, JSON.stringify(reenabled.json));
	const afterReenable = JSON.parse(await readFile((await storedFilesNamed(dataRoot, 'two_factor'))[0], 'utf8'));
	assert.notEqual(afterReenable.FactorGeneration, afterDisable.FactorGeneration,
		're-enabling a factor rotates the session assurance generation again');
	assert.equal(afterReenable.TotpGeneration, afterDisable.TotpGeneration,
		're-enabling the same secret preserves its TOTP replay domain');
	assert.ok(afterReenable.LastTotpCounter > afterDisable.LastTotpCounter,
		're-enabling consumes a strictly newer TOTP time step');
	const clear = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorClear');
	assert.equal(clear.json?.code, 0, JSON.stringify(clear.json));
	const absentState = await nativeTwoFactorAction(baseUrl, jar, token, 'TwoFactorState');
	assert.equal(absentState.json?.Result?.Status, 'missing');
	const completeLog = await readFile(setupLogPath, 'utf8');
	assert.equal(completeLog.includes(successfulLoginCode), false, 'plugin login TOTP must be redacted from logs');
	assert.equal(completeLog.includes(backupCode), false, 'login recovery codes must not be written to logs');
	assert.equal(completeLog.includes(secret), false, 'the persisted TOTP secret must not be written to logs');
	assert.ok(completeLog.includes('Action: DoLogin'), 'safe login action metadata must remain');
	assert.match(completeLog, /serviceactions\.php/i, 'argument-free call-stack locations must remain');
});

test('message read delay defaults to 2 while preserving account and server values', {
	timeout: process.platform === 'win32' ? 120000 : 60000
}, async t => {
	const { baseUrl, dataRoot } = await createEnvironment(t, false);
	if (!baseUrl) {
		return;
	}

	const email = 'message-delay-' + randomBytes(6).toString('hex') + '@sec02.test';
	const { jar, token: guestToken } = await guestSession(baseUrl);
	const loginResult = await login(baseUrl, email, { jar, token: guestToken });
	assert.equal(loginResult.json?.code, 0, JSON.stringify(loginResult.json));

	let appData = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(appData.json?.Auth, true);
	assert.equal(appData.json?.MessageReadDelay, 2,
		'an account with no persisted personal value should receive the new default');
	for (const settingsPath of await storedFilesNamed(dataRoot, 'settings')) {
		const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
		assert.equal(Object.hasOwn(settings, 'MessageReadDelay'), false,
			'reading the new default must not persist a personal value');
	}
	const token = appData.json.System.token;

	for (const value of [7, 5, 0, 1, 2]) {
		const saved = await updateSettings(baseUrl, jar, token, { MessageReadDelay: String(value) });
		assert.equal(saved.json?.code, 0, JSON.stringify(saved.json));
		appData = await request(baseUrl, '/?/AppData', { jar });
		assert.equal(appData.json?.MessageReadDelay, value,
			`an explicitly persisted value of ${value} should remain unchanged`);
	}

	const overrideEnvironment = await createEnvironment(t, false, 4);
	if (!overrideEnvironment.baseUrl) {
		return;
	}
	const overrideEmail = 'message-delay-override-' + randomBytes(6).toString('hex') + '@sec02.test';
	const overrideGuest = await guestSession(overrideEnvironment.baseUrl);
	const overrideLogin = await login(overrideEnvironment.baseUrl, overrideEmail, {
		jar: overrideGuest.jar,
		token: overrideGuest.token
	});
	assert.equal(overrideLogin.json?.code, 0, JSON.stringify(overrideLogin.json));
	appData = await request(overrideEnvironment.baseUrl, '/?/AppData', { jar: overrideGuest.jar });
	assert.equal(appData.json?.MessageReadDelay, 4,
		'an explicit server configuration value should continue to override the code default');
	const overrideToken = appData.json.System.token;
	const savedOverrideAccountValue = await updateSettings(overrideEnvironment.baseUrl, overrideGuest.jar,
		overrideToken, { MessageReadDelay: '7' });
	assert.equal(savedOverrideAccountValue.json?.code, 0, JSON.stringify(savedOverrideAccountValue.json));
	appData = await request(overrideEnvironment.baseUrl, '/?/AppData', { jar: overrideGuest.jar });
	assert.equal(appData.json?.MessageReadDelay, 7,
		'a persisted personal value should retain its existing precedence over server configuration');
});
