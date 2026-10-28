import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const phpMinimumCheckProgram = String.raw`
$minimum = $argv[1] ?? "";
if (!preg_match("/\\A[0-9]+\\.[0-9]+\\.[0-9]+\\z/", $minimum)) {
    fwrite(STDERR, "Invalid minimum PHP version.\n");
    exit(2);
}
if (version_compare(PHP_VERSION, $minimum, "<")) {
    fwrite(STDERR, "PHP CLI " . PHP_VERSION . " is below required " . $minimum . ".\n");
    exit(1);
}
printf("PHP CLI %s (PHP_VERSION_ID=%d; PHP_BINARY=%s) satisfies >= %s\n", PHP_VERSION, PHP_VERSION_ID, PHP_BINARY, $minimum);
`;

function localRequest(port, route, headers = {}, method = 'GET') {
	return new Promise((resolve, reject) => {
		const req = request({ hostname: '127.0.0.1', port, path: route, method, headers }, response => {
			let body = '';
			response.setEncoding('utf8').on('data', chunk => { body += chunk; });
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
		});
		req.setTimeout(5000, () => req.destroy(new Error('Local diagnostic fixture timed out')));
		req.on('error', reject);
		req.end();
	});
}

test('M7.6 public integrity diagnostics never contact a request-selected host', { timeout: 30000 }, async t => {
	const modules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8' });
	assert.equal(modules.status, 0, 'PHP CLI is required');
	for (const name of ['intl', 'mbstring', 'openssl', 'curl']) {
		assert.match(modules.stdout, new RegExp('^' + name + '$', 'im'));
	}
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-m76-integrity-'));
	const dataRoot = path.join(temporaryRoot, 'data');
	const configRoot = path.join(dataRoot, '_data_', '_default_', 'configs');
	let child;
	let sentinel;
	t.after(async () => {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await new Promise(resolve => child.once('exit', resolve));
		}
		if (sentinel?.listening) {
			sentinel.closeAllConnections();
			await new Promise(resolve => sentinel.close(resolve));
		}
		await rm(temporaryRoot, { recursive: true, force: true });
	});
	await mkdir(configRoot, { recursive: true });
	await mkdir(path.join(configRoot, '..', 'cache'), { recursive: true });
	await writeFile(path.join(dataRoot, 'INSTALLED'), '0.0.0');
	await writeFile(path.join(configRoot, 'application.ini'), [
		'[webmail]', 'app_path = "/fixture/"', '',
		'[admin_panel]', 'key = "synthetic-admin"', ''
	].join('\n'));

	let sentinelRequests = 0;
	sentinel = createServer((req, response) => {
		sentinelRequests++;
		response.writeHead(200, { 'Content-Length': '0', 'X-Local-Diagnostic': 'synthetic' });
		response.end();
	});
	await new Promise(resolve => sentinel.listen(0, '127.0.0.1', resolve));
	const sentinelHost = '127.0.0.1:' + sentinel.address().port;

	const reservation = createServer();
	await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	child = spawn(phpBinary, [
		'-d', 'display_errors=0', '-S', '127.0.0.1:' + port, '-t', repositoryRoot,
		path.join(repositoryRoot, 'tests/fixtures/two-factor-router.php')
	], { cwd: repositoryRoot, env: { ...process.env, PETUJA_TEST_DATA_PATH: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null || child.signalCode !== null) assert.fail('Local PHP fixture exited: ' + output);
		try {
			const ping = await localRequest(port, '/?/Ping');
			if (ping.status === 200 && ping.body === 'Pong') { ready = true; break; }
		} catch { /* The loopback listener is not ready yet. */ }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.ok(ready, 'Local PHP fixture did not start');
	const headers = {
		Host: sentinelHost,
		'X-Forwarded-Host': sentinelHost,
		'X-Forwarded-Proto': 'https',
		Forwarded: 'host="' + sentinelHost + '";proto=https'
	};
	for (const [route, method, metadata] of [
		['/?/Test', 'GET', {}],
		['/?/tEsT', 'POST', {}],
		['/?/Test@fixture', 'GET', { 'Sec-Fetch-Site': 'same-origin' }],
		['/?synthetic-admin/Test', 'GET', {}]
	]) {
		const response = await localRequest(port, route, { ...headers, ...metadata }, method);
		assert.equal(response.status, 200);
		assert.equal(sentinelRequests, 0, 'Request-selected loopback host must receive no diagnostic requests');
		assert.equal(response.body, '', 'Supported local PHP diagnostics produce no remote status/header output');
		assert.equal(response.headers['cache-control'], 'no-store');
	}
	const ping = await localRequest(port, '/?/Ping');
	assert.equal(ping.status, 200);
	assert.equal(ping.body, 'Pong', 'The adjacent local health check is unchanged');
});

test('M7.6 integrity keeps local PHP version and extension diagnostics', () => {
	const code = String.raw`
require $argv[1];
class FixtureVersionCheck extends \SnappyMail\Integrity {
	public static function phpVersion() { return 'synthetic version requirement'; }
	public static function phpExtensions() { throw new \RuntimeException('Version failure must return early'); }
}
class FixtureExtensionCheck extends \SnappyMail\Integrity {
	public static function phpVersion() {}
	public static function phpExtensions() { return ['synthetic_extension']; }
}
ob_start(); FixtureVersionCheck::test(); $version = ob_get_clean();
ob_start(); FixtureExtensionCheck::test(); $extensions = ob_get_clean();
echo json_encode([$version, $extensions, \SnappyMail\Integrity::phpVersion(), \SnappyMail\Integrity::phpExtensions()]);
`;
	const result = spawnSync(phpBinary, ['-d', 'display_errors=stderr', '-r', code,
		path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/snappymail/integrity.php')], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '', 'runtime compatibility diagnostics must not be hidden by the test harness');
	const [version, extensions, actualVersion, actualExtensions] = JSON.parse(result.stdout);
	assert.equal(version, '<p style="color: red">synthetic version requirement</p>');
	assert.match(extensions, /<li>synthetic_extension<\/li>/);
	assert.equal(actualVersion, null);
	assert.deepEqual(actualExtensions, []);
});

test('PHP minimum is 8.2.35 and uses semantic lower-bound comparison', async () => {
	const code = String.raw`
require $argv[1];
$versions = ['8.2.34', '8.2.35', '8.3.0', '8.10.0'];
$support = [];
foreach ($versions as $version) {
	$support[$version] = \SnappyMail\Integrity::isPhpVersionSupported($version);
}
echo json_encode([
	'minimum' => \SnappyMail\Integrity::MINIMUM_PHP_VERSION,
	'support' => $support,
	'actual' => PHP_VERSION,
	'actual_supported' => \SnappyMail\Integrity::isPhpVersionSupported(),
	'diagnostic' => \SnappyMail\Integrity::phpVersion()
], JSON_THROW_ON_ERROR);
`;
	const result = spawnSync(phpBinary, ['-d', 'display_errors=0', '-r', code,
		path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/snappymail/integrity.php')], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const data = JSON.parse(result.stdout);
	assert.equal(data.minimum, '8.2.35');
	assert.deepEqual(data.support, {
		'8.2.34': false,
		'8.2.35': true,
		'8.3.0': true,
		'8.10.0': true
	});
	assert.equal(data.actual_supported, true, `PHP ${data.actual} must meet the declared floor`);
	assert.equal(data.diagnostic, null);
	const productMetadata = JSON.parse(await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/petuja-product.json'), 'utf8'));
	assert.equal(productMetadata.minimumPhpVersion, data.minimum);
	const bootstrap = await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/include.php'), 'utf8');
	const installCheck = bootstrap.indexOf("include __DIR__ . '/setup.php';");
	const runtimeCheck = bootstrap.indexOf('\\SnappyMail\\Integrity::phpVersion()');
	const serviceCall = bootstrap.indexOf('RainLoop\\Service::Handle();');
	assert.ok(installCheck >= 0 && runtimeCheck > installCheck && serviceCall > runtimeCheck,
		'installed requests must check the canonical PHP floor before service handling');
	assert.match(bootstrap, /http_response_code\(503\)/);
});

test('release image builder and FPM runtime enforce the semantic PHP minimum', async () => {
	const dockerfile = await readFile(path.join(repositoryRoot, '.docker/release/Dockerfile'), 'utf8');
	const [builder, runtime] = dockerfile.split('FROM php:8.2-fpm-alpine AS final');
	assert.ok(runtime, 'FPM runtime stage must remain present');
	assert.match(builder, /FROM php:8\.2-cli-alpine AS builder/);
	const phpFloorGate = /RUN php -r 'if \(version_compare\(PHP_VERSION, "8\.2\.35", "<"\)\)/;
	assert.match(builder, phpFloorGate, 'release builder must reject PHP below 8.2.35');
	assert.match(runtime, phpFloorGate, 'FPM runtime must reject PHP below 8.2.35');
});

test('active PHP support documentation and CI baseline match the runtime requirement', async () => {
	const [development, storage, readiness, localization, release] = await Promise.all([
		readFile(path.join(repositoryRoot, 'docs/DEVELOPMENT.md'), 'utf8'),
		readFile(path.join(repositoryRoot, 'docs/security/account-storage-identity.md'), 'utf8'),
		readFile(path.join(repositoryRoot, 'docs/production/M8-persistence-readiness.md'), 'utf8'),
		readFile(path.join(repositoryRoot, '.github/workflows/localization-check.yml'), 'utf8'),
		readFile(path.join(repositoryRoot, '.github/workflows/release-check.yml'), 'utf8')
	]);
	assert.match(development, /petuja\.email 1\.1\.0 requires PHP\s+8\.2\.35 or newer;\s+no upper version bound is imposed\./);
	assert.match(storage, /petuja\.email 1\.1\.0 requires PHP 8\.2\.35 or\s+newer\./);
	assert.match(readiness, /supported PHP baseline\s+\(8\.2\.35 or newer\)/);
	for (const workflow of [localization, release]) {
		assert.match(workflow, /php-version: '8\.2\.35'/);
		assert.match(workflow, /PHP_VERSION !== "8\.2\.35" \|\| PHP_VERSION_ID !== 80235/);
	}
});

test('native deployment PHP preflight uses the supplied CLI and reports its runtime', async t => {
	const checker = path.join(repositoryRoot, 'scripts/check-php-minimum.sh');
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-php-preflight-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const fixturePhp = path.join(temporaryRoot, 'php');
	await writeFile(fixturePhp, `#!/usr/bin/env python3
import re
import sys

EXPECTED_PROGRAM = ${JSON.stringify(phpMinimumCheckProgram)}
if len(sys.argv) != 4 or sys.argv[1] != "-r" or sys.argv[2] != EXPECTED_PROGRAM:
    raise SystemExit("unexpected synthetic PHP invocation")
match = re.fullmatch(r"([0-9]+)\\.([0-9]+)\\.([0-9]+)", sys.argv[3])
if not match:
    print("Invalid minimum PHP version.", file=sys.stderr)
    raise SystemExit(2)
version = "8.2.35"
minimum = tuple(map(int, sys.argv[3].split(".")))
if (8, 2, 35) < minimum:
    print(f"PHP CLI {version} is below required {sys.argv[3]}.", file=sys.stderr)
    raise SystemExit(1)
print(f"PHP CLI {version} (PHP_VERSION_ID=80235; PHP_BINARY={sys.argv[0]}) satisfies >= {sys.argv[3]}")
`);
	await chmod(fixturePhp, 0o755);
	const result = spawnSync('bash', [checker, fixturePhp, '8.2.35'], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /PHP CLI 8\.2\.35 \(PHP_VERSION_ID=80235; PHP_BINARY=/);
	assert.match(result.stdout, /satisfies >= 8\.2\.35/);

	const unsupported = spawnSync('bash', [checker, fixturePhp, '99.0.0'], { encoding: 'utf8' });
	assert.equal(unsupported.status, 1, unsupported.stdout + unsupported.stderr);
	assert.match(unsupported.stderr, /PHP CLI 8\.2\.35 is below required 99\.0\.0/);

	const invalid = spawnSync('bash', [checker, fixturePhp, '8.2'], { encoding: 'utf8' });
	assert.equal(invalid.status, 2);
	assert.match(invalid.stderr, /Invalid minimum PHP version/);
});

test('native deploy, layout preparation, and pull paths retain the floor and use one selected PHP CLI', async () => {
	const [pull, deploy, verifier, prepare] = await Promise.all([
		readFile(path.join(repositoryRoot, 'scripts/pull-deploy-production.sh'), 'utf8'),
		readFile(path.join(repositoryRoot, 'scripts/deploy-production-release.sh'), 'utf8'),
		readFile(path.join(repositoryRoot, 'scripts/verify-production-deployment.sh'), 'utf8'),
		readFile(path.join(repositoryRoot, 'scripts/prepare-production-layout.sh'), 'utf8')
	]);
	assert.match(pull, /"\$PHP_MINIMUM_CHECKER" "\$PHP_BIN" "\$MINIMUM_PHP_VERSION"/);
	assert.match(pull, /ls-tree "\$DEPLOY_CONTROL_SHA" -- scripts\/check-php-minimum\.sh/);
	assert.match(pull, /PHP minimum checker blob: \$control_php_checker_blob/);
	assert.match(pull, /xargs -0 -n1 -P4 "\$PHP_BIN" -l/);
	assert.match(pull, /"\$PHP_BIN" release\.php/);
	assert.match(pull, /MINIMUM_PHP_VERSION="\$MINIMUM_PHP_VERSION"/);
	assert.match(deploy, /"\$PHP_MINIMUM_CHECKER" "\$PHP_BIN" "\$MINIMUM_PHP_VERSION"/);
	assert.match(deploy, /"minimumPhpVersion": "\$MINIMUM_PHP_VERSION"/);
	assert.match(deploy, /"\$PHP_BIN" -l "\$staging_dir\/index\.php"/);
	assert.match(verifier, /minimumPhpVersion/);
	assert.match(prepare, /validate-product-metadata\.sh/);
	assert.match(prepare, /check-php-minimum\.sh/);
	assert.match(prepare, /"\$PHP_BIN" -l "\$legacy_release\/index\.php"/);
});
