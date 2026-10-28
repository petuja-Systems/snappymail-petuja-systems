import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const applicationRoot = path.join(repositoryRoot, 'snappymail/v/0.0.0');
const librariesRoot = path.join(applicationRoot, 'app/libraries');

test('Core bootstrap no longer defines or creates plugin package paths', async () => {
	const [include, setup] = await Promise.all([
		readFile(path.join(applicationRoot, 'include.php'), 'utf8'),
		readFile(path.join(applicationRoot, 'setup.php'), 'utf8')
	]);

	assert.doesNotMatch(include, /APP_PLUGINS_PATH|SNAPPYMAIL_UPDATE_PLUGINS|Repository::/);
	assert.doesNotMatch(setup, /APP_PLUGINS_PATH|SNAPPYMAIL_UPDATE_PLUGINS|Repository::|['"]plugins['"]/);
});

test('startup is identical when stale plugin directories are absent or present', async (t) => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'petuja-core-bootstrap-'));
	t.after(() => rm(tempRoot, { recursive: true, force: true }));

	const outcomes = [];
	const pluginStates = [
		{ name: 'plugins-absent', directory: false, loginCpanel: false, loginRemote: false },
		{ name: 'plugins-empty', directory: true, loginCpanel: false, loginRemote: false },
		{ name: 'login-cpanel', directory: true, loginCpanel: true, loginRemote: false },
		{ name: 'login-remote', directory: true, loginCpanel: false, loginRemote: true },
		{ name: 'both-login-plugins', directory: true, loginCpanel: true, loginRemote: true }
	];
	for (const state of pluginStates) {
		const name = state.name;
		const fixtureRoot = path.join(tempRoot, name);
		const dataRoot = path.join(fixtureRoot, 'data');
		const privateData = path.join(dataRoot, '_data_', '_default_');
		const pluginRoot = path.join(privateData, 'plugins');
		await mkdir(privateData, { recursive: true });
		if (state.directory) {
			await mkdir(pluginRoot, { recursive: true });
		}
		for (const [present, plugin] of [[state.loginCpanel, 'login-cpanel'], [state.loginRemote, 'login-remote']]) {
			if (present) {
				const pluginDirectory = path.join(pluginRoot, plugin);
				await mkdir(pluginDirectory, { recursive: true });
				await writeFile(path.join(pluginDirectory, 'fixture.txt'), 'persistent plugin state');
			}
		}

		const output = execFileSync('php', [
			path.join(repositoryRoot, 'tests/fixtures/core-bootstrap-router.php'),
			dataRoot,
			fixtureRoot,
			path.join(applicationRoot, 'include.php')
		], { encoding: 'utf8', cwd: repositoryRoot });
		const result = JSON.parse(output);
		assert.equal(result.ready, true, name);
		assert.equal(result.api_mode, true, name);
		assert.equal(result.installed_version, '0.0.0', name);
		assert.deepEqual(result.plugin_directories.sort(), [
			...(state.loginCpanel ? ['login-cpanel'] : []),
			...(state.loginRemote ? ['login-remote'] : [])
		].sort(), name);
		outcomes.push({ ready: result.ready, api_mode: result.api_mode, installed_version: result.installed_version });
	}

	assert.ok(outcomes.every((outcome) => JSON.stringify(outcome) === JSON.stringify(outcomes[0])),
		'presence of an old persistent plugin directory does not change Core startup results');
});

test('retained Core Autoconfig remains native after its plugin source is deleted', async () => {
	const [adminDomains, autoconfig] = await Promise.all([
		readFile(path.join(librariesRoot, 'RainLoop/Actions/AdminDomains.php'), 'utf8'),
		readFile(path.join(librariesRoot, 'RainLoop/Providers/Domain/Autoconfig.php'), 'utf8')
	]);

	assert.match(adminDomains, /DoAdminDomainAutoconfig[\s\S]*?Autoconfig::discover\(/,
		'Admin domain configuration calls retained Core Autoconfig');
	assert.match(autoconfig, /public static function discover\(/);
	assert.match(autoconfig, /file_get_contents\(/, 'native Core discovery remains identifiable for SEC-31 tracking');
	assert.doesNotMatch(autoconfig, /login\.credentials\.step-1/);
	await assert.rejects(access(path.join(repositoryRoot, 'plugins/login-autoconfig/index.php')),
		{ code: 'ENOENT' }, 'the separate legacy plugin hook source is removed');
});

test('native Core Autoconfig parses a synthetic provider response without external requests', async (t) => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'petuja-core-autoconfig-'));
	t.after(() => rm(tempRoot, { recursive: true, force: true }));
	const dataRoot = path.join(tempRoot, 'data');
	const privateData = path.join(dataRoot, '_data_', '_default_');
	await mkdir(privateData, { recursive: true });
	await writeFile(path.join(dataRoot, 'INSTALLED'), '0.0.0');

	const output = execFileSync('php', [
		path.join(repositoryRoot, 'tests/fixtures/core-autoconfig-probe.php'),
		dataRoot,
		tempRoot,
		path.join(applicationRoot, 'include.php')
	], { encoding: 'utf8', cwd: repositoryRoot });
	const result = JSON.parse(output);
	assert.equal(result.requests.length, 1, 'the first native discovery target returns the local fixture response');
	assert.match(result.requests[0], /^https:\/\/autoconfig\.example\.test\//);
	assert.equal(result.config.incomingServer[0].hostname, 'imap.example.test');
	assert.equal(result.config.outgoingServer[0].hostname, 'smtp.example.test');
});
