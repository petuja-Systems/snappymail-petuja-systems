import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	demoContactsConfiguration,
	demoContactsStatus,
	detectPdoSqlite
} from '../scripts/dev-demo-contacts.mjs';
import {
	assertDemoRuntimeSupported,
	demoPrivateDataRoot,
	demoWorkspacePath,
	ensureDemoDirectories,
	prepareDemoWorkspace,
	readDemoFile,
	resetDemoWorkspace,
	writeDemoFile,
	verifyDemoRootMarker
} from '../scripts/dev-demo-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakePhp(stdout, { status = 0, error = undefined } = {}) {
	return (_command, args, options) => {
		assert.deepEqual(args.slice(0, 1), ['-r']);
		assert.equal(options.encoding, 'utf8');
		return { status, stdout, error };
	};
}

test('demo Contacts enables only a working PDO SQLite extension and driver', () => {
	const available = detectPdoSqlite('php', fakePhp(JSON.stringify({
		pdo: true,
		pdo_sqlite: true,
		drivers: ['mysql', 'sqlite']
	})));
	assert.deepEqual(available, { available: true, reason: '' });
	const existingConfig = [
		'[security]',
		'require_two_factor_auth = Off',
		'',
		'[contacts]',
		'enable = Off',
		'type = mysql',
		'sqlite_global = On',
		'allow_sync = On',
		'persistent_note = keep-me',
		'',
		'[logs]',
		'time_zone = UTC',
		''
	].join('\n');
	const configured = demoContactsConfiguration(existingConfig, available);
	assert.match(configured, /enable = On/);
	assert.match(configured, /type = sqlite/);
	assert.match(configured, /sqlite_global = Off/);
	assert.match(configured, /allow_sync = Off/);
	assert.match(configured, /persistent_note = keep-me/);
	assert.match(configured, /require_two_factor_auth = Off/);
	assert.match(configured, /time_zone = UTC/);
	assert.equal(configured, demoContactsConfiguration(configured, available),
		'repeated demo startup keeps the local Contacts config deterministic');
	assert.match(demoContactsStatus(available), /isolated per-account SQLite/);

	for (const [capability, reason] of [
		[{ pdo: false, pdo_sqlite: false, drivers: [] }, 'PHP PDO extension is unavailable.'],
		[{ pdo: true, pdo_sqlite: false, drivers: ['mysql'] }, 'PHP pdo_sqlite extension is unavailable.'],
		[{ pdo: true, pdo_sqlite: true, drivers: ['mysql'] }, 'PHP PDO SQLite driver is unavailable.']
	]) {
		const unavailable = detectPdoSqlite('php', fakePhp(JSON.stringify(capability)));
		assert.deepEqual(unavailable, { available: false, reason });
		assert.match(demoContactsConfiguration('', unavailable), /enable = Off/);
		assert.match(demoContactsConfiguration('', unavailable), /sqlite_global = Off/);
		assert.equal(demoContactsStatus(unavailable), 'Contacts: unavailable (' + reason + ')');
	}
});

test('demo Contacts reports PHP probe failures with a concrete reason', () => {
	assert.match(
		detectPdoSqlite('missing-php', fakePhp('', { error: new Error('spawn missing-php ENOENT') })).reason,
		/Could not run PHP CLI/
	);
	assert.match(
		detectPdoSqlite('php', fakePhp('', { status: 7 })).reason,
		/exit status 7/
	);
	assert.match(
		detectPdoSqlite('php', fakePhp('not-json')).reason,
		/returned invalid output/
	);
	assert.match(
		detectPdoSqlite('php', fakePhp('null')).reason,
		/returned invalid output/
	);
});

test('demo Contacts settings are reachable only through the local launcher', async () => {
	const [demoScript, packageJson, index, include] = await Promise.all([
		readFile(path.join(repositoryRoot, 'scripts/dev-demo-main.mjs'), 'utf8'),
		readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
		readFile(path.join(repositoryRoot, 'index.php'), 'utf8'),
		readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/include.php'), 'utf8')
	]);
	assert.equal(packageJson.scripts['dev:demo'], 'node scripts/dev-demo.mjs');
	assert.match(demoScript, /from '\.\/dev-demo-contacts\.mjs'/);
	assert.match(demoScript, /_data_\/_default_\/configs\/application\.ini/);
	assert.match(demoScript, /demoContactsConfiguration\(configs, contactsAvailability\)/);
	assert.match(demoScript, /const demoCacheIndex = 'petuja-email-local-demo-v3'/);
	assert.match(demoScript, /'\[cache\]',\s*'index = "' \+ demoCacheIndex \+ '"'/);
	assert.doesNotMatch(demoScript, /APP_CONFIGURATION_NAME/);
	assert.doesNotMatch(index, /dev-demo-contacts|demo-local\.ini/);
	assert.doesNotMatch(include, /dev-demo-contacts|demo-local\.ini/);
});

test('local demo uses an isolated private-data root and rejects root include before workspace writes', async t => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-demo-runtime-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const syntheticRepositoryRoot = path.join(temporaryRoot, 'repository');
	await mkdir(syntheticRepositoryRoot);
	const demoDataRoot = path.join(temporaryRoot, 'private-demo');
	assert.equal(
		demoPrivateDataRoot(demoDataRoot),
		path.join(demoDataRoot, '_data_', '_default_')
	);
	await assertDemoRuntimeSupported(syntheticRepositoryRoot);
	await assert.rejects(lstat(demoDataRoot), { code: 'ENOENT' }, 'the preflight does not create demo state');

	await writeFile(path.join(syntheticRepositoryRoot, 'include.php'), '<?php define("MULTIDOMAIN", true);');
	await assert.rejects(
		assertDemoRuntimeSupported(syntheticRepositoryRoot),
		/Local demo requires the default private-data layout.*may redirect runtime data or configuration/
	);
	await assert.rejects(lstat(demoDataRoot), { code: 'ENOENT' },
		'unsupported Multidomain mode is rejected before configuration writes');

	const demoScript = await readFile(path.join(repositoryRoot, 'scripts/dev-demo-main.mjs'), 'utf8');
	const preflight = demoScript.indexOf('await assertDemoRuntimeSupported(repositoryRoot);');
	const prepareWorkspace = demoScript.indexOf('await prepareWorkspace();');
	assert.ok(preflight >= 0 && prepareWorkspace > preflight,
		'the launcher rejects unsupported runtime configuration before starting build or services');
});

test('demo workspace paths are deterministic and OS-scoped', () => {
	const first = demoWorkspacePath('C:\\repo\\petuja.email', {
		temporaryDirectory: 'C:\\Users\\robin\\AppData\\Local\\Temp', platform: 'win32'
	});
	const repeated = demoWorkspacePath('c:\\REPO\\petuja.email', {
		temporaryDirectory: 'C:\\Users\\robin\\AppData\\Local\\Temp', platform: 'win32'
	});
	const otherRepo = demoWorkspacePath('C:\\repo\\other', {
		temporaryDirectory: 'C:\\Users\\robin\\AppData\\Local\\Temp', platform: 'win32'
	});
	assert.equal(first, repeated);
	assert.notEqual(first, otherRepo);
	assert.equal(path.win32.dirname(first), 'C:\\Users\\robin\\AppData\\Local\\Temp');
});

test('demo workspace files require a matching marker and reset removes only the marked root', async t => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-demo-runtime-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const repository = path.join(temporaryRoot, 'repository');
	const stateRoot = path.join(temporaryRoot, 'state');
	await Promise.all([mkdir(repository), mkdir(stateRoot)]);
	const workspace = await prepareDemoWorkspace(repository, { temporaryDirectory: stateRoot });
	assert.equal((await verifyDemoRootMarker(workspace)).type, 'petuja.email-local-demo');
	await ensureDemoDirectories(workspace, 'configs/private');
	await writeDemoFile(workspace, 'configs/private/demo.ini', 'synthetic=true\n');
	assert.equal((await readDemoFile(workspace, 'configs/private/demo.ini')).toString(), 'synthetic=true\n');
	await assert.rejects(writeDemoFile(workspace, '../outside.txt', 'bad'), /unsafe relative/);
	assert.equal(await resetDemoWorkspace(repository, { temporaryDirectory: stateRoot }), true);
	assert.equal(await resetDemoWorkspace(repository, { temporaryDirectory: stateRoot }), false);
	assert.equal(await lstat(path.join(stateRoot, path.basename(workspace.root))).then(() => true, () => false), false);
});

test('demo reset refuses an unmarked or modified workspace', async t => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-demo-runtime-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const repository = path.join(temporaryRoot, 'repository');
	const stateRoot = path.join(temporaryRoot, 'state');
	await Promise.all([mkdir(repository), mkdir(stateRoot)]);
	const workspace = await prepareDemoWorkspace(repository, { temporaryDirectory: stateRoot });
	await writeFile(path.join(workspace.root, '.petuja-email-demo-root.json'), 'modified marker');
	await assert.rejects(resetDemoWorkspace(repository, { temporaryDirectory: stateRoot }), /marker is invalid/);
	assert.equal(await lstat(workspace.root).then(() => true, () => false), true);
});

test('POSIX demo workspaces must remain owner-only and owned by the current user', async t => {
	if ('win32' === process.platform || 'function' !== typeof process.getuid) {
		t.skip('POSIX ownership and mode checks require a POSIX host');
		return;
	}
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-demo-private-root-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const repository = path.join(temporaryRoot, 'repository');
	const stateRoot = path.join(temporaryRoot, 'state');
	await Promise.all([mkdir(repository), mkdir(stateRoot)]);
	const workspace = await prepareDemoWorkspace(repository, { temporaryDirectory: stateRoot });
	await chmod(workspace.root, 0o777);
	await assert.rejects(verifyDemoRootMarker(workspace), /not owned by this user with owner-only permissions/);
	await assert.rejects(readDemoFile(workspace, '.petuja-email-demo-root.json'), /not owned by this user with owner-only permissions/);
	await assert.rejects(resetDemoWorkspace(repository, { temporaryDirectory: stateRoot }), /not owned by this user with owner-only permissions/);
});

test('Windows demo tree audit rejects reparse points before descending', async () => {
	const script = await readFile(path.join(repositoryRoot,
		'snappymail/v/0.0.0/app/libraries/snappymail/storage/accountpath-acl.ps1'), 'utf8');
	const start = script.indexOf("'VerifyDemoTree' {");
	const end = script.indexOf("'VerifyStoragePath' {", start);
	assert.ok(start >= 0 && end > start, 'the demo-tree operation is present');
	const operation = script.slice(start, end);
	const reparseCheck = operation.indexOf('FileAttributes]::ReparsePoint');
	const descendantPush = operation.indexOf('$directories.Push($item)');
	assert.ok(operation.includes('SearchOption]::TopDirectoryOnly'),
		'directory enumeration must not recursively follow reparse points');
	assert.ok(reparseCheck >= 0 && descendantPush > reparseCheck,
		'reparse points must be rejected before child directories are queued');
	assert.ok(!operation.includes('SearchOption]::AllDirectories'),
		'do not use recursive enumeration across unverified children');
});
