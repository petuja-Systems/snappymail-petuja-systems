import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPrivateTestTempRoot } from './fixtures/private-test-temp.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const testTemporaryRoot = await createPrivateTestTempRoot(test, 'protocol-provider');
const imapPassword = randomBytes(18).toString('hex');
const smtpPassword = randomBytes(18).toString('hex');

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return server.address().port;
}

async function reserveLocalPort() {
	const server = createServer();
	const port = await listen(server);
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

function parseImapArgs(raw) {
	return [...raw.matchAll(/"((?:[^"]|"")*)"|(\S+)/g)]
		.map(item => (item[1] ?? item[2]).replace(/""/g, '"'));
}

async function startImapServer(t) {
	const logins = [];
	const sockets = new Set();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.write('* OK [CAPABILITY IMAP4rev1 LOGIN] M3A isolated fixture\r\n');
		let pending = '';
		socket.on('data', chunk => {
			pending += chunk.toString('utf8');
			while (pending.includes('\n')) {
				const end = pending.indexOf('\n');
				const line = pending.slice(0, end).replace(/\r$/, '');
				pending = pending.slice(end + 1);
				const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
				if (!match) continue;
				const [, tag, rawCommand, rawArgs = ''] = match;
				const command = rawCommand.toUpperCase();
				if ('CAPABILITY' === command) {
					socket.write('* CAPABILITY IMAP4rev1 LOGIN\r\n' + tag + ' OK capability\r\n');
				} else if ('LOGIN' === command) {
					const [username = '', password = ''] = parseImapArgs(rawArgs);
					logins.push({ username, password });
					const valid = (('main@example.test' === username || 'additional@example.test' === username)
						&& imapPassword === password);
					socket.write(tag + (valid ? ' OK authenticated\r\n' : ' NO invalid fixture credentials\r\n'));
				} else if ('LOGOUT' === command) {
					socket.write('* BYE fixture logout\r\n' + tag + ' OK logout\r\n');
				} else {
					socket.write(tag + ' OK fixture\r\n');
				}
			}
		});
		socket.on('error', () => {});
	});
	const port = await listen(server);
	t.after(() => new Promise(resolve => {
		for (const socket of sockets) socket.destroy();
		server.close(() => resolve());
	}));
	return { port, logins, server };
}

function decodePlain(token) {
	const fields = Buffer.from(token, 'base64').toString('utf8').split('\0');
	return { username: fields.at(-2) || '', password: fields.at(-1) || '' };
}

async function startSmtpServer(t) {
	const logins = [];
	const messages = [];
	const sockets = new Set();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.write('220 m3a-fixture ESMTP ready\r\n');
		let pending = '';
		let authContinuation = false;
		let dataLines = null;
		const respond = line => socket.write(line + '\r\n');
		const handleLine = line => {
			if (null !== dataLines) {
				if ('.' === line) {
					messages.push(dataLines.join('\r\n'));
					dataLines = null;
					respond('250 2.0.0 queued');
				} else {
					dataLines.push(line.startsWith('..') ? line.slice(1) : line);
				}
				return;
			}
			if (authContinuation) {
				logins.push(decodePlain(line));
				authContinuation = false;
				respond('235 2.7.0 authenticated');
				return;
			}
			const [command = '', ...args] = line.split(' ');
			switch (command.toUpperCase()) {
				case 'EHLO':
				case 'HELO':
					socket.write('250-m3a-fixture\r\n250-AUTH PLAIN\r\n250 SIZE 1000000\r\n');
					break;
				case 'AUTH': {
					const token = args[1];
					if (token) {
						logins.push(decodePlain(token));
						respond('235 2.7.0 authenticated');
					} else {
						authContinuation = true;
						respond('334 ');
					}
					break;
				}
				case 'MAIL':
				case 'RCPT':
				case 'RSET':
					respond('250 2.1.0 accepted');
					break;
				case 'DATA':
					dataLines = [];
					respond('354 end with <CRLF>.<CRLF>');
					break;
				case 'QUIT':
					respond('221 2.0.0 bye');
					break;
				default:
					respond('250 2.0.0 ok');
			}
		};
		socket.on('data', chunk => {
			pending += chunk.toString('utf8');
			while (pending.includes('\n')) {
				const end = pending.indexOf('\n');
				const line = pending.slice(0, end).replace(/\r$/, '');
				pending = pending.slice(end + 1);
				handleLine(line);
			}
		});
	});
	await listen(server);
	t.after(() => new Promise(resolve => {
		for (const socket of sockets) socket.destroy();
		server.close(() => resolve());
	}));
	return { port: server.address().port, logins, messages };
}

async function startSieveServer(t) {
	const logins = [];
	const scripts = new Map();
	const sockets = new Set();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.write('"IMPLEMENTATION" "M3A fixture"\r\n"SASL" "PLAIN"\r\n"SIEVE" "fileinto vacation"\r\nOK "ready"\r\n');
		let pending = '';
		let authContinuation = false;
		let pendingPut = '';
		let activeScript = '';
		const respond = line => socket.write(line + '\r\n');
		const handleLine = line => {
			if (authContinuation) {
				logins.push(decodePlain(line));
				authContinuation = false;
				respond('OK "authenticated"');
				return;
			}
			if (pendingPut) {
				scripts.set(pendingPut, line);
				pendingPut = '';
				respond('OK "stored"');
				return;
			}
			if (/^AUTHENTICATE\s+"PLAIN"(?:\s+\{\d+\+\})?$/i.test(line)) {
				authContinuation = true;
				return;
			}
			if (/^LISTSCRIPTS$/i.test(line)) {
				for (const name of scripts.keys()) {
					respond('"' + name + '"' + (name === activeScript ? ' ACTIVE' : ''));
				}
				respond('OK "listed"');
			} else if ((pendingPut = line.match(/^PUTSCRIPT\s+"([^"]+)"\s+\{\d+\+\}$/i)?.[1] || '')) {
				// The script body arrives as the next protocol line.
			} else if ((line.match(/^SETACTIVE\s+"([^"]*)"$/i))) {
				activeScript = line.match(/^SETACTIVE\s+"([^"]*)"$/i)[1];
				respond('OK "active"');
			} else if ((line.match(/^DELETESCRIPT\s+"([^"]+)"$/i))) {
				const name = line.match(/^DELETESCRIPT\s+"([^"]+)"$/i)[1];
				scripts.delete(name);
				if (activeScript === name) activeScript = '';
				respond('OK "deleted"');
			} else if (/^LOGOUT$/i.test(line)) {
				respond('OK "bye"');
			} else if (/^CAPABILITY$/i.test(line)) {
				respond('"IMPLEMENTATION" "M3A fixture"');
				respond('"SASL" "PLAIN"');
				respond('"SIEVE" "fileinto vacation"');
				respond('OK "capability"');
			} else {
				respond('OK "ok"');
			}
		};
		socket.on('data', chunk => {
			pending += chunk.toString('utf8');
			while (pending.includes('\n')) {
				const end = pending.indexOf('\n');
				const line = pending.slice(0, end).replace(/\r$/, '');
				pending = pending.slice(end + 1);
				handleLine(line);
			}
		});
	});
	await listen(server);
	t.after(() => new Promise(resolve => {
		for (const socket of sockets) socket.destroy();
		server.close(() => resolve());
	}));
	return { port: server.address().port, logins, scripts };
}

async function startPhpServer(t, { dataRoot, fixtureSecret, pluginSentinelPath }) {
	const modules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8' });
	assert.equal(modules.status, 0, 'PHP CLI is unavailable: ' + modules.stderr);
	for (const name of ['intl', 'mbstring', 'openssl']) {
		assert.match(modules.stdout, new RegExp('^' + name + '$', 'im'), 'PHP extension is unavailable: ' + name);
	}

	const port = await reserveLocalPort();
	const routerPath = path.join(repositoryRoot, 'tests', 'fixtures', 'protocol-provider-router.php');
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
			PETUJA_TEST_FIXTURE_SECRET: fixtureSecret,
			PETUJA_TEST_IMAP_PASSWORD: imapPassword,
			PETUJA_TEST_SMTP_PASSWORD: smtpPassword,
			PETUJA_TEST_PLUGIN_SENTINEL: pluginSentinelPath
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
			const response = await fetch(baseUrl + '/__test/ready');
			if (404 === response.status) {
				return { baseUrl, output: () => output };
			}
		} catch {
			// Wait for the loopback PHP server to bind.
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('PHP test server did not start:\n' + output);
}

test('retained protocol, account, domain, and provider callers do not depend on generic plugin hooks', async () => {
	const [account, actions, auth, messages, sieveStorage, domain] = await Promise.all([
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Model/Account.php'), 'utf8'),
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php'), 'utf8'),
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/UserAuth.php'), 'utf8'),
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php'), 'utf8'),
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Providers/Filters/SieveStorage.php'), 'utf8'),
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Providers/Domain.php'), 'utf8')
	]);
	assert.doesNotMatch(account, /Plugins\\Manager|RunHook|filter\.account|(?:imap|smtp|sieve)\.(?:before|after)-(?:connect|login)/);
	assert.match(account, /function ImapConnectAndLogin\(\\MailSo\\Imap\\ImapClient \$oImapClient, \\RainLoop\\Config\\Application \$oConfig\)/);
	assert.match(account, /function SmtpConnectAndLogin\(\\MailSo\\Smtp\\SmtpClient \$oSmtpClient\)/);
	assert.match(account, /function SieveConnectAndLogin\(\\MailSo\\Sieve\\SieveClient \$oSieveClient\)/);
	assert.doesNotMatch(auth, /filter\.account/);
	assert.doesNotMatch(actions, /filter\.application-config|main\.fabrica|filter\.fabrica/);
	assert.doesNotMatch(messages, /SmtpConnectAndLogin\(\$this->Plugins\(\)/);
	assert.doesNotMatch(sieveStorage, /Plugins|Manager|oConfig|SieveConnectAndLogin\([^)]*,/);
	assert.doesNotMatch(domain, /Plugins|Manager|filter\.domain/);
});

test('native mail and Sieve flows preserve configured credentials while stale plugin code stays inert', { timeout: 120000 }, async t => {
	const temporaryRoot = await mkdtemp(path.join(testTemporaryRoot, 'petuja-m3a-protocol-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const domainsRoot = path.join(privateRoot, 'domains');
	const configRoot = path.join(privateRoot, 'configs');
	const pluginsRoot = path.join(privateRoot, 'plugins');
	const logsRoot = path.join(privateRoot, 'logs');
	const pluginSentinelPath = path.join(temporaryRoot, 'stale-plugin-included');
	await Promise.all([
		mkdir(domainsRoot, { recursive: true }),
		mkdir(configRoot, { recursive: true }),
		mkdir(pluginsRoot, { recursive: true }),
		mkdir(logsRoot, { recursive: true })
	]);

	const imap = await startImapServer(t);
	const smtp = await startSmtpServer(t);
	const sieve = await startSieveServer(t);
	const pluginName = 'm3a-protocol-provider-disentanglement';
	await cp(
		path.join(repositoryRoot, 'tests/fixtures/protocol-provider-disentanglement-plugin'),
		path.join(pluginsRoot, pluginName),
		{ recursive: true }
	);

	const domain = JSON.parse(await readFile(
		path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'
	));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imap.port;
	domain.IMAP.type = 0;
	domain.IMAP.timeout = 7;
	domain.SMTP.host = '127.0.0.1';
	domain.SMTP.port = smtp.port;
	domain.SMTP.type = 0;
	domain.SMTP.useAuth = true;
	domain.SMTP.usePhpMail = false;
	domain.SMTP.sasl = ['PLAIN'];
	domain.Sieve.enabled = true;
	domain.Sieve.host = '127.0.0.1';
	domain.Sieve.port = sieve.port;
	domain.Sieve.type = 0;
	domain.Sieve.sasl = ['PLAIN'];
	await writeFile(path.join(domainsRoot, 'example.test.json'), JSON.stringify(domain));
	await writeFile(path.join(domainsRoot, '_wildcard_.wild.test.json'), JSON.stringify(domain));
	await writeFile(
		path.join(configRoot, 'application.ini'), [
			'[plugins]',
			'enable = 1',
			'enabled_list = "' + pluginName + '"',
			'',
			'[imap]',
		'message_all_headers = On',
			'',
			'[logs]',
			'enable = 1',
			'level = 7',
			'filename = "m3a-protocol.log"',
			'path = "' + logsRoot.replaceAll('\\', '/') + '"',
			'hide_passwords = On',
			''
		].join('\n')
	);

	const fixtureSecret = randomBytes(24).toString('hex');
	const { baseUrl, output } = await startPhpServer(t, { dataRoot, fixtureSecret, pluginSentinelPath });
	const response = await fetch(baseUrl + '/__test/protocol-provider', {
		headers: { 'X-Test-Fixture-Secret': fixtureSecret }
	});
	const body = await response.text();
	assert.equal(response.status, 200, 'isolated protocol fixture failed: ' + body.slice(0, 300) + output());
	const result = JSON.parse(body);

	assert.equal(await readFile(pluginSentinelPath).catch(() => null), null,
		'a stale enabled plugin entrypoint must not be included during native protocol operations');
	assert.equal(result.domain_provider, 'RainLoop\\Providers\\Domain');
	assert.equal(result.domain, 'example.test');
	assert.equal(result.wildcard_domain, '*.wild.test',
		'native wildcard-domain validation continues to resolve configured wildcard domains');
	assert.deepEqual(result.domain_hosts, {
		imap: '127.0.0.1',
		smtp: '127.0.0.1',
		sieve: '127.0.0.1'
	});
	assert.deepEqual(result.main_account, {
		class: 'RainLoop\\Model\\MainAccount',
		email: 'main@example.test',
		imap_user: 'main@example.test',
		smtp_user: 'main@example.test',
		password_sensitive: true,
		password_matches: true
	});
	assert.deepEqual(result.identities, {
		provider: 'RainLoop\\Providers\\Identities',
		primary_email: 'main@example.test'
	});
	assert.deepEqual(result.additional_account, {
		class: 'RainLoop\\Model\\AdditionalAccount',
		email: 'additional@example.test',
		imap_user: 'additional@example.test',
		imap_login: true,
		password_sensitive: true,
		password_matches: true
	});
	assert.equal(result.imap_timeout, 7, 'the domain IMAP timeout must remain in effect');
	assert.equal(result.imap_message_all_headers, true, 'native IMAP config overlays must remain applied');
	assert.equal(result.smtp.send_result, true, 'the normal SMTP send action should succeed');
	assert.equal(result.smtp.explicit_login, true, 'explicit SMTP credentials should still authenticate');
	assert.equal(result.smtp.password_sensitive, true);
	assert.ok(Array.isArray(result.sieve.load_result.Capa));
	assert.ok(result.sieve.load_result.Capa.includes('fileinto'));
	assert.ok(result.sieve.load_result.Scripts['rainloop.user']);
	assert.equal(result.sieve.save_result, true);
	assert.equal(result.sieve.activate_result, true);
	assert.equal(result.sieve.delete_result, true);
	assert.equal(result.sieve.password_sensitive, true);

	assert.deepEqual(imap.logins.map(({ username }) => username), [
		'main@example.test',
		'additional@example.test',
		'additional@example.test'
	]);
	assert.ok(imap.logins.every(({ password }) => imapPassword === password));
	assert.deepEqual(smtp.logins, [
		{ username: 'main@example.test', password: imapPassword },
		{ username: 'explicit-smtp-user', password: smtpPassword }
	]);
	assert.equal(smtp.messages.length, 1, 'one message should pass through the native SMTP send path');
	assert.match(smtp.messages[0], /synthetic message body/);
	assert.equal(sieve.logins.length, 4, 'Load, Save, Activate, and Delete each use native Sieve authentication');
	assert.ok(sieve.logins.every(({ username, password }) => 'main@example.test' === username && imapPassword === password));
	assert.equal(sieve.scripts.size, 0, 'the Sieve storage fixture should complete its save/activate/delete cycle');

	const hookMarker = path.join(privateRoot, 'm3a-hook-calls.log');
	await assert.rejects(readFile(hookMarker, 'utf8'), { code: 'ENOENT' }, 'none of the targeted generic hooks should execute');
	const logFiles = await readdir(logsRoot);
	const logs = (await Promise.all(logFiles.map(name => readFile(path.join(logsRoot, name), 'utf8')))).join('\n');
	for (const secret of [imapPassword, smtpPassword, 'plugin-password', 'unused-imap-password']) {
		assert.equal(logs.includes(secret), false, 'credentials must remain redacted from application logs');
	}
});
