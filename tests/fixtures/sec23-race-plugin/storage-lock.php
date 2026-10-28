<?php

$sRepositoryRoot = $argv[1] ?? '';
$sDataRoot = $argv[2] ?? '';
$sEmail = $argv[3] ?? '';
$sMode = $argv[4] ?? '';
$sBarrier = $argv[5] ?? '';
if (!$sRepositoryRoot || !$sDataRoot || !$sEmail || !$sBarrier || !\in_array($sMode, ['hold', 'delete'], true)) {
	fwrite(STDERR, "Invalid SEC-23 storage lock fixture arguments\n");
	exit(2);
}

define('APP_VERSION', '0.0.0');
define('APP_INDEX_ROOT_PATH', \rtrim($sRepositoryRoot, '\\/').DIRECTORY_SEPARATOR);
define('APP_DATA_FOLDER_PATH', \rtrim($sDataRoot, '\\/').DIRECTORY_SEPARATOR);
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require APP_INDEX_ROOT_PATH.'snappymail/v/'.APP_VERSION.'/include.php';

class Sec23DeleteProbeStorage extends \RainLoop\Providers\Storage\FileStorage
{
	private string $sBarrier;

	public function __construct(string $sStoragePath, string $sBarrier)
	{
		parent::__construct($sStoragePath);
		$this->sBarrier = $sBarrier;
	}

	public function AcquireLock($mAccount, int $iStorageType, string $sKey)
	{
		if ('delete-storage' === $sKey) {
			$sAccountRoot = $this->GenerateFilePath($mAccount, \RainLoop\Providers\Storage\Enumerations\StorageType::ROOT);
			$sLockFile = $this->sDataPath.'/.signme-locks/'.\hash('sha256', \rtrim($sAccountRoot, '\\/')).'.lock';
			$mProbe = @\fopen($sLockFile, 'c');
			$bContended = \is_resource($mProbe) && !@\flock($mProbe, LOCK_EX | LOCK_NB);
			\file_put_contents($this->sBarrier.'/delete-lock-probe', $bContended ? 'contended' : 'uncontended');
			if (\is_resource($mProbe)) {
				if (!$bContended) {
					@\flock($mProbe, LOCK_UN);
				}
				@\fclose($mProbe);
			}
		}

		return parent::AcquireLock($mAccount, $iStorageType, $sKey);
	}
}

$oStorage = new Sec23DeleteProbeStorage(APP_PRIVATE_DATA.'storage', $sBarrier);
$iStorageType = \RainLoop\Providers\Storage\Enumerations\StorageType::SIGN_ME;
if ('hold' === $sMode) {
	// Explicit synthetic provisioning precedes a raw-identity lock probe.
	$oStorage->GenerateFilePath($sEmail, \RainLoop\Providers\Storage\Enumerations\StorageType::ROOT, true);
	$mLock = $oStorage->AcquireLock($sEmail, $iStorageType, 'account');
	if (!$mLock) {
		fwrite(STDERR, "Unable to acquire fixture account lock\n");
		exit(3);
	}
	$oStorage->Put($sEmail, $iStorageType, 'fixture-lineage', 'fixture-token');
	\file_put_contents($sBarrier.'/lock-held', 'held');
	$fDeadline = \microtime(true) + 15;
	while (!\is_file($sBarrier.'/release')) {
		if (\microtime(true) >= $fDeadline) {
			$oStorage->ReleaseLock($mLock);
			fwrite(STDERR, "SEC-23 storage lock fixture timed out\n");
			exit(4);
		}
		\usleep(10000);
	}
	$oStorage->ReleaseLock($mLock);
	exit(0);
}

\file_put_contents($sBarrier.'/delete-started', 'started');
$bDeleted = $oStorage->DeleteStorage($sEmail);
\file_put_contents($sBarrier.'/delete-done', $bDeleted ? 'deleted' : 'failed');
exit($bDeleted ? 0 : 5);
