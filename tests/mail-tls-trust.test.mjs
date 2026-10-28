import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);

test('MailSo enforces TLS trust for current and legacy domain settings', { timeout: 90000 }, async t => {
	const fixture = fileURLToPath(new URL('./fixtures/mail-tls-trust.py', import.meta.url));
	const { stdout } = await execute(process.env.PYTHON || 'python3', [fixture], { timeout: 85000 });
	const results = JSON.parse(stdout);
	for (const protocol of ['imap', 'smtp', 'sieve']) {
		await t.test(protocol + ' verifies direct TLS and STARTTLS certificates', () => {
			for (const transport of ['implicit', 'starttls']) {
				for (const name of ['legacy_untrusted', 'legacy_self_signed', 'wrong_host', 'direct_flags_untrusted', 'direct_flags_wrong_host']) {
					assert.deepEqual(results[protocol][transport + '_' + name], { rejected: true }, transport + '/' + name);
				}
			}
		});
		await t.test(protocol + ' preserves explicit CA trust across saved, alias, wildcard, INI and system settings', () => {
			for (const transport of ['implicit', 'starttls']) {
				for (const name of ['trusted_CA', 'alias', 'wildcard', 'legacy_INI', 'system_trust', 'CA_directory']) {
					const result = results[protocol][transport + '_' + name];
					assert.equal(result.connected, true, transport + '/' + name);
					assert.equal(result.encrypted, true);
					assert.equal(result.verify_peer, true);
					assert.equal(result.verify_peer_name, true);
					assert.equal(result.allow_self_signed, false);
					assert.equal(result.custom_CA_preserved, true);
					assert.equal(result.security_level, 'legacy_INI' === name ? 1 : 2);
				}
			}
		});
		await t.test(protocol + ' keeps the configured TLS mode authoritative over URI prefixes', () => {
			for (const scheme of ['tcp', 'SSL', 'tLs']) {
				assert.equal(results[protocol][scheme + '_implicit'].encrypted, true, scheme);
				for (const transport of ['starttls', 'none', 'auto']) {
					const result = results[protocol][scheme + '_' + transport];
					if ('tcp' === scheme) {
						assert.equal(result.connected, true, transport);
						assert.equal(result.encrypted, 'none' !== transport, transport);
					} else {
						assert.deepEqual(result, { rejected: true, target_connected: false }, scheme + '/' + transport);
					}
				}
			}
			for (const transport of ['implicit', 'starttls', 'none', 'auto']) {
				assert.deepEqual(results[protocol]['nested_' + transport], { rejected: true, target_connected: false });
			}
			assert.deepEqual(results[protocol].plaintext_rejected, { rejected: true });
			assert.equal(results[protocol].explicit_plaintext.connected, true);
			assert.equal(results[protocol].explicit_plaintext.encrypted, false);
			assert.equal(results[protocol].auto_STARTTLS.encrypted, true);
		});
	}
});

test('admin domain serialization preserves each protocol CA and context options', async () => {
	const { readFile } = await import('node:fs/promises');
	const { runInNewContext } = await import('node:vm');
	const source = await readFile(new URL('../dev/View/Popup/Domain.js', import.meta.url), 'utf8');
	const { domainDefaults, domainToParams } = runInNewContext(
		source.slice(source.indexOf('const\n'), source.indexOf('export class')) + '\n({ domainDefaults, domainToParams });',
		{ pInt: value => parseInt(value, 10) }
	);
	const domain = Object.fromEntries(Object.entries(domainDefaults).map(([key, value]) => [key, () => value]));
	domain.imapDisabled_capabilities = () => [];
	for (const protocol of ['imap', 'smtp', 'sieve']) {
		domain[protocol + 'SslOptions'] = () => ({
			cafile: '/synthetic/' + protocol + '-ca.pem',
			capath: '/synthetic/' + protocol + '-trust',
			local_cert: '/synthetic/client.pem',
			security_level: 2,
			SNI_enabled: false,
			disable_compression: true,
			verify_peer: false,
			verify_peer_name: false,
			allow_self_signed: true
		});
	}
	const serialized = domainToParams(domain);
	for (const [protocol, section] of [['imap', 'IMAP'], ['smtp', 'SMTP'], ['sieve', 'Sieve']]) {
		assert.deepEqual(JSON.parse(JSON.stringify(serialized[section].ssl)), {
			...domain[protocol + 'SslOptions'](),
			verify_peer: true,
			verify_peer_name: true,
			allow_self_signed: false
		});
	}
});

test('auto-detected implicit TLS fails closed when PHP has no TLS transport', async () => {
	const fixture = fileURLToPath(new URL('./fixtures/mail-tls-no-runtime.php', import.meta.url));
	// Model missing TLS capability in an isolated PHP 8 subprocess; disable sockets so no regression can connect.
	const { stdout } = await execute(process.env.PHP_BINARY || 'php', ['-n', '-d', 'disable_functions=stream_get_transports,stream_socket_client', fixture]);
	const result = JSON.parse(stdout);
	assert.equal(result.ssl_available, false);
	assert.deepEqual(result.rejected, { 993: true, 995: true, 465: true });
});
