import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/c19-folder-information.php');
const php = process.env.PHP_BINARY || 'php';

function run(input) {
	const argument = 'string' === typeof input ? input : JSON.stringify(input);
	const result = spawnSync(php, [fixture, argument], {
		cwd: root,
		encoding: 'utf8',
		timeout: 15000
	});
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return JSON.parse(result.stdout);
}

test('C-19 bounds unique folder-status work while preserving supported batches', async (t) => {
	await t.test('empty lists preserve the previous connection and empty-response behavior', () => {
		const result = run({ folders: [] });
		assert.equal(result.code, 0);
		assert.deepEqual(result.result, []);
		assert.equal(result.authenticationChecks, 2);
		assert.equal(result.imapConnections, 1);
		assert.equal(result.folderInformationCalls, 0);
	});

	await t.test('single and representative Unicode mailbox names reach the fake client once each', () => {
		const single = run({ folders: ['INBOX'] });
		assert.equal(single.code, 0);
		assert.deepEqual(single.folders, ['INBOX']);
		assert.equal(single.imapConnections, 1);
		assert.equal(single.folderInformationCalls, 1);

		const representative = run({ folders: ['INBOX', 'Archive/År', 'Team Shared/Inbox'] });
		assert.equal(representative.code, 0);
		assert.deepEqual(representative.folders, ['INBOX', 'Archive/År', 'Team Shared/Inbox']);
		assert.equal(representative.folderInformationCalls, 3);
	});

	await t.test('duplicate values are deduplicated without normalizing numeric-looking names or keys', () => {
		const duplicate = run({ folders: ['INBOX', 'INBOX', 'Sent', 'INBOX'] });
		assert.deepEqual(duplicate.folders, ['INBOX', 'Sent']);
		assert.equal(duplicate.folderInformationCalls, 2);

		const numericNames = run({ folders: ['1', '01', '1'] });
		assert.deepEqual(numericNames.folders, ['1', '01']);
		assert.equal(numericNames.folderInformationCalls, 2);

		const keyed = run({ folders: { 0: 'INBOX', 9: 'INBOX', named: 'Sent' } });
		assert.deepEqual(keyed.folders, ['INBOX', 'Sent']);
		assert.equal(keyed.folderInformationCalls, 2);
	});

	await t.test('exactly ten unique folders are accepted and ordered', () => {
		const folders = Array.from({ length: 10 }, (_, index) => 'folder-' + index);
		const result = run({ folders });
		assert.equal(result.code, 0);
		assert.deepEqual(result.folders, folders);
		assert.equal(result.folderInformationCalls, 10);
	});

	await t.test('a duplicate-heavy list costs one status call', () => {
		const result = run('duplicates');
		assert.equal(result.code, 0);
		assert.deepEqual(result.folders, ['INBOX']);
		assert.equal(result.folderInformationCalls, 1);
	});

	await t.test('per-folder IMAP errors remain logged and do not alter the response convention', () => {
		const result = run({ folders: ['INBOX', 'Broken', 'Sent'], failingFolders: ['Broken'] });
		assert.equal(result.code, 0);
		assert.deepEqual(result.result, [{ name: 'INBOX' }, { name: 'Sent' }]);
		assert.equal(result.folderInformationCalls, 3);
		assert.equal(result.loggedFolderFailures, 1);
	});
});

test('C-19 rejects oversized and malformed arrays before IMAP connection or status work', async (t) => {
	await t.test('an omitted folders parameter preserves the previous empty no-op behavior', () => {
		const result = run({});
		assert.equal(result.code, 0);
		assert.deepEqual(result.result, []);
		assert.equal(result.authenticationChecks, 0);
		assert.equal(result.imapConnections, 0);
		assert.equal(result.folderInformationCalls, 0);
	});

	for (const [label, folders] of [
		['string', 'INBOX'],
		['null', null],
		['integer', 42],
		['float', 1.5],
		['boolean', false]
	]) {
		await t.test('explicit top-level ' + label + ' is rejected', () => {
			const result = run({ folders });
			assert.equal(result.code, 903);
			assert.equal(result.result, null);
			assert.equal(result.authenticationChecks, 1);
			assert.equal(result.imapConnections, 0);
			assert.equal(result.folderInformationCalls, 0);
		});
	}

	const sparseFolders = {};
	for (let index = 0; index < 11; ++index) {
		sparseFolders[String(index * 2)] = 'folder-' + index;
	}

	for (const [label, input] of [
		['eleven unique folders', { folders: Array.from({ length: 11 }, (_, index) => 'folder-' + index) }],
		['eleven unique values under sparse numeric keys', { folders: sparseFolders }],
		['very large unique list', 'large'],
		['nested array entry', { folders: ['INBOX', ['Sent']] }],
		['object entry', { folders: ['INBOX', { name: 'Sent' }] }],
		['numeric entry', { folders: ['INBOX', 42] }],
		['null entry', { folders: ['INBOX', null] }]
	]) {
		await t.test(label, () => {
			const result = run(input);
			assert.equal(result.code, 903);
			assert.equal(result.result, null);
			assert.equal(result.imapConnections, 0);
			assert.equal(result.folderInformationCalls, 0);
		});
	}
});

test('C-19 preserves authentication rejection and the session remains usable after an oversized request', () => {
	const unauthenticated = run({ authenticated: false, folders: Array.from({ length: 11 }, (_, index) => 'folder-' + index) });
	assert.equal(unauthenticated.code, 102);
	assert.equal(unauthenticated.imapConnections, 0);
	assert.equal(unauthenticated.folderInformationCalls, 0);

	const recovery = run('recovery');
	assert.equal(recovery.rejected.code, 903);
	assert.equal(recovery.rejected.folderInformationCalls, 0);
	assert.equal(recovery.recovered.code, 0);
	assert.deepEqual(recovery.recovered.folders, ['INBOX']);
	assert.equal(recovery.recovered.folderInformationCalls, 1);
});
