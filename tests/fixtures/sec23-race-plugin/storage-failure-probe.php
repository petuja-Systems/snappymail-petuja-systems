<?php

$sRepositoryRoot = $argv[1] ?? '';
$sDataRoot = $argv[2] ?? '';
$sEmail = $argv[3] ?? '';
$sStorageName = $argv[4] ?? '';
$sKey = $argv[5] ?? '';
if (!$sRepositoryRoot || !$sDataRoot || !$sEmail || !$sKey || !\in_array($sStorageName, ['session', 'signme'], true)) {
	fwrite(STDERR, "Invalid SEC-23 storage failure fixture arguments\n");
	exit(2);
}

define('APP_VERSION', '0.0.0');
define('APP_INDEX_ROOT_PATH', \rtrim($sRepositoryRoot, '\\/').DIRECTORY_SEPARATOR);
define('APP_DATA_FOLDER_PATH', \rtrim($sDataRoot, '\\/').DIRECTORY_SEPARATOR);
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require APP_INDEX_ROOT_PATH.'snappymail/v/'.APP_VERSION.'/include.php';
require_once __DIR__.'/storage.php';

$iStorageType = 'signme' === $sStorageName
	? \RainLoop\Providers\Storage\Enumerations\StorageType::SIGN_ME
	: \RainLoop\Providers\Storage\Enumerations\StorageType::SESSION;
$oStorage = new Sec23FailingStorage(new \RainLoop\Providers\Storage\FileStorage(APP_PRIVATE_DATA.'storage'));
$bCleared = $oStorage->Clear($sEmail, $iStorageType, $sKey);
$mValue = $oStorage->Get($sEmail, $iStorageType, $sKey);
$sFilePath = (new \RainLoop\Providers\Storage\FileStorage(APP_PRIVATE_DATA.'storage'))
	->GenerateFilePath($sEmail, $iStorageType).$sKey;
echo \json_encode([
	'clear' => $bCleared,
	'get' => $mValue,
	'underlyingExists' => \is_file($sFilePath)
], JSON_THROW_ON_ERROR);
