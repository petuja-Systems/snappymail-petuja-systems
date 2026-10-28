import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const testSecret = 'M3A2_PUBLIC_APPDATA_SECRET_SENTINEL_7d03c2';
const testEmail = 'dev@example.invalid';
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

async function startPhpServer(t, dataRoot) {
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
		env: { ...process.env, PETUJA_TEST_DATA_PATH: dataRoot },
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
			lastProbe = error.message;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('PHP test server did not start:\n' + output + '\nLast probe: ' + lastProbe);
}

test('unauthenticated development AppData never serializes the configured password', async t => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-m3a2-appdata-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configRoot = path.join(privateRoot, 'configs');
	await Promise.all([
		mkdir(configRoot, { recursive: true }),
		mkdir(path.join(privateRoot, 'cache'), { recursive: true })
	]);
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[labs]',
		'dev_email = "' + testEmail + '"',
		'dev_password = "' + testSecret + '"',
		''
	].join('\n'));

	const baseUrl = await startPhpServer(t, dataRoot);
	if (!baseUrl) {
		return;
	}
	const response = await fetch(baseUrl + '/?/AppData', { headers: testHeaders });
	const serialized = await response.text();
	assert.equal(response.status, 200, serialized.slice(0, 300));
	assert.match(response.headers.get('content-type') || '', /application\/json/i);
	assert.equal(serialized.includes(testSecret), false,
		'the configured development password must not occur anywhere in public AppData');

	const appData = JSON.parse(serialized);
	assert.equal(appData.Auth, false, 'the request has no authentication cookie');
	assert.equal(appData.DevEmail, testEmail, 'public development email remains available');
	assert.equal(appData.DevPassword, '', 'public development password remains empty');
	assert.equal(appData.System.version, '0.0.0', 'the test exercises the development version path');
	assert.match(appData.System.token, /^0-/, 'guest AppData retains its guest CSRF token');
});
