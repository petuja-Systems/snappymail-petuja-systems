import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrivateTestTempRoot } from './fixtures/private-test-temp.mjs';

const fixture = fileURLToPath(new URL('./fixtures/login-abuse-ledger.php', import.meta.url));
const isWindows = 'win32' === process.platform;
const testTemporaryRoot = await createPrivateTestTempRoot(test, 'login-abuse');
const reserve = (identity, source) => ({ action: 'reserve', ...(identity && { identity }), ...(source && { source }) });

async function directory(t) {
	const root = await mkdtemp(path.join(testTemporaryRoot, 'petuja-m74-ledger-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	return path.join(root, 'private-ledger');
}

async function run(directory, operations) {
	const child = spawn(process.env.PHP_BINARY || 'php', [fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
	let output = '', errors = '';
	child.stdout.on('data', value => { output += value; });
	child.stderr.on('data', value => { errors += value; });
	const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
	child.stdin.end(JSON.stringify({ directory, operations }));
	assert.equal(await exit, 0, errors);
	return JSON.parse(output);
}

async function age(directory) {
	const file = path.join(directory, 'state.json');
	const state = JSON.parse(await readFile(file, 'utf8'));
	for (const events of Object.values(state.buckets)) {
		for (const id of Object.keys(events)) events[id] = Math.floor(Date.now() / 1000) - 1;
	}
	await writeFile(file, JSON.stringify(state));
}

test('M7.4 accounts and sources have independent bounded rolling budgets', async t => {
	const root = await directory(t);
	const tickets = await run(root, Array.from({ length: 10 }, (_, n) => reserve(null, n % 2 ? '192.0.2.11' : '192.0.2.10')));
	assert.ok(tickets.every(Boolean));
	assert.deepEqual(await run(root, [reserve(null, '192.0.2.12')]), [null], 'account budget spans sources');
	assert.deepEqual(await run(root, [{ action: 'release', ticket: tickets[0] }, reserve(null, '192.0.2.12')]).then(items => items.map(Boolean)), [true, true]);
	await age(root);
	const sourceTickets = await run(root, Array.from({ length: 30 }, (_, n) => reserve(['server.test', 993, 'synthetic-' + n])));
	assert.ok(sourceTickets.every(Boolean));
	assert.deepEqual(await run(root, [reserve(['server.test', 993, 'another'])]), [null], 'source budget spans account names');
	assert.ok((await run(root, [{ ...reserve(), realm: 'admin' }]))[0], 'mail/admin realms are independent');
});

test('M8.1 factor account budget survives source rotation and factor identities stay isolated', async t => {
	const root = await directory(t);
	const factorReserve = (identity, source) => ({
		...reserve(identity, source),
		realm: 'two-factor'
	});
	const account = ['factor@example.test'];
	const rotatedSources = await run(root, Array.from({ length: 10 }, (_, index) =>
		factorReserve(account, '192.0.2.' + (10 + index))));
	assert.ok(rotatedSources.every(Boolean), 'each source can spend one account-bound factor attempt');
	assert.deepEqual(await run(root, [factorReserve(account, '192.0.2.30')]), [null],
		'rotating sources cannot bypass the factor account budget');
	assert.ok((await run(root, [factorReserve(['other-factor@example.test'], '192.0.2.30')]))[0],
		'a different factor account keeps its own budget');
	assert.ok((await run(root, [{ ...reserve(account, '192.0.2.30'), realm: 'mail' }]))[0],
		'the factor realm remains separate from primary-password guessing');

	const sourceRoot = await directory(t);
	const sameSource = await run(sourceRoot, Array.from({ length: 30 }, (_, index) =>
		factorReserve(['factor-user-' + index + '@example.test'], '198.51.100.40')));
	assert.ok(sameSource.every(Boolean), 'the configured source budget admits 30 distinct accounts');
	assert.deepEqual(await run(sourceRoot, [factorReserve(['factor-user-30@example.test'], '198.51.100.40')]), [null],
		'the configured source budget spans factor accounts');
});

test('M8.1 factor account budget is atomic across simultaneous PHP workers', { timeout: 30000 }, async t => {
	const root = await directory(t);
	const operation = {
		action: 'reserve',
		realm: 'two-factor',
		source: '192.0.2.40',
		identity: ['factor-race@example.test']
	};
	const results = await Promise.all(Array.from({ length: 24 }, () => run(root, [operation])));
	assert.equal(results.flat().filter(Boolean).length, 10,
		'concurrent factor reservations cannot exceed the account budget');
	assert.deepEqual(await run(root, [operation]), [null]);
});

test('M7.4 parallel PHP workers reserve before authentication without lost updates', { timeout: 30000 }, async t => {
	const root = await directory(t);
	const results = await Promise.all(Array.from({ length: 24 }, () => run(root, [reserve()])));
	assert.equal(results.flat().filter(Boolean).length, 10);
	const before = await readFile(path.join(root, 'state.json'), 'utf8');
	assert.deepEqual(await run(root, [reserve()]), [null]);
	assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before, 'denials do not extend expiration');
	await age(root);
	assert.ok((await run(root, [reserve()]))[0], 'abandoned reservations expire deterministically');
	assert.deepEqual((await readdir(root)).sort(), ['lock', 'state.json']);
	if (!isWindows) {
		assert.equal((await stat(root)).mode & 0o777, 0o700);
		assert.equal((await stat(path.join(root, 'state.json'))).mode & 0o777, 0o600);
	}
});

test('M7.4 completion refunds only its event and normalizes equivalent source addresses', async t => {
	const root = await directory(t);
	const [first, second] = await run(root, [reserve(null, '2001:db8::1'), reserve(null, '2001:0db8:0:0:0:0:0:1')]);
	assert.equal(first.keys[0], second.keys[0]);
	const [v4, mapped] = await run(root, [reserve(null, '192.0.2.5'), reserve(null, '::ffff:192.0.2.5')]);
	assert.equal(v4.keys[0], mapped.keys[0]);
	await run(root, [{ action: 'release', ticket: first }, { action: 'release', ticket: first }]);
	const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
	assert.ok(state.buckets[second.keys[0]][second.id], 'a later or delayed failure survives another success');
	const different = (await run(root, [reserve(['other.test', 993, 'fixture@example.test'], '192.0.2.20')]))[0];
	assert.notEqual(second.keys[1], different.keys[1], 'explicit backend namespaces remain distinct');
	const text = await readFile(path.join(root, 'state.json'), 'utf8');
	assert.doesNotMatch(text, /fixture@example\.test|192\.0\.2|2001:|synthetic-ledger-secret/);
});

test('M7.4 admission remains charged for at least the entire five-minute window', async t => {
	const root = await directory(t);
	const [{ started, finished, ticket }] = await run(root, [{ action: 'timed-reserve' }]);
	assert.ok(ticket);
	const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
	const expires = state.buckets[ticket.keys[0]][ticket.id];
	assert.ok(expires >= started + 300, 'fractional admission times cannot shorten the window');
	assert.ok(expires <= finished + 301, 'conservative rounding adds at most one second');
});

test('M7.4 corrupt, oversized and unavailable ledger state fail closed', async t => {
	const root = await directory(t);
	await run(root, [reserve()]);
	const factorReserve = { ...reserve(), realm: 'two-factor' };
	for (const text of ['{', '{"version":1,"buckets":{"invalid":{}}}', ' '.repeat(1048577)]) {
		await writeFile(path.join(root, 'state.json'), text);
		assert.deepEqual(await run(root, [reserve(), factorReserve]), [null, null]);
		assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), text, 'corruption is never silently cleared');
	}
	await rm(path.join(root, 'state.json'));
	await mkdir(path.join(root, 'state.tmp'));
	assert.deepEqual(await run(root, [reserve(), factorReserve]), [null, null],
		'failed atomic publication never admits password or factor auth');
	await rm(path.join(root, 'state.tmp'), { recursive: true });
	const sentinel = path.join(root, 'sentinel');
	await writeFile(sentinel, 'preserve');
	if (isWindows) {
		t.diagnostic('File symlink creation is unavailable here; Windows reparse/junction checks run in account-storage.test.mjs.');
	} else {
		await symlink(sentinel, path.join(root, 'state.json'));
		assert.deepEqual(await run(root, [reserve(), factorReserve]), [null, null]);
		assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
	}
});

test('M7.4 full ledger preserves unexpired entries and recovers by expiration', async t => {
	const root = await directory(t);
	await run(root, [reserve()]);
	const buckets = {};
	for (let n = 0; n < 4096; ++n) {
		buckets[createHash('sha256').update('synthetic-' + n).digest('hex')] = {
			['0'.repeat(32)]: Math.floor(Date.now() / 1000) + 290
		};
	}
	await writeFile(path.join(root, 'state.json'), JSON.stringify({ version: 1, buckets }));
	const before = await readFile(path.join(root, 'state.json'), 'utf8');
	assert.deepEqual(await run(root, [reserve()]), [null], 'capacity cannot evict live protection');
	assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
	await age(root);
	assert.ok((await run(root, [reserve()]))[0]);
});
