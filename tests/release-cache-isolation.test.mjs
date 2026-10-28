import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
	phpBinary = process.env.PHP_BINARY || 'php';

test('compiled template cache keys follow immutable releases through activation and rollback', async t => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-release-cache-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

	const releasesRoot = path.join(temporaryRoot, 'releases'),
		oldRelease = path.join(releasesRoot, 'petuja-email-old-source'),
		newRelease = path.join(releasesRoot, 'petuja-email-new-source'),
		currentLink = path.join(temporaryRoot, 'current'),
		utilsPath = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Utils.php'),
		servicePath = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Service.php'),
		probeSource = `<?php
define('APP_VERSION', '2.38.2');
define('APP_INDEX_ROOT_PATH', __DIR__ . DIRECTORY_SEPARATOR);
require $argv[1];
require $argv[2];
$method = new ReflectionMethod(\\RainLoop\\Service::class, 'templateCacheFileName');
echo $method->invoke(null, 'en', 'petuja-email-next-release', '.min', '.min', array());
`;

	await mkdir(releasesRoot, { recursive: true });
	for (const release of [oldRelease, newRelease]) {
		await mkdir(release);
		await writeFile(path.join(release, 'probe.php'), probeSource);
	}
	await symlink(oldRelease, currentLink, 'dir');

	const cacheKeyForCurrentRelease = () => {
		const result = spawnSync(phpBinary, [path.join(currentLink, 'probe.php'), utilsPath, servicePath], {
			encoding: 'utf8'
		});
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.match(result.stdout, /^TMPL:[a-f0-9]{40}$/);
		return result.stdout;
	};

	const oldReleaseKey = cacheKeyForCurrentRelease();
	assert.equal(cacheKeyForCurrentRelease(), oldReleaseKey, 'the same release produces a stable key');
	await unlink(currentLink);
	await symlink(newRelease, currentLink, 'dir');
	const newReleaseKey = cacheKeyForCurrentRelease();

	assert.notEqual(newReleaseKey, oldReleaseKey,
		'the next cache.index cannot let an old release share the new release namespace');

	const cache = new Map([[oldReleaseKey, 'old release template']]);
	assert.equal(cache.get(oldReleaseKey), 'old release template', 'same-release requests reuse their key');
	assert.equal(cache.get(newReleaseKey), undefined, 'activation cannot reuse the old release template');
	cache.set(newReleaseKey, 'new release template');

	await unlink(currentLink);
	await symlink(oldRelease, currentLink, 'dir');
	assert.equal(cacheKeyForCurrentRelease(), oldReleaseKey, 'rollback returns to the prior release key');
	assert.equal(cache.get(oldReleaseKey), 'old release template', 'rollback retains the prior namespace');
});
