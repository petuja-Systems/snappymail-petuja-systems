import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import test from 'node:test';
import { createDemoMailbox, demoContacts, demoEmail, demoMessageCount } from '../scripts/dev-demo-fixtures.mjs';
import { createSyntheticImapServer } from '../scripts/synthetic-imap-server.mjs';
import { createSyntheticSmtpServer } from '../scripts/synthetic-smtp-server.mjs';

function response(socket, pattern, timeout = 3000) {
	return new Promise((resolve, reject) => {
		let value = '';
		const timer = setTimeout(() => finish(new Error('Timed out waiting for ' + pattern + '; received ' + value.slice(-300))), timeout);
		const onData = chunk => {
			value += chunk.toString('utf8');
			if (pattern.test(value)) finish(null, value);
		};
		const onError = error => finish(error);
		function finish(error, result) {
			clearTimeout(timer);
			socket.removeListener('data', onData);
			socket.removeListener('error', onError);
			error ? reject(error) : resolve(result);
		}
		socket.on('data', onData);
		socket.on('error', onError);
	});
}

async function connect(port) {
	const socket = createConnection({ host: '127.0.0.1', port });
	await new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('error', reject);
	});
	return socket;
}

test('demo mailbox contains a deterministic, diverse set of fictional messages and contacts', () => {
	const first = createDemoMailbox();
	const second = createDemoMailbox();
	assert.equal(demoMessageCount(first), 22);
	assert.deepEqual(Object.fromEntries(Object.entries(first.folders).map(([folder, messages]) => [folder, messages.length])), {
		INBOX: 14, Sent: 3, Drafts: 1, Archive: 2, Spam: 1, Trash: 1
	});
	assert.deepEqual(first, second, 'the initial mailbox is repeatable on every launch');
	assert.equal(demoContacts.length, 5);
	assert.ok(demoContacts.every(contact => contact.email.endsWith('.test')));
	assert.ok(Object.values(first.folders).flat().every(message => message.raw.includes('example.test')));
	assert.match(first.folders.INBOX[0].raw, /Content-Type: multipart\/mixed/);
	assert.match(first.folders.INBOX[0].raw, /projektstart-plan\.png/);
	assert.equal(demoEmail, 'demo@example.test');
});

test('synthetic IMAP supports authenticated folder, search, fetch, flag, and append flows on loopback', async t => {
	const mailbox = createDemoMailbox();
	const server = createSyntheticImapServer({ expectedUsername: demoEmail, expectedPassword: 'demo', mailbox });
	t.after(() => server.close());
	await server.listen();
	const socket = await connect(server.port);
	t.after(() => socket.destroy());
	assert.match(await response(socket, /^\* OK/m), /^\* OK \[CAPABILITY/);
	socket.write('A1 CAPABILITY\r\n');
	assert.match(await response(socket, /\r\nA1 OK CAPABILITY completed\r\n/), /IMAP4rev1.*MOVE/);
	socket.write('A2 LOGIN "' + demoEmail + '" "demo"\r\n');
	assert.match(await response(socket, /(?:^|\r\n)A2 OK .*authenticated\r\n/), /authenticated/);
	assert.deepEqual(server.logins, [demoEmail]);
	socket.write('A3 LIST "" "*"\r\n');
	const listed = await response(socket, /\r\nA3 OK LIST completed\r\n/);
	for (const folder of ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash']) assert.match(listed, new RegExp('"' + folder + '"'));
	socket.write('A4 SELECT INBOX\r\n');
	assert.match(await response(socket, /\r\nA4 OK .*SELECT completed\r\n/), /14 EXISTS/);
	socket.write('A5 SEARCH UNSEEN\r\n');
	assert.match(await response(socket, /\r\nA5 OK SEARCH completed\r\n/), /\* SEARCH 1 3 5 8 12/);
	socket.write('A6 UID FETCH 1 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER])\r\n');
	const fetched = await response(socket, /\r\nA6 OK FETCH completed\r\n/);
	assert.match(fetched, /ENVELOPE/);
	assert.match(fetched, /BODY\[HEADER\] \{/);
	assert.match(fetched, /BODYSTRUCTURE/);
	socket.write('A7 APPEND "Sent" (\\Seen) {33}\r\n');
	assert.match(await response(socket, /\+ Ready for local message literal/), /Ready/);
	const message = 'Subject: local\r\n\r\nHello from test';
	assert.equal(Buffer.byteLength(message), 33);
	socket.write(message + '\r\n');
	assert.match(await response(socket, /(?:^|\r\n)A7 OK \[APPENDUID [^\]]+\] APPEND completed\r\n/), /APPENDUID/);
	socket.write('A8 STATUS Sent (MESSAGES)\r\n');
	assert.match(await response(socket, /\r\nA8 OK STATUS completed\r\n/), /MESSAGES 4/);
});

test('synthetic IMAP bounds command lines and folder growth, including prototype-like names', async t => {
	const mailbox = createDemoMailbox();
	const server = createSyntheticImapServer({ expectedUsername: demoEmail, expectedPassword: 'demo', mailbox });
	t.after(() => server.close());
	await server.listen();
	const socket = await connect(server.port);
	t.after(() => socket.destroy());
	assert.match(await response(socket, /^\* OK/m), /^\* OK \[CAPABILITY/);
	socket.write('A0 LOGIN "' + demoEmail + '" "demo"\r\n');
	assert.match(await response(socket, /(?:^|\r\n)A0 OK .*authenticated\r\n/), /authenticated/);
	socket.write('A1 CREATE constructor\r\n');
	assert.match(await response(socket, /(?:^|\r\n)A1 OK CREATE completed\r\n/), /CREATE completed/);
	for (let index = 0; index < 25; index++) {
		const tag = 'A' + (index + 2);
		socket.write(tag + ' CREATE "Demo Folder ' + index + '"\r\n');
		assert.match(await response(socket, new RegExp('(?:^|\\r\\n)' + tag + ' OK CREATE completed\\r\\n')), /CREATE completed/);
	}
	assert.equal(Object.keys(mailbox.folders).length, 32);
	socket.write('A27 CREATE Overflow\r\n');
	assert.match(await response(socket, /(?:^|\r\n)A27 NO \[OVERQUOTA\] Local demo folder capacity reached\r\n/), /folder capacity/);
	assert.equal(Object.hasOwn(mailbox.folders, 'constructor'), true);

	const longLineSocket = await connect(server.port);
	t.after(() => longLineSocket.destroy());
	assert.match(await response(longLineSocket, /^\* OK/m), /local synthetic mailbox/);
	const closed = new Promise(resolve => longLineSocket.once('close', resolve));
	longLineSocket.write('A1 NOOP ' + 'x'.repeat(9000));
	await closed;
});

test('synthetic IMAP rejects amplified FETCH literals before writing any literal data', async t => {
	const raw = 'Subject: bounded fetch\r\n\r\n' + 'x'.repeat(64 * 1024);
	const message = {
		uid: 1, flags: [], raw, internalDate: '2026-01-01T00:00:00Z',
		body: '', isHtml: false, attachments: []
	};
	const mailbox = { folders: { INBOX: [message] }, nextUid: 2, uidValidity: 1 };
	const server = createSyntheticImapServer({ expectedUsername: demoEmail, expectedPassword: 'demo', mailbox });
	t.after(() => server.close());
	await server.listen();
	const socket = await connect(server.port);
	t.after(() => socket.destroy());
	assert.match(await response(socket, /^\* OK/m), /local synthetic mailbox/);
	socket.write('A1 LOGIN "' + demoEmail + '" "demo"\r\n');
	assert.match(await response(socket, /(?:^|\r\n)A1 OK .*authenticated\r\n/), /authenticated/);
	socket.write('A2 SELECT INBOX\r\n');
	assert.match(await response(socket, /(?:^|\r\n)A2 OK .*SELECT completed\r\n/), /SELECT completed/);
	const selectors = Array.from({ length: 256 }, () => 'BODY.PEEK[]').join(' ');
	socket.write('A3 FETCH 1 (' + selectors + ')\r\n');
	const rejected = await response(socket, /(?:^|\r\n)A3 NO \[OVERQUOTA\] FETCH literal byte limit reached\r\n/);
	assert.doesNotMatch(rejected, /BODY\[\] \{/);
});

test('synthetic SMTP captures messages locally and refuses external delivery features', async t => {
	const server = createSyntheticSmtpServer();
	t.after(() => server.close());
	await server.listen();
	const socket = await connect(server.port);
	t.after(() => socket.destroy());
	assert.match(await response(socket, /^220/m), /local synthetic SMTP sink/);
	socket.write('EHLO local-demo\r\n');
	assert.match(await response(socket, /250 SIZE \d+\r\n/), /250-8BITMIME/);
	socket.write('AUTH PLAIN\r\n');
	assert.match(await response(socket, /502 .*authentication is disabled/), /disabled/);
	socket.write('MAIL FROM:<demo@example.test>\r\n');
	assert.match(await response(socket, /250 2\.1\.0/), /Sender accepted/);
	socket.write('RCPT TO:<anna.becker@example.test>\r\n');
	assert.match(await response(socket, /250 2\.1\.5/), /Recipient accepted/);
	socket.write('DATA\r\n');
	assert.match(await response(socket, /354 End message/), /delivery stays local/);
	socket.write('Subject: local demo\r\n\r\nline one\r\n..dot-stuffed line\r\n.\r\n');
	assert.match(await response(socket, /250 2\.0\.0 Message stored in the local demo outbox/), /nothing was sent externally/);
	assert.equal(server.accepted.length, 1);
	assert.deepEqual(server.accepted[0].recipients, ['anna.becker@example.test']);
	assert.match(server.accepted[0].raw, /\.dot-stuffed line/);
	socket.write('STARTTLS\r\n');
	assert.match(await response(socket, /502 .*TLS is not available/), /loopback-only/);
	socket.write('QUIT\r\n');
	assert.match(await response(socket, /221 2\.0\.0 Bye/), /Bye/);
});

test('synthetic SMTP rejects oversized messages even when the terminator arrives in the same chunk', async t => {
	const server = createSyntheticSmtpServer({ maxBytes: 8 });
	t.after(() => server.close());
	await server.listen();
	const socket = await connect(server.port);
	t.after(() => socket.destroy());
	assert.match(await response(socket, /^220/m), /local synthetic SMTP sink/);
	socket.write('EHLO local-demo\r\n');
	assert.match(await response(socket, /250 SIZE \d+\r\n/), /local synthetic SMTP sink/);
	socket.write('MAIL FROM:<demo@example.test>\r\n');
	assert.match(await response(socket, /250 2\.1\.0/), /Sender accepted/);
	socket.write('RCPT TO:<anna.becker@example.test>\r\n');
	assert.match(await response(socket, /250 2\.1\.5/), /Recipient accepted/);
	socket.write('DATA\r\n');
	assert.match(await response(socket, /354 End message/), /delivery stays local/);
	socket.write('123456789\r\n.\r\n');
	assert.match(await response(socket, /552 5\.3\.4 Message exceeds/), /local demo size limit/);
	assert.equal(server.accepted.length, 0);
});

test('synthetic SMTP caps pending input while outbox storage is awaiting', async t => {
	let releaseMessage;
	let markEntered;
	const messageEntered = new Promise(resolve => { markEntered = resolve; });
	const storageGate = new Promise(resolve => { releaseMessage = resolve; });
	const server = createSyntheticSmtpServer({
		maxBytes: 64,
		onMessage: async () => { markEntered(); await storageGate; }
	});
	t.after(async () => { releaseMessage(); await server.close(); });
	await server.listen();
	const socket = await connect(server.port);
	t.after(() => socket.destroy());
	assert.match(await response(socket, /^220/m), /local synthetic SMTP sink/);
	socket.write('MAIL FROM:<demo@example.test>\r\n');
	assert.match(await response(socket, /250 2\.1\.0/), /Sender accepted/);
	socket.write('RCPT TO:<anna.becker@example.test>\r\n');
	assert.match(await response(socket, /250 2\.1\.5/), /Recipient accepted/);
	socket.write('DATA\r\n');
	assert.match(await response(socket, /354 End message/), /delivery stays local/);
	socket.write('Subject: x\r\n\r\nx\r\n.\r\n');
	await messageEntered;
	const closed = new Promise(resolve => socket.once('close', resolve));
	socket.write('x'.repeat(9000));
	let timeout;
	try {
		await Promise.race([
			closed,
			new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SMTP input buffer was not capped')), 3000); })
		]);
	} finally {
		clearTimeout(timeout);
	}
	releaseMessage();
});

test('synthetic SMTP bounds recipients per transaction', async t => {
	const server = createSyntheticSmtpServer();
	t.after(() => server.close());
	await server.listen();
	const socket = await connect(server.port);
	t.after(() => socket.destroy());
	assert.match(await response(socket, /^220/m), /local synthetic SMTP sink/);
	socket.write('MAIL FROM:<demo@example.test>\r\n');
	assert.match(await response(socket, /250 2\.1\.0/), /Sender accepted/);
	for (let index = 0; index < 100; index++) {
		socket.write('RCPT TO:<recipient' + index + '@example.test>\r\n');
		assert.match(await response(socket, /250 2\.1\.5/), /Recipient accepted/);
	}
	socket.write('RCPT TO:<overflow@example.test>\r\n');
	assert.match(await response(socket, /452 4\.5\.3 Local demo recipient limit reached/), /recipient limit/);
});
