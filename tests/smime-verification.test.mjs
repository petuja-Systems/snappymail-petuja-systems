import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const markerDetached = 'SEC18-DETACHED-MARKER-a39d';
const markerOpaque = 'SEC18-OPAQUE-MARKER-6f14';
const requiredOpenSslFunctions = [
	'openssl_pkey_new',
	'openssl_pkey_export',
	'openssl_csr_new',
	'openssl_csr_sign',
	'openssl_x509_export',
	'openssl_pkcs7_sign',
	'openssl_pkcs7_verify',
	'openssl_pkcs7_read',
	'openssl_pkcs7_encrypt',
	'openssl_pkcs7_decrypt'
];

test('M7.8 distributed S/MIME signing pairs are absent', async () => {
	for (const name of ['examples/crypto/smime', 'snappymail/v/0.0.0/app/libraries/snappymail/smime/snappymail']) {
		for (const suffix of ['.key', '.crt']) {
			await assert.rejects(access(path.join(repositoryRoot, name + suffix)), { code: 'ENOENT' });
		}
	}
});

test('S/MIME verifies signatures without requiring certificate trust', { timeout: 60000 }, async (t) => {
	const phpCheckScript = [
		'extension_loaded("openssl")',
		...requiredOpenSslFunctions.map((name) => `function_exists("${name}")`)
	].join(' && ');
	const phpCheck = spawnSync(phpBinary, ['-r', `exit(${phpCheckScript} ? 0 : 1);`], {
		encoding: 'utf8'
	});
	if (phpCheck.error) {
		t.skip('PHP CLI is unavailable: ' + phpCheck.error.message);
		return;
	}
	if (0 !== phpCheck.status) {
		t.skip('PHP OpenSSL S/MIME and certificate-generation functions are unavailable');
		return;
	}

	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-smime-verification-'));
	t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	const phpTemporaryDirectory = path.join(temporaryRoot, 'php-tmp');
	await mkdir(phpTemporaryDirectory);

	const fixture = path.join(repositoryRoot, 'tests', 'fixtures', 'smime-verification.php');
	const phpResult = spawnSync(phpBinary, [
		'-d', 'sys_temp_dir=' + phpTemporaryDirectory,
		fixture,
		temporaryRoot,
		markerDetached,
		markerOpaque
	], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		timeout: 55000
	});
	assert.equal(phpResult.error, undefined, 'PHP fixture could not start: ' + phpResult.error?.message);
	assert.equal(phpResult.status, 0, 'PHP S/MIME fixture failed: ' + phpResult.stderr + phpResult.stdout);
	const result = JSON.parse(phpResult.stdout);

	await t.test('M7.8 creates self-signed leaf identities without a distributed signer', () => {
		for (const property of ['ignores_shared_issuer', 'without_bundled_pair', 'self_signed',
			'matching_encrypted_key', 'leaf_email_usage', 'provided_key_preserved',
			'signed_message_verifies', 'wrong-passphrase', 'invalid-key']) {
			assert.equal(result.identity_generation[property], true, property);
		}
	});

	await t.test('M7-F2 request-backed S/MIME loaders reject locators and unsupported input forms', () => {
		for (const name of ['export_locator', 'create_locator', 'key_locator', 'key_array_locator',
			'key_array_pem', 'key_plain_path', 'key_malformed', 'key_incomplete_envelope',
			'certificate_locator', 'certificate_malformed', 'import_locator', 'encrypt_locator',
			'encrypt_array', 'decrypt_key_locator', 'decrypt_certificate_locator',
			'sign_key_locator', 'sign_certificate_locator', 'zero_key', 'wrong_passphrase',
			'import_no_store', 'failed_key_cleared', 'failed_certificate_cleared']) {
			assert.equal(result.request_input_boundary.rejected[name], true, name);
		}
	});

	await t.test('M7-F2 preserves PEM passphrases, native objects and actual message signing', () => {
		for (const name of ['plain_export', 'encrypted_export', 'provided_pem_preserved',
			'native_objects', 'outer_whitespace', 'certificate_preamble', 'key_preamble',
			'recipient_preamble', 'message_signing', 'ec_pem', 'completed']) {
			assert.equal(result.request_input_boundary.accepted[name], true, name);
		}
	});

	await t.test('valid detached signature succeeds and modified content fails', () => {
		assert.equal(result.valid_detached.success, true, JSON.stringify(result.runtime));
		assert.equal(result.tampered_detached.success, false, JSON.stringify(result.runtime));
		assert.equal(result.tampered_detached.has_body, false);
		assert.equal(result.different_length_detached.success, false, JSON.stringify(result.runtime));
		assert.equal(result.tampered_detached_signature.success, false, JSON.stringify(result.runtime));
		assert.equal(result.extra_trailing_line_detached.success, false, JSON.stringify(result.runtime));
	});

	await t.test('standards-compliant MIME canonicalization and body edge cases remain verifiable', () => {
		assert.equal(result.canonicalized_lf_utf8_headers_detached.success, true, JSON.stringify(result.runtime));
		assert.equal(result.empty_detached.success, true, JSON.stringify(result.runtime));
		assert.equal(result.utf8_detached.success, true, JSON.stringify(result.runtime));
		assert.equal(result.mime_entity_headers_detached.success, true, JSON.stringify(result.runtime));
		assert.equal(result.final_newline_detached.success, true, JSON.stringify(result.runtime));
		assert.equal(result.no_final_newline_detached.success, true, JSON.stringify(result.runtime));
	});

	await t.test('valid opaque signature returns its original body and tampering fails closed', () => {
		assert.equal(result.valid_opaque.success, true, JSON.stringify(result.runtime));
		assert.equal(result.valid_opaque.body, result.expected_opaque_body);
		assert.equal(result.tampered_opaque.success, false, JSON.stringify(result.runtime));
		assert.equal(result.tampered_opaque.has_body, false);
		assert.equal(result.tampered_opaque_signature.success, false, JSON.stringify(result.runtime));
		assert.equal(result.tampered_opaque_signature.has_body, false);
	});

	await t.test('self-signed signature integrity is separate from certificate trust', () => {
		assert.equal(result.self_signed_integrity.success, true, JSON.stringify(result.runtime));
		assert.equal(result.explicit_unrelated_trust_validation_succeeded, false, JSON.stringify(result.runtime));
		assert.equal(result.nochain_omitted_integrity_succeeded, true, JSON.stringify(result.runtime));
		assert.equal(result.runtime.flags.verifier_flags & result.runtime.flags.nosigs, 0);
		assert.equal(result.runtime.flags.verifier_flags, result.runtime.flags.noverify);
		assert.equal(result.runtime.flags.verifier_flags & result.runtime.flags.nochain, 0);
	});

	await t.test('message verification never grants future encryption trust', () => {
		assert.equal(result.invalid_action_threw, true, JSON.stringify(result.runtime));
		assert.equal(result.invalid_action_certificate_imports, 0);
		assert.equal(result.tampered_signature_action_threw, true, JSON.stringify(result.runtime));
		assert.equal(result.tampered_signature_action_certificate_imports, 0);
		assert.equal(result.tampered_opaque_action_threw, true, JSON.stringify(result.runtime));
		assert.equal(result.tampered_opaque_action_certificate_imports, 0);
		assert.equal(result.valid_untrusted_action_success, true, JSON.stringify(result.runtime));
		assert.equal(result.valid_untrusted_action_certificate_imports, 0);
		assert.equal(result.empty_verification_result_is_false, true);
		assert.equal(result.empty_verification_certificate_imports, 0);
	});

	await t.test('only explicit import grants fingerprint-bound recipient eligibility', () => {
		assert.equal(Object.keys(result.explicit_certificate_trust).length, 20);
		assert.deepEqual(Object.entries(result.explicit_certificate_trust)
			.filter(([, passed]) => passed !== true).map(([name]) => name), []);
	});

	await t.test('decrypted signed content remains readable only when its inner signature verifies', () => {
		assert.equal(result.valid_decrypted_signed_success, true, JSON.stringify(result.runtime));
		assert.equal(result.valid_decrypted_signed_body, result.expected_opaque_body);
		assert.equal(result.tampered_decrypted_signed_threw, true, JSON.stringify(result.runtime));
		assert.equal(result.null_decrypted_verification_result_is_false, true);
		assert.equal(result.null_decrypted_verification_returns_no_body, true);
	});

	await t.test('only an explicit successful verification reaches the green UI state', async () => {
		const templatePath = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/templates/Views/User/MailMessageView.html');
		const viewPath = path.join(repositoryRoot, 'dev/View/User/MailBox/MessageView.js');
		const messagesActionPath = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Messages.php');
		const smimeActionPath = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/SMime.php');
		const opensslPath = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/snappymail/smime/openssl.php');
		const englishLocalizationPath = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/localization/en/user.json');
		const [template, view, messagesAction, smimeAction, openssl, localization] = await Promise.all([
			readFile(templatePath, 'utf8'),
			readFile(viewPath, 'utf8'),
			readFile(messagesActionPath, 'utf8'),
			readFile(smimeActionPath, 'utf8'),
			readFile(opensslPath, 'utf8'),
			readFile(englishLocalizationPath, 'utf8')
		]);

		assert.match(template, /success:\s*true === message\(\)\.smimeSigned\(\)\?\.success/);
		assert.match(template, /error:\s*false === message\(\)\.smimeSigned\(\)\?\.success/);
		assert.equal(JSON.parse(localization).SMIME.SIGNED_MESSAGE, 'S/MIME signed message');
		assert.match(view, /delete data\.success;\s*message\.smimeSigned\(data\);[\s\S]*?Remote\.post\('SMimeVerifyMessage'[\s\S]*?\.catch\(\(\) => \{/);
		assert.match(view, /if \(true === response\?\.Result\?\.success\) \{[\s\S]*?MimeToMessage\(response\.Result\.body, message\);[\s\S]*?message\.smimeSigned\(\{ \.\.\.data, success: true \}\);/);
		assert.match(messagesAction, /if \(\$result\) \{[\s\S]*?\$oMessage->smimeSigned\['success'\] = \$result\['success'\];/);
		assert.match(smimeAction, /\$signed = \$SMIME->verify\(\$result\['data'\], null, true\);\s*if \(!\\is_array\(\$signed\) \|\| true !== \(\$signed\['success'\] \?\? null\)\) \{\s*return \$this->DefaultResponse\(false\);/);
		assert.match(smimeAction, /\$result = \$this->SMIME\(\)->verify\(\$sBody, null, !\$bDetached\);\s*if \(!\\is_array\(\$result\) \|\| true !== \(\$result\['success'\] \?\? null\)\) \{\s*return \$this->DefaultResponse\(false\);/);
		const verifier = openssl.slice(openssl.indexOf('public function verify('));
		assert.match(verifier, /\\PKCS7_NOVERIFY\s*,/);
		assert.doesNotMatch(verifier, /PKCS7_NO(?:SIGS|CHAIN)/);
		assert.equal(result.tampered_detached.success, false);
		assert.equal(result.tampered_opaque.success, false);
	});

	await t.test('verification errors disclose no temporary paths and key files are not persisted', async () => {
		for (const entry of [
			result.tampered_detached,
			result.different_length_detached,
			result.tampered_detached_signature,
			result.extra_trailing_line_detached,
			result.tampered_opaque,
			result.tampered_opaque_signature
		]) {
			assert.equal(entry.success, false);
			assert.ok(!entry.error_message?.includes(temporaryRoot), 'OpenSSL error exposed the temporary directory');
		}
		const pending = [temporaryRoot];
		while (pending.length) {
			const directory = pending.pop();
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const filePath = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					pending.push(filePath);
				} else {
					assert.doesNotMatch(entry.name, /(?:private|secret).*\.(?:key|pem)$/i, 'generated private key persisted to disk');
				}
			}
		}
	});
});
