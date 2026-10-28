import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSyntheticImapServer } from '../scripts/synthetic-imap-server.mjs';
import { createPrivateTestTempRoot } from './fixtures/private-test-temp.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
	isWindows = 'win32' === process.platform,
	testTemporaryRoot = await createPrivateTestTempRoot(test, 'appearance'),
	phpBinary = process.env.PHP_BINARY || 'php',
	testPassword = 'm2b-appearance-test-password',
	testAdminLogin = 'm2d-appearance-admin',
	testAdminPassword = 'm2d-appearance-admin-password',
	testHeaders = {
		Accept: 'application/json',
		'Sec-Fetch-Dest': 'empty',
		'Sec-Fetch-Mode': 'cors',
		'Sec-Fetch-Site': 'same-origin'
	},
	appearanceContractSource = await readFile(path.join(repositoryRoot, 'dev/Common/Appearance.js'), 'utf8'),
	appearanceContract = await import('data:text/javascript;base64,' + Buffer.from(appearanceContractSource).toString('base64'));

class CookieJar {
	#cookies = new Map();

	header() {
		return [...this.#cookies].map(([name, value]) => name + '=' + value).join('; ');
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

	const port = await reserveLocalPort(),
		router = path.join(repositoryRoot, 'tests/fixtures/two-factor-router.php'),
		child = spawn(phpBinary, [
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
	let lastProbe = '';
	for (let attempt = 0; attempt < 100; attempt++) {
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

async function createEnvironment(t) {
	const temporaryRoot = await mkdtemp(path.join(testTemporaryRoot, 'petuja-m2b-appearance-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data'),
		privateRoot = path.join(dataRoot, '_data_', '_default_'),
		configRoot = path.join(privateRoot, 'configs'),
		domainsRoot = path.join(privateRoot, 'domains');
	const imap = createSyntheticImapServer({
		expectedPassword: testPassword,
		greeting: 'isolated M2B appearance fixture'
	});
	await imap.listen();
	t.after(() => imap.close());
	await Promise.all([
		mkdir(configRoot, { recursive: true }),
		mkdir(path.join(privateRoot, 'cache'), { recursive: true }),
		mkdir(domainsRoot, { recursive: true })
	]);
	const domain = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'), 'utf8'));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imap.port;
	domain.IMAP.type = 0;
	await writeFile(path.join(domainsRoot, 'default.json'), JSON.stringify(domain));
	const adminPasswordHash = spawnSync(phpBinary, [
		'-r', `echo password_hash('${testAdminPassword}', PASSWORD_DEFAULT);`
	], { encoding: 'utf8' }).stdout?.trim() || '';
	assert.ok(adminPasswordHash, 'PHP generated the synthetic Admin password hash');
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[plugins]',
		'enable = Off',
		'',
		'[security]',
		'require_two_factor_auth = Off',
		'admin_login = "' + testAdminLogin + '"',
		'admin_password = "' + adminPasswordHash + '"',
		'',
		'[version]',
		'two_factor_policy_migration = 1',
		'',
		'[webmail]',
		'theme = BlackWood',
		'allow_themes = On',
		'allow_user_background = On',
		'',
		'[login]',
		'fault_delay = 0',
		''
	].join('\n'));
	return {
		dataRoot,
		configPath: path.join(configRoot, 'application.ini'),
		baseUrl: await startPhpServer(t, dataRoot)
	};
}

async function request(baseUrl, route, { jar, token, method = 'GET', fields, payload, formData } = {}) {
	const headers = { ...testHeaders };
	if (jar?.header()) {
		headers.Cookie = jar.header();
	}
	if (undefined !== token) {
		headers['X-SM-Token'] = token;
	}
	let body;
	if (fields) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
		body = new URLSearchParams(fields);
	} else if (formData) {
		body = formData;
	} else if (undefined !== payload) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(payload);
	}
	const response = await fetch(baseUrl + route, { method, headers, body });
	jar?.update(response);
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// CSS and redirects are not JSON unless the route explicitly requests JSON.
	}
	if (json && undefined === json.code && Object.hasOwn(json, 'Result')) {
		json.code = 0;
	}
	return { response, text, json };
}

async function guestSession(baseUrl) {
	const jar = new CookieJar(),
		result = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(result.response.status, 200, result.text.slice(0, 300));
	assert.match(result.json?.System?.token || '', /^0-/);
	assert.equal(Object.hasOwn(result.json, 'Appearance'), false,
		'anonymous Login bootstrap does not consume account Appearance');
	return { jar, token: result.json.System.token };
}

async function login(baseUrl, email) {
	const guest = await guestSession(baseUrl),
		result = await request(baseUrl, '/?/Json', {
			jar: guest.jar,
			token: guest.token,
			method: 'POST',
			fields: { Action: 'Login', Email: email, Password: testPassword }
		});
	assert.equal(result.json?.code, 0, JSON.stringify(result.json));
	assert.equal(result.json.Result.Auth, true);
	return {
		jar: guest.jar,
		token: result.json.Result.System.token,
		appData: result.json.Result
	};
}

async function storedFilesNamed(dataRoot, fileName) {
	const files = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ('ENOENT' === error.code) {
				return;
			}
			throw error;
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

async function initializeAccountSettings(environment, user, initial) {
	const before = new Set(await Promise.all(['settings', 'settings_local'].map(name => storedFilesNamed(environment.dataRoot, name))).then(groups => groups.flat()));
	const response = await request(environment.baseUrl, '/?/Json', {
		jar: user.jar,
		token: user.token,
		method: 'POST',
		payload: { Action: 'SettingsUpdate', Appearance: 'system' }
	});
	assert.equal(response.json?.code, 0, JSON.stringify(response.json));
	const newFiles = (await Promise.all(['settings', 'settings_local'].map(name => storedFilesNamed(environment.dataRoot, name)))
		.then(groups => groups.flat())).filter(file => !before.has(file));
	const settingsPath = newFiles.find(file => 'settings' === path.basename(file)),
		localSettingsPath = newFiles.find(file => 'settings_local' === path.basename(file));
	assert.ok(settingsPath, 'authenticated settings mutation creates account CONFIG/settings');
	assert.ok(localSettingsPath, 'the existing settings action keeps its local settings store');
	await writeFile(settingsPath, JSON.stringify(initial));
	await writeFile(localSettingsPath, JSON.stringify({ Theme: 'Default' }));
	return { settingsPath, localSettingsPath };
}

async function setRecords(paths, settings, localSettings) {
	await Promise.all([
		writeFile(paths.settingsPath, JSON.stringify(settings)),
		writeFile(paths.localSettingsPath, JSON.stringify(localSettings))
	]);
}

async function readAppData(environment, user) {
	const result = await request(environment.baseUrl, '/?/AppData', {
		jar: user.jar,
		token: user.token
	});
	assert.equal(result.response.status, 200, result.text.slice(0, 300));
	assert.equal(result.json?.Auth, true, result.text.slice(0, 300));
	return result.json;
}

test('M2D preserves strict native Appearance and retires theme/font/background runtime', {
	timeout: isWindows ? 900000 : 90000
}, async t => {
	assert.deepEqual(Object.values(appearanceContract.AppearancePreference).sort(), ['dark', 'light', 'system']);
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}

	const account = await login(environment.baseUrl, 'm2b-' + Date.now() + '@sec02.test');
	const paths = await initializeAccountSettings(environment, account, {
		fontSansSerif: 'Arial',
		fontSerif: 'Georgia',
		fontMono: 'Courier',
		UserBackgroundName: 'fixture-background.png',
		UserBackgroundHash: 'fixture-background-hash'
	});
	const adminBootstrap = await request(environment.baseUrl, '/?/admin/AdminAppData', { jar: account.jar });
	assert.equal(adminBootstrap.response.status, 200, adminBootstrap.text.slice(0, 300));
	assert.equal(Object.hasOwn(adminBootstrap.json, 'Appearance'), false,
		'Admin bootstrap does not inherit personal account Appearance');
	for (const retiredCapability of ['Themes', 'UserBackground']) {
		assert.equal(Object.hasOwn(adminBootstrap.json?.Capa || {}, retiredCapability), false,
			`Admin AppData does not expose the retired ${retiredCapability} capability`);
	}

	await t.test('pre-paint bootstrap is authenticated, nonce-trusted, and independent of the stored legacy Theme', async () => {
		const guest = await guestSession(environment.baseUrl),
			guestDocument = await request(environment.baseUrl, '/', { jar: guest.jar }),
			adminDocument = await request(environment.baseUrl, '/?/admin', { jar: account.jar });
		assert.equal(guestDocument.response.status, 200, guestDocument.text.slice(0, 300));
		assert.equal(adminDocument.response.status, 200, adminDocument.text.slice(0, 300));

		const guestHtml = guestDocument.text.match(/<html\b[^>]*>/)?.[0] || '',
			adminHtml = adminDocument.text.match(/<html\b[^>]*>/)?.[0] || '';
		assert.doesNotMatch(guestHtml, /data-appearance-(?:preference|scheme)/,
			'Login does not receive a mailbox Appearance value');
		assert.doesNotMatch(adminHtml, /data-appearance-(?:preference|scheme)/,
			'Admin does not receive a mailbox Appearance value');
		assert.match(adminDocument.text, /<body[^>]+data-admin='1'/);
		assert.doesNotMatch(guestDocument.text, /app-plugin-style|BaseAppPluginCss/,
			'guest Login does not expose a generic plugin stylesheet slot');
		assert.doesNotMatch(guestDocument.text, /app-native-theme-style|app-theme-style/,
			'the document does not ship a legacy theme stylesheet');

		await setRecords(paths, { Appearance: 'system' }, { Theme: 'BlackWood' });
		const authenticatedDocument = await request(environment.baseUrl, '/', { jar: account.jar });
		assert.equal(authenticatedDocument.response.status, 200, authenticatedDocument.text.slice(0, 300));
		const html = authenticatedDocument.text.match(/<html\b[^>]*>/)?.[0] || '',
			nonce = authenticatedDocument.text.match(/<script id="appearance-bootstrap" nonce="([^"]+)"/)?.[1],
			csp = authenticatedDocument.response.headers.get('content-security-policy') || '';
		assert.match(html, /data-appearance-preference="system"/);
		assert.doesNotMatch(html, /data-appearance-scheme=/,
			'the effective scheme is assigned by the early resolver, not raw server interpolation');
		assert.doesNotMatch(authenticatedDocument.text, /app-plugin-style|BaseAppPluginCss/,
			'authenticated pages do not expose a generic plugin stylesheet slot');
		assert.doesNotMatch(authenticatedDocument.text, /app-native-theme-style|app-theme-style/);
		assert.ok(nonce, 'early bootstrap receives the server nonce');
		assert.ok(csp.includes("'nonce-" + nonce + "'"), 'the existing CSP authorizes the bootstrap nonce');
		assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/i, 'the bootstrap does not require unsafe-inline');
	});

	await t.test('exact built-in legacy IDs resolve deterministically, including the ambiguous fallback', async () => {
		const mappings = {
			A: 'light',
			BlackWood: 'dark',
			Blurred: 'light',
			BlurredDark: 'dark',
			DarkShine: 'light',
			Default: 'light',
			Linen: 'light',
			Love: 'light',
			LoveDark: 'dark',
			Magnetic: 'dark',
			'NextcloudV25+': 'system',
			NightShine: 'dark',
			Snow: 'light',
			SnowDarkV1: 'dark',
			Squares: 'light',
			SquaresDark: 'dark',
			Stripes: 'light',
			StripesDark: 'dark',
			Wood: 'light',
			Xv: 'light',
			Clear: 'light'
		};
		for (const [theme, appearance] of Object.entries(mappings)) {
			const settings = {
				fontSansSerif: 'Arial',
				fontSerif: 'Georgia',
				fontMono: 'Courier',
				UserBackgroundName: 'fixture-background.png',
				UserBackgroundHash: 'fixture-background-hash'
			};
			await setRecords(paths, settings, { Theme: theme });
			const before = await Promise.all([
				readFile(paths.settingsPath, 'utf8'),
				readFile(paths.localSettingsPath, 'utf8')
			]);
			const appData = await readAppData(environment, account);
			assert.equal(Object.hasOwn(appData, 'Theme'), false, 'AppData does not expose the removed active Theme');
			assert.equal(Object.hasOwn(appData.System, 'themes'), false, 'AppData does not expose a theme catalogue');
			for (const retiredCapability of ['Themes', 'UserBackground']) {
				assert.equal(Object.hasOwn(appData.Capa || {}, retiredCapability), false,
					`user AppData does not expose the retired ${retiredCapability} capability`);
			}
			assert.equal(appData.Appearance, appearance, `legacy Theme ${theme} maps to ${appearance}`);
			assert.deepEqual(
				await Promise.all([
					readFile(paths.settingsPath, 'utf8'),
					readFile(paths.localSettingsPath, 'utf8')
				]),
				before,
				`reading Theme ${theme} does not persist a migration`
			);
			assert.equal((await readAppData(environment, account)).Appearance, appearance,
				`repeated Theme ${theme} reads are idempotent`);
		}
	});

	await t.test('valid native preferences win; invalid or missing values use exact compatibility and fallback', async () => {
		for (const preference of Object.values(appearanceContract.AppearancePreference)) {
			await setRecords(paths, { Appearance: preference }, { Theme: 'BlackWood' });
			const appData = await readAppData(environment, account);
			assert.equal(appData.Appearance, preference);
			assert.equal(appearanceContract.isAppearancePreference(appData.Appearance), true);
			assert.equal(Object.hasOwn(appData, 'Theme'), false, 'the legacy setting stays internal');
		}

		const malformedValues = ['', 'dark<script>', '../../theme', 'Dark', 'DARK', 'dark-mode', 'custom-dark', null, [], {}, true, false, 1];
		for (const invalid of malformedValues) {
			await setRecords(paths, { Appearance: invalid }, { Theme: 'BlackWood' });
			const appData = await readAppData(environment, account);
			assert.equal(appData.Appearance, 'dark', `invalid Appearance ${JSON.stringify(invalid)} falls back through exact Theme mapping`);
			assert.equal(appearanceContract.isAppearancePreference(appData.Appearance), true);
		}

		for (const theme of [
			'missing-custom@custom', 'custom-dark', '../../theme', '../Default', '..%2fDefault', '%2e%2e%2fDefault',
			'BlackWood@custom', 'evil@nextcloud', 'NextcloudV25+@nextcloud',
			'body{background:url(x)}', '</style><script>alert(1)</script>', '" onmouseover="alert(1)'
		]) {
			await setRecords(paths, {}, { Theme: theme });
			const appData = await readAppData(environment, account);
			assert.equal(appData.Appearance, 'light', `unknown, custom, or ambiguous Theme ${theme} uses Light fallback`);
			assert.equal(Object.hasOwn(appData, 'Theme'), false,
				'unknown legacy values are not exposed to a stylesheet runtime');
		}
		const injectedTheme = '</style><script>alert(1)</script>',
			staleName = 'stale-background-name-must-stay-private',
			staleHash = 'stale-background-hash-must-stay-private';
		await setRecords(paths, {
			UserBackgroundName: staleName,
			UserBackgroundHash: staleHash
		}, { Theme: injectedTheme });
		const document = await request(environment.baseUrl, '/', { jar: account.jar }),
			html = document.text.match(/<html\b[^>]*>/)?.[0] || '';
		assert.equal(document.response.status, 200, document.text.slice(0, 300));
		assert.match(html, /data-appearance-preference="light"/,
			'malicious legacy Theme values resolve to the safe native Light preference');
		assert.doesNotMatch(document.text, /<\/style><script>alert\(1\)<\/script>/,
			'legacy Theme markup is never interpolated into the document');
		assert.doesNotMatch(document.text, /stale-background-(?:name|hash)-must-stay-private/,
			'stale background metadata is not rendered into the document');

		for (const malformedTheme of [null, [], {}, true, 1]) {
			await setRecords(paths, {}, { Theme: malformedTheme });
			const appData = await readAppData(environment, account);
			assert.equal(appData.Appearance, 'light',
				'non-string persisted Theme ' + JSON.stringify(malformedTheme) + ' falls back to Light');
		}
		await setRecords(paths, {}, { Theme: '' });
		assert.equal((await readAppData(environment, account)).Appearance, 'dark',
			'an empty historical local Theme falls back to the exact legacy site default');
		const applicationConfig = await readFile(environment.configPath, 'utf8');
		assert.match(applicationConfig, /^theme = BlackWood$/m, 'the synthetic site default is present');
		for (const [theme, appearance] of [
			['Default', 'light'],
			['BlackWood', 'dark'],
			['LoveDark', 'dark'],
			['NextcloudV25+', 'system'],
			['Clear', 'light'],
			['custom-dark', 'light']
		]) {
			const updatedConfig = applicationConfig.replace(/^theme = .*$/m, 'theme = ' + theme);
			await writeFile(environment.configPath, updatedConfig);
			await setRecords(paths, {}, {});
			assert.equal((await readAppData(environment, account)).Appearance, appearance,
				`missing local Theme maps the exact legacy site default ${theme} to ${appearance}`);
		}
		await writeFile(environment.configPath, applicationConfig);

		await setRecords(paths, {}, {});
		const adminLogin = await request(environment.baseUrl, '/?/admin/Json', {
			jar: account.jar,
			token: account.token,
			method: 'POST',
			fields: { Action: 'AdminLogin', Login: testAdminLogin, Password: testAdminPassword }
		});
		assert.equal(adminLogin.json?.code, 0, JSON.stringify(adminLogin.json));
		const adminToken = adminLogin.json?.Result?.System?.token;
		assert.match(adminToken || '', /^[01]-/);
		const adminConfig = await request(environment.baseUrl, '/?/admin/Json', {
			jar: account.jar,
			token: adminToken,
			method: 'POST',
			payload: { Action: 'AdminSettingsGet' }
		});
		assert.equal(adminConfig.json?.code, 0, JSON.stringify(adminConfig.json));
		assert.equal(Object.hasOwn(adminConfig.json?.Result?.webmail || {}, 'theme'), false,
			'generic Admin settings do not expose the legacy site Theme');
		for (const staleKey of ['allow_themes', 'allow_user_background']) {
			assert.equal(Object.hasOwn(adminConfig.json?.Result?.webmail || {}, staleKey), false,
				`generic Admin settings do not expose stale ${staleKey} configuration`);
		}
		const legacyAdminUpdate = await request(environment.baseUrl, '/?/admin/Json', {
			jar: account.jar,
			token: adminToken,
			method: 'POST',
			fields: {
				Action: 'AdminSettingsUpdate',
				CapaThemes: 'true',
				CapaUserBackground: 'true'
			}
		});
		assert.equal(legacyAdminUpdate.json?.code, 0, JSON.stringify(legacyAdminUpdate.json));
		const adminConfigWrite = await request(environment.baseUrl, '/?/admin/Json', {
			jar: account.jar,
			token: adminToken,
			method: 'POST',
			payload: { Action: 'AdminSettingsSet', config: { webmail: {
				theme: 'LoveDark',
				allow_themes: true,
				allow_user_background: true
			} } }
		});
		assert.equal(adminConfigWrite.json?.code, 0, JSON.stringify(adminConfigWrite.json));
		const adminConfigAfterLegacyWrites = await request(environment.baseUrl, '/?/admin/Json', {
			jar: account.jar,
			token: adminToken,
			method: 'POST',
			payload: { Action: 'AdminSettingsGet' }
		});
		assert.equal(adminConfigAfterLegacyWrites.json?.code, 0, JSON.stringify(adminConfigAfterLegacyWrites.json));
		for (const staleKey of ['allow_themes', 'allow_user_background']) {
			assert.equal(Object.hasOwn(adminConfigAfterLegacyWrites.json?.Result?.webmail || {}, staleKey), false,
				`generic Admin writes cannot revive stale ${staleKey} configuration`);
		}
		await setRecords(paths, {}, {});
		assert.equal((await readAppData(environment, account)).Appearance, 'dark',
			'generic Admin settings cannot change the retained site default');
	});

	await t.test('POST writes validate strictly, preserve Theme/content metadata, and GET cannot mutate settings', async () => {
		await setRecords(paths, {
			fontSansSerif: 'Arial',
			fontSerif: 'Georgia',
			fontMono: 'Courier',
			UserBackgroundName: 'fixture-background.png',
			UserBackgroundHash: 'fixture-background-hash'
		}, { Theme: 'BlackWood' });
		const before = await readFile(paths.settingsPath, 'utf8');
		for (const invalid of ['dark<script>', '../../theme', 'Dark', 'DARK', 'dark-mode', 'custom-dark', null, [], {}, true, false]) {
			const response = await request(environment.baseUrl, '/?/Json', {
				jar: account.jar,
				token: account.token,
				method: 'POST',
				payload: { Action: 'SettingsUpdate', Appearance: invalid }
			});
			assert.notEqual(response.json?.code, 0, `invalid write ${JSON.stringify(invalid)} is rejected`);
			assert.equal(await readFile(paths.settingsPath, 'utf8'), before,
				`invalid write ${JSON.stringify(invalid)} leaves persistence unchanged`);
		}
		const csrfRejected = await request(environment.baseUrl, '/?/Json', {
			jar: account.jar,
			method: 'POST',
			payload: { Action: 'SettingsUpdate', Appearance: 'system' }
		});
		assert.notEqual(csrfRejected.json?.code, 0, 'native setting writes require the existing CSRF token');
		assert.equal(await readFile(paths.settingsPath, 'utf8'), before, 'a missing CSRF token cannot mutate settings');

		const unauthenticated = await guestSession(environment.baseUrl),
			unauthorizedWrite = await request(environment.baseUrl, '/?/Json', {
				jar: unauthenticated.jar,
				token: unauthenticated.token,
				method: 'POST',
				payload: { Action: 'SettingsUpdate', Appearance: 'system' }
			});
		assert.notEqual(unauthorizedWrite.json?.code, 0, 'anonymous users cannot write account Appearance');
		assert.equal(await readFile(paths.settingsPath, 'utf8'), before, 'anonymous writes cannot mutate account settings');

		const getUpdate = await request(environment.baseUrl, '/?/Json/unused/SettingsUpdate', {
			jar: account.jar,
			token: account.token
		});
		assert.notEqual(getUpdate.json?.code, 0, 'GET dispatch of SettingsUpdate is rejected');
		assert.equal(await readFile(paths.settingsPath, 'utf8'), before, 'GET does not write account settings');

		for (const preference of Object.values(appearanceContract.AppearancePreference)) {
			const response = await request(environment.baseUrl, '/?/Json', {
				jar: account.jar,
				token: account.token,
				method: 'POST',
				payload: { Action: 'SettingsUpdate', Appearance: preference }
			});
			assert.equal(response.json?.code, 0, JSON.stringify(response.json));
			const saved = JSON.parse(await readFile(paths.settingsPath, 'utf8'));
			assert.equal(saved.Appearance, preference);
			const localSaved = JSON.parse(await readFile(paths.localSettingsPath, 'utf8'));
			assert.equal(localSaved.Theme, 'BlackWood', 'native writes do not side-write the legacy Theme');
			const appData = await readAppData(environment, account);
			assert.equal(appData.Appearance, preference);
			for (const key of ['Theme', 'fontSansSerif', 'fontSerif', 'fontMono', 'userBackgroundName', 'userBackgroundHash']) {
				assert.equal(Object.hasOwn(appData, key), false, `AppData omits removed state ${key}`);
			}
		}

		const themeCss = await request(environment.baseUrl,
			'/?/Css/0/User/-/BlackWood/-/123/Hash/-/Json/');
		assert.doesNotMatch(themeCss.response.headers.get('content-type') || '', /^text\/css\b/i,
			'the former dynamic theme CSS route no longer returns arbitrary theme CSS');

		await setRecords(paths, {
			Appearance: 'dark',
			fontSansSerif: 'Arial',
			fontSerif: 'Georgia',
			fontMono: 'Courier',
			UserBackgroundName: 'fixture-background.png',
			UserBackgroundHash: 'fixture-background-hash'
		}, { Theme: 'BlackWood' });
		const legacyThemeWrite = await request(environment.baseUrl, '/?/Json', {
			jar: account.jar,
			token: account.token,
			method: 'POST',
			payload: {
				Action: 'SettingsUpdate',
				Theme: 'Default',
				fontSansSerif: 'Verdana',
				fontSerif: 'Georgia',
				fontMono: 'Courier New'
			}
		});
		assert.equal(legacyThemeWrite.json?.code, 0, JSON.stringify(legacyThemeWrite.json));
		assert.equal(JSON.parse(await readFile(paths.settingsPath, 'utf8')).Appearance, 'dark',
			'legacy Theme writes do not overwrite the native preference');
		assert.equal(JSON.parse(await readFile(paths.localSettingsPath, 'utf8')).Theme, 'BlackWood',
			'removed Theme writes do not alter the persisted compatibility value');
		const afterLegacyThemeWrite = await readAppData(environment, account);
		assert.equal(afterLegacyThemeWrite.Appearance, 'dark');
		assert.equal(Object.hasOwn(afterLegacyThemeWrite, 'Theme'), false);
		for (const key of ['fontSansSerif', 'fontSerif', 'fontMono', 'userBackgroundName', 'userBackgroundHash']) {
			assert.equal(Object.hasOwn(afterLegacyThemeWrite, key), false, `removed state ${key} is not exposed`);
		}
	});

	await t.test('native preference storage remains account scoped', async () => {
		const otherAccount = await login(environment.baseUrl, 'm2b-other-' + Date.now() + '@sec02.test');
		const otherPaths = await initializeAccountSettings(environment, otherAccount, { Appearance: 'light' });
		await setRecords(paths, { Appearance: 'dark' }, { Theme: 'Default' });
		assert.equal((await readAppData(environment, account)).Appearance, 'dark');
		assert.equal((await readAppData(environment, otherAccount)).Appearance, 'light');
		assert.notEqual(paths.settingsPath, otherPaths.settingsPath);
	});

	await t.test('forced two-factor enrollment does not receive the account Appearance bootstrap', async () => {
		const configPath = path.join(environment.dataRoot, '_data_', '_default_', 'configs', 'application.ini'),
			original = await readFile(configPath, 'utf8'),
			required = original.replace('require_two_factor_auth = Off', 'require_two_factor_auth = On');
		assert.notEqual(required, original, 'the isolated fixture has a disabled forced-2FA policy');
		try {
			await writeFile(configPath, required);
			const pendingData = await request(environment.baseUrl, '/?/AppData', { jar: account.jar });
			assert.equal(pendingData.json?.SetupTwoFactor, true, 'fixture enters the existing restricted enrollment state');
			assert.equal(Object.hasOwn(pendingData.json, 'Appearance'), false);
			const document = await request(environment.baseUrl, '/', { jar: account.jar }),
				html = document.text.match(/<html\b[^>]*>/)?.[0] || '';
			assert.doesNotMatch(html, /data-appearance-preference=/,
				'pre-paint appearance is withheld until the existing M1 boundary is complete');
		} finally {
			await writeFile(configPath, original);
		}
	});
});

test('former background upload, clear, and raw routes cannot access a stale account blob', {
	timeout: isWindows ? 180000 : 30000
}, async t => {
	const environment = await createEnvironment(t);
	if (!environment.baseUrl) {
		return;
	}
	const account = await login(environment.baseUrl, 'm2d-background-' + Date.now() + '@sec02.test'),
		paths = await initializeAccountSettings(environment, account, {
			Appearance: 'dark',
			UserBackgroundName: 'stale-background-name-must-stay-private',
			UserBackgroundHash: 'stale-background-hash-must-stay-private'
		}),
		staleHash = 'stale-background-hash-must-stay-private',
		backgroundPath = path.join(path.dirname(paths.settingsPath), 'background'),
		backgroundRecord = JSON.stringify({
			ContentType: 'image/png',
			Raw: Buffer.from('m2d-stale-background-marker').toString('base64')
		});
	await setRecords(paths, {
		Appearance: 'dark',
		UserBackgroundName: 'stale-background-name-must-stay-private',
		UserBackgroundHash: staleHash
	}, { Theme: 'BlackWood' });
	await writeFile(backgroundPath, backgroundRecord);
	const settingsBefore = await readFile(paths.settingsPath, 'utf8'),
		localSettingsBefore = await readFile(paths.localSettingsPath, 'utf8');

	const clear = await request(environment.baseUrl, '/?/Json', {
		jar: account.jar,
		token: account.token,
		method: 'POST',
		payload: { Action: 'ClearUserBackground' }
	});
	assert.notEqual(clear.json?.code, 0, 'the removed clear action is not dispatchable');
	assert.equal(await readFile(backgroundPath, 'utf8'), backgroundRecord,
		'the rejected clear action leaves the stale blob untouched');
	assert.equal(await readFile(paths.settingsPath, 'utf8'), settingsBefore,
		'the rejected clear action does not alter stale metadata');
	assert.equal(await readFile(paths.localSettingsPath, 'utf8'), localSettingsBefore);

	const raw = await request(environment.baseUrl, '/?/Raw/0/UserBackground/' + staleHash + '/', {
		jar: account.jar,
		token: account.token
	});
	assert.equal(raw.response.headers.get('x-raw-action'), null, 'the removed raw action is not invoked');
	assert.doesNotMatch(raw.response.headers.get('content-type') || '', /^image\//i);
	assert.doesNotMatch(raw.text, /m2d-stale-background-marker/,
		'the stale account blob is not served by the former raw route');

	const upload = new FormData();
	upload.append('uploader', new Blob([Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FMsAAAAASUVORK5CYII=',
		'base64'
	)], { type: 'image/png' }), 'background.png');
	const uploaded = await request(environment.baseUrl, '/?/UploadBackground/0', {
		jar: account.jar,
		token: account.token,
		method: 'POST',
		formData: upload
	});
	assert.match(uploaded.response.headers.get('content-type') || '', /^text\/html\b/i,
		'the former upload route falls back to the application page instead of its JSON upload handler');
	assert.doesNotMatch(uploaded.text, /"Action":"UploadBackground"/);
	assert.equal(await readFile(backgroundPath, 'utf8'), backgroundRecord,
		'the removed upload route does not replace or expose the stale blob');
	assert.equal(await readFile(paths.settingsPath, 'utf8'), settingsBefore,
		'the removed upload route does not mutate legacy metadata');
});

test('legacy ThemeStore retains structural responsive state', async () => {
	const themeStore = await readFile(path.join(repositoryRoot, 'dev/Stores/Theme.js'), 'utf8');
	assert.match(themeStore, /isMobile:\s*ko\.observable\(false\)/);
	assert.match(themeStore, /isMobile\.onchange\s*=\s*e\s*=>/);
	assert.match(themeStore, /leftPanelDisabled\(ThemeStore\.isMobile\(\)\)/);
});
