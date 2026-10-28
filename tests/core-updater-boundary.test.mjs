import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const applicationRoot = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries');
const phpBinary = process.env.PHP_BINARY || 'php';
const harnessPath = path.join(repositoryRoot, 'tests/fixtures/core-updater-harness.php');
const privateRelativePath = path.join('data', 'private');
const releaseBody = Buffer.from('synthetic Core release bytes');

async function source(relativePath) {
	return readFile(path.join(applicationRoot, relativePath), 'utf8');
}

async function startFixtureServer(t) {
	const requests = [];
	let metadataStatus = 200;
	let metadataBody = JSON.stringify({ version: '2.39.0', file: 'core.tar.gz', warnings: ['2.38.3'] });
	let archiveStatus = 200;
	let archiveBody = releaseBody;
	let closeArchiveConnection = false;
	const server = createServer((request, response) => {
		requests.push(request.url);
		if ('/repository/v2/core.json' === request.url) {
			response.writeHead(metadataStatus, { 'Content-Type': 'application/json' });
			response.end(metadataBody);
		} else if ('/repository/v2/core.tar.gz' === request.url) {
			if (closeArchiveConnection) {
				response.writeHead(200, { 'Content-Length': releaseBody.length + 17 });
				response.write(releaseBody.subarray(0, 5), () => request.socket.destroy());
				return;
			}
			response.writeHead(archiveStatus, { 'Content-Type': 'application/gzip' });
			response.end(archiveBody);
		} else {
			response.writeHead(404);
			response.end('missing fixture');
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(() => new Promise(resolve => server.close(() => resolve())));

	return {
		baseUrl: 'http://127.0.0.1:' + server.address().port + '/repository/v2/',
		requests,
		setMetadata(status, body) {
			metadataStatus = status;
			metadataBody = body;
		},
		setArchiveStatus(status) {
			archiveStatus = status;
		},
		setArchiveBody(body) {
			archiveBody = body;
		},
		setCloseArchiveConnection(value) {
			closeArchiveConnection = value;
		},
		resetRequests() {
			requests.length = 0;
		}
	};
}

async function runHarness(operation, baseUrl, root, options = {}) {
	const privateRoot = path.join(root, privateRelativePath);
	await mkdir(privateRoot, { recursive: true });
	await mkdir(path.join(root, 'snappymail', 'v'), { recursive: true });
	const appRoot = path.join(root, 'application');
	await mkdir(appRoot, { recursive: true });
	await writeFile(path.join(appRoot, 'index.php'), '<?php // writable test target');

	const child = spawn(phpBinary, ['-d', 'display_errors=0', harnessPath, operation], {
		cwd: repositoryRoot,
		env: {
			...process.env,
			PETUJA_TEST_CORE_BASE_URL: baseUrl,
			PETUJA_TEST_CORE_ROOT: root,
			PETUJA_TEST_CORE_PRIVATE_DATA: privateRoot,
			PETUJA_TEST_CORE_VERSION: options.version || '2.38.2',
			PETUJA_TEST_CORE_ALLOW_UPDATE: options.allowUpdate === false ? '0' : '1'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
	child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
	const exitCode = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', resolve);
	});
	assert.equal(exitCode, 0, 'Core updater fixture PHP failed: ' + stderr);
	try {
		return JSON.parse(stdout);
	} catch {
		assert.fail('Core updater fixture did not return JSON: ' + stdout + '\n' + stderr);
	}
}

test('Core updater preserves metadata, version, gate, download and failure behavior', { timeout: 30000 }, async t => {
	const phpCheck = spawnSync(phpBinary, ['-r', 'exit(PHP_VERSION_ID >= 70400 ? 0 : 1);'], { encoding: 'utf8' });
	if (phpCheck.error || 0 !== phpCheck.status) {
		t.skip('PHP 7.4 or newer is unavailable');
		return;
	}

	const root = await mkdtemp(path.join(tmpdir(), 'petuja-core-updater-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await startFixtureServer(t);

	const info = await runHarness('info', fixture.baseUrl, path.join(root, 'info'));
	assert.deepEqual({ ok: info.ok, version: info.version, file: info.file, warnings: info.warnings, canUpdate: info.can_update, adminChecks: info.admin_checks }, {
		ok: true,
		version: '2.39.0',
		file: 'core.tar.gz',
		warnings: ['2.38.3'],
		canUpdate: true,
		adminChecks: 1
	});
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json']);

	fixture.resetRequests();
	const downloaded = await runHarness('download', fixture.baseUrl, path.join(root, 'download'));
	assert.equal(downloaded.ok, true);
	assert.equal(Buffer.from(downloaded.downloaded, 'base64').toString(), releaseBody.toString());
	assert.equal(downloaded.admin_checks, 1);
	assert.deepEqual(downloaded.private_files, [], 'successful download temp file is removed by its caller');
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json', '/repository/v2/core.tar.gz']);
	const largeArchive = Buffer.alloc(1024 * 1024 + 17, 0x61);
	fixture.setArchiveBody(largeArchive);
	const largeDownload = await runHarness('download', fixture.baseUrl, path.join(root, 'large-download'));
	assert.equal(largeDownload.ok, true);
	assert.deepEqual(Buffer.from(largeDownload.downloaded, 'base64'), largeArchive);
	assert.deepEqual(largeDownload.private_files, []);
	fixture.setArchiveBody(releaseBody);

	fixture.resetRequests();
	fixture.setMetadata(200, JSON.stringify({ version: '2.38.2', file: 'core.tar.gz' }));
	const current = await runHarness('download', fixture.baseUrl, path.join(root, 'current'));
	assert.equal(current.ok, true);
	assert.equal(current.downloaded, null, 'equal Core versions are not downloaded');
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json']);

	fixture.resetRequests();
	const blockedByConfig = await runHarness('gate', fixture.baseUrl, path.join(root, 'disabled'), { allowUpdate: false });
	assert.equal(blockedByConfig.can_update, false, 'allow_update remains an eligibility gate');
	assert.deepEqual(fixture.requests, []);
	const blockedByVersion = await runHarness('gate', fixture.baseUrl, path.join(root, 'old-version'), { version: '2.0' });
	assert.equal(blockedByVersion.can_update, false, 'Core versions at the native minimum remain ineligible');

	fixture.resetRequests();
	fixture.setMetadata(200, '{"version":');
	const malformedJson = await runHarness('info', fixture.baseUrl, path.join(root, 'malformed-json'));
	assert.equal(malformedJson.ok, false);
	assert.equal(malformedJson.error_class, 'JsonException');
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json']);

	fixture.resetRequests();
	fixture.setMetadata(200, '[]');
	const malformedShape = await runHarness('download', fixture.baseUrl, path.join(root, 'malformed-shape'));
	assert.equal(malformedShape.ok, false);
	assert.equal(malformedShape.error_class, 'UnexpectedValueException');
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json']);
	fixture.setMetadata(200, ' '.repeat(1024 * 1024 + 1));
	const oversizedMetadata = await runHarness('info', fixture.baseUrl, path.join(root, 'oversized-metadata'));
	assert.equal(oversizedMetadata.ok, false);
	assert.equal(oversizedMetadata.error_class, 'RuntimeException');

	fixture.resetRequests();
	fixture.setMetadata(503, 'temporary repository failure');
	const metadataFailure = await runHarness('info', fixture.baseUrl, path.join(root, 'metadata-failure'));
	assert.equal(metadataFailure.ok, false);
	assert.equal(metadataFailure.error_code, 503);
	assert.equal(metadataFailure.error, 'temporary repository failure');
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json']);

	fixture.resetRequests();
	fixture.setMetadata(200, JSON.stringify({ version: '2.39.0', file: 'core.tar.gz' }));
	fixture.setArchiveStatus(502);
	fixture.setArchiveBody('synthetic-error-' + 'e'.repeat(1024 * 1024 - 'synthetic-error-'.length));
	const downloadFailure = await runHarness('download', fixture.baseUrl, path.join(root, 'download-failure'));
	assert.equal(downloadFailure.ok, false);
	assert.equal(downloadFailure.error_code, 502);
	assert.equal(downloadFailure.error.length, 1024 * 1024, 'archive error preview is bounded');
	assert.ok(downloadFailure.error.startsWith('synthetic-error-'));
	assert.deepEqual(downloadFailure.private_files, [], 'HTTP failure removes the partial download temp file');
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json', '/repository/v2/core.tar.gz']);

	fixture.setArchiveBody('e'.repeat(1024 * 1024 + 1));
	const oversizedError = await runHarness('download', fixture.baseUrl, path.join(root, 'oversized-error'));
	assert.equal(oversizedError.ok, false);
	assert.equal(oversizedError.error_class, 'RuntimeException');
	assert.deepEqual(oversizedError.private_files, [], 'oversized error removes its bounded temporary prefix');

	fixture.resetRequests();
	fixture.setArchiveStatus(200);
	fixture.setArchiveBody(releaseBody);
	fixture.setCloseArchiveConnection(true);
	const networkFailure = await runHarness('download', fixture.baseUrl, path.join(root, 'network-failure'));
	assert.equal(networkFailure.ok, false);
	assert.deepEqual(networkFailure.private_files, [], 'network failure removes the partial download temp file');
	assert.deepEqual(fixture.requests, ['/repository/v2/core.json', '/repository/v2/core.tar.gz']);
});

test('Core updater and release archive remain after package updater removal', async () => {
	const [coreUpdater, coreArchive, coreExtractor, transport, admin, upgrade, serviceActions] = await Promise.all([
		source('snappymail/coreupdater.php'),
		source('snappymail/corereleasearchive.php'),
		source('snappymail/corereleasetarextractor.php'),
		source('snappymail/repositorytransport.php'),
		readFile(path.join(applicationRoot, 'RainLoop/ActionsAdmin.php'), 'utf8'),
		readFile(path.join(applicationRoot, 'snappymail/upgrade.php'), 'utf8'),
		readFile(path.join(applicationRoot, 'RainLoop/ServiceActions.php'), 'utf8')
	]);

	for (const forbidden of [
		'getRepositoryData', 'getPackagesList', 'installPackage', 'deletePackage', 'enablePackage', 'APP_PLUGINS_PATH'
	]) {
		assert.doesNotMatch(coreUpdater, new RegExp(forbidden), 'CoreUpdater contains package dependency ' + forbidden);
		assert.doesNotMatch(coreArchive, new RegExp(forbidden), 'Core release archive contains package dependency ' + forbidden);
	}
	assert.match(coreUpdater, /RepositoryTransport/);
	assert.match(coreUpdater, /CoreReleaseArchive::install/);
	assert.doesNotMatch(coreUpdater + coreArchive, /\.phar/i);
	assert.doesNotMatch(coreUpdater + coreArchive, /SnappyMail\\Repository::/);
	assert.match(coreArchive, /APP_INDEX_ROOT_PATH/);
	assert.match(coreArchive, /extractTo\(\$target, 'snappymail\/'\)/);
	assert.match(coreArchive, /CoreReleaseTarExtractor::extract/,
		'Core uses only its dedicated archive fallback when PharData is absent');
	assert.match(coreArchive, /PharData/);
	assert.match(coreExtractor, /index\.php/);
	assert.match(coreExtractor, /snappymail\//);
	assert.match(coreExtractor, /realpath\(APP_INDEX_ROOT_PATH\)/,
		'Core archive reader fixes its destination to APP_INDEX_ROOT_PATH');
	assert.doesNotMatch(coreExtractor, /APP_PLUGINS_PATH|installPackage|deletePackage|packages\.json|SnappyMail\\Repository|RainLoop\\Plugins/,
		'Core archive reader has no plugin/package caller or destination');
	assert.doesNotMatch(coreExtractor, /extractTo\s*\(/,
		'Core archive reader exposes no generic extraction API');
	assert.doesNotMatch(transport, /packages\.json|RepositoryCache|APP_PLUGINS_PATH|installPackage|deletePackage/,
		'RepositoryTransport is retained for Core updates and has no plugin catalogue operations');
	await assert.rejects(
		access(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/snappymail/repository.php')),
		{ code: 'ENOENT' },
		'the package repository implementation is removed'
	);
	assert.match(admin, /\$oCoreUpdater->getLatestCoreInfo\(\)/);
	assert.match(admin, /\$oCoreUpdater->canUpdateCore\(\)/);
	assert.match(admin, /CoreUpdater\(\)\)->update\(\)/);
	assert.doesNotMatch(admin, /Repository::(?:getLatestCoreInfo|canUpdateCore|downloadCore)/);
	assert.match(admin, /\$this->IsAdminLoggined\(\);\s*\$oCoreUpdater = new \\SnappyMail\\CoreUpdater\(\);/);
	assert.match(admin, /header\('Connection: close'\);\s*return \$this->DefaultResponse\(/);
	assert.doesNotMatch(upgrade, /function\s+core\s*\(|Nextcloud|ownCloud/,
		'deleted integrations have no Core-update compatibility entry point');
	assert.match(serviceActions, /IsAdminLoggined\(\)/, 'native Admin authorization remains in JSON dispatch');
	assert.match(transport, /curl_proxy/);
	assert.match(transport, /curl_proxy_auth/);
	assert.match(transport, /max_response_kb = 0/);
	assert.match(transport, /timeout = 15/);
	assert.match(transport, /200 !== \$oResponse->status/);
});
