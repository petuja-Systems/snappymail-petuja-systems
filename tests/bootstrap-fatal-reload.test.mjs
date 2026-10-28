import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
	phpBinary = process.env.PHP_BINARY || 'php';

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
			const response = await fetch(baseUrl + '/');
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
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-m6b-fatal-reload-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data'),
		privateRoot = path.join(dataRoot, '_data_', '_default_'),
		configRoot = path.join(privateRoot, 'configs');
	await mkdir(configRoot, { recursive: true });
	await mkdir(path.join(privateRoot, 'cache'), { recursive: true });
	await writeFile(path.join(dataRoot, 'INSTALLED'), '0.0.0');
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[webmail]',
		'language = eo',
		'app_path = "/mail/"',
		'',
		'[admin_panel]',
		'key = "petuja-admin"',
		'language = de',
		''
	].join('\n'));
	const baseUrl = await startPhpServer(t, dataRoot);
	return baseUrl ? { baseUrl, configPath: path.join(configRoot, 'application.ini') } : null;
}

function reloadLink(html) {
	const count = (html.match(/id="rl-loading-error-reload"/g) || []).length;
	assert.equal(count, 1, 'the shared fatal state contains exactly one reload link');
	const errorState = html.match(/<div id="rl-loading-error"[^>]*>([\s\S]*?)<\/div>/);
	assert.ok(errorState, 'the reload link is rendered inside the shared bootstrap error state');
	const link = errorState[1].match(/<a\b[^>]*id="rl-loading-error-reload"[^>]*>([^<]*)<\/a>/);
	assert.ok(link, 'the fatal action is a semantic anchor');
	const href = link[0].match(/\bhref="([^"]*)"/);
	assert.ok(href, 'the fatal action has a safe page target');
	return { href: href[1].replaceAll('&amp;', '&'), label: link[1] };
}

test('shared bootstrap fatal state renders one localized safe GET reload link', async t => {
	const environment = await createEnvironment(t);
	if (!environment) return;
	const { baseUrl, configPath } = environment;

	const hostileReferer = 'https://untrusted.example/redirect?next=https%3A%2F%2Fevil.example',
		userResponse = await fetch(baseUrl + '/?next=https%3A%2F%2Fevil.example', {
			headers: { Referer: hostileReferer }
		}),
		userHtml = await userResponse.text();
	assert.equal(userResponse.status, 200, userHtml.slice(0, 300));
	const userLink = reloadLink(userHtml), userTarget = new URL(userLink.href, baseUrl);
	assert.equal(userLink.label, 'Reload', 'missing static locale uses canonical English fallback');
	assert.equal(userTarget.origin, new URL(baseUrl).origin);
	assert.equal(userTarget.pathname, '/mail/', 'configured application base path is preserved');
	assert.equal(userTarget.search, '', 'untrusted query and Referer are not copied to the target');
	assert.equal(userTarget.hash, '');
	assert.equal(userHtml.includes(hostileReferer), false);
	const csp = userResponse.headers.get('content-security-policy') || '',
		scriptNonce = userHtml.match(/<script id="appearance-bootstrap" nonce="([^"]+)"/)?.[1];
	assert.ok(scriptNonce, 'the shared page retains its nonce-protected bootstrap script');
	assert.ok(csp.includes(`'nonce-${scriptNonce}'`), 'the existing nonce remains present in the CSP');
	assert.doesNotMatch(csp, /(?:^|;)\s*script-src[^;]*'unsafe-inline'/i,
		'the reload action does not require relaxing the script policy');

	const adminResponse = await fetch(baseUrl + '/?petuja-admin');
	const adminHtml = await adminResponse.text();
	assert.equal(adminResponse.status, 200, adminHtml.slice(0, 300));
	const adminLink = reloadLink(adminHtml), adminTarget = new URL(adminLink.href, baseUrl);
	assert.equal(adminLink.label, 'Aktualisieren', 'path-based Admin uses its configured static locale');
	assert.equal(adminTarget.origin, new URL(baseUrl).origin);
	assert.equal(adminTarget.pathname, '/mail/');
	assert.equal(adminTarget.search, '?petuja-admin', 'path-based Admin entry is preserved');

	const postResponse = await fetch(baseUrl + '/?petuja-admin', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'synthetic_mutation=must_not_be_replayed'
	});
	const postHtml = await postResponse.text();
	assert.equal(postResponse.status, 200, postHtml.slice(0, 300));
	const postLink = reloadLink(postHtml), postTarget = new URL(postLink.href, baseUrl);
	assert.equal(postTarget.href, adminTarget.href, 'failed POST page links to the safe Admin entry, not the POST URL/body');
	const retryResponse = await fetch(postTarget.href);
	assert.equal(retryResponse.status, 200, (await retryResponse.text()).slice(0, 300));
	assert.equal(postHtml.includes('must_not_be_replayed'), false);

	const config = await readFile(configPath, 'utf8');
	await writeFile(configPath, config.replace('app_path = "/mail/"', 'app_path = "https://untrusted.example/base/"'));
	const invalidBaseResponse = await fetch(baseUrl + '/');
	const invalidBaseHtml = await invalidBaseResponse.text();
	assert.equal(invalidBaseResponse.status, 200, invalidBaseHtml.slice(0, 300));
	const invalidBaseTarget = new URL(reloadLink(invalidBaseHtml).href, baseUrl);
	assert.equal(invalidBaseTarget.href, new URL('/', baseUrl).href,
		'an absolute configured URL falls back to a root-relative same-origin entry');

	const [template, boot] = await Promise.all([
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/templates/Index.html'), 'utf8'),
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/static/js/boot.js'), 'utf8')
	]);
	assert.doesNotMatch(template, /<meta\b[^>]*http-equiv=["']?refresh/i);
	const errorState = template.match(/<div id="rl-loading-error"[^>]*>([\s\S]*?)<\/div>/);
	assert.ok(errorState);
	assert.doesNotMatch(errorState[1], /<script\b/i);
	assert.doesNotMatch(errorState[1], /\son[a-z]+\s*=/i);
	assert.doesNotMatch(template, /href=["']javascript:/i);
	assert.doesNotMatch(boot, /(?:location\.reload|setTimeout|setInterval|serviceWorker)/i);
});
