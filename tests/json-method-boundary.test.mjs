import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const php = process.env.PHP_BINARY || 'php';

test('actual JSON dispatcher requires POST except the two cached mailbox reads and preserves existing policy gates', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'petuja-json-method-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = path.join(directory, 'data/_data_/_default_/configs');
	await mkdir(config, { recursive: true });
	await writeFile(path.join(config, 'application.ini'), '[plugins]\nenable = Off\n');
	const result = spawnSync(php, ['-d', 'display_errors=0',
		path.join(root, 'tests/fixtures/json-method-boundary.php'), directory],
		{ cwd: root, encoding: 'utf8', timeout: 20000 });
	assert.equal(result.error, undefined, 'the inert native dispatcher fixture executes');
	assert.equal(result.status, 0, 'the fixture completes without printing runtime diagnostics');
	const cases = JSON.parse(result.stdout);
	const methodDenied = ['get_path', 'get_valid_token', 'get_decoded_action', 'get_lower_mutation',
		'get_mixed_mutation', 'get_other_action', 'get_logout', 'get_override', 'get_array_action',
		'head', 'put', 'patch', 'delete', 'options', 'lower_post', 'padded_post', 'missing_method'];
	for (const name of methodDenied) {
		assert.equal(cases[name].code, 102, name);
		assert.equal(cases[name].mutations + cases[name].reads + cases[name].adminChecks, 0, name);
	}
	for (const name of ['post_header', 'post_form', 'post_future_action', 'post_logout']) {
		assert.equal(cases[name].success, true, name);
		assert.equal(cases[name].mutations, 1, name);
	}
	for (const name of ['post_missing_token', 'post_bad_header', 'post_bad_form', 'read_bad_token']) {
		assert.equal(cases[name].code, 101, name);
		assert.equal(cases[name].mutations + cases[name].reads + cases[name].adminChecks, 0, name);
	}
	for (const name of ['post_admin_denied', 'post_two_factor_denied', 'read_two_factor_denied']) {
		assert.equal(cases[name].code, 102, name);
		assert.equal(cases[name].mutations + cases[name].reads, 0, name);
	}
	assert.equal(cases.post_header.adminChecks, 1);
	assert.equal(cases.post_admin_denied.adminChecks, 1);
	assert.equal(cases.post_two_factor_denied.adminChecks, 0);
	for (const name of ['read_message', 'read_list', 'read_lower', 'read_mixed']) {
		assert.equal(cases[name].success, true, name);
		assert.equal(cases[name].reads, 1, name);
		assert.equal(cases[name].mutations, 0, name);
		assert.equal(cases[name].rawKey, 'synthetic-cache-key', name);
	}
});

test('native Contacts synchronization supplies a POST action body and retains streamed completion', { timeout: 5000 }, async () => {
	const requests = [];
	const observable = initial => {
		let value = initial;
		const result = function (next) { if (arguments.length) value = next; return value; };
		result.extend = () => result;
		return result;
	};
	const context = vm.createContext({
		ko: { observable }, koComputable: callback => callback, koArrayWithDestroy: () => [],
		addObservablesTo: (target, values) => Object.entries(values).forEach(([name, value]) => { target[name] = observable(value); }),
		SettingsGet: () => null, Notifications: {}, isArray: Array.isArray, pInt: Number, pString: String,
		serverRequest: () => '/?/Json/0/', getNotification: () => '',
		AbortController, TextDecoder, setTimeout, clearTimeout, console,
		rl: { fetch: (url, options, body) => {
			requests.push({ url, body });
			return Promise.resolve(new Response('{"progress":1}\n{"Action":"ContactsSync","Result":true,"code":0}\n'));
		} }
	});
	const executable = text => text.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
	vm.runInContext(executable(await readFile(path.join(root, 'dev/Remote/AbstractFetch.js'), 'utf8'))
		+ '\nglobalThis.Remote = new AbstractFetchRemote();', context);
	vm.runInContext(executable(await readFile(path.join(root, 'dev/Stores/User/Contact.js'), 'utf8'))
		+ '\nglobalThis.store = ContactUserStore;', context);
	context.store.syncMode(2);
	const completed = new Promise(resolve => context.store.sync((code, data) => resolve({ code, data })));
	const result = await completed;
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, '/?/Json/0/');
	assert.equal(requests[0].body.Action, 'ContactsSync', 'the existing fetch builder receives POST data');
	assert.equal(result.code, 0);
	assert.equal(result.data.Result, true);
	assert.equal(context.store.syncing(), false);
});
