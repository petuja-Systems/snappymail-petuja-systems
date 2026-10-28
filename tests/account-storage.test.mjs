import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	windowsPowerShellEnvironment,
	windowsPowerShellExecutable
} from './fixtures/windows-acl.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = 'win32' === process.platform;
const fixtureTimeout = isWindows ? 120000 : 15000;
const raceBarrierWaitTimeout = isWindows ? 20000 : 5000;
const raceTestTimeout = isWindows ? 60000 : 20000;
const windowsAclScript = path.join(root,
	'snappymail/v/0.0.0/app/libraries/snappymail/storage/accountpath-acl.ps1');
const windowsPowerShell = isWindows
	? windowsPowerShellExecutable(process.env.SystemRoot || process.env.SYSTEMROOT)
	: '';
const windowsEnvironment = isWindows ? windowsPowerShellEnvironment(process.env) : process.env;
let testTemporaryRoot = tmpdir();
if (isWindows) {
	testTemporaryRoot = path.join(homedir(), '.p-' + process.pid + '-' + randomUUID().slice(0, 16));
	const prepared = spawnSync(windowsPowerShell, [
		'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
		'-File', windowsAclScript, '-Operation', 'PrepareDemoRoot', '-Path', testTemporaryRoot
	], {
		cwd: root,
		encoding: 'utf8',
		env: windowsEnvironment,
		timeout: 15000,
		windowsHide: true
	});
	try {
		await access(testTemporaryRoot);
		test.after(() => rm(testTemporaryRoot, { recursive: true, force: true }));
	} catch {
		// Preparation failed before creating the unique scratch directory.
	}
	assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
	assert.equal(prepared.stdout.trim(), 'CREATED');
}
function createTemporaryDirectory(prefix) {
	return mkdtemp(path.join(testTemporaryRoot, prefix));
}

function runWindowsAclHelper(operation, target, privateBase) {
	return spawnSync(windowsPowerShell, [
		'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
		'-File', windowsAclScript, '-Operation', operation, '-Path', target,
		'-PrivateBase', privateBase
	], {
		cwd: root,
		encoding: 'utf8',
		env: windowsEnvironment,
		timeout: 15000,
		windowsHide: true
	});
}

function runWindowsStorageFixture(temporary, mode, timeout = fixtureTimeout, phpArguments = [], fixtureArguments = []) {
	return spawnSync(process.env.PHP_BINARY || 'php',
		[...phpArguments, path.join(root, 'tests/fixtures/account-storage.php'), temporary, mode, ...fixtureArguments],
		{ cwd: root, encoding: 'utf8', timeout });
}

function runIcacls(...args) {
	const executable = path.join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32', 'icacls.exe');
	return spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
}

for (const mode of ['identity', 'fresh', 'read-only', 'ambiguous', 'legacy', 'invalid', 'locking',
	'deletion', 'pending', 'recovery', 'replacement', 'gc', 'cache', 'orphan', 'unknown-child', 'deletion-failure',
	'reattest', 'reattest-v2', 'nofsync-adopt', 'nofsync-delete', 'gnupg-safe',
	'gnupg-wrong-alias', 'gnupg-external-home', 'gnupg-server-home', 'gnupg-unprivate-alias',
	'initial-registry-recovery', 'leaf-links', 'allocation-main-absent', 'allocation-main-empty', 'allocation-main-dirty',
	'allocation-child-absent', 'allocation-child-empty', 'allocation-child-dirty']) {
	if (isWindows && mode === 'gnupg-safe') {
		test('M7.9 account storage invariant: ' + mode, {
			skip: 'The positive GnuPG fixture needs PHP symlink privileges and POSIX temp-mode semantics; Windows junction/reparse checks run separately.'
		}, () => {});
		continue;
	}
	test('M7.9 account storage invariant: ' + mode, async t => {
		const temporary = await createTemporaryDirectory('m79-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		if (isWindows && mode === 'gnupg-wrong-alias') {
			const fixture = path.join(root, 'tests/fixtures/account-storage.php');
			const preparation = spawnSync(process.env.PHP_BINARY || 'php',
				['-d', 'sys_temp_dir=' + temporary, fixture, temporary, 'gnupg-wrong-alias-prepare'],
				{ cwd: root, encoding: 'utf8', timeout: fixtureTimeout });
			assert.equal(preparation.status, 0, preparation.stderr + preparation.stdout);
			const { alias } = JSON.parse(preparation.stdout);
			const junctionScript = path.join(temporary, 'create-junction.ps1');
			await writeFile(junctionScript, [
				'param([string]$Link, [string]$Target)',
				'$ErrorActionPreference = "Stop"',
				'New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null', ''
			].join('\n'));
			const junction = spawnSync(windowsPowerShell, [
				'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
				'-File', junctionScript, '-Link', alias, '-Target', path.join(temporary, 'unowned')
			], { cwd: root, encoding: 'utf8', env: windowsEnvironment, timeout: 15000, windowsHide: true });
			await rm(junctionScript, { force: true });
			assert.equal(junction.error, undefined, 'junction creation launch failed: ' + junction.error);
			assert.equal(junction.status, 0, junction.stderr + junction.stdout);
		}
		if (mode === 'deletion-failure') {
			const preparation = spawnSync(process.env.PHP_BINARY || 'php',
				[path.join(root, 'tests/fixtures/account-storage.php'), temporary, 'deletion-prepare'],
				{ cwd: root, encoding: 'utf8', timeout: fixtureTimeout });
			assert.equal(preparation.status, 0, preparation.stderr + preparation.stdout);
		}
		const result = spawnSync(process.env.PHP_BINARY || 'php',
			[...(mode.startsWith('gnupg-') ? ['-d', 'sys_temp_dir=' + temporary] : []),
				...(mode.startsWith('nofsync-') ? ['-d', 'disable_functions=fsync'] : []),
				...(mode === 'deletion-failure' ? ['-d', 'disable_functions=unlink'] : []),
				path.join(root, 'tests/fixtures/account-storage.php'), temporary, mode],
			{ cwd: root, encoding: 'utf8', timeout: fixtureTimeout });
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).passed, true);
		if (mode === 'deletion-failure') {
			const retry = spawnSync(process.env.PHP_BINARY || 'php',
				[path.join(root, 'tests/fixtures/account-storage.php'), temporary, 'deletion-resume'],
				{ cwd: root, encoding: 'utf8', timeout: fixtureTimeout });
			assert.equal(retry.status, 0, retry.stderr + retry.stdout);
			assert.equal(JSON.parse(retry.stdout).passed, true);
		}
	});
}

if (isWindows) {
	test('Windows storage traversal accepts create-only access when the child already exists', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-create-only-parent-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const storage = path.join(temporary, 'storage');
		await mkdir(storage);
		const grant = runIcacls(temporary, '/grant', '*S-1-5-11:(AD)');
		assert.equal(grant.status, 0, grant.stderr + grant.stdout);
		const result = runWindowsAclHelper('VerifyStorageBasePath', storage);
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(result.stdout.trim(), 'OK');
	});

	test('Windows storage traversal rejects parent DELETE_CHILD on an existing child', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-delete-child-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const storage = path.join(temporary, 'storage');
		await mkdir(storage);
		const grant = runIcacls(temporary, '/grant', '*S-1-5-11:(DC)');
		assert.equal(grant.status, 0, grant.stderr + grant.stdout);
		const result = runWindowsAclHelper('VerifyStorageBasePath', storage);
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stderr, /untrusted write-capable ACL/i);
	});

	test('Windows storage traversal rejects child DELETE on an existing component', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-child-delete-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const storage = path.join(temporary, 'storage');
		const leaf = path.join(storage, 'leaf');
		await mkdir(leaf, { recursive: true });
		const grant = runIcacls(storage, '/grant', '*S-1-5-11:(D)');
		assert.equal(grant.status, 0, grant.stderr + grant.stdout);
		const result = runWindowsAclHelper('VerifyStorageBasePath', leaf);
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stderr, /untrusted write-capable ACL/i);
	});

	test('Windows AccountPath initializes fresh private storage for the current user', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-current-user-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const result = runWindowsStorageFixture(temporary, 'windows-absent', 30000);
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).passed, true);
	});

	test('Windows AccountPath handles spaces and Unicode paths', async t => {
		const temporary = await mkdtemp(path.join(testTemporaryRoot, 'petuja storage ä-'));
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const result = runWindowsStorageFixture(temporary, 'windows-absent', 30000);
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).passed, true);
	});

	test('Windows AccountPath rejects inherited ACL grants to an untrusted identity', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-unsafe-acl-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const grant = runIcacls(temporary, '/grant', '*S-1-5-11:(OI)(CI)R');
		assert.equal(grant.status, 0, grant.stderr + grant.stdout);
		const result = runWindowsStorageFixture(temporary, 'windows-reject');
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).passed, true);
	});

	test('Windows AccountPath rejects inherited-only ACL grants before creating storage', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-inherit-only-acl-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const grant = runIcacls(temporary, '/grant', '*S-1-5-11:(OI)(CI)(IO)M');
		assert.equal(grant.status, 0, grant.stderr + grant.stdout);
		const result = runWindowsAclHelper('VerifyStorageBasePath', path.join(temporary, 'storage'), temporary);
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stderr, /untrusted inheritable ACL/i);
	});

	for (const [name, sid, rights] of [
		['Everyone read access', 'S-1-1-0', 'R'],
		['Users write access', 'S-1-5-32-545', 'M'],
		['Authenticated Users write access', 'S-1-5-11', 'M']
	]) {
		test('Windows private storage rejects ' + name, async t => {
			const temporary = await createTemporaryDirectory('petuja-account-storage-acl-');
			t.after(() => rm(temporary, { recursive: true, force: true }));
			const grant = runIcacls(temporary, '/grant', `*${sid}:(OI)(CI)${rights}`);
			assert.equal(grant.status, 0, grant.stderr + grant.stdout);
			const result = runWindowsStorageFixture(temporary, 'windows-reject');
			assert.equal(result.status, 0, result.stderr + result.stdout);
			assert.equal(JSON.parse(result.stdout).passed, true);
		});
	}

	test('Windows AccountPath fails closed when ACL inspection cannot run', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-no-acl-tool-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const result = runWindowsStorageFixture(temporary, 'windows-reject', 30000,
			['-d', 'disable_functions=proc_open']);
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).passed, true);
	});

	test('Windows offline CLI rejects an ownership map readable by Authenticated Users', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-map-acl-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const prepared = spawnSync(process.env.PHP_BINARY || 'php',
			[path.join(root, 'tests/fixtures/account-storage.php'), temporary, 'dry-run-prepare'],
			{ cwd: root, encoding: 'utf8', timeout: fixtureTimeout });
		assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
		const grant = runIcacls(path.join(temporary, 'authoritative.json'), '/grant', '*S-1-5-11:R');
		assert.equal(grant.status, 0, grant.stderr + grant.stdout);
		const result = runAccountStorageCli('--offline', '--dry-run',
			'--storage=' + path.join(temporary, 'storage'),
			'--map=' + path.join(temporary, 'authoritative.json'));
		assert.equal(result.status, 1);
		assert.equal(result.stderr, 'Account storage unavailable; offline operator ownership review required. No automatic recovery.\n');
	});

	test('Windows offline CLI rejects a private map whose parent permits untrusted replacement', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-map-parent-acl-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const prepared = spawnSync(process.env.PHP_BINARY || 'php',
			[path.join(root, 'tests/fixtures/account-storage.php'), temporary, 'dry-run-prepare'],
			{ cwd: root, encoding: 'utf8', timeout: fixtureTimeout });
		assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
		const map = path.join(temporary, 'authoritative.json');
		const grant = runIcacls(temporary, '/grant', '*S-1-5-11:F');
		assert.equal(grant.status, 0, grant.stderr + grant.stdout);
		const inspection = runWindowsAclHelper('VerifyPrivateFile', map, temporary);
		assert.notEqual(inspection.status, 0, inspection.stdout);
		assert.match(inspection.stderr, /ancestor grants an untrusted write-capable ACL/i);
		const result = runAccountStorageCli('--offline', '--dry-run',
			'--storage=' + path.join(temporary, 'storage'), '--map=' + map);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, 'Account storage unavailable; offline operator ownership review required. No automatic recovery.\n');
	});

	test('Windows ACL helper rejects reparse points in account storage paths', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-reparse-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const target = path.join(temporary, 'target');
		await mkdir(path.join(target, 'child'), { recursive: true });
		const junction = path.join(temporary, 'junction');
		await symlink(target, junction, 'junction');
		const result = runWindowsAclHelper('VerifyStoragePath', path.join(junction, 'child'), temporary);
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stderr, /reparse point/i);
	});

	test('Windows AccountPath rejects a junction before resolving the storage base', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-base-reparse-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const target = path.join(temporary, 'target');
		await mkdir(path.join(target, 'child'), { recursive: true });
		const junction = path.join(temporary, 'junction');
		await symlink(target, junction, 'junction');
		const result = runWindowsStorageFixture(temporary, 'windows-reparse-base', 30000, [], [
			path.join(junction, 'child', 'storage')
		]);
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).passed, true);
	});

	test('Windows AccountPath rejects dot segments before normalizing the storage base', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-dot-segment-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const result = runWindowsStorageFixture(temporary, 'windows-reparse-base', 30000, [], [
			path.join(temporary, 'junction') + '\\..\\storage'
		]);
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).passed, true);
	});

	test('Windows ACL helper accepts only a missing leaf below a verified private parent', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-missing-leaf-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const missing = path.join(temporary, 'absent-record');
		const result = runWindowsAclHelper('VerifyStoragePathOrMissing', missing, temporary);
		assert.equal(result.status, 0, result.stderr + result.stdout);
		assert.equal(result.stdout.trim(), 'MISSING');

		const unsafeParent = runWindowsAclHelper('VerifyStoragePathOrMissing',
			path.join(temporary, 'absent-directory', 'absent-record'), temporary);
		assert.notEqual(unsafeParent.status, 0, unsafeParent.stdout);
	});

	test('Windows demo-tree verification rejects a junction to a separate private root', async t => {
		const targetRoot = path.join(homedir(), '.petuja-email-storage-external-' + process.pid + '-' + randomUUID());
		const prepared = runWindowsAclHelper('PrepareDemoRoot', targetRoot, testTemporaryRoot);
		assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
		assert.equal(prepared.stdout.trim(), 'CREATED');
		t.after(() => rm(targetRoot, { recursive: true, force: true }));

		const junction = path.join(testTemporaryRoot, 'reparse-to-external-root');
		t.after(() => rm(junction, { recursive: true, force: true }));
		await symlink(targetRoot, junction, 'junction');

		const result = runWindowsAclHelper('VerifyDemoTree', testTemporaryRoot);
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stderr, /reparse point in the local demo tree/i);
	});

	test('Windows ACL helper rejects an untrusted owner', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-owner-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const target = path.join(temporary, 'owned-by-untrusted-group');
		await mkdir(target);
		const owner = runIcacls(target, '/setowner', '*S-1-5-11');
		if (0 !== owner.status) {
			t.skip('This Windows token cannot assign the synthetic directory to an untrusted owner SID.');
			return;
		}
		const result = runWindowsAclHelper('VerifyStoragePath', target, temporary);
		assert.notEqual(result.status, 0, result.stdout);
		assert.match(result.stderr, /untrusted identity owns private storage/i);
	});

	test('Windows SyncDirectory flushes a protected directory and rejects a file', async t => {
		const temporary = await createTemporaryDirectory('petuja-account-storage-flush-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const flushed = runWindowsAclHelper('SyncDirectory', temporary, temporary);
		assert.equal(flushed.status, 0, flushed.stderr + flushed.stdout);
		assert.equal(flushed.stdout.trim(), 'OK');

		const file = path.join(temporary, 'not-a-directory');
		await writeFile(file, 'synthetic');
		const rejected = runWindowsAclHelper('SyncDirectory', file, temporary);
		assert.notEqual(rejected.status, 0, rejected.stdout);
		assert.match(rejected.stderr, /Only a verified regular directory can be flushed/);
	});
}

async function snapshotTree(directory) {
	const snapshot = {};
	const visit = async relative => {
		const current = path.join(directory, relative);
		const info = await lstat(current, { bigint: true });
		const isDirectory = info.isDirectory();
		snapshot[relative || '.'] = {
			mode: Number(info.mode & 0o7777n),
			ino: info.ino.toString(),
			mtimeNs: info.mtimeNs.toString(),
			size: info.size.toString(),
			data: isDirectory ? null : (await readFile(current)).toString('base64')
		};
		if (isDirectory) {
			for (const name of await readdir(current)) {
				await visit(path.join(relative, name));
			}
		}
	};
	await visit('');
	return snapshot;
}

async function pathExists(target) {
	try { await lstat(target); return true; } catch (error) {
		if (error.code === 'ENOENT') { return false; }
		throw error;
	}
}

function runAccountStorageCli(...args) {
	return spawnSync(process.env.PHP_BINARY || 'php', [path.join(root, 'cli/account-storage.php'), ...args],
		{ cwd: root, encoding: 'utf8', timeout: fixtureTimeout });
}

for (const [mode, extraFlags, expectedStatus] of [
	['dry-run-prepare', [], 0],
	['dry-run-prepare-invalid', [], 1],
	['dry-run-prepare-resume', ['--resume'], 0],
	['dry-run-prepare-resume-mismatch', ['--resume'], 1]
]) {
	test('M8 account storage dry-run is read-only: ' + mode, async t => {
		const temporary = await createTemporaryDirectory('petuja-m8-dry-run-');
		t.after(() => rm(temporary, { recursive: true, force: true }));
		const prepared = spawnSync(process.env.PHP_BINARY || 'php',
			[path.join(root, 'tests/fixtures/account-storage.php'), temporary, mode],
			{ cwd: root, encoding: 'utf8', timeout: 15000 });
		assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
		const before = await snapshotTree(temporary);
		const storage = path.join(temporary, 'storage');
		const result = runAccountStorageCli('--offline', '--dry-run', ...extraFlags,
			'--storage=' + storage, '--map=' + path.join(temporary, 'authoritative.json'));
		assert.equal(result.status, expectedStatus, result.stderr + result.stdout);
		assert.doesNotMatch(result.stderr + result.stdout, /reader\+notes|example\.test|authoritative\.json|storage-v2/);
		if (0 === expectedStatus) {
			assert.equal(result.stdout, 'Dry-run metadata preflight passed; adoption is not confirmed.\n');
		} else {
			assert.match(result.stderr, /Account storage unavailable; offline operator ownership review required/);
		}
		assert.deepEqual(await snapshotTree(temporary), before,
			'dry-run must preserve names, file bytes, inodes, modes and modification times');
		assert.equal(await pathExists(storage + '-v2'), mode.startsWith('dry-run-prepare-resume'));
		if (mode.startsWith('dry-run-prepare-resume')) {
			assert.equal(await pathExists(path.join(storage + '-v2', '.pending')), true);
			assert.equal(await pathExists(path.join(storage + '-v2', '.identity-' + 'c'.repeat(24))), true);
			assert.equal(await pathExists(path.join(storage + '-v2', '.identity.json')),
				mode === 'dry-run-prepare-resume-mismatch');
		}
	});
}

test('M8 account storage dry-run rejects re-attestation without touching the inventory', async t => {
	const temporary = await createTemporaryDirectory('petuja-m8-dry-run-options-');
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const prepared = spawnSync(process.env.PHP_BINARY || 'php',
		[path.join(root, 'tests/fixtures/account-storage.php'), temporary, 'dry-run-prepare'],
		{ cwd: root, encoding: 'utf8', timeout: 15000 });
	assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
	const before = await snapshotTree(temporary);
	const result = runAccountStorageCli('--offline', '--dry-run', '--reattest',
		'--storage=' + path.join(temporary, 'storage'), '--map=' + path.join(temporary, 'authoritative.json'));
	assert.equal(result.status, 2);
	assert.equal(result.stderr, 'Dry-run cannot be combined with re-attestation.\n');
	assert.deepEqual(await snapshotTree(temporary), before);
});

test('M8 account storage dry-run remains read-only and available without fsync', async t => {
	const temporary = await createTemporaryDirectory('petuja-m8-dry-run-nofsync-');
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const prepared = spawnSync(process.env.PHP_BINARY || 'php',
		[path.join(root, 'tests/fixtures/account-storage.php'), temporary, 'dry-run-prepare'],
		{ cwd: root, encoding: 'utf8', timeout: 15000 });
	assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
	const before = await snapshotTree(temporary);
	const result = spawnSync(process.env.PHP_BINARY || 'php', ['-d', 'disable_functions=fsync',
		path.join(root, 'cli/account-storage.php'), '--offline', '--dry-run',
		'--storage=' + path.join(temporary, 'storage'), '--map=' + path.join(temporary, 'authoritative.json')],
	{ cwd: root, encoding: 'utf8', timeout: 15000 });
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.equal(result.stdout, 'Dry-run metadata preflight passed; adoption is not confirmed.\n');
	assert.deepEqual(await snapshotTree(temporary), before);
});

test('M8 account storage dry-run does not create a missing storage parent', async t => {
	const temporary = await createTemporaryDirectory('petuja-m8-dry-run-missing-');
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const map = path.join(temporary, 'authoritative.json');
	await writeFile(map, JSON.stringify({ authoritative_ownership: true, accounts: [] }), { mode: 0o600 });
	const before = await snapshotTree(temporary);
	const missingParent = path.join(temporary, 'not-created');
	const result = runAccountStorageCli('--offline', '--dry-run', '--storage=' + path.join(missingParent, 'storage'),
		'--map=' + map);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Account storage unavailable; offline operator ownership review required/);
	assert.deepEqual(await snapshotTree(temporary), before);
	assert.equal(await pathExists(missingParent), false);
});


test('M7.9 provider write and deletion share the complete I/O gate', { timeout: raceTestTimeout }, async t => {
	const temporary = await createTemporaryDirectory('petuja-m79-race-');
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const fixture = path.join(root, 'tests/fixtures/account-storage.php');
	const processes = [];
	const start = mode => {
		const child = spawn(process.env.PHP_BINARY || 'php', [fixture, temporary, mode]);
		let output = '';
		child.stdout.on('data', data => { output += data; });
		child.stderr.on('data', data => { output += data; });
		const result = new Promise(resolve => child.once('exit', code => resolve({ code, output })));
		processes.push(child);
		return result;
	};
	t.after(() => processes.forEach(child => { if (child.exitCode === null) { child.kill('SIGTERM'); } }));
	const exists = async name => { try { await access(path.join(temporary, name)); return true; } catch { return false; } };
	const wait = async name => {
		const deadline = Date.now() + raceBarrierWaitTimeout;
		while (!await exists(name)) {
			assert.ok(Date.now() < deadline, 'fixture marker: ' + name);
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};
	const writer = start('race-write');
	await wait('write-resolved');
	const deletion = start('race-delete');
	await wait('delete-started');
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(await exists('delete-completed'), false, 'deletion must wait for the resolved write');
	await writeFile(path.join(temporary, 'release-write'), 'release');
	for (const result of await Promise.all([writer, deletion])) {
		assert.equal(result.code, 0, result.output);
	}
	assert.equal(await exists('delete-completed'), true);
});

test('M7.9 session touch and GC share the complete I/O gate', { timeout: raceTestTimeout }, async t => {
	const temporary = await createTemporaryDirectory('petuja-m79-race-');
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const fixture = path.join(root, 'tests/fixtures/account-storage.php');
	const processes = [];
	const start = mode => {
		const child = spawn(process.env.PHP_BINARY || 'php', [fixture, temporary, mode]);
		let output = '';
		child.stdout.on('data', data => { output += data; });
		child.stderr.on('data', data => { output += data; });
		const result = new Promise(resolve => child.once('exit', code => resolve({ code, output })));
		processes.push(child);
		return result;
	};
	t.after(() => processes.forEach(child => { if (child.exitCode === null) { child.kill('SIGTERM'); } }));
	const exists = async name => { try { await access(path.join(temporary, name)); return true; } catch { return false; } };
	const wait = async name => {
		const deadline = Date.now() + raceBarrierWaitTimeout;
		while (!await exists(name)) {
			assert.ok(Date.now() < deadline, 'fixture marker: ' + name);
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};
	const writer = start('race-read');
	await wait('read-resolved');
	const deletion = start('race-gc');
	await wait('gc-started');
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(await exists('gc-completed'), false, 'GC must wait for the resolved read and its session touch');
	await writeFile(path.join(temporary, 'release-read'), 'release');
	for (const result of await Promise.all([writer, deletion])) {
		assert.equal(result.code, 0, result.output);
	}
	assert.equal(await exists('gc-completed'), true);
});
