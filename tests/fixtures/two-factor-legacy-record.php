<?php

$sRepositoryRoot = $argv[1] ?? '';
$sDataRoot = $argv[2] ?? '';
$sFormat = $argv[3] ?? '';
$sJson = $argv[4] ?? '';
if (!$sRepositoryRoot || !$sDataRoot || !$sFormat || !$sJson) {
	fwrite(STDERR, "Invalid two-factor legacy record fixture arguments\n");
	exit(2);
}

define('APP_VERSION', '0.0.0');
define('APP_INDEX_ROOT_PATH', rtrim($sRepositoryRoot, '\\/').DIRECTORY_SEPARATOR);
define('APP_DATA_FOLDER_PATH', rtrim($sDataRoot, '\\/').DIRECTORY_SEPARATOR);
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require APP_INDEX_ROOT_PATH.'snappymail/v/'.APP_VERSION.'/include.php';

$mRecord = json_decode($sJson, true, 512, JSON_THROW_ON_ERROR);
if (!is_array($mRecord)) {
	fwrite(STDERR, "Two-factor fixture requires a record array\n");
	exit(3);
}

if ('serialized-object' === $sFormat) {
	class TwoFactorWakeupProbe {}
	$mRecord['Probe'] = new TwoFactorWakeupProbe();
	$sPayload = serialize($mRecord);
} else if ('serialized' === $sFormat) {
	$sPayload = serialize($mRecord);
} else if ('encrypted-json' === $sFormat || 'encrypted-serialized' === $sFormat) {
	$sPlaintext = 'encrypted-json' === $sFormat ? json_encode($mRecord, JSON_THROW_ON_ERROR) : serialize($mRecord);
	$sCiphertext = \MailSo\Base\Xxtea::Encrypt($sPlaintext, md5(APP_SALT));
	$sPayload = \MailSo\Base\Utils::UrlSafeBase64Encode($sCiphertext);
} else {
	fwrite(STDERR, "Unsupported two-factor legacy record format\n");
	exit(4);
}

echo base64_encode($sPayload);
