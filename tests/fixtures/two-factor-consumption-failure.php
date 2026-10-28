<?php

$sRepositoryRoot = $argv[1] ?? '';
$sDataRoot = $argv[2] ?? '';
$sEmail = $argv[3] ?? '';
$sRecordJson = $argv[4] ?? '';
if (!$sRepositoryRoot || !$sDataRoot || !$sEmail || !$sRecordJson) {
	fwrite(STDERR, "Invalid two-factor consumption fixture arguments\n");
	exit(2);
}

define('APP_VERSION', '0.0.0');
define('APP_INDEX_ROOT_PATH', rtrim($sRepositoryRoot, '\\/').DIRECTORY_SEPARATOR);
define('APP_DATA_FOLDER_PATH', rtrim($sDataRoot, '\\/').DIRECTORY_SEPARATOR);
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require APP_INDEX_ROOT_PATH.'snappymail/v/'.APP_VERSION.'/include.php';

class TwoFactorFailingStorage implements \RainLoop\Providers\Storage\IStorage
{
	private string $sRecord;

	public function __construct(string $sRecord)
	{
		$this->sRecord = $sRecord;
	}

	public function Put($mAccount, int $iStorageType, string $sKey, string $sValue) : bool
	{
		return false;
	}

	public function Get($mAccount, int $iStorageType, string $sKey, $mDefault = false)
	{
		return \RainLoop\Providers\Storage\Enumerations\StorageType::CONFIG === $iStorageType
			&& 'two_factor' === $sKey ? $this->sRecord : $mDefault;
	}

	public function Clear($mAccount, int $iStorageType, string $sKey) : bool
	{
		return false;
	}

	public function IsLocal() : bool
	{
		return false;
	}

	public function Record() : string
	{
		return $this->sRecord;
	}
}

$mRecord = json_decode($sRecordJson, true, 512, JSON_THROW_ON_ERROR);
if (!is_array($mRecord)) {
	fwrite(STDERR, "Two-factor fixture requires a record array\n");
	exit(3);
}
$oAccount = (new ReflectionClass(\RainLoop\Model\MainAccount::class))->newInstanceWithoutConstructor();
$oEmail = new ReflectionProperty(\RainLoop\Model\Account::class, 'sEmail');
if (PHP_VERSION_ID < 80100) {
	$oEmail->setAccessible(true);
}
$oEmail->setValue($oAccount, $sEmail);
$sStoredRecord = json_encode($mRecord, JSON_THROW_ON_ERROR);
$oDriver = new TwoFactorFailingStorage($sStoredRecord);
$oStorage = new \RainLoop\Providers\Storage($oDriver);
$oTwoFactor = new \SnappyMail\TwoFactor($oStorage, $oAccount);
$sRecoveryCode = (string) (explode(' ', $mRecord['BackupCodes'])[0] ?? '');

echo json_encode([
	'verifyBefore' => $oTwoFactor->VerifyRecoveryCode($sRecoveryCode),
	'consume' => $oTwoFactor->ConsumeRecoveryCode($sRecoveryCode),
	'totpFallback' => \SnappyMail\TwoFactor::VerifyTotp($mRecord['Secret'], $sRecoveryCode),
	'recordAfter' => json_decode($oDriver->Record(), true, 512, JSON_THROW_ON_ERROR)
], JSON_THROW_ON_ERROR);
