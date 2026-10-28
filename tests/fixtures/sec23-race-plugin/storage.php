<?php

use RainLoop\Providers\Storage\Enumerations\StorageType;
use RainLoop\Providers\Storage\IStorage;

class Sec23BarrierStorage extends \RainLoop\Providers\Storage\FileStorage
{
	private int $iSelectedSignMeGets = 0;

	public function Put($mAccount, int $iStorageType, string $sKey, string $sValue) : bool
	{
		if ('1' === \getenv('PETUJA_TEST_STORAGE_FAIL_SESSION_BINDING')
			&& StorageType::SESSION === $iStorageType
			&& \str_starts_with($sKey, 'auth-')) {
			return false;
		}

		return parent::Put($mAccount, $iStorageType, $sKey, $sValue);
	}

	private function isSelectedSignMe($mAccount, int $iStorageType): bool
	{
		$sEmail = \is_string($mAccount)
			? $mAccount
			: ($mAccount instanceof \RainLoop\Model\Account ? $mAccount->Email() : '');
		$sTargetEmail = \getenv('PETUJA_TEST_SIGNME_BARRIER_EMAIL');
		return StorageType::SIGN_ME === $iStorageType
			&& (\getenv('PETUJA_TEST_SIGNME_BARRIER_DIR') || \getenv('PETUJA_TEST_SIGNME_LOCKED_BARRIER_DIR'))
			&& $sTargetEmail
			&& \strcasecmp($sEmail, $sTargetEmail) === 0;
	}

	private function waitAtSignMeBarrier(
		string $sDirectoryVariable = 'PETUJA_TEST_SIGNME_BARRIER_DIR',
		string $sMarker = 'reached'
	): void
	{
		$sBarrier = \getenv($sDirectoryVariable);
		if (!$sBarrier) {
			return;
		}
		\file_put_contents($sBarrier.'/'.$sMarker, 'post-IMAP-check');
		$fDeadline = \microtime(true) + 15;
		while (!\is_file($sBarrier.'/release')) {
			if (\microtime(true) >= $fDeadline) {
				throw new \RuntimeException('SEC-23 fixture barrier timed out');
			}
			\usleep(10000);
		}
	}

	/**
	 * In the fixed implementation, redemption reaches AcquireLock only after
	 * the post-IMAP token comparison has succeeded. In the baseline, use the
	 * equivalent second-read barrier because AcquireLock does not exist there.
	 * The separate logout server does not receive the barrier environment.
	 */
	public function Get($mAccount, int $iStorageType, string $sKey, $mDefault = false)
	{
		$mValue = parent::Get($mAccount, $iStorageType, $sKey, $mDefault);
		if ($this->isSelectedSignMe($mAccount, $iStorageType)) {
			++$this->iSelectedSignMeGets;
			if (2 === $this->iSelectedSignMeGets
				&& !\interface_exists(\RainLoop\Providers\Storage\ILockingStorage::class)) {
				$this->waitAtSignMeBarrier();
			}
		}

		return $mValue;
	}

	public function AcquireLock($mAccount, int $iStorageType, string $sKey)
	{
		$bAfterPostImapCheck = 2 === $this->iSelectedSignMeGets
			&& $this->isSelectedSignMe($mAccount, $iStorageType)
			&& \interface_exists(\RainLoop\Providers\Storage\ILockingStorage::class);
		if ($bAfterPostImapCheck && \getenv('PETUJA_TEST_SIGNME_BARRIER_DIR')) {
			$this->waitAtSignMeBarrier();
		}

		$sLogoutBarrier = \getenv('PETUJA_TEST_SIGNME_LOGOUT_LOCK_ATTEMPT_DIR');
		if ($sLogoutBarrier
			&& 'POST' === ($_SERVER['REQUEST_METHOD'] ?? '')
			&& \str_contains($_SERVER['REQUEST_URI'] ?? '', '/?/Json')) {
			$sAccountRoot = $this->GenerateFilePath($mAccount, StorageType::ROOT);
			$sLockFile = $this->sDataPath.'/.signme-locks/'.\hash('sha256', \rtrim($sAccountRoot, '\\/')).'.lock';
			$mProbe = @\fopen($sLockFile, 'c');
			$bContended = \is_resource($mProbe) && !@\flock($mProbe, LOCK_EX | LOCK_NB);
			if (\is_resource($mProbe)) {
				if (!$bContended) {
					@\flock($mProbe, LOCK_UN);
				}
				@\fclose($mProbe);
			}
			\file_put_contents($sLogoutBarrier.'/logout-lock-attempt', $bContended ? 'contended' : 'uncontended');
		}

		$mLock = parent::AcquireLock($mAccount, $iStorageType, $sKey);
		if ($bAfterPostImapCheck && $mLock && \getenv('PETUJA_TEST_SIGNME_LOCKED_BARRIER_DIR')) {
			$this->waitAtSignMeBarrier('PETUJA_TEST_SIGNME_LOCKED_BARRIER_DIR', 'lock-held');
		}
		return $mLock;
	}
}

/**
 * Deliberately exposes only IStorage so tests can confirm Remember-Me fails
 * closed for installed drivers without the optional locking capability.
 */
class Sec23UnlockedStorage implements IStorage, \RainLoop\Providers\Storage\IRevocationStorage
{
	private \RainLoop\Providers\Storage\FileStorage $oStorage;

	public function __construct(\RainLoop\Providers\Storage\FileStorage $oStorage)
	{
		$this->oStorage = $oStorage;
	}

	public function Put($mAccount, int $iStorageType, string $sKey, string $sValue) : bool
	{
		return $this->oStorage->Put($mAccount, $iStorageType, $sKey, $sValue);
	}

	public function Get($mAccount, int $iStorageType, string $sKey, $mDefault = false)
	{
		return $this->oStorage->Get($mAccount, $iStorageType, $sKey, $mDefault);
	}

	public function Clear($mAccount, int $iStorageType, string $sKey) : bool
	{
		return $this->oStorage->Clear($mAccount, $iStorageType, $sKey);
	}

	public function Inspect($mAccount, int $iStorageType, string $sKey, &$mValue) : ?bool
	{
		return $this->oStorage->Inspect($mAccount, $iStorageType, $sKey, $mValue);
	}

	public function Revoke($mAccount, int $iStorageType, string $sKey) : ?bool
	{
		return $this->oStorage->Revoke($mAccount, $iStorageType, $sKey);
	}

	public function IsLocal() : bool
	{
		return $this->oStorage->IsLocal();
	}

	public function DeleteStorage($mAccount) : bool
	{
		return $this->oStorage->DeleteStorage($mAccount);
	}

	public function GenerateFilePath($mAccount, int $iStorageType, bool $bMkDir = false) : string
	{
		return $this->oStorage->GenerateFilePath($mAccount, $iStorageType, $bMkDir);
	}

	public function GC() : void
	{
		$this->oStorage->GC();
	}
}

/**
 * Models a legacy provider that reports Clear failure and masks subsequent
 * Get failures as absence while leaving the underlying record in place.
 */
class Sec23FailingStorage implements IStorage
{
	private \RainLoop\Providers\Storage\FileStorage $oStorage;

	public function __construct(\RainLoop\Providers\Storage\FileStorage $oStorage)
	{
		$this->oStorage = $oStorage;
	}

	public function Put($mAccount, int $iStorageType, string $sKey, string $sValue) : bool
	{
		return $this->oStorage->Put($mAccount, $iStorageType, $sKey, $sValue);
	}

	public function Get($mAccount, int $iStorageType, string $sKey, $mDefault = false)
	{
		if (StorageType::SIGN_ME === $iStorageType
			|| (StorageType::SESSION === $iStorageType && !\str_starts_with($sKey, 'auth-'))) {
			return $mDefault;
		}

		return $this->oStorage->Get($mAccount, $iStorageType, $sKey, $mDefault);
	}

	public function Clear($mAccount, int $iStorageType, string $sKey) : bool
	{
		if (StorageType::SIGN_ME === $iStorageType
			|| (StorageType::SESSION === $iStorageType && !\str_starts_with($sKey, 'auth-'))) {
			return false;
		}

		return $this->oStorage->Clear($mAccount, $iStorageType, $sKey);
	}

	public function IsLocal() : bool
	{
		return $this->oStorage->IsLocal();
	}

	public function DeleteStorage($mAccount) : bool
	{
		return $this->oStorage->DeleteStorage($mAccount);
	}

	public function GenerateFilePath($mAccount, int $iStorageType, bool $bMkDir = false) : string
	{
		return $this->oStorage->GenerateFilePath($mAccount, $iStorageType, $bMkDir);
	}

	public function GC() : void
	{
		$this->oStorage->GC();
	}
}
