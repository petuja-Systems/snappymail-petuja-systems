import { createServer } from 'node:net';

const capability = 'IMAP4rev1 UIDPLUS MOVE SPECIAL-USE';
const maxMailboxMessages = 1000;
const maxMailboxBytes = 50 * 1024 * 1024;
const maxMailboxFolders = 32;
const maxCommandBytes = 8 * 1024;
const maxFetchLiteralBytes = 10 * 1024 * 1024;
const maxFetchLiteralCount = 1024;
const knownFolders = {
	INBOX: '\\Inbox',
	Sent: '\\Sent',
	Drafts: '\\Drafts',
	Archive: '\\Archive',
	Spam: '\\Junk',
	Trash: '\\Trash'
};

function splitWords(input) {
	const words = [];
	let current = '';
	let quoted = false;
	let escaped = false;
	let parentheses = 0;
	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
		} else if (quoted && '\\' === char) {
			current += char;
			escaped = true;
		} else if ('"' === char) {
			quoted = !quoted;
			current += char;
		} else if (!quoted && '(' === char) {
			parentheses++;
			current += char;
		} else if (!quoted && ')' === char) {
			parentheses = Math.max(0, parentheses - 1);
			current += char;
		} else if (!quoted && 0 === parentheses && /\s/.test(char)) {
			if (current) {
				words.push(current);
				current = '';
			}
		} else {
			current += char;
		}
	}
	if (current) {
		words.push(current);
	}
	return words.map(word => word.startsWith('"') && word.endsWith('"')
		? word.slice(1, -1).replace(/\\([\\"])/g, '$1')
		: word);
}

function quote(value) {
	if (null === value || undefined === value) {
		return 'NIL';
	}
	return '"' + String(value).replace(/[\r\n]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function unquote(value = '') {
	return value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1).replace(/\\([\\"])/g, '$1')
		: value;
}

function folderName(mailbox, requested) {
	if ('INBOX' === requested.toUpperCase()) {
		return Object.keys(mailbox.folders).find(name => 'INBOX' === name.toUpperCase()) || 'INBOX';
	}
	return Object.keys(mailbox.folders).find(name => name.toLowerCase() === requested.toLowerCase()) || requested;
}

function parseHeaders(raw) {
	const separator = raw.indexOf('\r\n\r\n');
	const source = separator >= 0 ? raw.slice(0, separator) : raw.split(/\r?\n\r?\n/, 1)[0];
	const headers = Object.create(null);
	for (const line of source.split(/\r?\n/)) {
		if (/^[ \t]/.test(line) && Object.keys(headers).length) {
			const last = Object.keys(headers).at(-1);
			headers[last] += ' ' + line.trim();
			continue;
		}
		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (match) {
			const key = match[1].toUpperCase();
			headers[key] = headers[key] ? headers[key] + ', ' + match[2] : match[2];
		}
	}
	return { headers, separator, source };
}

function addresses(value = '') {
	return [...value.matchAll(/(?:"?([^"<,]*)"?\s*)?<([^>]+)>|(?:^|,\s*)([^,\s]+@[^,\s]+)/g)]
		.map(match => {
			const email = match[2] || match[3] || '';
			const display = (match[1] || '').trim();
			const [local = '', domain = ''] = email.split('@');
			return '(' + [quote(display || null), 'NIL', quote(local), quote(domain)].join(' ') + ')';
		});
}

function envelope(message) {
	const { headers } = parseHeaders(message.raw);
	const list = key => {
		const values = addresses(headers[key] || '');
		return values.length ? '(' + values.join(' ') + ')' : 'NIL';
	};
	const date = headers.DATE || null;
	const subject = headers.SUBJECT || null;
	return '(' + [
		quote(date), quote(subject), list('FROM'), 'NIL', 'NIL', list('TO'), list('CC'), list('BCC'),
		quote(headers['IN-REPLY-TO'] || null), quote(headers['MESSAGE-ID'] || null)
	].join(' ') + ')';
}

function partHeader(message, attachment = null) {
	if (attachment) {
		return [
			'Content-Type: ' + attachment.contentType + '; name="' + attachment.filename + '"',
			'Content-Disposition: attachment; filename="' + attachment.filename + '"',
			'Content-Transfer-Encoding: base64', '', ''
		].join('\r\n');
	}
	return [
		'Content-Type: ' + (message.isHtml ? 'text/html' : 'text/plain') + '; charset=UTF-8',
		'Content-Transfer-Encoding: 8bit', '', ''
	].join('\r\n');
}

function bodyStructure(message) {
	const bodyType = message.isHtml ? 'HTML' : 'PLAIN';
	const bodyLength = Buffer.byteLength(message.body || '', 'utf8');
	const bodyLines = (message.body || '').split(/\r?\n/).length;
	const body = '("TEXT" "' + bodyType + '" ("CHARSET" "UTF-8") NIL NIL "8BIT" '
		+ bodyLength + ' ' + bodyLines + ' NIL NIL NIL)';
	if (!message.attachments?.length) {
		return body;
	}
	const attachments = message.attachments.map(attachment => {
		const [type = 'APPLICATION', subtype = 'OCTET-STREAM'] = attachment.contentType.toUpperCase().split('/');
		const size = Buffer.byteLength(attachment.data || '', 'utf8');
		return '("' + type + '" "' + subtype + '" ("NAME" ' + quote(attachment.filename)
			+ ') NIL NIL "BASE64" ' + size + ' NIL ("ATTACHMENT" ("FILENAME" '
			+ quote(attachment.filename) + ')) NIL NIL)';
	});
	const boundary = 'petuja-demo';
	return '(' + [body, ...attachments, '"MIXED" ("BOUNDARY" ' + quote(boundary) + ') NIL NIL NIL'].join(' ') + ')';
}

function sectionValue(message, section) {
	const upper = section.toUpperCase();
	const { headers, separator, source } = parseHeaders(message.raw);
	const rawBody = separator >= 0 ? message.raw.slice(separator + 4) : '';
	if ('HEADER' === upper) {
		return source + '\r\n\r\n';
	}
	if ('TEXT' === upper || '' === upper) {
		return 'TEXT' === upper ? rawBody : message.raw;
	}
	const fields = upper.match(/^HEADER\.FIELDS(?:\.NOT)?\s*\(([^)]*)\)$/);
	if (fields) {
		const requested = fields[1].split(/\s+/).filter(Boolean).map(value => value.toUpperCase());
		const isNot = upper.startsWith('HEADER.FIELDS.NOT');
		const selected = source.split(/\r?\n/).filter(line => {
			const name = line.match(/^([^:]+):/)?.[1]?.toUpperCase();
			return name && (isNot ? !requested.includes(name) : requested.includes(name));
		});
		return selected.join('\r\n') + '\r\n\r\n';
	}

	const part = upper.match(/^(\d+(?:\.\d+)*)(?:\.(MIME|HEADER|TEXT))?$/);
	if (part) {
		const [, number, suffix = ''] = part;
		const indexes = number.split('.').map(value => Number(value));
		const first = indexes[0];
		const attachment = indexes.length === 1 && first > 1 ? message.attachments?.[first - 2] : null;
		if (attachment) {
			if ('MIME' === suffix || 'HEADER' === suffix) {
				return partHeader(message, attachment).replace(/\r\n\r\n$/, '\r\n');
			}
			return attachment.data || '';
		}
		if (1 === first && 1 === indexes.length) {
			return 'MIME' === suffix || 'HEADER' === suffix
				? partHeader(message).replace(/\r\n\r\n$/, '\r\n')
				: message.body || '';
		}
	}
	return '';
}

function messageDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '01-Jan-2026 00:00:00 +0000';
	}
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const pad = part => String(part).padStart(2, '0');
	return pad(date.getUTCDate()) + '-' + months[date.getUTCMonth()] + '-' + date.getUTCFullYear()
		+ ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds()) + ' +0000';
}

function sequenceMatches(range, value, maximum) {
	for (const item of range.split(',')) {
		const [fromText, toText = fromText] = item.split(':');
		const parse = text => '*' === text ? maximum : Number(text);
		const from = parse(fromText);
		const to = parse(toText);
		if (Number.isFinite(from) && Number.isFinite(to) && value >= Math.min(from, to) && value <= Math.max(from, to)) {
			return true;
		}
	}
	return false;
}

function selectedMessages(session, range, uidMode) {
	const name = session.selected;
	const messages = session.mailbox.folders[name] || [];
	return messages.map((message, index) => ({ message, sequence: index + 1 }))
		.filter(({ message, sequence }) => sequenceMatches(range, uidMode ? message.uid : sequence,
			uidMode ? Math.max(0, ...messages.map(item => item.uid)) : messages.length));
}

function mailboxUsage(mailbox) {
	const messages = Object.values(mailbox.folders).flat();
	return {
		count: messages.length,
		bytes: messages.reduce((total, message) => total + Buffer.byteLength(message.raw || '', 'utf8'), 0)
	};
}

function commandResponse(session, tag, command, args, socket) {
	const mailbox = session.mailbox;
	const send = text => socket.write(text + '\r\n');
	if (!session.authenticated && !['CAPABILITY', 'LOGIN', 'LOGOUT'].includes(command)) {
		send(tag + ' NO [AUTHENTICATIONREQUIRED] Authenticate before using the synthetic mailbox');
		return;
	}
	const selectedName = session.selected;
	const messages = selectedName && mailbox.folders[selectedName] ? mailbox.folders[selectedName] : [];
	const maximumUid = Math.max(0, ...messages.map(item => item.uid));
	const uidNext = maximumUid + 1;
	const status = (name, values) => {
		const folder = folderName(mailbox, name);
		const list = mailbox.folders[folder] || [];
		const unseen = list.filter(message => !message.flags.includes('\\Seen')).length;
		const requested = values?.match(/\(([^)]*)\)/)?.[1]?.trim().split(/\s+/).filter(Boolean) || ['MESSAGES', 'UNSEEN', 'UIDNEXT', 'UIDVALIDITY'];
		const rendered = requested.map(key => {
			switch (key.toUpperCase()) {
				case 'MESSAGES': return 'MESSAGES ' + list.length;
				case 'UNSEEN': return 'UNSEEN ' + unseen;
				case 'UIDNEXT': return 'UIDNEXT ' + (Math.max(0, ...list.map(item => item.uid)) + 1);
				case 'UIDVALIDITY': return 'UIDVALIDITY ' + mailbox.uidValidity;
				case 'HIGHESTMODSEQ': return 'HIGHESTMODSEQ 1';
				default: return '';
			}
		}).filter(Boolean);
		send('* STATUS ' + quote(folder) + ' (' + rendered.join(' ') + ')');
	};
	const folders = () => Object.keys(mailbox.folders);
	const listFolders = (pattern = '*') => {
		const regex = new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/%/g, '[^/]*') + '$', 'i');
		for (const name of folders()) {
			if (regex.test(name)) {
				send('* LIST (\\HasNoChildren ' + (Object.hasOwn(knownFolders, name) ? knownFolders[name] : '') + ') "/" ' + quote(name));
			}
		}
	};
	const select = (requested, readOnly) => {
		const name = folderName(mailbox, requested);
		if (!mailbox.folders[name]) {
			return false;
		}
		session.selected = name;
		const list = mailbox.folders[name];
		send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
		send('* ' + list.length + ' EXISTS');
		send('* 0 RECENT');
		send('* OK [UIDVALIDITY ' + mailbox.uidValidity + '] UIDs valid');
		send('* OK [UIDNEXT ' + (Math.max(0, ...list.map(item => item.uid)) + 1) + '] predicted next UID');
		send('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] permanent flags');
		return true;
	};
	const uidMode = session.uidCommand;

	switch (command) {
		case 'CAPABILITY':
			send('* CAPABILITY ' + capability);
			send(tag + ' OK CAPABILITY completed');
			return;
		case 'LOGIN': {
			const username = args[0] || '';
			const password = args[1] || '';
			session.logins.push(username);
			if ((undefined === session.expectedUsername || session.expectedUsername === username)
				&& session.expectedPassword === password) {
				session.authenticated = true;
				send(tag + ' OK [CAPABILITY ' + capability + '] authenticated');
			} else {
				send(tag + ' NO [AUTHENTICATIONFAILED] ' + session.loginFailure);
			}
			return;
		}
		case 'ID': send('* ID NIL'); send(tag + ' OK ID completed'); return;
		case 'NAMESPACE': send('* NAMESPACE (("" "/")) NIL NIL'); send(tag + ' OK NAMESPACE completed'); return;
		case 'LIST':
		case 'LSUB': listFolders(args[1] || '*'); send(tag + ' OK ' + command + ' completed'); return;
		case 'STATUS': status(args[0] || 'INBOX', args[1] || ''); send(tag + ' OK STATUS completed'); return;
		case 'SELECT':
		case 'EXAMINE':
			if (select(args[0] || 'INBOX', 'EXAMINE' === command)) {
				send(tag + ' OK [' + ('EXAMINE' === command ? 'READ-ONLY' : 'READ-WRITE') + '] ' + command + ' completed');
			} else {
				send(tag + ' NO [NONEXISTENT] Mailbox does not exist');
			}
			return;
		case 'UNSELECT':
		case 'CLOSE': session.selected = ''; send(tag + ' OK ' + command + ' completed'); return;
		case 'NOOP':
			if (selectedName) send('* ' + messages.length + ' EXISTS');
			send(tag + ' OK NOOP completed');
			return;
		case 'CHECK': send(tag + ' OK CHECK completed'); return;
		case 'SEARCH': {
			const criteria = args.join(' ').toUpperCase();
			let results = messages.map((message, index) => ({ message, index }));
			if (/\bUNSEEN\b/.test(criteria)) results = results.filter(item => !item.message.flags.includes('\\Seen'));
			if (/\bSEEN\b/.test(criteria) && !/\bUNSEEN\b/.test(criteria)) results = results.filter(item => item.message.flags.includes('\\Seen'));
			if (/\bFLAGGED\b/.test(criteria) && !/\bUNFLAGGED\b/.test(criteria)) results = results.filter(item => item.message.flags.includes('\\Flagged'));
			if (/\bUNFLAGGED\b/.test(criteria)) results = results.filter(item => !item.message.flags.includes('\\Flagged'));
			if (/\bDELETED\b/.test(criteria) && !/\bUNDELETED\b/.test(criteria)) results = results.filter(item => item.message.flags.includes('\\Deleted'));
			if (/\bUNDELETED\b/.test(criteria)) results = results.filter(item => !item.message.flags.includes('\\Deleted'));
			if (/\bDRAFT\b/.test(criteria)) results = results.filter(item => item.message.flags.includes('\\Draft'));
			const textMatch = criteria.match(/\b(FROM|TO|CC|SUBJECT|BODY|TEXT)\s+"([^"]*)"/);
			if (textMatch) {
				const [, field, term] = textMatch;
				results = results.filter(item => {
					const raw = item.message.raw.toUpperCase();
					const header = parseHeaders(item.message.raw).headers;
					const source = 'BODY' === field ? raw.slice(raw.indexOf('\r\n\r\n') + 4)
						: 'TEXT' === field ? raw : header[field] || '';
					return source.toUpperCase().includes(term);
				});
			}
			const ids = results.map(({ message, index }) => uidMode ? message.uid : index + 1);
			send('* SEARCH' + (ids.length ? ' ' + ids.join(' ') : ''));
			send(tag + ' OK SEARCH completed');
			return;
		}
		case 'FETCH': {
			const range = args[0] || '*';
			const attributes = args.slice(1).join(' ');
			const selected = selectedMessages(session, range, uidMode);
			const sections = [...attributes.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\]/gi)];
			if (selected.length * sections.length > maxFetchLiteralCount) {
				send(tag + ' NO [OVERQUOTA] FETCH literal count limit reached');
				return;
			}
			let literalBytes = 0;
			for (const { message } of selected) {
				for (const [, section] of sections) {
					literalBytes += Buffer.byteLength(sectionValue(message, section), 'utf8');
					if (literalBytes > maxFetchLiteralBytes) {
						send(tag + ' NO [OVERQUOTA] FETCH literal byte limit reached');
						return;
					}
				}
			}
			for (const { message, sequence } of selected) {
				const values = [
					'UID ' + message.uid,
					'RFC822.SIZE ' + Buffer.byteLength(message.raw, 'utf8')
				];
				if (/\bFLAGS\b/i.test(attributes)) values.push('FLAGS (' + message.flags.join(' ') + ')');
				if (/\bINTERNALDATE\b/i.test(attributes)) values.push('INTERNALDATE ' + quote(messageDate(message.internalDate)));
				if (/\bENVELOPE\b/i.test(attributes)) values.push('ENVELOPE ' + envelope(message));
				if (/\bBODYSTRUCTURE\b/i.test(attributes)) values.push('BODYSTRUCTURE ' + bodyStructure(message));
				if (/\bBODY(?!\.PEEK)/i.test(attributes) && !/BODY(?:\.PEEK)?\[[^\]]*\]/i.test(attributes)) values.push('BODY ' + bodyStructure(message));
				let output = '* ' + sequence + ' FETCH (' + values.join(' ');
				for (const [match, section] of sections) {
					const requested = match.slice(match.indexOf('[') + 1, -1);
					const key = 'BODY[' + requested.toUpperCase() + ']';
					const content = Buffer.from(sectionValue(message, section), 'utf8');
					if (!match.includes('.PEEK')) {
						if (!message.flags.includes('\\Seen')) message.flags.push('\\Seen');
					}
					output += ' ' + key + ' {' + content.length + '}\r\n';
					socket.write(output);
					socket.write(content);
					output = '';
				}
				socket.write(output + ')\r\n');
			}
			send(tag + ' OK FETCH completed');
			return;
		}
		case 'STORE': {
			const range = args[0] || '*';
			const action = (args[1] || '').toUpperCase();
			const flags = (args[2] || '').replace(/^\(|\)$/g, '').split(/\s+/).filter(Boolean);
			for (const { message, sequence } of selectedMessages(session, range, uidMode)) {
				if (action.startsWith('+')) {
					for (const flag of flags) if (!message.flags.includes(flag)) message.flags.push(flag);
				} else if (action.startsWith('-')) {
					message.flags = message.flags.filter(flag => !flags.includes(flag));
				} else {
					message.flags = [...flags];
				}
				if (!action.endsWith('.SILENT')) send('* ' + sequence + ' FETCH (UID ' + message.uid + ' FLAGS (' + message.flags.join(' ') + '))');
			}
			send(tag + ' OK STORE completed');
			return;
		}
		case 'COPY':
		case 'MOVE': {
			const range = args[0] || '*';
			const destination = folderName(mailbox, args[1] || '');
			const destinationExists = Object.hasOwn(mailbox.folders, destination);
			if (!validFolderName(destination)) {
				send(tag + ' NO [INVALIDNAME] Destination folder name is invalid');
				return;
			}
			if (!destinationExists && Object.keys(mailbox.folders).length >= maxMailboxFolders) {
				send(tag + ' NO [OVERQUOTA] Local demo folder capacity reached');
				return;
			}
			const selected = selectedMessages(session, range, uidMode);
			const usage = mailboxUsage(mailbox);
			const selectedBytes = selected.reduce((total, item) => total + Buffer.byteLength(item.message.raw || '', 'utf8'), 0);
			if (usage.count + selected.length > maxMailboxMessages || usage.bytes + selectedBytes > maxMailboxBytes) {
				send(tag + ' NO [OVERQUOTA] Local demo mailbox capacity reached');
				return;
			}
			if (!destinationExists) mailbox.folders[destination] = [];
			for (const { message } of selected) {
				const copy = { ...message, uid: Math.max(0, ...mailbox.folders[destination].map(item => item.uid)) + 1, flags: [...message.flags] };
				mailbox.folders[destination].push(copy);
				if ('MOVE' === command) {
					const from = mailbox.folders[selectedName];
					const index = from.indexOf(message);
					if (index >= 0) from.splice(index, 1);
				}
			}
			send(tag + ' OK ' + command + ' completed');
			return;
		}
		case 'EXPUNGE': {
			const range = args[0] || '*';
			const indexes = messages.map((message, index) => ({ message, sequence: index + 1 }))
				.filter(({ message, sequence }) => message.flags.includes('\\Deleted')
					&& (!args.length || !uidMode || sequenceMatches(range, message.uid, maximumUid)));
			let offset = 0;
			for (const { message, sequence } of indexes) {
				const index = messages.indexOf(message);
				if (index >= 0) {
					messages.splice(index, 1);
					send('* ' + Math.max(1, sequence - offset++) + ' EXPUNGE');
				}
			}
			send(tag + ' OK EXPUNGE completed');
			return;
		}
		case 'APPEND': {
			const literal = args.at(-1)?.match(/^\{(\d+)\+?\}$/);
			if (!literal) {
				send(tag + ' BAD APPEND requires a bounded message literal');
				return;
			}
			const length = Number(literal[1]);
			if (!Number.isSafeInteger(length) || length < 1 || length > 10 * 1024 * 1024) {
				send(tag + ' NO [TOOBIG] Message is outside the local demo limit');
				return;
			}
			const target = folderName(mailbox, args[0] || 'INBOX');
			if (!validFolderName(target)) {
				send(tag + ' NO [INVALIDNAME] Destination folder name is invalid');
				return;
			}
			if (!Object.hasOwn(mailbox.folders, target) && Object.keys(mailbox.folders).length >= maxMailboxFolders) {
				send(tag + ' NO [OVERQUOTA] Local demo folder capacity reached');
				return;
			}
			if (!Object.hasOwn(mailbox.folders, target)) mailbox.folders[target] = [];
			const usage = mailboxUsage(mailbox);
			if (usage.count >= maxMailboxMessages || usage.bytes + length > maxMailboxBytes) {
				send(tag + ' NO [OVERQUOTA] Local demo mailbox capacity reached');
				return;
			}
			session.awaitingLiteral = {
				tag,
				length,
				folder: target,
				flags: (args[1] || '').replace(/^\(|\)$/g, '').split(/\s+/).filter(value => value.startsWith('\\'))
			};
			socket.write('+ Ready for local message literal\r\n');
			return;
		}
		case 'CREATE': {
			const name = folderName(mailbox, args[0] || '');
			if (!validFolderName(name)) send(tag + ' NO [INVALIDNAME] Folder name is invalid');
			else if (Object.hasOwn(mailbox.folders, name)) send(tag + ' NO [ALREADYEXISTS] Folder exists');
			else if (Object.keys(mailbox.folders).length >= maxMailboxFolders) send(tag + ' NO [OVERQUOTA] Local demo folder capacity reached');
			else { mailbox.folders[name] = []; send(tag + ' OK CREATE completed'); }
			return;
		}
		case 'DELETE': {
			const name = folderName(mailbox, args[0] || '');
			if ('INBOX' === name || !Object.hasOwn(mailbox.folders, name)) send(tag + ' NO [NONEXISTENT] Cannot delete that folder');
			else { delete mailbox.folders[name]; send(tag + ' OK DELETE completed'); }
			return;
		}
		case 'RENAME': {
			const from = folderName(mailbox, args[0] || '');
			const to = folderName(mailbox, args[1] || '');
			if (!Object.hasOwn(mailbox.folders, from) || !validFolderName(to) || Object.hasOwn(mailbox.folders, to)) send(tag + ' NO [NONEXISTENT] Folder cannot be renamed');
			else { mailbox.folders[to] = mailbox.folders[from]; delete mailbox.folders[from]; send(tag + ' OK RENAME completed'); }
			return;
		}
		case 'SUBSCRIBE':
		case 'UNSUBSCRIBE': send(tag + ' OK ' + command + ' completed'); return;
		case 'LOGOUT': send('* BYE local synthetic IMAP connection closed'); send(tag + ' OK LOGOUT completed'); socket.end(); return;
		default: send(tag + ' NO [UNAVAILABLE] Command is not implemented by the local synthetic mailbox'); return;
	}
}

function validFolderName(name) {
	return 'string' === typeof name && 0 < name.length && 255 >= Buffer.byteLength(name, 'utf8')
		&& !/[\x00-\x1f\x7f]/.test(name);
}

export function createSyntheticImapServer({
	expectedPassword,
	expectedUsername,
	loginFailure = 'Invalid local demo credentials',
	greeting = 'petuja.email local synthetic mailbox',
	mailbox = { folders: { INBOX: [] }, nextUid: 1, uidValidity: 1 }
}) {
	if ('string' !== typeof expectedPassword) {
		throw new TypeError('expectedPassword must be a string');
	}
	if (!mailbox || !mailbox.folders || 'object' !== typeof mailbox.folders) {
		throw new TypeError('mailbox must contain a folders object');
	}
	const folderEntries = Object.entries(mailbox.folders);
	if (folderEntries.length > maxMailboxFolders
		|| folderEntries.some(([name, messages]) => !validFolderName(name) || !Array.isArray(messages))) {
		throw new TypeError('mailbox folders must be valid, bounded arrays');
	}
	mailbox.folders = Object.assign(Object.create(null), mailbox.folders);
	const initialUsage = mailboxUsage(mailbox);
	if (initialUsage.count > maxMailboxMessages || initialUsage.bytes > maxMailboxBytes) {
		throw new RangeError('mailbox exceeds the local demo message or byte limit');
	}

	const logins = [];
	const sockets = new Set();
	const server = createServer(socket => {
		const session = {
			mailbox,
			expectedUsername,
			expectedPassword,
			loginFailure,
			logins,
			authenticated: false,
			selected: '',
			uidCommand: false,
			awaitingLiteral: null
		};
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.write('* OK [CAPABILITY ' + capability + '] ' + greeting + '\r\n');
		let pending = Buffer.alloc(0);
		const processInput = () => {
			while (!socket.destroyed) {
				if (session.awaitingLiteral) {
					if (pending.length < session.awaitingLiteral.length) return;
					const request = session.awaitingLiteral;
					const raw = pending.subarray(0, request.length).toString('utf8');
					pending = pending.subarray(request.length);
					if (pending.subarray(0, 2).toString('ascii') === '\r\n') pending = pending.subarray(2);
					const target = folderName(mailbox, request.folder);
					if (!mailbox.folders[target]) mailbox.folders[target] = [];
					const usage = mailboxUsage(mailbox);
					if (usage.count >= maxMailboxMessages || usage.bytes + Buffer.byteLength(raw, 'utf8') > maxMailboxBytes) {
						socket.write(request.tag + ' NO [OVERQUOTA] Local demo mailbox capacity reached\r\n');
						session.awaitingLiteral = null;
						continue;
					}
					const uid = Math.max(0, ...mailbox.folders[target].map(item => item.uid)) + 1;
					mailbox.folders[target].push({ uid, flags: request.flags, raw, internalDate: new Date().toUTCString(), body: '', isHtml: false, attachments: [] });
					socket.write(request.tag + ' OK [APPENDUID ' + mailbox.uidValidity + ' ' + uid + '] APPEND completed\r\n');
					session.awaitingLiteral = null;
					continue;
				}
				const lineEnd = pending.indexOf(10);
				if (lineEnd < 0) {
					if (pending.length > maxCommandBytes) {
						socket.write('* BYE IMAP command exceeds the local demo line limit\r\n');
						socket.destroy();
					}
					return;
				}
				if (lineEnd > maxCommandBytes) {
					socket.write('* BYE IMAP command exceeds the local demo line limit\r\n');
					socket.destroy();
					return;
				}
				const line = pending.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '');
				pending = pending.subarray(lineEnd + 1);
				const match = line.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/);
				if (!match) continue;
				const [, tag, rawCommand, rawArgs = ''] = match;
				let command = rawCommand.toUpperCase();
				let args = splitWords(rawArgs);
				session.uidCommand = false;
				if ('UID' === command) {
					command = (args.shift() || '').toUpperCase();
					session.uidCommand = true;
				}
				commandResponse(session, tag, command, args, socket);
			}
		};
		socket.on('data', chunk => {
			pending = Buffer.concat([pending, chunk]);
			processInput();
		});
	});
	let closePromise = null;

	return {
		logins,
		mailbox,
		get port() {
			return server.listening ? server.address().port : 0;
		},
		listen(port = 0) {
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, '127.0.0.1', () => {
					server.removeListener('error', reject);
					resolve(server.address().port);
				});
			});
		},
		close() {
			if (!closePromise) {
				for (const socket of sockets) socket.destroy();
				closePromise = server.listening
					? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
					: Promise.resolve();
			}
			return closePromise;
		}
	};
}
