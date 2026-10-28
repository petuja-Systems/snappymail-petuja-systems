import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const testHeaders = {
	'Accept': 'application/json',
	'Sec-Fetch-Dest': 'empty',
	'Sec-Fetch-Mode': 'cors',
	'Sec-Fetch-Site': 'same-origin'
};

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

async function startPhpServer(t, dataRoot, fixtureSecret, pluginSentinelPath) {
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
	const routerPath = path.join(repositoryRoot, 'tests', 'fixtures', 'proxy-auth-router.php');
	const child = spawn(phpBinary, ['-d', 'display_errors=0', '-S', '127.0.0.1:' + port, '-t', repositoryRoot, routerPath], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PETUJA_TEST_DATA_PATH: dataRoot,
			PETUJA_TEST_FIXTURE_SECRET: fixtureSecret,
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
			const response = await fetch(baseUrl + '/?/AppData', { headers: testHeaders });
			if (response.ok) {
				return { baseUrl, phpOutput: () => output };
			}
		} catch {
			// Wait for the local PHP server to bind.
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('PHP test server did not start:\n' + output);
}

async function fixtureRequest(baseUrl, fixtureSecret, route) {
	const response = await fetch(baseUrl + route, {
		headers: { ...testHeaders, 'X-Test-Fixture-Secret': fixtureSecret }
	});
	const text = await response.text();
	assert.equal(response.ok, true, 'fixture route failed: ' + text.slice(0, 300));
	return JSON.parse(text);
}

test('stale proxy-auth plugin routes cannot authenticate or execute', async t => {
	const phpModules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8' });
	assert.equal(phpModules.status, 0, 'PHP CLI is unavailable: ' + phpModules.stderr);
	for (const moduleName of ['intl', 'mbstring', 'openssl']) {
		assert.match(phpModules.stdout, new RegExp('^' + moduleName + '$', 'im'), 'PHP extension is unavailable: ' + moduleName);
	}

	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-m3b-plugin-inert-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configRoot = path.join(privateRoot, 'configs');
	const pluginRoot = path.join(privateRoot, 'plugins', 'proxy-auth');
	const domainRoot = path.join(privateRoot, 'domains');
	const pluginSentinelPath = path.join(temporaryRoot, 'plugin-executed');
	const fixtureSecret = randomBytes(32).toString('hex');
	await Promise.all([
		mkdir(configRoot, { recursive: true }),
		mkdir(path.join(privateRoot, 'cache'), { recursive: true }),
		mkdir(domainRoot, { recursive: true }),
		mkdir(pluginRoot, { recursive: true })
	]);
	await writeFile(path.join(pluginRoot, 'index.php'), [
		'<?php',
		'@file_put_contents((string) getenv("PETUJA_TEST_PLUGIN_SENTINEL"), "included");',
		'class ProxyAuthPlugin extends \\RainLoop\\Plugins\\AbstractPlugin {',
		'\tpublic function Init() : void { $this->addPartHook("ProxyAuth", function() { exit("unexpected"); }); }',
	'}'
	].join('\n'));
	await writeFile(path.join(configRoot, 'plugin-proxy-auth.json'), JSON.stringify({
		plugin: { master_user: 'fixture-only', master_password: 'fixture-only' }
	}));
	const domain = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = 9;
	domain.IMAP.type = 0;
	await writeFile(path.join(domainRoot, 'example.test.json'), JSON.stringify(domain));
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[version]',
		'two_factor_policy_migration = 1',
		'',
		'[plugins]',
		'enable = On',
		'enabled_list = "proxy-auth"',
		'',
		'[security]',
		'require_two_factor_auth = Off',
		'',
		'[login]',
		'default_domain = "example.test"',
		''
	].join('\n'));

	const server = await startPhpServer(t, dataRoot, fixtureSecret, pluginSentinelPath);
	if (!server) {
		return;
	}
	const state = await fixtureRequest(server.baseUrl, fixtureSecret, '/__test/plugin-state');
	assert.deepEqual(state, {
		plugins_enabled: false,
		enabled_list: '',
		stale_enablement_config_preserved: true,
		plugin_file_readable: true,
		plugin_config_exists: true,
		plugin_sentinel_executed: false,
		authenticated: false
	}, 'legacy enablement remains stored but is ignored, and the stale plugin is inert');

	for (const route of ['/?ProxyAuth', '/?UserHeaderSet']) {
		const response = await fetch(server.baseUrl + route, {
			headers: { ...testHeaders, 'Remote-User': 'alice', 'Client-IP': '127.0.0.1' },
			redirect: 'manual'
		});
		assert.equal(response.status, 200, route + ' falls through to the native public page');
		assert.match(response.headers.get('content-type') || '', /^text\/html\b/i);
		const html = await response.text();
		assert.doesNotMatch(html, /unexpected/);
	}

	const guestAppData = await fetch(server.baseUrl + '/?/AppData', { headers: testHeaders }).then(response => response.json());
	assert.equal(guestAppData.Auth, false);
	assert.equal(Object.hasOwn(guestAppData, 'Email'), false);
	assert.equal(await readFile(pluginSentinelPath).catch(() => null), null,
		'ordinary and plugin-only Part requests never include the stale plugin PHP');
	assert.doesNotMatch(server.phpOutput(), /Fatal error|Uncaught Error|Call to undefined method/,
		'Core requests do not call removed plugin runtime methods');
});
