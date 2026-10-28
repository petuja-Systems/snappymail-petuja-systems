import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releasePhp = process.env.RELEASE_TEST_PHP_BIN || 'php';
const requestedSourceSha = process.env.RELEASE_TEST_SOURCE_SHA;

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		...options,
		encoding: 'utf8',
		env: { ...process.env, ...(options.env || {}), LC_ALL: 'C' },
	});
	assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
	return result.stdout;
}

function runWithUmask(command, args, options = {}) {
	return run('/bin/sh', ['-c', 'umask 022; exec "$@"', 'release-archive-test', command, ...args], options);
}

function zipEntries(archivePath) {
	const phpSource = String.raw`
putenv("TZ=UTC");
date_default_timezone_set("UTC");
$zip = new ZipArchive();
if (true !== $zip->open($argv[1])) {
    fwrite(STDERR, "Unable to open ZIP archive\n");
    exit(2);
}
$entries = [];
for ($index = 0; $index < $zip->numFiles; $index++) {
    if (!$zip->getExternalAttributesIndex($index, $opsys, $attributes)) {
        fwrite(STDERR, "Missing ZIP external attributes\n");
        exit(3);
    }
    $mode = ($attributes >> 16) & 0xffff;
    $entries[] = [
        'name' => $zip->getNameIndex($index),
        'opsys' => $opsys,
        'type' => $mode & 0170000,
        'permissions' => $mode & 07777,
        'mtime' => $zip->statIndex($index)['mtime'],
    ];
}
echo json_encode($entries, JSON_THROW_ON_ERROR);
`;
	return JSON.parse(run(releasePhp, ['-r', phpSource, archivePath]));
}

async function assertCanonicalZip(archivePath, extractedPath, version, sourceEpoch, aurVariant = false) {
	const entries = zipEntries(archivePath);
	const appRoot = `snappymail/v/${version}`;
	const canonicalMtime = Math.floor(Number(sourceEpoch) / 2) * 2;
	const executablePaths = new Set([
		`${appRoot}/app/libraries/RainLoop/Providers/Identities.php`,
		`${appRoot}/app/libraries/RainLoop/Providers/Identities/FileIdentities.php`,
		`${appRoot}/app/libraries/RainLoop/Providers/Identities/IIdentities.php`,
		`${appRoot}/app/libraries/snappymail/http/csp.php`,
		`${appRoot}/imapsync.php`,
	]);
	const observedExecutables = new Set();

	assert.ok(entries.length > 0, 'release ZIP has members');
	for (const entry of entries) {
		assert.equal(entry.opsys, 3, `${entry.name} uses Unix external attributes`);
		assert.ok(!entry.name.startsWith('/'), `${entry.name} is relative`);
		assert.ok(!entry.name.includes('\\'), `${entry.name} uses ZIP path separators`);
		assert.ok(!entry.name.split('/').includes('..'), `${entry.name} has no traversal segment`);
		if (entry.type === 0o040000) {
			assert.equal(entry.permissions, 0o755, `${entry.name} directory mode`);
			assert.equal(entry.permissions & 0o022, 0, `${entry.name} directory is not group/world writable`);
		} else {
			assert.equal(entry.type, 0o100000, `${entry.name} is a regular file`);
			const expectedMode = executablePaths.has(entry.name) ? 0o755 : 0o644;
			assert.equal(entry.permissions, expectedMode, `${entry.name} canonical file mode`);
			assert.equal(entry.permissions & 0o022, 0, `${entry.name} is not group/world writable`);
			if (0o755 === expectedMode) observedExecutables.add(entry.name);
		}
		assert.equal(entry.mtime, canonicalMtime, `${entry.name} uses the source timestamp in UTC`);
	}
	assert.deepEqual([...observedExecutables].sort(), [...executablePaths].sort(), 'only the five intentional application executables retain execute bits');

	const byName = new Map(entries.map(entry => [entry.name, entry]));
	assert.equal(byName.get('index.php')?.permissions, 0o644, 'generated index.php is 0644 in the ZIP');
	assert.equal(byName.get('data/VERSION')?.permissions, 0o644, 'generated data/VERSION is 0644 in the ZIP');
	assert.equal(byName.get(`${appRoot}/app/libraries/RainLoop/ServiceActions.php`)?.permissions, 0o644, 'representative PHP file is 0644 in the ZIP');
	assert.equal(byName.get(`${appRoot}/app/`)?.permissions, 0o755, 'representative directory is 0755 in the ZIP');
	assert.equal(byName.get(`${appRoot}/imapsync.php`)?.permissions, 0o755, 'intentional executable remains 0755 in the ZIP');
	if (aurVariant) {
		assert.equal(byName.get('include.php')?.permissions, 0o644, 'generated AUR include.php is 0644 in the ZIP');
	}

	const dataFiles = entries.map(entry => entry.name).filter(name => name.startsWith('data/') && !name.endsWith('/')).sort();
	assert.deepEqual(dataFiles, ['data/.htaccess', 'data/README.md', 'data/VERSION'], 'root data contains only release bootstrap files');

	await mkdir(extractedPath, { recursive: true });
	runWithUmask('unzip', ['-q', archivePath, '-d', extractedPath]);
	const extractedMode = async name => (await stat(join(extractedPath, name))).mode & 0o7777;
	assert.equal(await extractedMode('index.php'), 0o644, 'extracted index.php is 0644 under umask 022');
	assert.equal(await extractedMode('data/VERSION'), 0o644, 'extracted data/VERSION is 0644 under umask 022');
	assert.equal(await extractedMode(`${appRoot}/app/libraries/RainLoop/ServiceActions.php`), 0o644, 'extracted ordinary PHP file is not group/world writable');
	assert.equal(await extractedMode(`${appRoot}/app`), 0o755, 'extracted application directory is 0755');
	assert.equal(await extractedMode(`${appRoot}/imapsync.php`), 0o755, 'extracted intentional executable remains executable');
	if (aurVariant) {
		assert.equal(await extractedMode('include.php'), 0o644, 'extracted generated AUR include.php is 0644');
	}
}

test('release ZIP writes canonical Unix modes and extracts safely', async t => {
	const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
	const sourceSha = requestedSourceSha || currentHead;
	const tempRoot = await mkdtemp(join(tmpdir(), 'petuja-release-archive-'));
	t.after(() => rm(tempRoot, { recursive: true, force: true }));
	const sourceRoot = join(tempRoot, 'source');
	const binRoot = join(tempRoot, 'bin');
	await mkdir(sourceRoot, { recursive: true });
	await mkdir(binRoot, { recursive: true });
	const sourceArchive = execFileSync('git', ['archive', '--format=tar', sourceSha], {
		cwd: repositoryRoot,
		maxBuffer: 256 * 1024 * 1024,
	});
	execFileSync('tar', ['-xf', '-', '-C', sourceRoot], {
		input: sourceArchive,
		env: { ...process.env, LC_ALL: 'C' },
	});
	if (!requestedSourceSha) {
		await copyFile(join(repositoryRoot, 'cli/release.php'), join(sourceRoot, 'cli/release.php'));
	}
	// A local checkout mode must not make an ordinary source file executable in the release ZIP.
	await chmod(join(sourceRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/ServiceActions.php'), 0o755);
	const sourceEpoch = execFileSync('git', ['show', '-s', '--format=%ct', sourceSha], {
		cwd: repositoryRoot,
		encoding: 'utf8',
	}).trim();
	const packageMetadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
	const version = packageMetadata.version;
	const gulpShim = join(binRoot, 'gulp');
	await writeFile(gulpShim, '#!/bin/sh\nexit 0\n');
	await chmod(gulpShim, 0o755);

	const build = aur => {
		const args = ['cli/release.php', '--skip-gulp'];
		if (aur) args.push('--aur');
		return run(releasePhp, args, {
			cwd: sourceRoot,
			env: {
				...process.env,
				PATH: `${binRoot}${delimiter}${process.env.PATH || ''}`,
				SOURCE_DATE_EPOCH: sourceEpoch,
			},
		});
	};
	const releaseDir = join(sourceRoot, 'build/dist/releases/webmail', version);
	const zipPath = join(releaseDir, `snappymail-${version}.zip`);
	const tarGzPath = join(releaseDir, `snappymail-${version}.tar.gz`);

	build(false);
	const defaultZipPath = join(tempRoot, 'default.zip');
	const defaultExtractPath = join(tempRoot, 'default-extracted');
	await copyFile(zipPath, defaultZipPath);
	await assertCanonicalZip(defaultZipPath, defaultExtractPath, version, sourceEpoch);

	const tarExtractPath = join(tempRoot, 'tar-extracted');
	await mkdir(tarExtractPath, { recursive: true });
	runWithUmask('tar', ['-xzf', tarGzPath, '-C', tarExtractPath]);
	const tarMode = async name => (await stat(join(tarExtractPath, name))).mode & 0o7777;
	assert.equal(await tarMode('index.php'), 0o644, 'TAR index.php remains 0644');
	assert.equal(await tarMode('data/VERSION'), 0o644, 'TAR data/VERSION remains 0644');
	assert.equal(await tarMode(`snappymail/v/${version}/app`), 0o755, 'TAR application directory remains 0755');

	build(true);
	await assertCanonicalZip(zipPath, join(tempRoot, 'aur-extracted'), version, sourceEpoch, true);

	const outsideSource = join(tempRoot, 'outside-release-source.txt');
	const outsideLink = join(sourceRoot, 'snappymail/v/0.0.0/release-escape.txt');
	await writeFile(outsideSource, 'must not enter the release archive');
	await symlink(outsideSource, outsideLink);
	const failedBuild = spawnSync(releasePhp, ['cli/release.php', '--skip-gulp'], {
		cwd: sourceRoot,
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${binRoot}${delimiter}${process.env.PATH || ''}`,
			SOURCE_DATE_EPOCH: sourceEpoch,
			LC_ALL: 'C',
		},
	});
	assert.notEqual(failedBuild.status, 0, 'release build rejects a source symlink');
	assert.match(failedBuild.stderr, /symbolic links are not allowed in release sources/);
	await assert.rejects(stat(zipPath), { code: 'ENOENT' }, 'failed build removes its partial ZIP');
	await assert.rejects(stat(tarGzPath), { code: 'ENOENT' }, 'failed build leaves no TAR.GZ artifact');

	const outsideOutput = join(tempRoot, 'outside-release-output');
	const releaseOutput = join(sourceRoot, 'build/dist/releases/webmail', version);
	await mkdir(outsideOutput, { recursive: true });
	await rm(releaseOutput, { recursive: true, force: true });
	await symlink(outsideOutput, releaseOutput, 'dir');
	const failedOutputBuild = spawnSync(releasePhp, ['cli/release.php', '--skip-gulp'], {
		cwd: sourceRoot,
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${binRoot}${delimiter}${process.env.PATH || ''}`,
			SOURCE_DATE_EPOCH: sourceEpoch,
			LC_ALL: 'C',
		},
	});
	assert.notEqual(failedOutputBuild.status, 0, 'release build rejects an output-directory symlink');
	assert.match(failedOutputBuild.stderr, /symbolic links are not allowed in release output paths/);
	assert.deepEqual(await readdir(outsideOutput), [], 'release build writes nothing through an output symlink');
});
