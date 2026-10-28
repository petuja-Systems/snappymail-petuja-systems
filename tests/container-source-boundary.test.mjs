import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = relative => readFile(path.join(root, relative), 'utf8');

test('release FPM is loopback-only and Nginx passes its authoritative peer', async () => {
	const fpm = await source('.docker/release/files/usr/local/etc/php-fpm.d/php-fpm.conf');
	assert.deepEqual([...fpm.matchAll(/^listen\s*=\s*(.+)$/gm)].map(match => match[1]), ['127.0.0.1:9000']);
	assert.match(fpm, /^listen\.allowed_clients\s*=\s*127\.0\.0\.1$/m);
	const nginx = await source('.docker/release/files/etc/nginx/nginx.conf');
	assert.match(nginx, /fastcgi_pass\s+127\.0\.0\.1:9000;/);
	assert.deepEqual([...nginx.matchAll(/fastcgi_param\s+REMOTE_ADDR\s+([^;]+);/g)].map(match => match[1]), ['$remote_addr']);
	assert.doesNotMatch(nginx, /^\s*(?:set_real_ip_from|real_ip_header)\s/m, 'default trusts no proxy header');
	const dockerfile = await source('.docker/release/Dockerfile');
	assert.doesNotMatch(dockerfile, /^EXPOSE 9000$/m, 'no explicit external FPM service declaration');
	for (const name of ['docker.conf', 'www.conf', 'zz-docker.conf']) {
		assert.ok(dockerfile.includes('/' + name + '.disabled'), 'base pool must be disabled: ' + name);
	}
	const structure = yaml.load(await source('.docker/release/test/config.yaml'));
	const commands = structure.commandTests[0].args.at(-1);
	assert.ok(commands.includes('nc -vz 127.0.0.1 9000'));
	assert.ok(commands.includes('if nc -vz -w 1 "$address" 9000; then exit 1; fi'));
	assert.ok(commands.includes('test "$non_loopback" = 1'));
});

test('Docker examples preserve the web service without a network FastCGI exporter', async () => {
	for (const name of ['simple', 'mysql', 'postgres', 'traefik']) {
		const text = await source('examples/docker/docker-compose.' + name + '.yml');
		const compose = yaml.load(text);
		assert.ok(compose.services.snappymail, name);
		assert.equal(compose.services['php-fpm-exporter'], undefined, name);
		assert.doesNotMatch(text, /PHP_FPM_SCRAPE_URI|9000:9000|network_mode:\s*(?:host|service:)/);
	}
});

test('core log addresses ignore forged forwarding headers and the legacy proxy flag', async t => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'petuja-client-source-'));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const fixture = path.join(root, 'tests/fixtures/client-source-boundary.php');
	const { stdout } = await execute(process.env.PHP_BINARY || 'php', [fixture], {
		env: { ...process.env, PETUJA_TEST_DATA_PATH: temporary }
	});
	const results = JSON.parse(stdout);
	assert.equal(results.length, 18);
	for (const { peer, log } of results) {
		assert.equal(log, 'Auth failed: ip=' + peer + ' user-ip=' + peer);
	}
	const actions = await source('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php');
	assert.equal([...actions.matchAll(/GetClientIp\(\)/g)].length, 3, 'all first-party log paths use the server peer');
	assert.doesNotMatch(actions, /http_client_ip_check_proxy/);
	assert.doesNotMatch(await source('snappymail/v/0.0.0/app/libraries/RainLoop/Config/Application.php'), /http_client_ip_check_proxy/);
});
