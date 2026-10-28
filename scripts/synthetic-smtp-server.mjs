import { createServer } from 'node:net';

const maxMessageBytes = 10 * 1024 * 1024;
const maxCommandBytes = 8 * 1024;
const maxRecipients = 100;

export function createSyntheticSmtpServer({ onMessage = async () => {}, maxBytes = maxMessageBytes } = {}) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new RangeError('The synthetic SMTP message limit must be a positive safe integer.');
	}
	const accepted = [];
	const sockets = new Set();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.setEncoding('utf8');
		socket.write('220 petuja.email local synthetic SMTP sink ready\r\n');
		let pending = '';
		let pendingBytes = 0;
		const setPending = value => {
			pending = value;
			pendingBytes = Buffer.byteLength(value, 'utf8');
		};
		let data = null;
		let sender = '';
		let recipients = [];
		let busy = false;

		const reply = text => socket.write(text + '\r\n');
		const processInput = async () => {
			if (busy || socket.destroyed) {
				return;
			}
			busy = true;
			try {
				while (!socket.destroyed) {
					if (null !== data) {
						const terminator = pending.indexOf('\r\n.\r\n');
						if (terminator < 0) {
							if (pendingBytes > maxBytes) {
								data = null;
								setPending('');
								reply('552 5.3.4 Message exceeds the local demo size limit');
								continue;
							}
							break;
						}
						if (Buffer.byteLength(pending.slice(0, terminator), 'utf8') > maxBytes) {
							setPending(pending.slice(terminator + 5));
							data = null;
							sender = '';
							recipients = [];
							reply('552 5.3.4 Message exceeds the local demo size limit');
							continue;
						}
						const message = (data + pending.slice(0, terminator)).replace(/^\.\./gm, '.');
						setPending(pending.slice(terminator + 5));
						const acceptedMessage = { from: sender, recipients: [...recipients], raw: message };
						data = null;
						sender = '';
						recipients = [];
						try {
							await onMessage(acceptedMessage);
							accepted.push(acceptedMessage);
							if (accepted.length > 250) accepted.shift();
							reply('250 2.0.0 Message stored in the local demo outbox; nothing was sent externally');
						} catch {
							reply('451 4.3.0 Could not store the message in the local demo outbox');
						}
						continue;
					}

					const lineEnd = pending.indexOf('\n');
					if (lineEnd < 0) {
						if (pendingBytes > maxCommandBytes) {
							setPending('');
							reply('500 5.5.2 SMTP command exceeds the local demo line limit');
							socket.destroy();
						}
						break;
					}
					if (Buffer.byteLength(pending.slice(0, lineEnd), 'utf8') > maxCommandBytes) {
						setPending(pending.slice(lineEnd + 1));
						reply('500 5.5.2 SMTP command exceeds the local demo line limit');
						socket.destroy();
						return;
					}
					const line = pending.slice(0, lineEnd).replace(/\r$/, '').trim();
					setPending(pending.slice(lineEnd + 1));
					const [command = '', ...rest] = line.split(/\s+/);
					const argument = rest.join(' ');
					switch (command.toUpperCase()) {
						case 'EHLO':
							reply('250-petuja.email local synthetic SMTP sink');
							reply('250-8BITMIME');
							reply('250 SIZE ' + maxBytes);
							break;
						case 'HELO': reply('250 petuja.email local synthetic SMTP sink'); break;
						case 'MAIL': {
							const match = argument.match(/^FROM:\s*<([^>]*)>/i);
							if (!match) {
								reply('501 5.5.4 Expected MAIL FROM');
								break;
							}
							sender = match[1];
							recipients = [];
							reply('250 2.1.0 Sender accepted for local capture');
							break;
						}
						case 'RCPT': {
							const match = argument.match(/^TO:\s*<([^>]*)>/i);
							if (!sender || !match || !match[1]) {
								reply('501 5.5.4 Expected MAIL FROM before RCPT TO');
								break;
							}
							if (recipients.length >= maxRecipients) {
								reply('452 4.5.3 Local demo recipient limit reached');
								break;
							}
							recipients.push(match[1]);
							reply('250 2.1.5 Recipient accepted for local capture');
							break;
						}
						case 'DATA':
							if (!sender || !recipients.length) {
								reply('503 5.5.1 MAIL FROM and RCPT TO are required first');
							} else {
								data = '';
								reply('354 End message with <CRLF>.<CRLF>; delivery stays local');
							}
							break;
						case 'RSET': sender = ''; recipients = []; data = null; reply('250 2.0.0 Reset'); break;
						case 'NOOP': reply('250 2.0.0 OK'); break;
						case 'QUIT': reply('221 2.0.0 Bye'); socket.end(); break;
						case 'AUTH': reply('502 5.5.1 SMTP authentication is disabled for the local sink'); break;
						case 'STARTTLS': reply('502 5.5.1 TLS is not available on the loopback-only demo sink'); break;
						default: reply('502 5.5.1 Command not supported by the local demo sink'); break;
					}
				}
			} finally {
				busy = false;
			}
		};

		socket.on('data', chunk => {
			if (socket.destroyed) return;
			const incomingBytes = Buffer.byteLength(chunk, 'utf8');
			if (pendingBytes + incomingBytes > maxBytes + maxCommandBytes + 5) {
				setPending('');
				socket.destroy();
				return;
			}
			pending += chunk;
			pendingBytes += incomingBytes;
			void processInput();
		});
	});
	let closePromise = null;

	return {
		accepted,
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
				for (const socket of sockets) {
					socket.destroy();
				}
				closePromise = server.listening
					? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
					: Promise.resolve();
			}
			return closePromise;
		}
	};
}
