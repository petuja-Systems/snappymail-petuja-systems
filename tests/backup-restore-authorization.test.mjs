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
const privateDataRelativePath = path.join('_data_', '_default_');
const testHeaders = {
	'Sec-Fetch-Dest': 'empty',
	'Sec-Fetch-Mode': 'cors',
	'Sec-Fetch-Site': 'same-origin'
};

class CookieJar {
	#cookies = new Map();

	header(overrides = {}) {
		const cookies = new Map(this.#cookies);
		for (const [name, value] of Object.entries(overrides)) {
			if (null === value) {
				cookies.delete(name);
			} else {
				cookies.set(name, value);
			}
		}
		return [...cookies].map(([name, value]) => name + '=' + value).join('; ');
	}

	get(name) {
		return this.#cookies.get(name);
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
			const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute.trim()));
			if (!value || expired) {
				this.#cookies.delete(name);
			} else {
				this.#cookies.set(name, value);
			}
		}
	}
}

function makeZip(zipPath, entryName, entryContents) {
	const script = '$zip = new ZipArchive(); '
		+ 'if (true !== $zip->open($argv[1], ZipArchive::CREATE | ZipArchive::OVERWRITE)) exit(2); '
		+ '$zip->addFromString($argv[2], $argv[3]); $zip->close();';
	const result = spawnSync(phpBinary, ['-r', script, zipPath, entryName, entryContents], {
		encoding: 'utf8'
	});

	assert.equal(result.status, 0, 'PHP could not create the isolated ZIP fixture: ' + result.stderr);
}

async function reserveLocalPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	await new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
	return port;
}

async function startServer(t, temporaryRoot, dataRoot, pluginSentinelPath) {
	const phpModules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8' });
	assert.equal(phpModules.status, 0, 'PHP CLI is unavailable: ' + phpModules.stderr);
	assert.match(phpModules.stdout, /^zip$/im, 'The focused integration test requires PHP ZipArchive');

	const port = await reserveLocalPort();
	const fixtureDirectory = path.join(repositoryRoot, 'tests', 'fixtures');
	const routerPath = path.join(fixtureDirectory, 'backup-restore-router.php');
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
			PETUJA_TEST_PLUGIN_SENTINEL: pluginSentinelPath
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let output = '';
	child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
	child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('exit', resolve));
		}
	});

	const baseUrl = 'http://127.0.0.1:' + port;
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (null !== child.exitCode || null !== child.signalCode) {
			assert.fail('PHP test server exited early:\n' + output);
		}
		try {
			await fetch(baseUrl + '/?/admin/AppData', { headers: testHeaders });
			return baseUrl;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	assert.fail('PHP test server did not start:\n' + output);
}

async function request(baseUrl, route, { jar, token, method = 'GET', fields, json, upload, cookieOverrides } = {}) {
	const headers = { ...testHeaders };
	const cookie = jar?.header(cookieOverrides);
	if (cookie) {
		headers.Cookie = cookie;
	}
	if (undefined !== token) {
		headers['X-SM-Token'] = token;
	}

	let body;
	if (upload) {
		body = new FormData();
		body.set('Action', fields.Action);
		body.append('backup', new Blob([upload.bytes], { type: upload.mime }), upload.name);
	} else if (json) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(json);
	} else if (fields) {
		body = new URLSearchParams(fields);
	}

	const response = await fetch(baseUrl + route, { method, headers, body });
	jar?.update(response);
	const text = await response.text();
	let responseJson;
	try {
		responseJson = JSON.parse(text);
	} catch {
		assert.fail('Expected JSON from ' + route + ', got HTTP ' + response.status + ': ' + text.slice(0, 500));
	}
	return { response, json: responseJson };
}

async function postPluginAction(baseUrl, jar, token, action, upload, cookieOverrides) {
	return request(baseUrl, '/?/admin/Json', {
		jar,
		token,
		method: 'POST',
		fields: { Action: action },
		upload,
		cookieOverrides
	});
}

function responseDiagnostic(response) {
	const { Action, code, message, messageAdditional, ExceptionCode } = response;
	return JSON.stringify({ Action, code, message, messageAdditional, ExceptionCode });
}

test('M3B keeps native admin authorization and stale plugins cannot execute or dispatch JSON actions', { timeout: 60000 }, async (t) => {
	const phpCheck = spawnSync(phpBinary, ['-r', 'exit(class_exists("ZipArchive") ? 0 : 1);']);
	if (phpCheck.error || 0 !== phpCheck.status) {
		t.skip('PHP ZipArchive is unavailable: ' + (phpCheck.error?.message || phpCheck.stderr));
		return;
	}

	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-backup-restore-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, privateDataRelativePath);
	const pluginRoot = path.join(privateRoot, 'plugins');
	const configRoot = path.join(privateRoot, 'configs');
	const stalePluginRoot = path.join(pluginRoot, 'backup');
	const markerPath = path.join(configRoot, 'restore-marker.txt');
	const pluginSentinelPath = path.join(temporaryRoot, 'stale-plugin-executed');
	const archivePath = path.join(temporaryRoot, 'benign-backup.zip');
	const testAdminLogin = 'admin-' + randomBytes(12).toString('hex');
	const testAdminPassword = randomBytes(24).toString('hex');
	const passwordHash = spawnSync(
		phpBinary,
		['-r', 'echo password_hash($argv[1], PASSWORD_DEFAULT);', testAdminPassword],
		{ encoding: 'utf8' }
	);
	assert.equal(passwordHash.status, 0, 'PHP could not create an isolated administrator password hash');

	await mkdir(pluginRoot, { recursive: true });
	await mkdir(stalePluginRoot, { recursive: true });
	await mkdir(configRoot, { recursive: true });
	await mkdir(path.join(privateRoot, 'cache'), { recursive: true });
	await writeFile(path.join(stalePluginRoot, 'index.php'), [
		'<?php',
		'@file_put_contents((string) getenv("PETUJA_TEST_PLUGIN_SENTINEL"), "included");',
		'class BackupPlugin extends \\RainLoop\\Plugins\\AbstractPlugin {',
		'\tpublic function Init() : void {',
		'\t\t$this->addJsonHook("DoPluginJsonAdminRestoreData", function() {});',
		'\t\t$this->addCss("style.css");',
		'\t\t$this->addJs("runtime.js");',
		'\t\t$this->addTemplate("InjectedPlugin.html");',
		'\t}',
		'}'
	].join('\n'));
	await mkdir(path.join(stalePluginRoot, 'lang'), { recursive: true });
	await mkdir(path.join(stalePluginRoot, 'templates'), { recursive: true });
	await writeFile(path.join(stalePluginRoot, 'style.css'), '.m3b-stale-plugin-css-sentinel { color: red; }');
	await writeFile(path.join(stalePluginRoot, 'runtime.js'), 'window.M3B_STALE_PLUGIN_JS_SENTINEL = true;');
	await writeFile(path.join(stalePluginRoot, 'lang', 'en.ini'), 'M3B_STALE_PLUGIN_LANGUAGE_SENTINEL=should-not-load');
	await writeFile(path.join(stalePluginRoot, 'templates', 'InjectedPlugin.html'), '<div>M3B_STALE_PLUGIN_TEMPLATE_SENTINEL</div>');
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[version]',
		'two_factor_policy_migration = 1',
		'',
		'[plugins]',
		'enable = 1',
		'enabled_list = "backup"',
		'',
		'[security]',
		'require_two_factor_auth = 0',
		'allow_admin_panel = 1',
		'admin_login = "' + testAdminLogin + '"',
		'admin_password = "' + passwordHash.stdout.trim() + '"',
		''
	].join('\n'));
	await writeFile(markerPath, 'baseline\n');
	makeZip(archivePath, 'configs/restore-marker.txt', 'restored by isolated test\n');

	const baseUrl = await startServer(t, temporaryRoot, dataRoot, pluginSentinelPath);
	const pluginState = await request(baseUrl, '/__test/plugin-state');
	assert.deepEqual(pluginState.json, {
		plugins_enabled: false,
		enabled_list: '',
		stale_enablement_config_preserved: true,
		backup_plugin_readable: true,
		plugin_sentinel_executed: false,
		admin_login_configured: true,
		admin_password_configured: true
	}, 'stale configuration remains on disk but is ignored, and the valid-looking plugin remains inert');
	const guestAppData = await request(baseUrl, '/?/AppData');
	assert.equal(guestAppData.json.Auth, false);
	assert.equal(Object.hasOwn(guestAppData.json, 'Plugins'), false);
	assert.equal(Object.hasOwn(guestAppData.json, 'PluginsLink'), false);
	const pageResponse = await fetch(baseUrl + '/', { headers: testHeaders });
	assert.equal(pageResponse.status, 200);
	const page = await pageResponse.text();
	assert.deepEqual([...page.matchAll(/app-plugin-style|BaseAppPluginCss|PluginsLink|M3B_STALE_PLUGIN/g)].map(match => match[0]), [],
		'index HTML contains no plugin stylesheet slot, link, or stale plugin marker');
	assert.match(page, /static\/css\/(?:app|admin)/, 'native Core CSS remains linked');
	const languageResponse = await fetch(baseUrl + '/?/Lang/0/App/en', { headers: testHeaders });
	assert.equal(languageResponse.status, 200);
	assert.doesNotMatch(await languageResponse.text(), /M3B_STALE_PLUGIN_LANGUAGE_SENTINEL/);
	const pluginScriptResponse = await fetch(baseUrl + '/?/Plugins/0/User', { headers: testHeaders });
	assert.doesNotMatch(await pluginScriptResponse.text(), /M3B_STALE_PLUGIN_JS_SENTINEL/);
	const adminJar = new CookieJar();
	const adminAppData = await request(baseUrl, '/?/admin/AppData', { jar: adminJar });
	const guestToken = adminAppData.json?.System?.token;
	assert.match(guestToken || '', /^0-/);

	const unauthorizedNativeAction = await request(baseUrl, '/?/admin/Json', {
		jar: adminJar,
		token: guestToken,
		method: 'POST',
		fields: { Action: 'AdminSettingsUpdate', RequireTwoFactor: 'true' }
	});
	assert.equal(unauthorizedNativeAction.json.code, 102,
		'native admin authorization must reject an anonymous write: ' + responseDiagnostic(unauthorizedNativeAction.json));
	assert.equal(await readFile(markerPath, 'utf8'), 'baseline\n');

	const adminLogin = await request(baseUrl, '/?/admin/Json', {
		jar: adminJar,
		token: guestToken,
		method: 'POST',
		fields: { Action: 'AdminLogin', Login: testAdminLogin, Password: testAdminPassword }
	});
	assert.ok(adminLogin.json?.Result?.System?.token, JSON.stringify(adminLogin.json));
	const adminToken = adminLogin.json.Result.System.token;
	const adminSettings = await request(baseUrl, '/?/admin/Json', {
		jar: adminJar,
		token: adminToken,
		method: 'POST',
		fields: { Action: 'AdminSettingsGet' }
	});
	assert.ok(adminSettings.json?.Result, JSON.stringify(adminSettings.json));
	assert.equal(Object.hasOwn(adminSettings.json.Result, 'plugins'), false,
		'generic Admin settings do not expose stale plugin configuration');
	const pluginSettingsWrite = await request(baseUrl, '/?/admin/Json', {
		jar: adminJar,
		token: adminToken,
		method: 'POST',
		json: { Action: 'AdminSettingsSet', config: { plugins: { enable: false, enabled_list: '' } } }
	});
	assert.notEqual(pluginSettingsWrite.json?.code, 0,
		'generic Admin settings cannot change the stale plugin enablement configuration');

	const upload = {
		bytes: await readFile(archivePath),
		mime: 'application/zip',
		name: 'benign-backup.zip'
	};
	const pluginAction = await postPluginAction(
		baseUrl, adminJar, adminToken, 'PluginJsonAdminRestoreData', upload
	);
	assert.equal(pluginAction.json.Action, 'PluginJsonAdminRestoreData');
	assert.notEqual(pluginAction.json.code, 0,
		'unknown generic plugin JSON actions must not dispatch through retained Core');
	assert.equal(await readFile(markerPath, 'utf8'), 'baseline\n',
		'unknown plugin JSON actions cannot extract the uploaded archive');
	assert.equal(await readFile(pluginSentinelPath).catch(() => null), null,
		'Admin requests must not execute the stale plugin entrypoint');
	for (const action of [
		'AdminPluginLoad', 'AdminPluginDisable', 'AdminPluginSettingsUpdate',
		'AdminPackagesList', 'AdminPackageInstall', 'AdminPackageDelete'
	]) {
		const response = await request(baseUrl, '/?/admin/Json', {
			jar: adminJar,
			token: adminToken,
			method: 'POST',
			fields: { Action: action, Plugin: 'backup' }
		});
		assert.notEqual(response.json?.code, 0, action + ' is no longer an Admin runtime action');
	}
});
