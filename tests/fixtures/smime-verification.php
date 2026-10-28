<?php

declare(strict_types=1);

use SnappyMail\SMime\OpenSSL;

$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries';
require $libraries . '/MailSo/Base/Utils.php';
require $libraries . '/RainLoop/Utils.php';
require $libraries . '/MailSo/Imap/Enumerations/FetchType.php';
require $libraries . '/snappymail/file/temporary.php';
require $libraries . '/snappymail/smime/openssl.php';
require $libraries . '/snappymail/sensitivestring.php';
require $libraries . '/snappymail/log.php';
require $libraries . '/RainLoop/Actions/SMime.php';
spl_autoload_register(static function (string $class) use ($libraries): void {
	$path = str_replace('\\', '/', $class) . '.php';
	foreach ([$path, strtolower($path)] as $name) {
		if (is_file($libraries . '/' . $name)) { require_once $libraries . '/' . $name; return; }
	}
});

if (!extension_loaded('openssl') || !function_exists('openssl_pkcs7_sign')) {
	fwrite(STDERR, "PHP OpenSSL S/MIME functions are required\n");
	exit(2);
}

$temporaryRoot = $argv[1] ?? '';
$markerDetached = $argv[2] ?? '';
$markerOpaque = $argv[3] ?? '';
if (!$temporaryRoot || !$markerDetached || !$markerOpaque || !is_dir($temporaryRoot)) {
	fwrite(STDERR, "A test temporary directory and content markers are required\n");
	exit(2);
}

function requireOpenSslResult($result, string $operation)
{
	if (false === $result) {
		throw new RuntimeException($operation . ': ' . (openssl_error_string() ?: 'OpenSSL operation failed'));
	}
	return $result;
}

function attemptVerification(OpenSSL $verifier, string $message, bool $opaque = false): array
{
	try {
		$result = $verifier->verify($message, null, $opaque);
		return [
			'success' => true === ($result['success'] ?? false),
			'body' => $result['body'] ?? null,
			'has_body' => is_array($result) && array_key_exists('body', $result) && null !== $result['body']
		];
	} catch (Throwable $error) {
		return [
			'success' => false,
			'has_body' => false,
			'error' => get_class($error),
			'error_message' => $error->getMessage()
		];
	}
}

function createDetachedMessage(
	string $temporaryRoot,
	string $name,
	string $content,
	string $certificate,
	string $privateKey,
	int $flags
): string
{
	$input = $temporaryRoot . '/' . $name . '-input.txt';
	$output = $temporaryRoot . '/' . $name . '-signed.eml';
	if (false === file_put_contents($input, $content)) {
		throw new RuntimeException('Could not write detached S/MIME input');
	}
	requireOpenSslResult(openssl_pkcs7_sign(
		$input,
		$output,
		$certificate,
		$privateKey,
		['From' => 'sec18@example.invalid', 'To' => 'recipient@example.invalid', 'Subject' => 'SEC-18 ' . $name],
		$flags
	), 'Create detached S/MIME signature: ' . $name);
	return file_get_contents($output);
}

function detachedSignatureParts(string $message): array
{
	if (!preg_match('/boundary="?([^";\r\n]+)"?/i', $message, $boundaryMatch)) {
		throw new RuntimeException('Detached message has no MIME boundary');
	}
	$sections = preg_split('/--' . preg_quote($boundaryMatch[1], '/') . "\\r?\\n/", $message);
	if (!isset($sections[2])) {
		throw new RuntimeException('Detached message has no signature part');
	}
	$signatureSection = $sections[2];
	if (!preg_match('/\r?\n\r?\n/', $signatureSection, $separatorMatch, PREG_OFFSET_CAPTURE)) {
		throw new RuntimeException('Detached signature part has no body');
	}
	$bodyOffset = $separatorMatch[0][1] + strlen($separatorMatch[0][0]);
	$signatureBody = substr($signatureSection, $bodyOffset);
	$closingBoundaryOffset = strrpos($signatureBody, "\n--" . $boundaryMatch[1] . '--');
	if (false === $closingBoundaryOffset) {
		throw new RuntimeException('Detached signature part has no closing MIME boundary');
	}
	$encodedBody = substr($signatureBody, 0, $closingBoundaryOffset);
	return [
		$boundaryMatch[1],
		$sections,
		substr($signatureSection, 0, $bodyOffset),
		trim($encodedBody)
	];
}

function extractDetachedSignature(string $message): string
{
	[, , , $signature] = detachedSignatureParts($message);
	return $signature;
}

function tamperDetachedSignature(string $message): string
{
	[$boundary, $sections, $signaturePrefix, $encodedSignature] = detachedSignatureParts($message);
	$der = base64_decode(preg_replace('/\s+/', '', $encodedSignature), true);
	if (false === $der || !strlen($der)) {
		throw new RuntimeException('Detached signature is not valid base64 CMS data');
	}
	$der = tamperCmsSignatureValue($der);
	$sections[2] = $signaturePrefix . chunk_split(base64_encode($der), 64, "\r\n") . "\r\n--" . $boundary . "--\r\n";
	return implode('--' . $boundary . "\r\n", $sections);
}

function readDerElement(string $der, int &$offset): array
{
	$start = $offset;
	if ($offset + 2 > strlen($der)) {
		throw new RuntimeException('Truncated CMS DER element');
	}
	$tag = ord($der[$offset++]);
	$firstLength = ord($der[$offset++]);
	if ($firstLength & 0x80) {
		$lengthBytes = $firstLength & 0x7f;
		if (!$lengthBytes || $offset + $lengthBytes > strlen($der)) {
			throw new RuntimeException('Invalid CMS DER length');
		}
		$length = 0;
		for ($index = 0; $index < $lengthBytes; ++$index) {
			$length = ($length << 8) | ord($der[$offset++]);
		}
	} else {
		$length = $firstLength;
	}
	$contentOffset = $offset;
	$end = $contentOffset + $length;
	if ($end > strlen($der)) {
		throw new RuntimeException('CMS DER element exceeds container');
	}
	return [
		'tag' => $tag,
		'start' => $start,
		'content' => $contentOffset,
		'end' => $end
	];
}

function findLastCmsSignatureByte(string $der, int $start = 0, ?int $end = null): ?int
{
	$end ??= strlen($der);
	$offset = $start;
	$lastByte = null;
	while ($offset < $end) {
		$element = readDerElement($der, $offset);
		// CMS SignerInfo.signature is an OCTET STRING; its value follows
		// certificate and signed-attribute OCTET STRINGs in this structure.
		if (0x04 === $element['tag'] && $element['end'] > $element['content']) {
			$lastByte = $element['end'] - 1;
		}
		if ($element['tag'] & 0x20) {
			$nested = findLastCmsSignatureByte($der, $element['content'], $element['end']);
			if (null !== $nested) {
				$lastByte = $nested;
			}
		}
		$offset = $element['end'];
	}
	return $lastByte;
}

function tamperCmsSignatureValue(string $der): string
{
	$signatureByte = findLastCmsSignatureByte($der);
	if (null === $signatureByte) {
		throw new RuntimeException('CMS container has no signature BIT STRING');
	}
	$der[$signatureByte] = chr(ord($der[$signatureByte]) ^ 1);
	return $der;
}

function tamperOpaqueMessage(string $message, string $marker): string
{
	$separator = strpos($message, "\r\n\r\n");
	$separatorLength = 4;
	if (false === $separator) {
		$separator = strpos($message, "\n\n");
		$separatorLength = 2;
	}
	if (false === $separator) {
		throw new RuntimeException('Opaque message has no MIME body separator');
	}
	$der = base64_decode(preg_replace('/\s+/', '', substr($message, $separator + $separatorLength)), true);
	if (false === $der || false === strpos($der, $marker)) {
		throw new RuntimeException('Opaque CMS body does not contain the expected marker');
	}
	$tamperedDer = str_replace($marker, str_repeat('X', strlen($marker)), $der);
	$encodedBody = chunk_split(base64_encode($tamperedDer), 64, "\r\n");
	return substr($message, 0, $separator + $separatorLength) . $encodedBody;
}

function tamperOpaqueSignature(string $message): string
{
	$separator = strpos($message, "\r\n\r\n");
	$separatorLength = 4;
	if (false === $separator) {
		$separator = strpos($message, "\n\n");
		$separatorLength = 2;
	}
	if (false === $separator) {
		throw new RuntimeException('Opaque message has no MIME body separator');
	}
	$der = base64_decode(preg_replace('/\s+/', '', substr($message, $separator + $separatorLength)), true);
	if (false === $der || !strlen($der)) {
		throw new RuntimeException('Opaque CMS body is not valid base64');
	}
	$der = tamperCmsSignatureValue($der);
	$encodedBody = chunk_split(base64_encode($der), 64, "\r\n");
	return substr($message, 0, $separator + $separatorLength) . $encodedBody;
}

function addDetachedTrailingLine(string $message, string $marker): string
{
	if (!preg_match('/boundary="?([^";\r\n]+)"?/i', $message, $boundaryMatch)) {
		throw new RuntimeException('Detached message has no MIME boundary');
	}
	$markerOffset = strpos($message, $marker);
	$boundaryOffset = false === $markerOffset
		? false
		: strpos($message, "\n--" . $boundaryMatch[1], $markerOffset + strlen($marker));
	if (false === $boundaryOffset) {
		throw new RuntimeException('Could not locate the detached MIME boundary after the signed content');
	}
	return substr($message, 0, $boundaryOffset) . "\r\n" . substr($message, $boundaryOffset);
}

function splitMimeMessage(string $message): array
{
	$separator = strpos($message, "\r\n\r\n");
	$separatorLength = 4;
	if (false === $separator) {
		$separator = strpos($message, "\n\n");
		$separatorLength = 2;
	}
	if (false === $separator) {
		throw new RuntimeException('S/MIME message has no header/body separator');
	}
	return [
		substr($message, 0, $separator + $separatorLength),
		substr($message, $separator + $separatorLength)
	];
}

class Sec18TrackingOpenSSL extends OpenSSL
{
	public int $certificateImports = 0;

	public function storeCertificate(string $certificate) : bool
	{
		++$this->certificateImports;
		return true;
	}
}

class Sec18NullVerificationOpenSSL extends OpenSSL
{
	public function verify($input, ?string $signers_certificates_filename = null, bool $opaque = false)
	{
		return null;
	}
}

class Sec18SMimeActionHarness
{
	use RainLoop\Actions\SMime;

	private array $parameters;
	private OpenSSL $crypto;
	private $imapClient = null;

	public function __construct(OpenSSL $crypto, array $parameters)
	{
		$this->crypto = $crypto;
		$this->parameters = $parameters;
	}

	public function SMIME() : OpenSSL
	{
		return $this->crypto;
	}

	public function getAccountFromToken()
	{
		return new class {
			public function Name(): string { return 'Local synthetic identity'; }
			public function Email(): string { return 'local@example.test'; }
		};
	}

	public function GetActionParam(string $name, $default = null)
	{
		return $this->parameters[$name] ?? $default;
	}

	public function DefaultResponse($result) : array
	{
		return ['Result' => $result];
	}

	public function initMailClientConnection() : void
	{
	}

	public function ImapClient()
	{
		return $this->imapClient;
	}

	public function setImapClient($imapClient) : void
	{
		$this->imapClient = $imapClient;
	}
}

class Sec18FakeFetchResponse
{
	private string $header;
	private string $body;

	public function __construct(string $header, string $body)
	{
		$this->header = $header;
		$this->body = $body;
	}

	public function GetFetchValue(string $name)
	{
		if (\MailSo\Imap\Enumerations\FetchType::BODY_HEADER === $name) {
			return $this->header;
		}
		if (\MailSo\Imap\Enumerations\FetchType::BODY . '[TEXT]' === $name) {
			return $this->body;
		}
		return null;
}
}

class Sec18FakeImapClient
{
	private string $header;
	private string $body;

	public function __construct(string $header, string $body)
	{
		$this->header = $header;
		$this->body = $body;
	}

	public function FolderExamine(string $folder) : void
	{
	}

	public function Fetch(array $items, int $uid, bool $peek) : array
	{
		return [new Sec18FakeFetchResponse($this->header, $this->body)];
	}
}

$key = requireOpenSslResult(openssl_pkey_new([
	'private_key_type' => OPENSSL_KEYTYPE_RSA,
	'private_key_bits' => 2048
]), 'Generate ephemeral RSA key');
$csr = requireOpenSslResult(openssl_csr_new([
	'commonName' => 'SEC-18 ephemeral test',
	'emailAddress' => 'sec18@example.invalid'
], $key, ['digest_alg' => 'sha256']), 'Generate ephemeral certificate request');
$certificate = requireOpenSslResult(openssl_csr_sign($csr, null, $key, 1, ['digest_alg' => 'sha256']), 'Sign ephemeral certificate');
$keyPem = '';
$certificatePem = '';
requireOpenSslResult(openssl_pkey_export($key, $keyPem), 'Export ephemeral private key');
requireOpenSslResult(openssl_x509_export($certificate, $certificatePem), 'Export ephemeral certificate');

$unrelatedKey = requireOpenSslResult(openssl_pkey_new([
	'private_key_type' => OPENSSL_KEYTYPE_RSA,
	'private_key_bits' => 2048
]), 'Generate unrelated ephemeral RSA key');
$unrelatedCsr = requireOpenSslResult(openssl_csr_new([
	'commonName' => 'SEC-18 unrelated trust test',
	'emailAddress' => 'unrelated@example.invalid'
], $unrelatedKey, ['digest_alg' => 'sha256']), 'Generate unrelated certificate request');
$unrelatedCertificate = requireOpenSslResult(openssl_csr_sign($unrelatedCsr, null, $unrelatedKey, 1, ['digest_alg' => 'sha256']), 'Sign unrelated ephemeral certificate');
$unrelatedCertificatePem = '';
requireOpenSslResult(openssl_x509_export($unrelatedCertificate, $unrelatedCertificatePem), 'Export unrelated ephemeral certificate');
$unrelatedCaPath = $temporaryRoot . '/unrelated-trust-anchor.pem';
if (false === file_put_contents($unrelatedCaPath, $unrelatedCertificatePem)) {
	throw new RuntimeException('Could not write isolated trust test certificate');
}

// Run the actual generator in a copied source directory: even the parent
// regression must never open the historical private key in the repository.
$creatorDirectory = $temporaryRoot . '/identity-generator';
mkdir($creatorDirectory, 0700);
foreach (['certificate.php', 'openssl.cnf'] as $file) {
	if (!copy($libraries . '/snappymail/smime/' . $file, $creatorDirectory . '/' . $file)) {
		throw new RuntimeException('Could not prepare isolated certificate generator');
	}
}
require $creatorDirectory . '/certificate.php';
class Sec78MaskingApi
{
	public static function Actions() { return new self(); }
	public static function Logger() { return new class { public function IsEnabled() { return false; } }; }
	public function logMask(string $value) : void {}
}
class_alias(Sec78MaskingApi::class, 'RainLoop\\Api');
$identityGeneration = [];
set_error_handler(static function () { throw new RuntimeException('Synthetic certificate operation failed'); });
try {
	// Only ephemeral material is placed at the old issuer filenames.
	file_put_contents($creatorDirectory . '/snappymail.crt', $unrelatedCertificatePem);
	openssl_pkey_export($unrelatedKey, $issuerKey);
	file_put_contents($creatorDirectory . '/snappymail.key', $issuerKey);
	$creator = new \SnappyMail\SMime\Certificate();
	$creator->keyBits = 2048;
	$creator->days = 1;
	$creator->distinguishedName = ['commonName' => 'Local identity', 'emailAddress' => 'identity@example.test'];
	$passphrase = new \SnappyMail\SensitiveString('local synthetic identity passphrase');
	$decoyResult = $creator->createSelfSigned($passphrase);
	$decoyCertificate = openssl_x509_parse($decoyResult['x509']);
	$identityGeneration['ignores_shared_issuer'] = $decoyCertificate['issuer'] === $decoyCertificate['subject'];
	unlink($creatorDirectory . '/snappymail.key');
	unlink($creatorDirectory . '/snappymail.crt');
	$created = $creator->createSelfSigned($passphrase);
	$createdKey = openssl_pkey_get_private($created['pkey'], (string) $passphrase);
	$createdCertificate = openssl_x509_parse($created['x509']);
	$identityGeneration['without_bundled_pair'] = true;
	$identityGeneration['self_signed'] = 1 === openssl_x509_verify($created['x509'], openssl_pkey_get_public($created['x509']))
		&& $createdCertificate['subject'] === $createdCertificate['issuer'];
	$identityGeneration['matching_encrypted_key'] = str_contains($created['pkey'], 'BEGIN ENCRYPTED PRIVATE KEY')
		&& openssl_x509_check_private_key($created['x509'], $createdKey);
	$extensions = $createdCertificate['extensions'];
	$identityGeneration['leaf_email_usage'] = 'CA:FALSE' === $extensions['basicConstraints']
		&& str_contains($extensions['subjectAltName'], 'email:identity@example.test')
		&& str_contains($extensions['extendedKeyUsage'], 'E-mail Protection')
		&& str_contains($extensions['keyUsage'], 'Digital Signature')
		&& str_contains($extensions['keyUsage'], 'Key Encipherment');
	$reused = $creator->createSelfSigned($passphrase, $created['pkey']);
	$identityGeneration['provided_key_preserved'] = $reused['pkey'] === $created['pkey']
		&& openssl_x509_check_private_key($reused['x509'], $createdKey);
	$crypto = new OpenSSL($temporaryRoot . '/identity-crypto');
	$crypto->setCertificate($created['x509']);
	$crypto->setPrivateKey($created['pkey'], $passphrase);
	$signedIdentity = $crypto->sign("Content-Type: text/plain\r\n\r\nLocal identity message\r\n", false);
	$signedIdentity = "Content-Type: application/pkcs7-mime; smime-type=signed-data\r\nContent-Transfer-Encoding: base64\r\n\r\n" . $signedIdentity;
	$identityGeneration['signed_message_verifies'] = true === ($crypto->verify($signedIdentity, null, true)['success'] ?? false);
	foreach (['wrong-passphrase' => $created['pkey'], 'invalid-key' => 'synthetic invalid key'] as $name => $input) {
		try {
			$creator->createSelfSigned(new \SnappyMail\SensitiveString('different synthetic passphrase'), $input);
			$identityGeneration[$name] = false;
		} catch (Throwable $error) {
			$identityGeneration[$name] = true;
		}
	}
} catch (Throwable $error) {
	$identityGeneration['completed'] = false;
} finally {
	restore_error_handler();
	foreach (['snappymail.key', 'snappymail.crt'] as $file) {
		if (is_file($creatorDirectory . '/' . $file)) unlink($creatorDirectory . '/' . $file);
	}
}

$detachedContent = "Detached signed content {$markerDetached}.\r\n";
$detachedInput = $temporaryRoot . '/detached-input.txt';
$detachedSignedPath = $temporaryRoot . '/detached-signed.eml';
file_put_contents($detachedInput, $detachedContent);
requireOpenSslResult(openssl_pkcs7_sign(
	$detachedInput,
	$detachedSignedPath,
	$certificatePem,
	$keyPem,
	['From' => 'sec18@example.invalid', 'To' => 'recipient@example.invalid', 'Subject' => 'SEC-18 detached'],
	PKCS7_DETACHED | PKCS7_BINARY
), 'Create detached S/MIME signature');
$detachedMessage = file_get_contents($detachedSignedPath);
$tamperedDetachedMessage = str_replace($markerDetached, str_repeat('Z', strlen($markerDetached)), $detachedMessage);
if ($tamperedDetachedMessage === $detachedMessage) {
	throw new RuntimeException('Detached marker was not present in signed MIME content');
}
$differentLengthDetachedMessage = str_replace(
	$detachedContent,
	"A different body with another length and no matching digest.\r\n",
	$detachedMessage,
	$differentBodyCount
);
if (1 !== $differentBodyCount) {
	throw new RuntimeException('Could not create the different-length detached body variant');
}
$tamperedDetachedSignatureMessage = tamperDetachedSignature($detachedMessage);
$trailingLineDetachedMessage = addDetachedTrailingLine($detachedMessage, $markerDetached);

$canonicalizedContent = "Content-Type: text/plain; charset=UTF-8\nX-Entity-Header: signed\n\nCafé and 世界 with LF line endings\n";
$canonicalizedDetachedMessage = createDetachedMessage(
	$temporaryRoot,
	'canonicalized',
	$canonicalizedContent,
	$certificatePem,
	$keyPem,
	PKCS7_DETACHED
);
$emptyDetachedMessage = createDetachedMessage(
	$temporaryRoot,
	'empty',
	'',
	$certificatePem,
	$keyPem,
	PKCS7_DETACHED
);
$utf8Content = "Café, Grüße, 世界!\r\n";
$utf8DetachedMessage = createDetachedMessage(
	$temporaryRoot,
	'utf8',
	$utf8Content,
	$certificatePem,
	$keyPem,
	PKCS7_DETACHED
);
$mimeEntityContent = "Content-Type: text/plain; charset=UTF-8\r\nX-Entity-Header: included-in-signature\r\n\r\nSigned MIME entity body.\r\n";
$mimeEntityDetachedMessage = createDetachedMessage(
	$temporaryRoot,
	'mime-entity',
	$mimeEntityContent,
	$certificatePem,
	$keyPem,
	PKCS7_DETACHED | PKCS7_BINARY
);
$trailingNewlineDetachedMessage = createDetachedMessage(
	$temporaryRoot,
	'trailing-newline',
	"Body with final newline.\r\n",
	$certificatePem,
	$keyPem,
	PKCS7_DETACHED | PKCS7_BINARY
);
$noTrailingNewlineDetachedMessage = createDetachedMessage(
	$temporaryRoot,
	'no-trailing-newline',
	'Body without final newline.',
	$certificatePem,
	$keyPem,
	PKCS7_DETACHED | PKCS7_BINARY
);

$opaqueContent = "Opaque signed content {$markerOpaque}.\r\n";
$opaqueInput = $temporaryRoot . '/opaque-input.txt';
$opaqueSignedPath = $temporaryRoot . '/opaque-signed.eml';
file_put_contents($opaqueInput, $opaqueContent);
requireOpenSslResult(openssl_pkcs7_sign(
	$opaqueInput,
	$opaqueSignedPath,
	$certificatePem,
	$keyPem,
	['From' => 'sec18@example.invalid', 'To' => 'recipient@example.invalid', 'Subject' => 'SEC-18 opaque'],
	PKCS7_BINARY
), 'Create opaque S/MIME signature');
$opaqueMessage = file_get_contents($opaqueSignedPath);
$tamperedOpaqueMessage = tamperOpaqueMessage($opaqueMessage, $markerOpaque);
$tamperedOpaqueSignatureMessage = tamperOpaqueSignature($opaqueMessage);

$verifier = new OpenSSL($temporaryRoot . '/certificates');
$validDetached = attemptVerification($verifier, $detachedMessage);
$tamperedDetached = attemptVerification($verifier, $tamperedDetachedMessage);
$differentLengthDetached = attemptVerification($verifier, $differentLengthDetachedMessage);
$tamperedDetachedSignature = attemptVerification($verifier, $tamperedDetachedSignatureMessage);
$trailingLineDetached = attemptVerification($verifier, $trailingLineDetachedMessage);
$canonicalizedDetached = attemptVerification($verifier, $canonicalizedDetachedMessage);
$emptyDetached = attemptVerification($verifier, $emptyDetachedMessage);
$utf8Detached = attemptVerification($verifier, $utf8DetachedMessage);
$mimeEntityDetached = attemptVerification($verifier, $mimeEntityDetachedMessage);
$trailingNewlineDetached = attemptVerification($verifier, $trailingNewlineDetachedMessage);
$noTrailingNewlineDetached = attemptVerification($verifier, $noTrailingNewlineDetachedMessage);
$validOpaque = attemptVerification($verifier, $opaqueMessage, true);
$tamperedOpaque = attemptVerification($verifier, $tamperedOpaqueMessage, true);
$tamperedOpaqueSignature = attemptVerification($verifier, $tamperedOpaqueSignatureMessage, true);

// Confirm an explicit unrelated trust anchor rejects this self-signed signer,
// while the product's integrity-only policy accepts its matching signature.
$unrelatedTrustResult = openssl_pkcs7_verify($detachedSignedPath, 0, null, [$unrelatedCaPath], null);
$noChainFlagIntegrityResult = openssl_pkcs7_verify($detachedSignedPath, PKCS7_NOVERIFY, null, [], null);
$selfSignedIntegrity = $validDetached;

$validNestedSignedPath = $temporaryRoot . '/valid-nested-signed.eml';
$tamperedNestedSignedPath = $temporaryRoot . '/tampered-nested-signed.eml';
$validEncryptedPath = $temporaryRoot . '/valid-encrypted.eml';
$tamperedEncryptedPath = $temporaryRoot . '/tampered-encrypted.eml';
file_put_contents($validNestedSignedPath, $opaqueMessage);
file_put_contents($tamperedNestedSignedPath, $tamperedOpaqueMessage);
requireOpenSslResult(openssl_pkcs7_encrypt(
	$validNestedSignedPath,
	$validEncryptedPath,
	$certificatePem,
	['To' => 'sec18@example.invalid'],
	PKCS7_BINARY
), 'Encrypt valid nested opaque signature');
requireOpenSslResult(openssl_pkcs7_encrypt(
	$tamperedNestedSignedPath,
	$tamperedEncryptedPath,
	$certificatePem,
	['To' => 'sec18@example.invalid'],
	PKCS7_BINARY
), 'Encrypt tampered nested opaque signature');

[$validEncryptedHeader, $validEncryptedBody] = splitMimeMessage(file_get_contents($validEncryptedPath));
$validDecryptCrypto = new OpenSSL($temporaryRoot . '/valid-decrypt-certificates');
$validDecryptAction = new Sec18SMimeActionHarness($validDecryptCrypto, [
	'folder' => 'INBOX',
	'uid' => 1,
	'partId' => 'TEXT',
	'certificate' => $certificatePem,
	'privateKey' => $keyPem,
	'passphrase' => ''
]);
$validDecryptAction->setImapClient(new Sec18FakeImapClient($validEncryptedHeader, $validEncryptedBody));
$validDecryptResponse = $validDecryptAction->DoSMimeDecryptMessage();

$nullDecryptAction = new Sec18SMimeActionHarness(new Sec18NullVerificationOpenSSL($temporaryRoot . '/null-decrypt-certificates'), [
	'folder' => 'INBOX',
	'uid' => 1,
	'partId' => 'TEXT',
	'certificate' => $certificatePem,
	'privateKey' => $keyPem,
	'passphrase' => ''
]);
$nullDecryptAction->setImapClient(new Sec18FakeImapClient($validEncryptedHeader, $validEncryptedBody));
$nullDecryptResponse = $nullDecryptAction->DoSMimeDecryptMessage();

[$tamperedEncryptedHeader, $tamperedEncryptedBody] = splitMimeMessage(file_get_contents($tamperedEncryptedPath));
$tamperedDecryptCrypto = new OpenSSL($temporaryRoot . '/tampered-decrypt-certificates');
$tamperedDecryptAction = new Sec18SMimeActionHarness($tamperedDecryptCrypto, [
	'folder' => 'INBOX',
	'uid' => 1,
	'partId' => 'TEXT',
	'certificate' => $certificatePem,
	'privateKey' => $keyPem,
	'passphrase' => ''
]);
$tamperedDecryptAction->setImapClient(new Sec18FakeImapClient($tamperedEncryptedHeader, $tamperedEncryptedBody));
$tamperedDecryptThrew = false;
try {
	$tamperedDecryptAction->DoSMimeDecryptMessage();
} catch (RuntimeException $error) {
	$tamperedDecryptThrew = true;
}

$trackingCrypto = new Sec18TrackingOpenSSL($temporaryRoot . '/action-certificates');
$action = new Sec18SMimeActionHarness($trackingCrypto, [
	'bodyPart' => $tamperedDetachedMessage,
	'detached' => 1,
	'sigPart' => extractDetachedSignature($detachedMessage)
]);
$invalidActionThrew = false;
try {
	$action->DoSMimeVerifyMessage();
} catch (RuntimeException $error) {
	$invalidActionThrew = true;
}

$tamperedSignatureCrypto = new Sec18TrackingOpenSSL($temporaryRoot . '/tampered-signature-action-certificates');
$tamperedSignatureAction = new Sec18SMimeActionHarness($tamperedSignatureCrypto, [
	'bodyPart' => $tamperedDetachedSignatureMessage,
	'detached' => 1,
	'sigPart' => extractDetachedSignature($detachedMessage)
]);
$tamperedSignatureActionThrew = false;
try {
	$tamperedSignatureAction->DoSMimeVerifyMessage();
} catch (RuntimeException $error) {
	$tamperedSignatureActionThrew = true;
}

$tamperedOpaqueCrypto = new Sec18TrackingOpenSSL($temporaryRoot . '/tampered-opaque-action-certificates');
$tamperedOpaqueAction = new Sec18SMimeActionHarness($tamperedOpaqueCrypto, [
	'bodyPart' => $tamperedOpaqueSignatureMessage,
	'detached' => 0,
	'sigPart' => extractDetachedSignature($detachedMessage)
]);
$tamperedOpaqueActionThrew = false;
try {
	$tamperedOpaqueAction->DoSMimeVerifyMessage();
} catch (RuntimeException $error) {
	$tamperedOpaqueActionThrew = true;
}

$validUntrustedCrypto = new Sec18TrackingOpenSSL($temporaryRoot . '/valid-untrusted-action-certificates');
$validUntrustedAction = new Sec18SMimeActionHarness($validUntrustedCrypto, [
	'bodyPart' => $detachedMessage,
	'detached' => 1,
	'sigPart' => extractDetachedSignature($detachedMessage)
]);
$validUntrustedResponse = $validUntrustedAction->DoSMimeVerifyMessage();

$emptyVerificationCrypto = new Sec18TrackingOpenSSL($temporaryRoot . '/empty-verification-action-certificates');
$emptyVerificationAction = new Sec18SMimeActionHarness($emptyVerificationCrypto, [
	'bodyPart' => '',
	'detached' => 1,
	'sigPart' => extractDetachedSignature($detachedMessage)
]);
$emptyVerificationResponse = $emptyVerificationAction->DoSMimeVerifyMessage();

// Real storage and message construction, with generated public certificates only.
// The logger facade is disabled above; no application/account bootstrap is used.
class Sec710Crypto extends OpenSSL
{
	public int $encryptionCalls = 0;
	public function encrypt($input, array $certificates): ?string
	{
		++$this->encryptionCalls;
		return parent::encrypt($input, $certificates);
	}
}
class Sec710MessageHarness
{
	use \RainLoop\Actions\Messages;
	public function __construct(private OpenSSL $crypto, private array $parameters) {}
	public function Config() { return new class { public function Get($section, $key, $default = null) { return $default; } }; }
	public function GetActionParam($name, $default = null) { return $this->parameters[$name] ?? $default; }
	public function SMIME(): OpenSSL { return $this->crypto; }
	public function build(): \MailSo\Mime\Message { return $this->buildMessage(new \RainLoop\Model\MainAccount(), false); }
}
$trustHome = $temporaryRoot . '/recipient-trust';
mkdir($trustHome, 0700);
$legacyId = str_replace(':', '', openssl_x509_parse($certificatePem)['extensions']['subjectKeyIdentifier']);
$legacyPath = $trustHome . '/' . $legacyId . '.crt';
file_put_contents($legacyPath, $certificatePem);
$legacyCache = json_encode([['file' => $legacyId . '.crt', 'id' => $legacyId,
	'CN' => 'Legacy synthetic identity', 'emailAddress' => 'sec18@example.invalid',
	'validTo_time_t' => time() + 3600, 'smimeencrypt' => true]], JSON_THROW_ON_ERROR);
file_put_contents($trustHome . '/certificates.json', $legacyCache);
$trustCrypto = new Sec710Crypto($trustHome);
$trustResults = ['legacy_ineligible' => [] === $trustCrypto->certificates()];
$realVerification = new Sec18SMimeActionHarness($trustCrypto, [
	'bodyPart' => $detachedMessage, 'detached' => 1,
	'sigPart' => extractDetachedSignature($detachedMessage)
]);
$trustResults['valid_message_still_verifies'] = true === ($realVerification->DoSMimeVerifyMessage()['Result']['success'] ?? false);
$trustResults['valid_message_does_not_promote'] = [] === $trustCrypto->certificates();
$importAction = new Sec18SMimeActionHarness($trustCrypto, ['pem' => "\n" . $certificatePem . "\n"]);
$trustResults['explicit_import_succeeds'] = true === ($importAction->DoSMimeImportCertificate()['Result'] ?? false);
$explicit = $trustCrypto->certificates();
$first = $explicit[0] ?? [];
$fingerprint = openssl_x509_fingerprint($certificatePem, 'sha256');
$trustResults['explicit_fingerprint'] = $fingerprint === ($first['id'] ?? null)
	&& $fingerprint . '.crt' === ($first['file'] ?? null);
$trustResults['explicit_recipient'] = count($explicit) === 1 && true === ($first['smimeencrypt'] ?? false)
	&& 'sec18@example.invalid' === ($first['emailAddress'] ?? null);
$importAction->DoSMimeImportCertificate();
$trustResults['reimport_idempotent'] = count($trustCrypto->certificates()) === 1;
$sameSki = requireOpenSslResult(openssl_csr_sign($csr, null, $key, 1, ['digest_alg' => 'sha256'], 710002), 'Renew synthetic certificate');
openssl_x509_export($sameSki, $sameSkiPem);
$trustResults['same_ski_fixture'] = openssl_x509_parse($sameSkiPem)['extensions']['subjectKeyIdentifier']
	=== openssl_x509_parse($certificatePem)['extensions']['subjectKeyIdentifier']
	&& openssl_x509_fingerprint($sameSkiPem, 'sha256') !== $fingerprint;
(new Sec18SMimeActionHarness($trustCrypto, ['pem' => $sameSkiPem]))->DoSMimeImportCertificate();
$trustResults['same_ski_distinct'] = count($trustCrypto->certificates()) === 2;
$claimCsr = requireOpenSslResult(openssl_csr_new(['commonName' => 'Independent synthetic identity',
	'emailAddress' => 'sec18@example.invalid'], $unrelatedKey, ['digest_alg' => 'sha256']), 'Independent synthetic claim');
$claim = requireOpenSslResult(openssl_csr_sign($claimCsr, null, $unrelatedKey, 1, ['digest_alg' => 'sha256'], 710003), 'Sign independent synthetic claim');
openssl_x509_export($claim, $claimPem);
$claimMessage = createDetachedMessage($temporaryRoot, 'independent-claim', $detachedContent, $claimPem,
	$issuerKey, PKCS7_DETACHED | PKCS7_BINARY);
$claimAction = new Sec18SMimeActionHarness($trustCrypto, ['bodyPart' => $claimMessage, 'detached' => 1,
	'sigPart' => extractDetachedSignature($claimMessage)]);
$trustResults['independent_signature_valid'] = true === ($claimAction->DoSMimeVerifyMessage()['Result']['success'] ?? false);
$trustResults['independent_claim_not_promoted'] = !in_array(openssl_x509_fingerprint($claimPem, 'sha256'),
	array_column($trustCrypto->certificates(), 'id'), true);
(new Sec18SMimeActionHarness($trustCrypto, ['pem' => $claimPem]))->DoSMimeImportCertificate();
$trustResults['independent_explicit_import'] = count($trustCrypto->certificates()) === 3
	&& in_array(openssl_x509_fingerprint($claimPem, 'sha256'), array_column($trustCrypto->certificates(), 'id'), true);
$trustResults['first_certificate_unchanged'] = $certificatePem === $trustCrypto->getCertificate($first['file']);
$trustResults['legacy_bytes_preserved'] = file_get_contents($legacyPath) === $certificatePem
	&& file_get_contents($trustHome . '/certificates.json') === $legacyCache;
$messageParameters = ['from' => 'sec18@example.invalid', 'to' => 'sec18@example.invalid',
	'subject' => 'Synthetic trust check', 'plain' => 'M710-LOCAL-PLAINTEXT'];
foreach (['unknown' => str_repeat('f', 64), 'legacy' => $legacyId] as $name => $id) {
	$trustCrypto->encryptionCalls = 0;
	$rejected = false;
	try { (new Sec710MessageHarness($trustCrypto, $messageParameters + ['encryptCertificates' => [$id]]))->build(); }
	catch (Throwable $error) { $rejected = true; }
	$trustResults[$name . '_id_refused_before_crypto'] = $rejected && 0 === $trustCrypto->encryptionCalls;
}
foreach (['invalid_list' => 'synthetic-invalid-list', 'invalid_item' => [[]]] as $name => $input) {
	$trustCrypto->encryptionCalls = 0;
	$rejected = false;
	try { (new Sec710MessageHarness($trustCrypto, $messageParameters + ['encryptCertificates' => $input]))->build(); }
	catch (RuntimeException $error) { $rejected = true; }
	$trustResults[$name . '_controlled'] = $rejected && 0 === $trustCrypto->encryptionCalls;
}
foreach (['explicit_id' => $first['id'], 'identity_pem' => $certificatePem] as $name => $input) {
	$built = (new Sec710MessageHarness($trustCrypto, $messageParameters + ['encryptCertificates' => [$input]]))->build();
	$mime = stream_get_contents($built->ToStream());
	$trustCrypto->setCertificate($certificatePem);
	$trustCrypto->setPrivateKey($keyPem);
	$trustResults[$name . '_roundtrip'] = str_contains($trustCrypto->decrypt($mime), 'M710-LOCAL-PLAINTEXT');
}

// Request-input regressions use only this fixture's generated material.
$inputBoundary = ['rejected' => [], 'accepted' => []];
$inputDirectory = $temporaryRoot . '/input-boundary';
mkdir($inputDirectory, 0700);
$keyInputFile = $inputDirectory . '/key.fixture';
$certificateInputFile = $inputDirectory . '/certificate.fixture';
file_put_contents($keyInputFile, $keyPem);
chmod($keyInputFile, 0600);
file_put_contents($certificateInputFile, $certificatePem);
$keyLocator = 'file://' . $keyInputFile;
$certificateLocator = 'file://' . $certificateInputFile;
$boundaryCrypto = static fn() => new OpenSSL($inputDirectory . '/crypto');
$boundaryAction = static fn(array $parameters) => new Sec18SMimeActionHarness($boundaryCrypto(), $parameters);
$rejects = static function (callable $operation): bool {
	try { return false === $operation(); }
	catch (Throwable $error) { return true; }
};
$decryptInput = static function ($keyInput, $certificateInput) use (
	$boundaryAction, $validEncryptedHeader, $validEncryptedBody
) {
	$action = $boundaryAction(['folder' => 'INBOX', 'uid' => 1, 'partId' => 'TEXT',
		'privateKey' => $keyInput, 'certificate' => $certificateInput, 'passphrase' => '']);
	$action->setImapClient(new Sec18FakeImapClient($validEncryptedHeader, $validEncryptedBody));
	return $action->DoSMimeDecryptMessage();
};
// Expected native parse failures produce no diagnostic/key-bearing output.
set_error_handler(static function () { throw new RuntimeException('Synthetic input rejected'); });
try {
	foreach ([
		'export_locator' => static fn() => $boundaryAction(['privateKey' => $keyLocator])->DoSMimeExportPrivateKey(),
		'create_locator' => static fn() => $boundaryAction(['privateKey' => $keyLocator])->DoSMimeCreateCertificate(),
		'key_locator' => static fn() => $boundaryCrypto()->setPrivateKey($keyLocator),
		'key_array_locator' => static fn() => $boundaryCrypto()->setPrivateKey([$keyLocator, '']),
		'key_array_pem' => static fn() => $boundaryCrypto()->setPrivateKey([$keyPem, '']),
		'key_plain_path' => static fn() => $boundaryCrypto()->setPrivateKey($keyInputFile),
		'key_malformed' => static fn() => $boundaryCrypto()->setPrivateKey('synthetic invalid key'),
		'key_incomplete_envelope' => static fn() => $boundaryCrypto()->setPrivateKey("-----BEGIN PRIVATE KEY-----\n"),
		'certificate_locator' => static fn() => $boundaryCrypto()->setCertificate($certificateLocator),
		'certificate_malformed' => static fn() => $boundaryCrypto()->setCertificate('synthetic invalid certificate'),
		'import_locator' => static fn() => $boundaryAction(['pem' => $certificateLocator])->DoSMimeImportCertificate()['Result'],
		'encrypt_locator' => static fn() => $boundaryCrypto()->encrypt('Local synthetic message', [$certificateLocator]),
		'encrypt_array' => static fn() => $boundaryCrypto()->encrypt('Local synthetic message', [[$certificatePem]]),
		'decrypt_key_locator' => static fn() => $decryptInput($keyLocator, $certificatePem),
		'decrypt_certificate_locator' => static fn() => $decryptInput($keyPem, $certificateLocator),
		'sign_key_locator' => static fn() => (new Sec710MessageHarness($boundaryCrypto(),
			$messageParameters + ['signCertificate' => $certificatePem, 'signPrivateKey' => $keyLocator]))->build(),
		'sign_certificate_locator' => static fn() => (new Sec710MessageHarness($boundaryCrypto(),
			$messageParameters + ['signCertificate' => $certificateLocator, 'signPrivateKey' => $keyPem]))->build(),
		'zero_key' => static fn() => $creator->createSelfSigned($passphrase, '0'),
		'wrong_passphrase' => static fn() => $boundaryAction(['privateKey' => $created['pkey'],
			'oldPassphrase' => 'different synthetic passphrase'])->DoSMimeExportPrivateKey()
	] as $name => $operation) {
		$inputBoundary['rejected'][$name] = $rejects($operation);
	}
	$inputBoundary['rejected']['import_no_store'] = !is_dir($inputDirectory . '/crypto/explicit-v1');

	$crypto = $boundaryCrypto();
	$crypto->setPrivateKey($keyPem);
	$rejects(static fn() => $crypto->setPrivateKey($keyLocator));
	$inputBoundary['rejected']['failed_key_cleared'] = $rejects(static fn() => $crypto->exportPrivateKey());
	$crypto = $boundaryCrypto();
	$crypto->setCertificate($certificatePem);
	$crypto->setPrivateKey($keyPem);
	$rejects(static fn() => $crypto->setCertificate($certificateLocator));
	$inputBoundary['rejected']['failed_certificate_cleared'] = $rejects(
		static fn() => $crypto->decrypt(file_get_contents($validEncryptedPath))
	);

	$plainExport = $boundaryAction(['privateKey' => $keyPem])->DoSMimeExportPrivateKey()['Result'];
	$inputBoundary['accepted']['plain_export'] = openssl_x509_check_private_key($certificatePem,
		openssl_pkey_get_private($plainExport));
	$encryptedExport = $boundaryAction(['privateKey' => $created['pkey'],
		'oldPassphrase' => (string) $passphrase, 'newPassphrase' => 'synthetic export passphrase'
	])->DoSMimeExportPrivateKey()['Result'];
	$inputBoundary['accepted']['encrypted_export'] = openssl_x509_check_private_key($created['x509'],
		openssl_pkey_get_private($encryptedExport, 'synthetic export passphrase'));
	$supplied = "\n" . $keyPem . "\n";
	$createdFromInput = $boundaryAction(['privateKey' => $supplied])->DoSMimeCreateCertificate()['Result'];
	$inputBoundary['accepted']['provided_pem_preserved'] = $createdFromInput['pkey'] === $supplied
		&& openssl_x509_check_private_key($createdFromInput['x509'], $key);
	$crypto = $boundaryCrypto();
	$crypto->setCertificate($certificate);
	$crypto->setPrivateKey($key);
	$inputBoundary['accepted']['native_objects'] = openssl_x509_check_private_key($certificate,
		openssl_pkey_get_private($crypto->exportPrivateKey()));
	$crypto = $boundaryCrypto();
	$crypto->setCertificate("\n" . $certificatePem . "\n");
	$crypto->setPrivateKey($supplied);
	$inputBoundary['accepted']['outer_whitespace'] = openssl_x509_check_private_key($certificate,
		openssl_pkey_get_private($crypto->exportPrivateKey()));
	$preamble = "Bag Attributes\n    friendlyName: Synthetic local export\nsubject=CN=Local fixture\nissuer=CN=Local fixture\n";
	$inputBoundary['accepted']['certificate_preamble'] = true === ($boundaryAction([
		'pem' => $preamble . $certificatePem
	])->DoSMimeImportCertificate()['Result'] ?? false);
	$crypto = $boundaryCrypto();
	$crypto->setCertificate($preamble . $certificatePem);
	$crypto->setPrivateKey($preamble . $keyPem);
	$inputBoundary['accepted']['key_preamble'] = openssl_x509_check_private_key($certificate,
		openssl_pkey_get_private($crypto->exportPrivateKey()));
	$inputBoundary['accepted']['recipient_preamble'] = is_string($crypto->encrypt(
		'Local synthetic message', [$preamble . $certificatePem]
	));
	$signedMessage = (new Sec710MessageHarness($boundaryCrypto(),
		$messageParameters + ['signCertificate' => $certificatePem, 'signPrivateKey' => $keyPem]))->build();
	$inputBoundary['accepted']['message_signing'] = true === ($boundaryCrypto()->verify(
		stream_get_contents($signedMessage->ToStream()), null, false)['success'] ?? false);
	$ecKey = requireOpenSslResult(openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC,
		'curve_name' => 'prime256v1']), 'Generate local EC input');
	$ecPem = '';
	openssl_pkey_export($ecKey, $ecPem);
	$crypto = $boundaryCrypto();
	$crypto->setPrivateKey($ecPem);
	$inputBoundary['accepted']['ec_pem'] = openssl_pkey_get_details($ecKey)['key']
		=== openssl_pkey_get_details(openssl_pkey_get_private($crypto->exportPrivateKey()))['key'];
	$inputBoundary['accepted']['completed'] = true;
} catch (Throwable $error) {
	$inputBoundary['accepted']['completed'] = false;
} finally {
	restore_error_handler();
	unlink($keyInputFile);
	unlink($certificateInputFile);
}

$runtime = [
	'php' => PHP_VERSION,
	'openssl' => OPENSSL_VERSION_TEXT,
	'flags' => [
		'nosigs' => PKCS7_NOSIGS,
		'noverify' => PKCS7_NOVERIFY,
		'nochain' => PKCS7_NOCHAIN,
		'verifier_flags' => PKCS7_NOVERIFY
	]
];

echo json_encode([
	'runtime' => $runtime,
	'identity_generation' => $identityGeneration,
	'request_input_boundary' => $inputBoundary,
	'explicit_certificate_trust' => $trustResults,
	'valid_detached' => $validDetached,
	'tampered_detached' => $tamperedDetached,
	'different_length_detached' => $differentLengthDetached,
	'tampered_detached_signature' => $tamperedDetachedSignature,
	'extra_trailing_line_detached' => $trailingLineDetached,
	'canonicalized_lf_utf8_headers_detached' => $canonicalizedDetached,
	'empty_detached' => $emptyDetached,
	'utf8_detached' => $utf8Detached,
	'mime_entity_headers_detached' => $mimeEntityDetached,
	'final_newline_detached' => $trailingNewlineDetached,
	'no_final_newline_detached' => $noTrailingNewlineDetached,
	'valid_opaque' => $validOpaque,
	'tampered_opaque' => $tamperedOpaque,
	'tampered_opaque_signature' => $tamperedOpaqueSignature,
	'expected_opaque_body' => $opaqueContent,
	'self_signed_integrity' => $selfSignedIntegrity,
	'explicit_unrelated_trust_validation_succeeded' => true === $unrelatedTrustResult,
	'nochain_omitted_integrity_succeeded' => true === $noChainFlagIntegrityResult,
	'invalid_action_threw' => $invalidActionThrew,
	'invalid_action_certificate_imports' => $trackingCrypto->certificateImports,
	'tampered_signature_action_threw' => $tamperedSignatureActionThrew,
	'tampered_signature_action_certificate_imports' => $tamperedSignatureCrypto->certificateImports,
	'tampered_opaque_action_threw' => $tamperedOpaqueActionThrew,
	'tampered_opaque_action_certificate_imports' => $tamperedOpaqueCrypto->certificateImports,
	'valid_untrusted_action_success' => !empty($validUntrustedResponse['Result']['success']),
	'valid_untrusted_action_certificate_imports' => $validUntrustedCrypto->certificateImports,
	'empty_verification_result_is_false' => false === ($emptyVerificationResponse['Result'] ?? null),
	'empty_verification_certificate_imports' => $emptyVerificationCrypto->certificateImports,
	'valid_decrypted_signed_success' => !empty($validDecryptResponse['Result']['signed']['success']),
	'valid_decrypted_signed_body' => $validDecryptResponse['Result']['data'] ?? null,
	'null_decrypted_verification_result_is_false' => false === ($nullDecryptResponse['Result'] ?? null),
	'null_decrypted_verification_returns_no_body' => !isset($nullDecryptResponse['Result']['data']),
	'tampered_decrypted_signed_threw' => $tamperedDecryptThrew
], JSON_THROW_ON_ERROR);
