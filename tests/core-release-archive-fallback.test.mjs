import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const harness = path.join(repositoryRoot, 'tests/fixtures/core-release-archive-harness.php');
const blockSize = 512;

function octal(value, length, checksum = false) {
	const digits = value.toString(8).padStart(checksum ? 6 : length - 1, '0');
	return Buffer.from(checksum ? digits + '\0 ' : digits + '\0');
}

function header(entry) {
	const block = Buffer.alloc(blockSize);
	let name = entry.path;
	let prefix = '';
	if (Buffer.byteLength(name) > 100) {
		const split = name.lastIndexOf('/');
		prefix = name.slice(0, split);
		name = name.slice(split + 1);
		assert.ok(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155,
			'fixture path must fit USTAR name and prefix fields');
	}
	block.write(name, 0, 100, 'utf8');
	octal(entry.mode ?? 0o644, 8).copy(block, 100);
	octal(0, 8).copy(block, 108);
	octal(0, 8).copy(block, 116);
	octal(entry.type === '5' ? 0 : Buffer.byteLength(entry.data || ''), 12).copy(block, 124);
	octal(0, 12).copy(block, 136);
	block.fill(0x20, 148, 156);
	block.write(entry.type || '0', 156, 1, 'ascii');
	if (entry.link) block.write(entry.link, 157, 100, 'utf8');
	block.write('ustar\0', 257, 6, 'binary');
	block.write('00', 263, 2, 'ascii');
	if (prefix) block.write(prefix, 345, 155, 'utf8');
	const sum = block.reduce((total, byte) => total + byte, 0);
	octal(sum, 8, true).copy(block, 148);
	return block;
}

function archive(entries) {
	const blocks = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.data || '');
		blocks.push(header(entry));
		if (body.length) {
			blocks.push(body);
			const padding = (blockSize - (body.length % blockSize)) % blockSize;
			if (padding) blocks.push(Buffer.alloc(padding));
		}
	}
	blocks.push(Buffer.alloc(blockSize * 2));
	return gzipSync(Buffer.concat(blocks));
}

async function run(action, bytes, target) {
	const archivePath = path.join(path.dirname(target), 'core.tar.gz');
	await writeFile(archivePath, bytes);
	const child = spawnSync(phpBinary, [harness, action, archivePath, target], {
		cwd: repositoryRoot,
		encoding: 'utf8'
	});
	assert.equal(child.error, undefined, 'PHP harness launch failed: ' + child.error);
	assert.equal(child.status, 0, 'PHP harness failed: ' + child.stderr);
	try {
		return JSON.parse(child.stdout);
	} catch {
		assert.fail('PHP harness did not return JSON: ' + child.stdout + '\n' + child.stderr);
	}
}

async function makeTarget(parent) {
	const target = path.join(parent, 'target');
	await mkdir(target, { recursive: true });
	return target;
}

async function assertNoStageDirectory(target) {
	const entries = await readdir(target);
	assert.equal(entries.some(name => name.startsWith('.core-update-')), false,
		'private extraction staging directory was cleaned');
}

const coreEntries = [
	{ path: 'snappymail/v/2.39.0/old.php', data: '<?php return "archive";' },
	{ path: 'snappymail/v/2.39.0/new.php', data: '<?php return "new";' },
	{ path: 'snappymail/v/2.39.0/static/' + 'nested-'.repeat(13) + 'asset.css', data: 'body{}' },
	{ path: 'index.php', data: '<?php return "new index";' },
	{ path: 'plugins/probe.php', data: '<?php return "plugin";' },
	{ path: 'data/VERSION', data: '2.39.0' }
];

test('Core-only fallback extracts the release subtree and replaces index.php last', async t => {
	const phpCheck = spawnSync(phpBinary, ['-r', 'exit(PHP_VERSION_ID >= 70400 ? 0 : 1);'], { encoding: 'utf8' });
	if (phpCheck.error || 0 !== phpCheck.status) {
		t.skip('PHP 7.4 or newer is unavailable');
		return;
	}
	const parent = await mkdtemp(path.join(tmpdir(), 'petuja-core-tar-'));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const target = await makeTarget(parent);
	await mkdir(path.join(target, 'snappymail/v/2.39.0'), { recursive: true });
	await writeFile(path.join(target, 'snappymail/v/2.39.0/old.php'), '<?php return "installed";');
	await writeFile(path.join(target, 'index.php'), '<?php return "old index";');

	const result = await run('fallback', archive(coreEntries), target);
	assert.deepEqual(result, { ok: true });
	assert.equal(await readFile(path.join(target, 'snappymail/v/2.39.0/old.php'), 'utf8'), '<?php return "installed";');
	assert.equal(await readFile(path.join(target, 'snappymail/v/2.39.0/new.php'), 'utf8'), '<?php return "new";');
	assert.equal(await readFile(path.join(target, 'snappymail/v/2.39.0/static/' + 'nested-'.repeat(13) + 'asset.css'), 'utf8'), 'body{}');
	assert.equal(await readFile(path.join(target, 'index.php'), 'utf8'), '<?php return "new index";');
	await assert.rejects(readFile(path.join(target, 'plugins/probe.php')), { code: 'ENOENT' });
	await assert.rejects(readFile(path.join(target, 'data/VERSION')), { code: 'ENOENT' });
	await assertNoStageDirectory(target);
});

test('Core-only fallback rejects pre-existing symlink escapes before publishing', async t => {
	const parent = await mkdtemp(path.join(tmpdir(), 'petuja-core-tar-symlink-'));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const target = await makeTarget(parent);
	const outside = path.join(parent, 'outside');
	await mkdir(outside);
	await symlink(outside, path.join(target, 'snappymail'), 'dir');

	const result = await run('fallback', archive(coreEntries), target);
	assert.deepEqual(result, { ok: false });
	assert.deepEqual(await readdir(outside), [], 'no release file was written through the symlink');
	await assertNoStageDirectory(target);
});

test('Core-only fallback rejects traversal, absolute paths, links and malformed archives without escaping target', async t => {
	const parent = await mkdtemp(path.join(tmpdir(), 'petuja-core-tar-reject-'));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const target = await makeTarget(parent);
	const escapedPath = path.join(parent, 'escape.txt');
	const absolutePath = path.join(parent, 'absolute-escape.txt');
	const invalidArchives = [
		archive([...coreEntries, { path: 'snappymail/../../escape.txt', data: 'outside' }]),
		archive([...coreEntries, { path: absolutePath, data: 'outside' }]),
		archive([...coreEntries, { path: 'snappymail/v/2.39.0/link', type: '2', link: '../../escape.txt' }]),
		gzipSync((() => {
			const malformed = gunzipSync(archive(coreEntries));
			malformed[0] ^= 1;
			return malformed;
		})()),
		gzipSync(Buffer.from('not a tar archive')),
		gzipSync(Buffer.alloc(512, 0x41))
	];

	for (const bytes of invalidArchives) {
		const result = await run('fallback', bytes, target);
		assert.deepEqual(result, { ok: false });
		await assert.rejects(readFile(escapedPath), { code: 'ENOENT' });
		await assert.rejects(readFile(absolutePath), { code: 'ENOENT' });
		await assertNoStageDirectory(target);
		assert.deepEqual(await readdir(target), [], 'rejected archives publish no files');
	}
});

test('CoreReleaseArchive retains its PharData extraction and index overwrite path', async t => {
	const phpCheck = spawnSync(phpBinary, ['-r', 'exit(class_exists("PharData") ? 0 : 1);'], { encoding: 'utf8' });
	if (phpCheck.error || 0 !== phpCheck.status) {
		t.skip('PharData is unavailable');
		return;
	}
	const parent = await mkdtemp(path.join(tmpdir(), 'petuja-core-phar-'));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const target = await makeTarget(parent);
	await writeFile(path.join(target, 'index.php'), '<?php return "old index";');

	const result = await run('install', archive(coreEntries), target);
	assert.deepEqual(result, { ok: true });
	assert.equal(await readFile(path.join(target, 'snappymail/v/2.39.0/new.php'), 'utf8'), '<?php return "new";');
	assert.equal(await readFile(path.join(target, 'index.php'), 'utf8'), '<?php return "new index";');
	await assert.rejects(readFile(path.join(target, 'plugins/probe.php')), { code: 'ENOENT' });
	await assert.rejects(readFile(path.join(target, 'data/VERSION')), { code: 'ENOENT' });
});
