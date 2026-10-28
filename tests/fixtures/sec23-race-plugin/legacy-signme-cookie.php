<?php

$sRepositoryRoot = $argv[1] ?? '';
$sDataRoot = $argv[2] ?? '';
$sCookie = $argv[3] ?? '';
$sMode = $argv[4] ?? 'pre-version';
if (!$sRepositoryRoot || !$sDataRoot || !$sCookie) {
	fwrite(STDERR, "Invalid SEC-23 legacy SignMe fixture arguments\n");
	exit(2);
}

define('APP_VERSION', '0.0.0');
define('APP_INDEX_ROOT_PATH', \rtrim($sRepositoryRoot, '\\/').DIRECTORY_SEPARATOR);
define('APP_DATA_FOLDER_PATH', \rtrim($sDataRoot, '\\/').DIRECTORY_SEPARATOR);
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require APP_INDEX_ROOT_PATH.'snappymail/v/'.APP_VERSION.'/include.php';

$aTokenData = \SnappyMail\Crypt::DecryptUrlSafe($sCookie, 'signme');
if (!\is_array($aTokenData) || !isset($aTokenData['e'], $aTokenData['u'])) {
	fwrite(STDERR, "Unable to decode SEC-23 SignMe cookie\n");
	exit(3);
}

if ('v2' === $sMode) {
	$oStorage = \RainLoop\Api::Actions()->StorageProvider();
	$sStored = $oStorage->Get(
		$aTokenData['e'],
		\RainLoop\Providers\Storage\Enumerations\StorageType::SIGN_ME,
		$aTokenData['u']
	);
	try {
		$aStored = \json_decode($sStored, true, 8, JSON_THROW_ON_ERROR);
	} catch (\Throwable $oException) {
		$aStored = null;
	}
	$sToken = \is_array($aStored) && 3 === ($aStored['Version'] ?? null)
		? \base64_decode($aStored['Token'] ?? '', true)
		: false;
	if (!\is_string($sToken) || '' === $sToken
		|| !$oStorage->Put(
			$aTokenData['e'],
			\RainLoop\Providers\Storage\Enumerations\StorageType::SIGN_ME,
			$aTokenData['u'],
			$sToken
		)
		|| $oStorage->Get(
			$aTokenData['e'],
			\RainLoop\Providers\Storage\Enumerations\StorageType::SIGN_ME,
			$aTokenData['u']
		) !== $sToken) {
		fwrite(STDERR, "Unable to create a pre-M1E v2 SignMe record\n");
		exit(4);
	}
	$aTokenData['v'] = 2;
	unset($aTokenData['g']);
} else {
	unset($aTokenData['v']);
}
echo \SnappyMail\Crypt::EncryptUrlSafe($aTokenData, 'signme');
