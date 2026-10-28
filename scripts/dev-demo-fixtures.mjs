export const demoEmail = 'demo@example.test';
export const demoPassword = 'demo';

export const demoContacts = [
	{ name: 'Anna Becker', email: 'anna.becker@example.test', organization: 'Nordlicht Studio', phone: '+49 30 5550 0101' },
	{ name: 'Max Fischer', email: 'max.fischer@example.test', organization: 'Nordlicht Studio', phone: '+49 30 5550 0102' },
	{ name: 'Lisa Wagner', email: 'lisa.wagner@example.test', organization: 'Klarblick Design', phone: '+49 30 5550 0103' },
	{ name: 'Daniel Hoffmann', email: 'daniel.hoffmann@example.test', organization: 'Petuja Demo Team', phone: '' },
	{ name: 'Example Company Support', email: 'support@example.test', organization: 'Example Company', phone: '+49 30 5550 0199' }
];

function escapeVCardText(value) {
	return String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

export function createDemoContactsVCard(contacts) {
	return contacts.map(contact => {
		const nameParts = String(contact.name).trim().split(/\s+/);
		const familyName = 1 < nameParts.length ? nameParts.pop() : '';
		const givenName = nameParts.join(' ');
		return [
			'BEGIN:VCARD',
			'VERSION:3.0',
			'FN:' + escapeVCardText(contact.name),
			'N:' + [familyName, givenName, '', '', ''].map(escapeVCardText).join(';'),
			...(contact.organization ? ['ORG:' + escapeVCardText(contact.organization)] : []),
			'EMAIL;TYPE=WORK:' + escapeVCardText(contact.email),
			...(contact.phone ? ['TEL;TYPE=WORK:' + escapeVCardText(contact.phone)] : []),
			'END:VCARD',
			''
		].join('\r\n');
	}).join('');
}

const pixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pYQAAAAASUVORK5CYII=';
const testPdf = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').toString('base64');

const definitions = [
	{
		folder: 'INBOX', uid: 1, fromName: 'Anna Becker', from: 'anna.becker@example.test',
		to: ['demo@example.test'], subject: 'Projektstart: Kundenportal im Überblick', date: 'Fri, 23 Oct 2026 08:42:00 +0200',
		flags: ['\\Flagged'], html: true,
		body: '<h2>Guten Morgen!</h2><p>Der Projektstart für das neue Kundenportal ist vorbereitet. Im Anhang findest du den kurzen Ablaufplan für die erste Woche.</p><p>Am Montag sammeln wir die offenen Fragen, am Dienstag stimmen wir die Startseite und die wichtigsten Wege durch das Portal ab. Danach halte ich die Entscheidungen im gemeinsamen Protokoll fest.</p><p>Viele Grüße<br>Anna</p>',
		attachments: [{ filename: 'projektstart-plan.png', contentType: 'image/png', data: pixelPng }]
	},
	{
		folder: 'INBOX', uid: 2, fromName: 'Max Fischer', from: 'max.fischer@example.test', to: ['demo@example.test'],
		subject: 'Re: Projektstart: Kundenportal im Überblick', date: 'Thu, 22 Oct 2026 16:18:00 +0200', flags: ['\\Seen'],
		inReplyTo: '<demo-1@example.test>', body: 'Hallo zusammen,\r\n\r\nDer Ablauf passt für mich. Ich bringe die aktuellen Entwürfe zum Termin am Montag mit.\r\n\r\nViele Grüße\r\nMax'
	},
	{
		folder: 'INBOX', uid: 3, fromName: 'Lisa Wagner', from: 'lisa.wagner@example.test',
		to: ['demo@example.test', 'anna.becker@example.test'], cc: ['max.fischer@example.test'],
		subject: 'Terminbestätigung: Design Review', date: 'Wed, 21 Oct 2026 11:05:00 +0200', flags: [],
		body: 'Hallo Anna und Robin,\r\n\r\nUnser Design Review findet am Donnerstag um 14:30 Uhr statt. Ich habe Max in CC genommen, damit alle denselben Stand haben.\r\n\r\nBeste Grüße\r\nLisa',
		attachments: [{ filename: 'review-einladung.pdf', contentType: 'application/pdf', data: testPdf }]
	},
	{
		folder: 'INBOX', uid: 4, fromName: 'Example Company', from: 'versand@example.test', to: ['demo@example.test'],
		subject: 'Ihre Test-Bestellung ist unterwegs', date: 'Tue, 20 Oct 2026 09:14:00 +0200', flags: ['\\Seen'],
		body: 'Guten Tag,\r\n\r\nIhre Demo-Bestellung wurde für den Versand vorbereitet. Die Sendungsnummer TEST-2048 ist eine lokale Beispielsnummer und kann nicht außerhalb dieser Demo verfolgt werden.\r\n\r\nExample Company Versandteam'
	},
	{
		folder: 'INBOX', uid: 5, fromName: 'Example Company Buchhaltung', from: 'rechnung@example.test', to: ['demo@example.test'],
		subject: 'Rechnung 2026-1042 für das Demo-Projekt', date: 'Mon, 19 Oct 2026 13:30:00 +0200', flags: [],
		body: 'Guten Tag,\r\n\r\nanbei finden Sie die fiktive Rechnung 2026-1042 für das lokale Demo-Projekt. Es werden keine Zahlungen ausgelöst.\r\n\r\nFreundliche Grüße\r\nExample Company Buchhaltung',
		attachments: [{ filename: 'rechnung-2026-1042.pdf', contentType: 'application/pdf', data: testPdf }]
	},
	{
		folder: 'INBOX', uid: 6, fromName: 'petuja.email Demo-Team', from: 'team@example.test', to: ['demo@example.test'],
		subject: 'Willkommen in der lokalen Demo', date: 'Sun, 18 Oct 2026 08:00:00 +0200', flags: ['\\Seen'], html: true,
		body: '<p>Schön, dass du die lokale Demo testest.</p><p>Alle Nachrichten, Kontakte und Empfängeradressen sind fiktiv. Der lokale SMTP-Dienst nimmt Nachrichten ausschließlich auf diesem Rechner an.</p><p>Viel Spaß beim Erkunden!</p>'
	},
	{
		folder: 'INBOX', uid: 7, fromName: 'Nordlicht Studio', from: 'newsletter@example.test', to: ['demo@example.test'],
		subject: 'Monatsbrief – Oktober', date: 'Fri, 16 Oct 2026 07:20:00 +0200', flags: ['\\Seen'], html: true,
		body: '<h1>Monatsbrief – Oktober</h1><p>Die besten Ideen entstehen oft dann, wenn ein Team Zeit hat, sie gemeinsam anzuschauen. In diesem Monat haben wir drei kleine Verbesserungen umgesetzt: übersichtlichere Statusmeldungen, bessere Tastaturbedienung und klarere Hinweise bei leeren Listen.</p><p>Für November planen wir eine offene Fragerunde und sammeln dafür noch Themen.</p><p><a href="https://example.test/demo-only">Beispiel-Link ohne externe Inhalte</a></p>'
	},
	{
		folder: 'INBOX', uid: 8, fromName: 'Example Company Support', from: 'support@example.test', to: ['demo@example.test'],
		subject: 'Supportanfrage #DEMO-2048', date: 'Thu, 15 Oct 2026 15:52:00 +0200', flags: [],
		body: 'Hallo Robin,\r\n\r\nwir haben die Beispielanfrage #DEMO-2048 erhalten. Eine Kollegin meldet sich im nächsten lokalen Demo-Schritt mit einer fiktiven Antwort.\r\n\r\nViele Grüße\r\nExample Company Support'
	},
	{
		folder: 'INBOX', uid: 9, fromName: 'Daniel Hoffmann', from: 'daniel.hoffmann@example.test', to: ['demo@example.test'],
		subject: 'Notizen vom Wochenmeeting', date: 'Wed, 14 Oct 2026 10:10:00 +0200', flags: ['\\Seen', '\\Flagged'],
		body: 'Hallo,\r\n\r\n1. Die Startseite wird zuerst auf kleinen Displays geprüft.\r\n2. Wir sammeln Feedback bis Freitag.\r\n3. Danach folgt ein gemeinsamer Durchgang durch die Einstellungen.\r\n\r\nDanke und viele Grüße\r\nDaniel'
	},
	{
		folder: 'INBOX', uid: 10, fromName: 'Klarblick Design', from: 'termine@example.test',
		to: ['demo@example.test'], subject: 'Einladung: Community-Abend', date: 'Mon, 12 Oct 2026 12:45:00 +0200', flags: ['\\Seen'],
		body: 'Hallo!\r\n\r\nWir laden zum Community-Abend am 29. Oktober ein. Die Veranstaltung ist ein fiktiver Eintrag für die Demo.\r\n\r\nViele Grüße\r\nKlarblick Design'
	},
	{
		folder: 'INBOX', uid: 11, fromName: 'Anna Becker', from: 'anna.becker@example.test', to: ['demo@example.test'],
		subject: 'Kurze Rückfrage zur Navigation', date: 'Fri, 9 Oct 2026 09:05:00 +0200', flags: ['\\Seen'],
		body: 'Passt die Bezeichnung „Archiv“ für dich? Ich habe den Menüpunkt im Entwurf markiert.\r\n\r\nAnna'
	},
	{
		folder: 'INBOX', uid: 12, fromName: 'Example Company', from: 'info@example.test', to: ['demo@example.test'],
		subject: 'Produktupdate: Kalenderimport', date: 'Wed, 7 Oct 2026 08:30:00 +0200', flags: [], html: true,
		body: '<p>Der Import von Kalenderdateien wurde verbessert.</p><ul><li>Fehler werden pro Termin angezeigt.</li><li>Zeitzonen bleiben sichtbar.</li><li>Leere Dateien erhalten einen klaren Hinweis.</li></ul><p>Diese Nachricht ist ein synthetisches Produktupdate.</p>'
	},
	{
		folder: 'INBOX', uid: 13, fromName: 'Max Fischer', from: 'max.fischer@example.test', to: ['demo@example.test'],
		subject: 'Re: Besprechung am Montag', date: 'Mon, 5 Oct 2026 17:40:00 +0200', flags: ['\\Seen'],
		body: 'Danke für die Zusammenfassung. Ich kümmere mich um die offenen Punkte und schicke morgen einen aktualisierten Entwurf.\r\n\r\nMax'
	},
	{
		folder: 'INBOX', uid: 14, fromName: 'Example Company Events', from: 'events@example.test', to: ['demo@example.test'],
		subject: 'Ihre Anmeldung ist bestätigt', date: 'Wed, 30 Sep 2026 14:00:00 +0200', flags: ['\\Seen'],
		body: 'Ihre Anmeldung für das lokale Demo-Event ist bestätigt. Veranstaltungsort und Bestätigung sind fiktiv.\r\n\r\nExample Company Events'
	},
	{
		folder: 'Sent', uid: 1, fromName: 'Robin Demo', from: 'demo@example.test', to: ['anna.becker@example.test'],
		subject: 'Re: Projektstart: Kundenportal im Überblick', date: 'Thu, 22 Oct 2026 16:42:00 +0200', flags: ['\\Seen'],
		body: 'Hallo Anna,\r\n\r\ndanke für den Plan. Ich habe den Ablauf ergänzt und freue mich auf den Start.\r\n\r\nViele Grüße\r\nRobin'
	},
	{
		folder: 'Sent', uid: 2, fromName: 'Robin Demo', from: 'demo@example.test', to: ['lisa.wagner@example.test'], cc: ['max.fischer@example.test'],
		subject: 'Unterlagen für das Design Review', date: 'Tue, 13 Oct 2026 11:02:00 +0200', flags: ['\\Seen'],
		body: 'Hallo Lisa,\r\n\r\nhier sind die Unterlagen für unser Review. Max ist in CC.\r\n\r\nViele Grüße\r\nRobin'
	},
	{
		folder: 'Sent', uid: 3, fromName: 'Robin Demo', from: 'demo@example.test', to: ['support@example.test'],
		subject: 'Rückfrage zur Demo-Bestellung', date: 'Fri, 2 Oct 2026 09:12:00 +0200', flags: ['\\Seen'],
		body: 'Guten Morgen,\r\n\r\ndies ist eine gespeicherte Beispielnachricht aus dem Ordner „Gesendet“.\r\n\r\nRobin'
	},
	{
		folder: 'Drafts', uid: 1, fromName: 'Robin Demo', from: 'demo@example.test', to: ['daniel.hoffmann@example.test'],
		subject: 'Entwurf: Follow-up zur Besprechung', date: 'Fri, 23 Oct 2026 09:10:00 +0200', flags: ['\\Draft'],
		body: 'Hallo Daniel,\r\n\r\ndanke für das Gespräch. Ich ergänze noch die nächsten Schritte und sende dir die aktualisierte Version.\r\n'
	},
	{
		folder: 'Archive', uid: 1, fromName: 'Anna Becker', from: 'anna.becker@example.test', to: ['demo@example.test'],
		subject: 'Projektbriefing: erste Fassung', date: 'Mon, 28 Sep 2026 10:30:00 +0200', flags: ['\\Seen'],
		body: 'Die erste Fassung des Briefings ist abgelegt. Alle Angaben gehören zur fiktiven Demo.'
	},
	{
		folder: 'Archive', uid: 2, fromName: 'Max Fischer', from: 'max.fischer@example.test', to: ['demo@example.test'],
		subject: 'Checkliste für den Launch', date: 'Thu, 24 Sep 2026 13:15:00 +0200', flags: ['\\Seen'],
		body: 'Dokumentation, Tastaturtest und kurzer Blick auf die Sprachwahl: die Checkliste für den fiktiven Launch.'
	},
	{
		folder: 'Spam', uid: 1, fromName: 'Example Deals', from: 'angebote@example.test', to: ['demo@example.test'],
		subject: 'Ungewöhnlich gute Demo-Angebote', date: 'Tue, 6 Oct 2026 06:20:00 +0200', flags: ['\\Seen'],
		body: 'Eine offensichtliche Beispiel-Spamnachricht, die nur lokale Testdaten enthält.'
	},
	{
		folder: 'Trash', uid: 1, fromName: 'Daniel Hoffmann', from: 'daniel.hoffmann@example.test', to: ['demo@example.test'],
		subject: 'Vorläufiger Zeitplan', date: 'Fri, 25 Sep 2026 15:00:00 +0200', flags: ['\\Seen', '\\Deleted'],
		body: 'Ein älterer, verworfener Zeitplan als Beispiel im Papierkorb.'
	}
];

function encodeHeader(value) {
	return /[^\x20-\x7e]/.test(value)
		? '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?='
		: value;
}

function addressHeader(name, email) {
	return name ? '"' + name.replace(/"/g, '') + '" <' + email + '>' : email;
}

function rawMessage(item) {
	const headers = [
		'From: ' + addressHeader(item.fromName, item.from),
		'To: ' + item.to.map(value => addressHeader('', value)).join(', '),
		...(item.cc?.length ? ['Cc: ' + item.cc.map(value => addressHeader('', value)).join(', ')] : []),
		'Subject: ' + encodeHeader(item.subject),
		'Date: ' + item.date,
		'Message-ID: <demo-' + item.folder.toLowerCase() + '-' + item.uid + '@example.test>',
		...(item.inReplyTo ? ['In-Reply-To: ' + item.inReplyTo, 'References: ' + item.inReplyTo] : []),
		'MIME-Version: 1.0'
	];
	if (item.attachments?.length) {
		const boundary = 'petuja-demo-' + item.folder.toLowerCase() + '-' + item.uid;
		const body = [
			'Content-Type: multipart/mixed; boundary="' + boundary + '"', '',
			'--' + boundary,
			'Content-Type: ' + (item.html ? 'text/html' : 'text/plain') + '; charset=UTF-8',
			'Content-Transfer-Encoding: 8bit', '', item.body,
			...item.attachments.flatMap(attachment => [
				'--' + boundary,
				'Content-Type: ' + attachment.contentType + '; name="' + attachment.filename + '"',
				'Content-Disposition: attachment; filename="' + attachment.filename + '"',
				'Content-Transfer-Encoding: base64', '', attachment.data
			]),
			'--' + boundary + '--', ''
		].join('\r\n');
		return [...headers, '', body].join('\r\n');
	}
	if (item.html) {
		headers.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit');
	} else {
		headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit');
	}
	return [...headers, '', item.body, ''].join('\r\n');
}

export function createDemoMailbox() {
	const folders = Object.create(null);
	for (const name of ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash']) {
		folders[name] = [];
	}
	for (const item of definitions) {
		folders[item.folder].push({
			uid: item.uid,
			flags: [...item.flags],
			internalDate: item.date,
			raw: rawMessage(item),
			body: item.body,
			isHtml: Boolean(item.html),
			attachments: item.attachments?.map(attachment => ({ ...attachment })) || []
		});
	}
	return { folders, nextUid: 15, uidValidity: 1261023 };
}

export function demoMessageCount(mailbox = createDemoMailbox()) {
	return Object.values(mailbox.folders).reduce((total, messages) => total + messages.length, 0);
}
