import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { demoContactsConfiguration, detectPdoSqlite } from '../scripts/dev-demo-contacts.mjs';
import { createSyntheticImapServer } from '../scripts/synthetic-imap-server.mjs';
import { createPrivateTestTempRoot } from './fixtures/private-test-temp.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = 'win32' === process.platform;
const phpBinary = process.env.PHP_BINARY || 'php';
const testPassword = 'm6a-contacts-synthetic-password';
const testTemporaryRoot = await createPrivateTestTempRoot(test, 'contacts');
const testHeaders = {
	Accept: 'application/json',
	'Sec-Fetch-Dest': 'empty',
	'Sec-Fetch-Mode': 'cors',
	'Sec-Fetch-Site': 'same-origin'
};

class CookieJar {
	#cookies = new Map();

	header() {
		return [...this.#cookies].map(([name, value]) => name + '=' + value).join('; ');
	}

	update(response) {
		const setCookie = response.headers.getSetCookie?.()
			?? (response.headers.get('set-cookie') || '').split(/,\s*(?=[^;,\s]+=)/);
		for (const cookie of setCookie) {
			const [pair, ...attributes] = cookie.split(';');
			const separator = pair.indexOf('=');
			if (separator < 1) {
				continue;
			}
			const name = pair.slice(0, separator).trim();
			const value = pair.slice(separator + 1).trim();
			const expired = attributes.some(attribute => /^max-age=0$/i.test(attribute.trim()));
			if (!value || expired) {
				this.#cookies.delete(name);
			} else {
				this.#cookies.set(name, value);
			}
		}
	}
}

async function reserveLocalPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

async function startPhpServer(t, dataRoot) {
	const modules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8' });
	if (modules.error || 0 !== modules.status) {
		t.skip('PHP CLI is unavailable: ' + (modules.error?.message || modules.stderr));
		return null;
	}
	for (const name of ['intl', 'mbstring', 'openssl']) {
		if (!new RegExp('^' + name + '$', 'im').test(modules.stdout)) {
			t.skip('PHP ' + name + ' extension is unavailable');
			return null;
		}
	}

	const port = await reserveLocalPort();
	const router = path.join(repositoryRoot, 'tests/fixtures/two-factor-router.php');
	const child = spawn(phpBinary, [
		'-d', 'display_errors=0',
		'-S', '127.0.0.1:' + port,
		'-t', repositoryRoot,
		router
	], {
		cwd: repositoryRoot,
		env: { ...process.env, PETUJA_TEST_DATA_PATH: dataRoot },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
	child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
	const stop = async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await new Promise(resolve => child.once('exit', resolve));
		}
	};
	t.after(stop);

	const baseUrl = 'http://127.0.0.1:' + port;
	const deadline = Date.now() + 10000;
	let lastProbe = '';
	while (Date.now() < deadline) {
		if (null !== child.exitCode || null !== child.signalCode) {
			assert.fail('PHP test server exited early:\n' + output);
		}
		try {
			const response = await fetch(baseUrl + '/?/AppData', { headers: testHeaders });
			if (response.ok) {
				return { baseUrl, stop };
			}
			lastProbe = 'HTTP ' + response.status + ': ' + (await response.text()).slice(0, 500);
		} catch (error) {
			lastProbe = error.message;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail('PHP test server did not start:\n' + output + '\nLast probe: ' + lastProbe);
}

async function createEnvironment(t) {
	const temporaryRoot = await mkdtemp(path.join(testTemporaryRoot, 'petuja-m6a-contacts-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const dataRoot = path.join(temporaryRoot, 'data');
	const privateRoot = path.join(dataRoot, '_data_', '_default_');
	const configRoot = path.join(privateRoot, 'configs');
	const domainsRoot = path.join(privateRoot, 'domains');
	const imap = createSyntheticImapServer({
		expectedPassword: testPassword,
		greeting: 'isolated M6A Contacts fixture'
	});
	await imap.listen();
	t.after(() => imap.close());
	await Promise.all([
		mkdir(configRoot, { recursive: true }),
		mkdir(path.join(privateRoot, 'cache'), { recursive: true }),
		mkdir(domainsRoot, { recursive: true })
	]);
	const domain = JSON.parse(await readFile(
		path.join(repositoryRoot, 'snappymail/v/0.0.0/app/domains/default.json'),
		'utf8'
	));
	domain.IMAP.host = '127.0.0.1';
	domain.IMAP.port = imap.port;
	domain.IMAP.type = 0;
	await writeFile(path.join(domainsRoot, 'default.json'), JSON.stringify(domain));
	const applicationConfig = [
		'[plugins]',
		'enable = Off',
		'',
		'[security]',
		'require_two_factor_auth = Off',
		'',
		'[version]',
		'two_factor_policy_migration = 1',
		'',
		'[login]',
		'fault_delay = 0',
		'',
		'[contacts]',
		'enable = Off',
		'type = sqlite',
		'sqlite_global = On',
		'allow_sync = On',
		''
	].join('\n');
	await writeFile(path.join(configRoot, 'application.ini'),
		demoContactsConfiguration(applicationConfig, { available: true, reason: '' }));
	return { dataRoot, server: await startPhpServer(t, dataRoot) };
}

async function setContactsSyncAllowed(dataRoot, allowed) {
	const configPath = path.join(dataRoot, '_data_', '_default_', 'configs', 'application.ini');
	const lines = (await readFile(configPath, 'utf8')).split(/\r?\n/);
	let inContactsSection = false;
	let updated = false;
	for (let index = 0; index < lines.length; index++) {
		if (/^\s*\[contacts\]\s*$/i.test(lines[index])) {
			inContactsSection = true;
		} else if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
			inContactsSection = false;
		} else if (inContactsSection && /^\s*allow_sync\s*=/i.test(lines[index])) {
			lines[index] = 'allow_sync = ' + (allowed ? 'On' : 'Off');
			updated = true;
			break;
		}
	}
	assert.equal(updated, true, 'the synthetic application config has an allow_sync setting');
	await writeFile(configPath, lines.join('\n'));
}

async function restartPhpServer(t, environment) {
	await environment.server.stop();
	environment.server = await startPhpServer(t, environment.dataRoot);
	assert.ok(environment.server, 'the isolated PHP server restarts using the same temporary data');
}

async function setContactsSyncCapability(t, environment, allowed) {
	await environment.server.stop();
	await setContactsSyncAllowed(environment.dataRoot, allowed);
	environment.server = await startPhpServer(t, environment.dataRoot);
	assert.ok(environment.server, 'the isolated PHP server restarts using the same temporary data');
}

async function setDavAllowedOrigins(t, environment, origins) {
	await environment.server.stop();
	const configPath = path.join(environment.dataRoot, '_data_', '_default_', 'configs', 'application.ini');
	const config = (await readFile(configPath, 'utf8')).replace(/^dav_allowed_origins\s*=.*\n/gm, '');
	await writeFile(configPath, config.replace('[contacts]\n', '[contacts]\ndav_allowed_origins = "' + origins + '"\n'));
	environment.server = await startPhpServer(t, environment.dataRoot);
	assert.ok(environment.server);
}

async function startLoopbackDavServer(t) {
	const requests = [];
	const addressBookResponse = [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">',
		'<d:response><d:href>/addressbook/</d:href><d:propstat><d:prop>',
		'<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype>',
		'<d:getetag>"synthetic-addressbook"</d:getetag>',
		'</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
		'</d:multistatus>'
	].join('');
	let listing = addressBookResponse;
	let vcard = '';
	const server = createHttpServer((request, response) => {
		requests.push({ method: request.method, path: request.url, depth: request.headers.depth });
		let properties = '';
		request.on('data', chunk => { properties += chunk; });
		request.on('end', () => {
			if ('GET' === request.method && vcard) {
				response.writeHead(200, { 'Content-Type': 'text/vcard', ETag: '"fixture-etag"' });
				response.end(vcard);
				return;
			}
			response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
			response.end(properties.includes(':getetag') ? listing : addressBookResponse);
		});
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	t.after(() => new Promise(resolve => server.close(() => resolve())));
	const { port } = server.address();
	return {
		url: 'http://127.0.0.1:' + port + '/addressbook/', requests,
		setListing(xml) { listing = xml; },
		setVcard(body) { vcard = body; }
	};
}

async function request(baseUrl, route, { jar, token, method = 'GET', fields } = {}) {
	const headers = { ...testHeaders };
	if (jar?.header()) {
		headers.Cookie = jar.header();
	}
	if (undefined !== token) {
		headers['X-SM-Token'] = token;
	}
	let body;
	if (fields) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
		body = new URLSearchParams(fields);
	}
	const response = await fetch(baseUrl + route, { method, headers, body });
	jar?.update(response);
	const bytes = Buffer.from(await response.clone().arrayBuffer());
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// Non-JSON error responses are reported with the response body below.
	}
	if (json && undefined === json.code && Object.hasOwn(json, 'Result')) {
		json.code = 0;
	}
	return { response, bytes, text, json };
}

async function guestSession(baseUrl) {
	const jar = new CookieJar();
	const result = await request(baseUrl, '/?/AppData', { jar });
	assert.equal(result.response.status, 200, result.text.slice(0, 300));
	assert.match(result.json?.System?.token || '', /^0-/);
	return { jar, token: result.json.System.token };
}

async function login(baseUrl, email) {
	const guest = await guestSession(baseUrl);
	const result = await request(baseUrl, '/?/Json', {
		jar: guest.jar,
		token: guest.token,
		method: 'POST',
		fields: {
			Action: 'Login',
			Email: email,
			Password: testPassword,
			signMe: '0'
		}
	});
	assert.equal(result.response.status, 200, result.text.slice(0, 300));
	assert.equal(result.json?.code, 0, result.text.slice(0, 500));
	return { jar: guest.jar, appData: result.json.Result };
}

async function contactAction(baseUrl, account, action, fields = {}) {
	return request(baseUrl, '/?/Json', {
		jar: account.jar,
		token: account.appData?.System?.token || account.token,
		method: 'POST',
		fields: { Action: action, ...fields }
	});
}

async function findNamedFiles(root, wantedName) {
	const matches = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			matches.push(...await findNamedFiles(entryPath, wantedName));
		} else if (entry.isFile() && entry.name === wantedName) {
			matches.push(entryPath);
		}
	}
	return matches;
}

function jCard(fullName, email) {
	return [
		'vcard',
		[
			['version', {}, 'text', '4.0'],
			['fn', {}, 'text', fullName],
			['email', { type: ['work'] }, 'text', email]
		]
	];
}

test('authenticated Contacts CSV exports text without changing stored contacts or vCard downloads', {
	timeout: isWindows ? 180000 : 30000
}, async t => {
	const availability = detectPdoSqlite(phpBinary);
	if (!availability.available) { t.skip(availability.reason); return; }
	const environment = await createEnvironment(t);
	if (!environment.server) return;
	const owner = await login(environment.server.baseUrl, 'csv-owner@example.test');
	const other = await login(environment.server.baseUrl, 'csv-other@example.test');
	const card = jCard('=1+1', 'csv-owner-contact@example.test');
	card[1].push(['uid', {}, 'text', 'synthetic-csv-export-owner'],
		['note', {}, 'text', '\ufeff@name'], ['nickname', {}, 'text', ' \t-1'],
		['tel', { type: ['cell'] }, 'text', '+49 30 5550101'],
		['org', {}, 'text', 'Müller, "Team" \\" quote\nSecond line']);
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'ContactSave', {
		uid: '', jCard: JSON.stringify(card)
	})).json?.Result?.Result, true);
	assert.equal((await contactAction(environment.server.baseUrl, other, 'ContactSave', {
		uid: '', jCard: JSON.stringify(jCard('Other private contact', 'csv-other-contact@example.test'))
	})).json?.Result?.Result, true);
	const before = await contactAction(environment.server.baseUrl, owner, 'Contacts');
	const vcfBefore = await request(environment.server.baseUrl, '/?/Raw/0/ContactsVcf', { jar: owner.jar });
	assert.equal(vcfBefore.response.status, 200);
	assert.match(vcfBefore.text, /FN:=1\+1/);
	const csv = await request(environment.server.baseUrl, '/?/Raw/0/ContactsCsv', { jar: owner.jar });
	assert.equal(csv.response.status, 200);
	assert.match(csv.response.headers.get('content-type') || '', /^text\/csv;.*UTF-8/i);
	assert.match(csv.response.headers.get('content-disposition') || '', /attachment;.*contacts\.csv/);
	const parsed = spawnSync(process.env.PYTHON || 'python3', ['-c',
		'import csv,io,json,sys; text=sys.stdin.buffer.read().decode("utf-8"); print(json.dumps(list(csv.reader(io.StringIO(text,newline=""),strict=True))))'
	], { input: csv.text, encoding: 'utf8' });
	assert.equal(parsed.status, 0, parsed.stderr);
	const rows = JSON.parse(parsed.stdout);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].length, 29);
	assert.equal(rows[1].length, 29);
	assert.equal(rows[1][0], "'=1+1");
	assert.equal(rows[1][5], "'=1+1");
	assert.equal(rows[1][4], "' \t-1");
	assert.equal(rows[1][11], "'\ufeff@name");
	assert.equal(rows[1][14], "'+49 30 5550101");
	assert.equal(rows[1][6], 'Müller, "Team" \\" quote\nSecond line');
	assert.equal(rows[1][10], 'csv-owner-contact@example.test');
	assert.equal(csv.text.includes('csv-other-contact@example.test'), false, 'owner export cannot read the other account');
	const otherCsv = await request(environment.server.baseUrl, '/?/Raw/0/ContactsCsv', { jar: other.jar });
	assert.equal(otherCsv.text.includes('csv-owner-contact@example.test'), false, 'other account cannot read owner export');
	assert.equal(otherCsv.text.includes('csv-other-contact@example.test'), true);
	const guestCsv = await request(environment.server.baseUrl, '/?/Raw/0/ContactsCsv');
	assert.equal(guestCsv.response.status, 200, 'the existing Raw dispatcher returns an empty 200 for a guest');
	assert.equal(guestCsv.bytes.length, 0, 'no account-bound CSV data or header row is exported to a guest');
	assert.equal(guestCsv.text.includes('csv-owner-contact@example.test'), false);
	assert.equal(guestCsv.text.includes('csv-other-contact@example.test'), false);
	const after = await contactAction(environment.server.baseUrl, owner, 'Contacts');
	assert.deepEqual(after.json?.Result?.List, before.json.Result.List, 'CSV export does not rewrite stored jCards');
	const vcfAfter = await request(environment.server.baseUrl, '/?/Raw/0/ContactsVcf', { jar: owner.jar });
	assert.deepEqual(vcfAfter.bytes, vcfBefore.bytes, 'VCF download retains the original values and bytes');
});

test('native Contacts SQLite API supports CRUD with isolated per-account data', {
	timeout: isWindows ? 180000 : 30000
}, async t => {
	const availability = detectPdoSqlite(phpBinary);
	if (!availability.available) {
		t.skip(availability.reason);
		return;
	}

	const environment = await createEnvironment(t);
	if (!environment.server) {
		return;
	}

	const ownerEmail = 'm6a-owner@example.test';
	const otherEmail = 'm6a-other@example.test';
	let owner = await login(environment.server.baseUrl, ownerEmail);
	assert.equal(owner.appData?.contactsAllowed, true, 'native Contacts capability is active');
	assert.equal('ContactsSync' in owner.appData, false, 'AppData hides sync while allow_sync is Off');
	const initialList = await contactAction(environment.server.baseUrl, owner, 'Contacts');
	assert.equal(initialList.json?.code, 0, initialList.text.slice(0, 500));
	assert.equal(initialList.json?.Result?.Count, 0);

	const saved = await contactAction(environment.server.baseUrl, owner, 'ContactSave', {
		uid: '',
		jCard: JSON.stringify(jCard('M6A Contact', 'm6a-contact@example.test'))
	});
	assert.equal(saved.json?.code, 0, saved.text.slice(0, 500));
	assert.equal(saved.json?.Result?.Result, true, saved.text.slice(0, 500));
	const contactId = String(saved.json.Result.ResultID);
	assert.match(contactId, /^\d+$/);

	const listed = await contactAction(environment.server.baseUrl, owner, 'Contacts', { Search: 'm6a-contact@example.test' });
	assert.equal(listed.json?.Result?.Count, 1, listed.text.slice(0, 500));
	let contact = listed.json.Result.List.find(item => String(item.id) === contactId);
	assert.ok(contact, 'the created contact is readable through the native Contacts list');
	assert.match(JSON.stringify(contact.jCard), /m6a-contact@example\.test/);

	const updated = await contactAction(environment.server.baseUrl, owner, 'ContactSave', {
		uid: contactId,
		jCard: JSON.stringify(jCard('M6A Updated Contact', 'm6a-updated@example.test'))
	});
	assert.equal(updated.json?.code, 0, updated.text.slice(0, 500));
	assert.equal(updated.json?.Result?.Result, true, updated.text.slice(0, 500));
	assert.equal(String(updated.json.Result.ResultID), contactId);
	const updatedList = await contactAction(environment.server.baseUrl, owner, 'Contacts', {
		Search: 'm6a-updated@example.test'
	});
	assert.equal(updatedList.json?.Result?.Count, 1, updatedList.text.slice(0, 500));
	contact = updatedList.json.Result.List.find(item => String(item.id) === contactId);
	assert.match(JSON.stringify(contact?.jCard), /M6A Updated Contact/);

	await environment.server.stop();
	environment.server = await startPhpServer(t, environment.dataRoot);
	assert.ok(environment.server, 'the isolated test server restarts using the same temporary data');
	owner = await login(environment.server.baseUrl, ownerEmail);
	assert.equal(owner.appData?.contactsAllowed, true);
	const persisted = await contactAction(environment.server.baseUrl, owner, 'Contacts', {
		Search: 'm6a-updated@example.test'
	});
	assert.equal(persisted.json?.Result?.Count, 1, 'Contacts persist deterministically across demo-style restarts');
	assert.match(JSON.stringify(persisted.json.Result.List[0].jCard), /M6A Updated Contact/);

	const other = await login(environment.server.baseUrl, otherEmail);
	assert.equal(other.appData?.contactsAllowed, true, 'the second account also uses native Contacts');
	const otherList = await contactAction(environment.server.baseUrl, other, 'Contacts');
	assert.equal(otherList.json?.code, 0, otherList.text.slice(0, 500));
	assert.equal(otherList.json?.Result?.Count, 0, 'another account cannot read the owner account contact');
	const crossAccountDelete = await contactAction(environment.server.baseUrl, other, 'ContactsDelete', {
		uids: contactId
	});
	assert.equal(crossAccountDelete.json?.code, 0, crossAccountDelete.text.slice(0, 500));
	assert.equal((await contactAction(environment.server.baseUrl, other, 'Contacts')).json?.Result?.Count, 0,
		'the other account cannot read a contact using the owner account id');
	const ownerAfterCrossDelete = await contactAction(environment.server.baseUrl, owner, 'Contacts', {
		Search: 'm6a-updated@example.test'
	});
	assert.equal(ownerAfterCrossDelete.json?.Result?.Count, 1,
		'the other account cannot delete the owner contact');
	assert.match(JSON.stringify(ownerAfterCrossDelete.json.Result.List[0].jCard), /M6A Updated Contact/);

	const deleted = await contactAction(environment.server.baseUrl, owner, 'ContactsDelete', { uids: contactId });
	assert.equal(deleted.json?.code, 0, deleted.text.slice(0, 500));
	assert.equal(deleted.json?.Result, true, deleted.text.slice(0, 500));
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'Contacts')).json?.Result?.List?.length, 0,
		'the deleted contact is no longer returned in the active address book');

	const databases = await findNamedFiles(environment.dataRoot, 'AddressBook.sqlite');
	assert.equal(databases.length, 2, 'each authenticated account receives its own SQLite address book');
	assert.ok(databases.every(file => file.startsWith(environment.dataRoot + path.sep)));
	assert.equal(new Set(databases).size, 2);
	assert.equal(
		await stat(path.join(environment.dataRoot, '_data_', '_default_', 'AddressBook.sqlite')).then(() => true, () => false),
		false,
		'the shared/default application database path is not used'
	);
	assert.ok((await Promise.all(databases.map(file => stat(file)))).every(info => info.size > 0),
		'native schema initialization created both SQLite files');
});

test('Contacts sync is gated server-side while local Contacts remain available', {
	timeout: isWindows ? 240000 : 60000
}, async t => {
	const availability = detectPdoSqlite(phpBinary);
	if (!availability.available) {
		t.skip(availability.reason);
		return;
	}

	const environment = await createEnvironment(t);
	if (!environment.server) {
		return;
	}
	const dav = await startLoopbackDavServer(t);
	const ownerEmail = 'm6a-sync-owner@example.test';
	const rejectedSecret = 'm6a-rejected-sync-secret';
	let owner = await login(environment.server.baseUrl, ownerEmail);
	assert.equal(owner.appData?.contactsAllowed, true);
	assert.equal('ContactsSync' in owner.appData, false);

	const rejectedSave = await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '1',
		Url: dav.url,
		User: 'synthetic-sync-user',
		Password: rejectedSecret
	});
	assert.equal(rejectedSave.response.status, 200, rejectedSave.text.slice(0, 500));
	assert.equal(rejectedSave.json?.Result, false, rejectedSave.text.slice(0, 500));
	assert.equal(rejectedSave.json?.code, 0, rejectedSave.text.slice(0, 500));

	const rejectedSync = await contactAction(environment.server.baseUrl, owner, 'ContactsSync');
	assert.equal(rejectedSync.response.status, 200, rejectedSync.text.slice(0, 500));
	assert.equal(rejectedSync.json?.code, 140, rejectedSync.text.slice(0, 500));
	assert.equal(dav.requests.length, 0, 'disabled save and sync make zero DAV requests');

	await setContactsSyncCapability(t, environment, true);
	owner = await login(environment.server.baseUrl, ownerEmail);
	assert.ok(owner.appData?.ContactsSync, 'AppData exposes native sync settings when allowed');
	assert.equal(owner.appData.ContactsSync.Mode, 0);
	assert.equal(owner.appData.ContactsSync.Url, '', 'disabled save did not persist the submitted URL');
	assert.equal(owner.appData.ContactsSync.User, '', 'disabled save did not persist the submitted user');
	assert.equal(owner.appData.ContactsSync.Password, '', 'disabled save did not persist the submitted secret');

	const unapprovedSave = await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '1', Url: dav.url, User: 'synthetic-sync-user', Password: rejectedSecret
	});
	assert.equal(unapprovedSave.json?.Result, false, 'empty operator policy denies an active user-selected endpoint');
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'ContactsSync')).text.includes('"code":140'), true);
	assert.equal(dav.requests.length, 0);
	owner = await login(environment.server.baseUrl, ownerEmail);
	assert.equal(owner.appData.ContactsSync.Mode, 0, 'rejected save did not persist active mode');
	assert.equal(owner.appData.ContactsSync.Url, '', 'rejected save did not persist its URL');
	await setDavAllowedOrigins(t, environment, new URL(dav.url).origin);
	owner = await login(environment.server.baseUrl, ownerEmail);

	const savedSync = await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '1',
		Url: dav.url,
		User: 'synthetic-sync-user',
		Password: 'm6a-enabled-sync-secret'
	});
	assert.equal(savedSync.json?.Result, true, savedSync.text.slice(0, 500));
	assert.equal(dav.requests.length, 0, 'saving enabled sync settings does not itself contact DAV');
	const configurations = await findNamedFiles(environment.dataRoot, 'contacts_sync');
	assert.equal(configurations.length, 1);
	const savedBytes = await readFile(configurations[0]);
	const deniedReplacement = await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '1', Url: 'http://127.0.0.1:1/denied/', User: 'replacement-user', Password: rejectedSecret
	});
	assert.equal(deniedReplacement.json?.Result, false);
	assert.ok(savedBytes.equals(await readFile(configurations[0])), 'rejected replacement preserves exact encrypted saved configuration');
	const legacy = spawnSync(phpBinary, ['-r',
		'require $argv[1]; $s = trim(file_get_contents($argv[2]."/SALT.php")); '
		+ '$key = md5(md5($s."_default_".$s)); '
		+ '$data = json_encode(["Enable"=>true,"Url"=>$argv[3],"User"=>"synthetic-legacy-user","Password"=>"synthetic-legacy-password"]); '
		+ 'echo rtrim(strtr(base64_encode(\\MailSo\\Base\\Xxtea::Encrypt($data,$key)),"+/","-_"),"=");',
		path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/MailSo/Base/Xxtea.php'), environment.dataRoot, dav.url
	], { encoding: 'utf8' });
	assert.equal(legacy.status, 0, legacy.stderr);
	await writeFile(configurations[0], legacy.stdout);
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '1', Url: 'http://127.0.0.1:1/denied/', User: 'replacement-user', Password: rejectedSecret
	})).json?.Result, false);
	assert.equal(await readFile(configurations[0], 'utf8'), legacy.stdout, 'denied SAVE does not initialize the provider or convert a legacy record');
	owner = await login(environment.server.baseUrl, ownerEmail);
	assert.equal(owner.appData.ContactsSync.User, 'synthetic-legacy-user', 'the synthetic legacy fixture is valid and readable');
	assert.notEqual(await readFile(configurations[0], 'utf8'), legacy.stdout, 'ordinary permitted reads retain the existing encrypted legacy conversion');
	await writeFile(configurations[0], savedBytes);
	assert.equal('dav_allowed_origins' in owner.appData, false, 'operator policy is not an account preference');


	const enabledSync = await contactAction(environment.server.baseUrl, owner, 'ContactsSync');
	assert.equal(enabledSync.response.status, 200, enabledSync.text.slice(0, 500));
	assert.ok(dav.requests.length > 0, 'enabled native Sync invokes only the loopback DAV sentinel');
	assert.ok(dav.requests.every(request => 'PROPFIND' === request.method),
		'the empty synthetic address book requires no remote contact writes');

	dav.requests.length = 0;
	await setContactsSyncCapability(t, environment, false);
	owner = await login(environment.server.baseUrl, ownerEmail);
	assert.equal('ContactsSync' in owner.appData, false, 'AppData hides previously stored sync config while disabled');

	const disabledUpdate = await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '1',
		Url: 'http://127.0.0.1:1/changed/',
		User: 'replacement-user',
		Password: 'm6a-replacement-sync-secret'
	});
	assert.equal(disabledUpdate.json?.Result, false, disabledUpdate.text.slice(0, 500));
	const disabledStoredSync = await contactAction(environment.server.baseUrl, owner, 'ContactsSync');
	assert.equal(disabledStoredSync.json?.code, 140, disabledStoredSync.text.slice(0, 500));
	assert.equal(dav.requests.length, 0, 'disabled sync does not use previously stored DAV credentials');

	await setContactsSyncCapability(t, environment, true);
	owner = await login(environment.server.baseUrl, ownerEmail);
	assert.equal(owner.appData?.ContactsSync?.Url, dav.url, 'disabled save did not replace previously stored sync config');
	assert.equal(owner.appData?.ContactsSync?.User, 'synthetic-sync-user');
	assert.equal(owner.appData?.ContactsSync?.Password, '********', 'AppData masks the stored sync password');
});

test('oversized DAV listing fails without deleting a previously imported contact', {
	timeout: isWindows ? 240000 : 60000
}, async t => {
	const availability = detectPdoSqlite(phpBinary);
	if (!availability.available) { t.skip(availability.reason); return; }
	const environment = await createEnvironment(t);
	if (!environment.server) return;
	await setContactsSyncCapability(t, environment, true);
	const dav = await startLoopbackDavServer(t);
	await setDavAllowedOrigins(t, environment, new URL(dav.url).origin);
	let owner = await login(environment.server.baseUrl, 'dav-bounds-owner@example.test');
	const listing = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/addressbook/bounded-fixture.vcf</d:href>'
		+ '<d:propstat><d:prop><d:resourcetype/><d:getetag>"fixture-etag"</d:getetag></d:prop>'
		+ '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
	dav.setListing(listing);
	dav.setVcard('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:bounded-fixture\r\nFN:Bounded Fixture\r\nN:Fixture;Bounded;;;\r\nEMAIL:bounded-fixture@example.test\r\nEND:VCARD\r\n');
	const saved = await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '2', Url: dav.url, User: 'synthetic-dav-user', Password: 'synthetic-dav-password'
	});
	assert.equal(saved.json?.Result, true);
	const requestsBeforeGet = dav.requests.length;
	const deniedGet = await request(environment.server.baseUrl, '/?/Json/0/ContactsSync', {
		jar: owner.jar, token: owner.appData.System.token
	});
	assert.equal(deniedGet.json?.code, 102, 'GET cannot start a configured Contacts synchronization');
	assert.equal(dav.requests.length, requestsBeforeGet, 'rejected GET makes no DAV request');
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'Contacts', {
		Search: 'bounded-fixture@example.test'
	})).json?.Result?.List?.length, 0, 'rejected GET imports no contact');
	const firstSync = await contactAction(environment.server.baseUrl, owner, 'ContactsSync');
	assert.ok(dav.requests.some(item => 'GET' === item.method && '/addressbook/bounded-fixture.vcf' === item.path),
		JSON.stringify({ requests: dav.requests, response: firstSync.text.slice(0, 600) }));
	const before = await contactAction(environment.server.baseUrl, owner, 'Contacts', { Search: 'bounded-fixture@example.test' });
	assert.equal(before.json?.Result?.List?.length, 1, 'ordinary DAV contact imported before the failure');
	const databases = await findNamedFiles(environment.dataRoot, 'AddressBook.sqlite');
	assert.equal(databases.length, 1);
	const storedEtags = () => {
		const result = spawnSync(phpBinary, ['-r',
			'$db = new PDO("sqlite:".$argv[1]); echo json_encode($db->query("SELECT etag FROM rainloop_ab_contacts WHERE deleted = 0")->fetchAll(PDO::FETCH_COLUMN));',
			databases[0]], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	assert.deepEqual(storedEtags(), ['fixture-etag'], 'the persisted ETag makes deletion-on-missing-remote applicable');
	const tombstone = await contactAction(environment.server.baseUrl, owner, 'ContactSave', {
		uid: '', jCard: JSON.stringify(jCard('Pending local deletion', 'pending-delete@example.test'))
	});
	assert.equal(tombstone.json?.Result?.Result, true);
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'ContactsDelete', {
		uids: String(tombstone.json.Result.ResultID)
	})).json?.Result, true);
	const databaseState = () => {
		const result = spawnSync(phpBinary, ['-r',
			'$db = new PDO("sqlite:".$argv[1]); echo json_encode($db->query("SELECT id_contact,id_contact_str,changed,deleted,etag FROM rainloop_ab_contacts ORDER BY id_contact")->fetchAll(PDO::FETCH_ASSOC));',
			databases[0]], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	const originalState = databaseState();
	assert.equal(originalState.filter(row => Number(row.deleted) === 1).length, 1);
	const foreign = await startLoopbackDavServer(t);
	await setDavAllowedOrigins(t, environment, new URL(dav.url).origin + ',' + new URL(foreign.url).origin);
	owner = await login(environment.server.baseUrl, 'dav-bounds-owner@example.test');
	for (const badListing of [
		listing.replace('/addressbook/bounded-fixture.vcf', foreign.url + 'foreign.vcf'),
		listing.replace('<d:resourcetype/>', '<d:resourcetype/><d:current-user-principal><d:href>'
			+ foreign.url + '</d:href></d:current-user-principal>'),
		listing.replace('/addressbook/bounded-fixture.vcf', 'http://user@localhost/invalid.vcf')
	]) {
		dav.setListing(badListing);
		const failure = await contactAction(environment.server.baseUrl, owner, 'ContactsSync');
		const final = JSON.parse(failure.text.trim().split('\n').at(-1));
		assert.equal(final.Result, false);
		assert.equal(final.code, 140);
		assert.deepEqual(databaseState(), originalState, 'invalid href preserves contacts, ETags and pending tombstones before mutation');
	}
	assert.equal(foreign.requests.length, 0, 'separately approved foreign listing origin receives no request');
	await setDavAllowedOrigins(t, environment, '');
	owner = await login(environment.server.baseUrl, 'dav-bounds-owner@example.test');
	dav.requests.length = 0;
	const revoked = await contactAction(environment.server.baseUrl, owner, 'ContactsSync');
	assert.equal(JSON.parse(revoked.text.trim().split('\n').at(-1)).code, 140);
	assert.equal(dav.requests.length, 0, 'revoking a previously saved origin prevents all DAV egress');
	assert.deepEqual(databaseState(), originalState);
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'Contacts')).json?.Result?.List?.length, 1,
		'local Contacts remain available with an unapproved stored synchronization URL');
	const localOnly = await contactAction(environment.server.baseUrl, owner, 'ContactSave', {
		uid: '', jCard: JSON.stringify(jCard('Local only', 'local-only@example.test'))
	});
	assert.equal(localOnly.json?.Result?.Result, true, 'unapproved stored sync configuration does not disable local writes');
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'ContactsDelete', {
		uids: String(localOnly.json.Result.ResultID)
	})).json?.Result, true);
	for (const fields of [{ Mode: '0', Url: dav.url }, { Mode: '1', Url: '' }]) {
		assert.equal((await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
			...fields, User: '', Password: ''
		})).json?.Result, true, 'disabled or blank configuration can still be cleared without destination approval');
	}
	await setDavAllowedOrigins(t, environment, new URL(dav.url).origin);
	owner = await login(environment.server.baseUrl, 'dav-bounds-owner@example.test');
	assert.equal((await contactAction(environment.server.baseUrl, owner, 'SaveContactsSyncData', {
		Mode: '2', Url: dav.url, User: 'synthetic-dav-user', Password: 'synthetic-dav-password'
	})).json?.Result, true);
	// Valid XML, just one byte over the production 1 MiB ceiling.
	dav.setListing(listing.replace('</d:multistatus>', '<!--' + ' '.repeat(1024 * 1024 + 1 - listing.length - 7) + '--></d:multistatus>'));
	const failed = await contactAction(environment.server.baseUrl, owner, 'ContactsSync');
	const failure = JSON.parse(failed.text.trim().split('\n').at(-1));
	assert.equal(failure.Result, false);
	assert.equal(failure.code, 140);
	const after = await contactAction(environment.server.baseUrl, owner, 'Contacts', { Search: 'bounded-fixture@example.test' });
	assert.deepEqual(after.json?.Result?.List, before.json.Result.List, 'failed listing preserves the contact');
	assert.deepEqual(storedEtags(), ['fixture-etag'], 'failed listing preserves its persisted ETag');
});
