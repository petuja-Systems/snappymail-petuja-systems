import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	acquireDemoRunLock,
	assertDemoRuntimeSupported,
	demoRootMarkerName,
	demoWorkspacePath,
	ensureDemoDirectories,
	prepareDemoWorkspace,
	readDemoFile,
	resetDemoWorkspace,
	writeDemoFile
} from './dev-demo-runtime.mjs';
import { prepareDemoBuild, runDemoStartup } from './dev-demo-build.mjs';
import { demoContactsConfiguration, demoContactsStatus, detectPdoSqlite } from './dev-demo-contacts.mjs';
import {
	createDemoContactsVCard, demoContacts, demoEmail, demoMessageCount, demoPassword, createDemoMailbox
} from './dev-demo-fixtures.mjs';
import { createSyntheticImapServer } from './synthetic-imap-server.mjs';
import { createSyntheticSmtpServer } from './synthetic-smtp-server.mjs';
import { runDemoAclOperation } from './dev-demo-windows.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceBase = 'win32' === process.platform ? homedir() : tmpdir();
const httpHost = '127.0.0.1';
const httpPort = Number(process.env.PETUJA_DEMO_HTTP_PORT || 8782);
const phpBinary = process.env.PHP_BINARY || 'php';
// SnappyMail's template cache key does not include template source contents.
// Advance this namespace when local demo templates change.
const demoCacheIndex = 'petuja-email-local-demo-v3';
const requiredAssets = [
	'snappymail/v/0.0.0/static/css/app.min.css',
	'snappymail/v/0.0.0/static/js/min/libs.min.js',
	'snappymail/v/0.0.0/static/js/min/app.min.js',
	'snappymail/v/0.0.0/static/images/background.jpg',
	'snappymail/v/0.0.0/static/images/petuja-systems-logo.svg',
	'snappymail/v/0.0.0/static/fonts/Rubik/Rubik-VariableFont_wght.ttf'
];

if (!Number.isSafeInteger(httpPort) || httpPort < 1024 || httpPort > 65535) {
	throw new Error('PETUJA_DEMO_HTTP_PORT must be an integer between 1024 and 65535.');
}

let workspace = null;
let releaseRunLock = null;
let imapServer = null;
let smtpServer = null;
let phpServer = null;
let buildProcess = null;
let phpSpawnError = null;
let stopping = false;
let stopRequested = false;
let ready = false;
let shutdownPromise = null;
let startupStartedAt = 0;
const maxOutboxBytes = 5 * 1024 * 1024;

function elapsedSince(start) {
	return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

function assertPhpRuntime() {
	const result = spawnSync(phpBinary, ['-m'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
	if (result.error || 0 !== result.status) {
		throw new Error('Could not run PHP CLI: ' + (result.error?.message || result.stderr || 'unknown error'));
	}
	const modules = result.stdout || '';
	const missing = ['intl', 'mbstring', 'openssl'].filter(name => !new RegExp('^' + name + '$', 'im').test(modules));
	if (missing.length) throw new Error('PHP is missing required extensions: ' + missing.join(', '));
	return detectPdoSqlite(phpBinary);
}

async function prepareWorkspace() {
	const temporaryDirectory = workspaceBase;
	let directoryPrecreated = false;
	if ('win32' === process.platform) {
		const expectedRoot = demoWorkspacePath(repositoryRoot, { temporaryDirectory, platform: process.platform });
		const result = await runDemoAclOperation('PrepareDemoRoot', expectedRoot);
		if (!['CREATED', 'EXISTS'].includes(result)) {
			throw new Error('Could not prepare the private Windows demo directory.');
		}
		directoryPrecreated = 'CREATED' === result;
	}
	workspace = await prepareDemoWorkspace(repositoryRoot, {
		temporaryDirectory,
		platform: process.platform,
		directoryPrecreated
	});
	if ('win32' === process.platform) {
		await runDemoAclOperation('VerifyDemoTree', workspace.root);
	}
	releaseRunLock = await acquireDemoRunLock(workspace);
}

async function readOutbox() {
	try {
		const value = JSON.parse((await readDemoFile(workspace, 'outbox.json', { maxBytes: maxOutboxBytes })).toString('utf8'));
		if (!Array.isArray(value) || value.some(item => !item || 'object' !== typeof item
			|| 'string' !== typeof item.raw || !Array.isArray(item.recipients))) {
			throw new Error('The local synthetic SMTP outbox has an invalid format.');
		}
		return value.slice(-250);
	} catch (error) {
		if ('ENOENT' === error.code) return [];
		throw error;
	}
}

async function writeDemoConfiguration({ imapPort, smtpPort, contactsAvailability }) {
	for (const directory of ['_data_/_default_/configs', '_data_/_default_/domains', '_data_/_default_/cache', '_data_/_default_/storage']) {
		await ensureDemoDirectories(workspace, directory);
	}
	const configs = [
		'[cache]',
		'index = "' + demoCacheIndex + '"',
		'',
		'[plugins]',
		'enable = Off',
		'',
		'[security]',
		'require_two_factor_auth = Off',
		'gnupg = Off',
		'',
		'[version]',
		'two_factor_policy_migration = 1',
		'',
		'[login]',
		'fault_delay = 0',
		''
	].join('\n');
	const applicationConfig = demoContactsConfiguration(configs, contactsAvailability);
	await writeDemoFile(workspace, '_data_/_default_/configs/application.ini', applicationConfig);

	const domain = JSON.parse(await readFile(
		path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'
	));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imapPort;
	domain.IMAP.type = 0;
	domain.SMTP.host = '127.0.0.1';
	domain.SMTP.port = smtpPort;
	domain.SMTP.type = 0;
	domain.SMTP.usePhpMail = false;
	domain.Sieve.host = '';
	domain.Sieve.enabled = false;
	await writeDemoFile(workspace, '_data_/_default_/domains/default.json', JSON.stringify(domain, null, 2) + '\n');

	const markerContents = await readFile(path.join(workspace.root, demoRootMarkerName));
	const bootstrap = [
		'<?php',
		"if (defined('PETUJA_LOCAL_DEMO_ROOT')) return;",
		"define('APP_DATA_FOLDER_PATH', __DIR__ . DIRECTORY_SEPARATOR);",
		"define('PETUJA_LOCAL_DEMO_ROOT', __DIR__);",
		"define('PETUJA_LOCAL_DEMO_MARKER_CONTENTS', hex2bin('" + markerContents.toString('hex') + "'));",
		''
	].join('\n');
	const bootstrapPath = await writeDemoFile(workspace, 'demo-bootstrap.php', bootstrap);
	return { bootstrapPath };
}

function createCookieJar() {
	const cookies = new Map();
	return {
		header() { return [...cookies].map(([name, value]) => name + '=' + value).join('; '); },
		update(response) {
			const entries = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') || '').split(/,\s*(?=[^;,\s]+=)/);
			for (const cookie of entries) {
				const [pair, ...attributes] = cookie.split(';');
				const separator = pair.indexOf('=');
				if (separator < 1) continue;
				const name = pair.slice(0, separator).trim();
				const value = pair.slice(separator + 1).trim();
				if (!value || attributes.some(item => /^max-age=0$/i.test(item.trim()))) cookies.delete(name);
				else cookies.set(name, value);
			}
		}
	};
}

async function request(baseUrl, route, { jar, token, fields, method = 'GET' } = {}) {
	const headers = {
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
		'Sec-Fetch-Dest': 'empty',
		'Sec-Fetch-Mode': 'cors',
		'Sec-Fetch-Site': 'same-origin'
	};
	if (jar?.header()) headers.Cookie = jar.header();
	if (token) headers['X-SM-Token'] = token;
	const response = await fetch(baseUrl + route, {
		method,
		headers,
		body: fields ? new URLSearchParams(fields) : undefined,
		signal: AbortSignal.timeout(10000)
	});
	jar?.update(response);
	const text = await response.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* Health check reports status and body. */ }
	if (json && undefined === json.code && Object.hasOwn(json, 'Result')) json.code = 0;
	return { response, text, json };
}

function assertHttp(response, description, body = '') {
	if (!response.ok) throw new Error(description + ' returned HTTP ' + response.status + (body ? ': ' + body.slice(0, 300) : '.'));
}

async function probeGreeting(port, prefix, description) {
	await new Promise((resolve, reject) => {
		const socket = createConnection({ host: '127.0.0.1', port });
		const timer = setTimeout(() => socket.destroy(new Error(description + ' did not send a greeting.')), 3000);
		const finish = error => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolve();
		};
		socket.once('error', finish);
		socket.once('data', chunk => {
			if (!chunk.toString('utf8').startsWith(prefix)) finish(new Error(description + ' sent an unexpected greeting.'));
			else finish();
		});
	});
}

async function seedContacts(baseUrl, account) {
	const list = await request(baseUrl, '/?/Json', {
		jar: account.jar, token: account.token, method: 'POST', fields: { Action: 'Contacts' }
	});
	assertHttp(list.response, 'Contact list self-check', list.text);
	if (list.json?.code !== 0) throw new Error('Contacts returned an API error: ' + list.text.slice(0, 300));
	const existing = JSON.stringify(list.json?.Result?.List || []);
	const missing = demoContacts.filter(contact => !existing.includes(contact.email));
	if (missing.length) {
		const vCards = createDemoContactsVCard(missing);
		const form = new FormData();
		form.append('uploader', new Blob([vCards], { type: 'text/vcard' }), 'petuja-demo-contacts.vcf');
		const headers = {
			Accept: 'application/json',
			'Sec-Fetch-Dest': 'empty',
			'Sec-Fetch-Mode': 'cors',
			'Sec-Fetch-Site': 'same-origin',
			'X-SM-Token': account.token
		};
		if (account.jar.header()) headers.Cookie = account.jar.header();
		const imported = await fetch(baseUrl + '/?/UploadContacts', {
			method: 'POST', headers, body: form, signal: AbortSignal.timeout(15000)
		});
		account.jar.update(imported);
		const text = await imported.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* Report the response body below. */ }
		if (json && undefined === json.code && Object.hasOwn(json, 'Result')) json.code = 0;
		assertHttp(imported, 'Contacts fixture import', text);
		if (json?.code !== 0 || Number(json?.Result) < missing.length) {
			throw new Error('Could not import the synthetic Contacts fixtures: ' + text.slice(0, 300));
		}
	}
	const finalList = await request(baseUrl, '/?/Json', {
		jar: account.jar, token: account.token, method: 'POST', fields: { Action: 'Contacts' }
	});
	const savedContacts = JSON.stringify(finalList.json?.Result?.List || []);
	if (finalList.json?.code !== 0 || finalList.json?.Result?.Count < demoContacts.length
		|| demoContacts.some(contact => !savedContacts.includes(contact.email))) {
		throw new Error('Contacts self-check did not find the seeded synthetic contacts.');
	}
	return finalList.json.Result.Count;
}

async function seedIdentity(baseUrl, account) {
	const response = await request(baseUrl, '/?/Json', {
		jar: account.jar, token: account.token, method: 'POST', fields: {
			Action: 'IdentityUpdate',
			Email: demoEmail,
			Name: 'petuja.email Demo Team'
		}
	});
	assertHttp(response.response, 'Demo identity self-check', response.text);
	if (response.json?.code !== 0 || response.json?.Result !== true) {
		throw new Error('Could not seed the local demo sender identity: ' + response.text.slice(0, 300));
	}
}

async function verifyApplication(baseUrl, contactsAvailability) {
	const page = await fetch(baseUrl + '/', { signal: AbortSignal.timeout(10000) });
	assertHttp(page, 'Application shell');
	const markup = await page.text();
	const metadata = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/petuja-product.json'), 'utf8'));
	const staticPrefix = 'snappymail/v/0.0.0/static/petuja-email-' + metadata.version + '/';
	if (!markup.includes(staticPrefix)) {
		throw new Error('Application shell does not reference the local SnappyMail assets.');
	}
	for (const asset of requiredAssets) {
		const publicAsset = asset.replace('snappymail/v/0.0.0/static/', staticPrefix);
		const response = await fetch(baseUrl + '/' + publicAsset, { signal: AbortSignal.timeout(10000) });
		assertHttp(response, 'Required asset ' + asset);
		if (!(await response.arrayBuffer()).byteLength) {
			throw new Error('Required asset is empty: ' + asset);
		}
	}

	const jar = createCookieJar();
	const guest = await request(baseUrl, '/?/AppData', { jar });
	assertHttp(guest.response, 'Guest AppData self-check', guest.text);
	if (guest.json?.System?.webStaticPath !== '/' + staticPrefix
		|| guest.json?.StaticLibsJs !== '/' + staticPrefix + 'js/min/libs.min.js') {
		throw new Error('Guest AppData does not use the product-versioned static tree.');
	}
	const guestToken = guest.json?.System?.token;
	if ('string' !== typeof guestToken || !guestToken.startsWith('0-')) {
		throw new Error('Guest AppData did not return the expected local login token.');
	}
	const login = await request(baseUrl, '/?/Json', {
		jar, token: guestToken, method: 'POST',
		fields: { Action: 'Login', Email: demoEmail, Password: demoPassword, signMe: '0' }
	});
	assertHttp(login.response, 'Demo login self-check', login.text);
	if (login.json?.code !== 0 || login.json?.Result?.Auth !== true || !login.json?.Result?.System?.token) {
		throw new Error('The deterministic demo account could not log in: ' + login.text.slice(0, 500));
	}
	const account = { jar, token: login.json.Result.System.token };
	if (!imapServer.logins.includes(demoEmail)) {
		throw new Error('The successful login did not authenticate against the local synthetic IMAP service.');
	}
	await seedIdentity(baseUrl, account);
	let contactCount = 0;
	if (contactsAvailability.available) contactCount = await seedContacts(baseUrl, account);
	const logout = await request(baseUrl, '/?/Json', {
		jar, token: account.token, method: 'POST', fields: { Action: 'Logout' }
	});
	assertHttp(logout.response, 'Demo logout self-check', logout.text);
	if (logout.json?.Result !== true) throw new Error('The startup self-check could not close its authenticated demo session.');
	return { contactCount, htmlBytes: Buffer.byteLength(markup) };
}

async function waitForPhp(child, baseUrl) {
	const deadline = Date.now() + 12000;
	let lastError = '';
	while (Date.now() < deadline) {
		if (phpSpawnError) throw new Error('Could not start PHP: ' + phpSpawnError.message);
		if (null !== child.exitCode || null !== child.signalCode) {
			throw new Error('PHP development server exited before becoming ready. Check whether port ' + httpPort + ' is occupied.');
		}
		try {
			const response = await fetch(baseUrl + '/?/AppData', { signal: AbortSignal.timeout(2000) });
			if (response.ok) {
				const appData = await response.json();
				if (appData?.System?.token) return;
				lastError = 'guest AppData did not contain a login token';
			} else lastError = 'HTTP ' + response.status;
		} catch (error) { lastError = error.message; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error('PHP development server did not become ready: ' + lastError);
}

function waitForExit(child, milliseconds) {
	if (!child || null !== child.exitCode || null !== child.signalCode || !child.pid) return Promise.resolve(true);
	return new Promise(resolve => {
		const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, milliseconds);
		function onExit() { clearTimeout(timer); resolve(true); }
		child.once('exit', onExit);
	});
}

async function stopChild(child) {
	if (!child || null !== child.exitCode || null !== child.signalCode || !child.pid) return;
	child.kill('SIGTERM');
	if (!await waitForExit(child, 3000)) {
		child.kill('SIGKILL');
		await waitForExit(child, 3000);
	}
}

async function shutdown(signal) {
	if (shutdownPromise) return shutdownPromise;
	stopping = true;
	shutdownPromise = (async () => {
		await stopChild(buildProcess);
		await stopChild(phpServer);
		if (imapServer) await imapServer.close();
		if (smtpServer) await smtpServer.close();
		if (releaseRunLock) {
			await releaseRunLock();
			releaseRunLock = null;
		}
		if (ready) process.stdout.write('\nStopped petuja.email local demo' + (signal ? ' (' + signal + ')' : '') + '.\n');
		else if (signal) process.stdout.write('\nStopped petuja.email local demo during startup (' + signal + ').\n');
	})();
	return shutdownPromise;
}

async function resetDemo() {
	const removed = await resetDemoWorkspace(repositoryRoot, {
		temporaryDirectory: workspaceBase,
		platform: process.platform,
		beforeRemove: async current => {
			if ('win32' === process.platform) await runDemoAclOperation('VerifyDemoTree', current.root);
		}
	});
	process.stdout.write(removed ? 'Reset the marked synthetic local demo workspace.\n' : 'No marked local demo workspace to reset.\n');
}

async function startDemo() {
	startupStartedAt = process.hrtime.bigint();
	await assertDemoRuntimeSupported(repositoryRoot);
	await prepareWorkspace();
	const buildStartedAt = process.hrtime.bigint();
	let buildElapsedMs = 0;
	let buildResult;
	let contactsAvailability;
	await runDemoStartup({
		prepareBuild: async () => {
			buildResult = await prepareDemoBuild({
				repositoryRoot,
				workspace,
				onProcess: child => { buildProcess = child; }
			});
			buildElapsedMs = elapsedSince(buildStartedAt);
		},
		isStopping: () => stopping,
		assertRuntime: async () => { contactsAvailability = assertPhpRuntime(); },
		startServices: async () => {
			const mailbox = createDemoMailbox();
			imapServer = createSyntheticImapServer({
				expectedUsername: demoEmail,
				expectedPassword: demoPassword,
				greeting: 'petuja.email local deterministic demo mailbox',
				mailbox
			});
			const imapPort = await imapServer.listen();
			let outbox = await readOutbox();
			smtpServer = createSyntheticSmtpServer({
				onMessage: async message => {
					const nextOutbox = [...outbox, { ...message, receivedAt: new Date().toISOString() }].slice(-250);
					const contents = JSON.stringify(nextOutbox) + '\n';
					if (Buffer.byteLength(contents) > maxOutboxBytes) {
						throw new Error('The local demo outbox reached its size limit.');
					}
					await writeDemoFile(workspace, 'outbox.json', contents);
					outbox = nextOutbox;
				}
			});
			const smtpPort = await smtpServer.listen();
			if (stopping) throw new Error('Local demo startup was interrupted.');
			const { bootstrapPath } = await writeDemoConfiguration({ imapPort, smtpPort, contactsAvailability });
			if ('win32' === process.platform) await runDemoAclOperation('VerifyDemoTree', workspace.root);
			const baseUrl = 'http://' + httpHost + ':' + httpPort;
			phpServer = spawn(phpBinary, [
				'-d', 'display_errors=0',
				'-d', 'auto_prepend_file=' + bootstrapPath,
				'-S', httpHost + ':' + httpPort,
				'-t', repositoryRoot,
				path.join(repositoryRoot, 'scripts/dev-demo-router.php')
			], {
				cwd: repositoryRoot,
				env: process.env,
				stdio: 'inherit',
				windowsHide: true
			});
			phpServer.on('error', error => { phpSpawnError = error; });
			phpServer.once('exit', (code, signal) => {
				if (!stopping) {
					if (ready) process.stderr.write('\nPHP development server exited (' + (signal || code) + ').\n');
					else process.stderr.write('PHP development server exited during startup (' + (signal || code) + ').\n');
					void shutdown().finally(() => { process.exitCode = null === code ? 1 : code; });
				}
			});
			await waitForPhp(phpServer, baseUrl);
			await probeGreeting(imapPort, '* OK', 'Synthetic IMAP service');
			await probeGreeting(smtpPort, '220', 'Synthetic SMTP sink');
			const application = await verifyApplication(baseUrl, contactsAvailability);
			if (demoMessageCount(mailbox) !== 22) throw new Error('Synthetic mailbox fixture count does not match its reviewed 22-message set.');
			ready = true;
			process.stdout.write([
				'petuja.email local demo ready',
				'',
				'URL:       ' + baseUrl,
				'Email:     ' + demoEmail,
				'Password:  ' + demoPassword,
				'Mailbox:   22 synthetic messages in six folders',
				'SMTP:      loopback sink; outgoing mail is captured locally',
				contactsAvailability.available
					? 'Contacts:  ' + application.contactCount + ' synthetic contacts in isolated SQLite storage'
					: demoContactsStatus(contactsAvailability),
				'Build:     ' + (buildResult?.rebuilt ? 'rebuilt' : 'verified cache reused') + ' in ' + buildElapsedMs + ' ms',
				'Startup:   ' + elapsedSince(startupStartedAt) + ' ms including login, assets, and service checks',
				'Workspace: ' + workspace.root,
				'',
				'Press Ctrl+C to stop.'
			].join('\n') + '\n');
		}
	});
	if (!ready) await shutdown();
}

process.once('SIGINT', () => { stopRequested = true; void shutdown('SIGINT').finally(() => { process.exitCode = 0; }); });
process.once('SIGTERM', () => { stopRequested = true; void shutdown('SIGTERM').finally(() => { process.exitCode = 0; }); });

try {
	const argumentsList = process.argv.slice(2);
	if (argumentsList.length && ['--reset'].includes(argumentsList[0]) && argumentsList.length === 1) {
		await resetDemo();
	} else if (argumentsList.length) {
		throw new Error('Use `node scripts/dev-demo.mjs` or `node scripts/dev-demo.mjs --reset`.');
	} else {
		await startDemo();
	}
} catch (error) {
	try { await shutdown(); }
	catch (cleanupError) { process.stderr.write('Demo cleanup failed: ' + cleanupError.message + '\n'); }
	if (stopRequested) process.exitCode = 0;
	else {
		process.stderr.write('Local demo failed: ' + error.message + '\n');
		process.exitCode = 1;
	}
}
