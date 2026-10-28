<?php

namespace RainLoop\Providers;

class Storage extends \RainLoop\Providers\AbstractProvider
{
	/**
	 * @var \RainLoop\Providers\Storage\IStorage
	 */
	private $oDriver;

	public function __construct(\RainLoop\Providers\Storage\IStorage $oDriver)
	{
		$this->oDriver = $oDriver;
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	private function verifyAccount($mAccount, int $iStorageType) : bool
	{
		return \RainLoop\Providers\Storage\Enumerations\StorageType::NOBODY === $iStorageType
			|| $mAccount instanceof \RainLoop\Model\Account
			|| \is_string($mAccount);
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @param mixed $sValue
	 */
	public function Put($mAccount, int $iStorageType, string $sKey, string $sValue) : bool
	{
		return $this->verifyAccount($mAccount, $iStorageType)
			? $this->oDriver->Put($mAccount, $iStorageType, $sKey, $sValue)
			: false;
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @param mixed $mDefault = false
	 *
	 * @return mixed
	 */
	public function Get($mAccount, int $iStorageType, string $sKey, $mDefault = false)
	{
		return $this->verifyAccount($mAccount, $iStorageType)
			? $this->oDriver->Get($mAccount, $iStorageType, $sKey, $mDefault)
			: $mDefault;
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function Clear($mAccount, int $iStorageType, string $sKey) : bool
	{
		return $this->verifyAccount($mAccount, $iStorageType)
			? $this->oDriver->Clear($mAccount, $iStorageType, $sKey)
			: false;
	}

	/**
	 * Read an exact record for security-sensitive revocation decisions.
	 * Legacy drivers can establish presence through Get(), but cannot establish
	 * absence because IStorage::Get() also returns false for some I/O failures.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @param mixed $mValue
	 */
	public function Inspect($mAccount, int $iStorageType, string $sKey, &$mValue) : ?bool
	{
		if (!$this->verifyAccount($mAccount, $iStorageType)) {
			$mValue = false;
			return null;
		}

		if ($this->oDriver instanceof \RainLoop\Providers\Storage\IRevocationStorage) {
			return $this->oDriver->Inspect($mAccount, $iStorageType, $sKey, $mValue);
		}

		$mValue = $this->oDriver->Get($mAccount, $iStorageType, $sKey);
		return \is_string($mValue) ? true : null;
	}

	/**
	 * Remove an exact record. A legacy Clear(false) is unresolved, not evidence
	 * that the record was already absent.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function Revoke($mAccount, int $iStorageType, string $sKey) : ?bool
	{
		if (!$this->verifyAccount($mAccount, $iStorageType)) {
			return null;
		}

		if ($this->oDriver instanceof \RainLoop\Providers\Storage\IRevocationStorage) {
			return $this->oDriver->Revoke($mAccount, $iStorageType, $sKey);
		}

		return $this->oDriver->Clear($mAccount, $iStorageType, $sKey) ? true : null;
	}

	/**
	 * Locking is an optional storage capability. Callers that require it must
	 * fail closed when an installed driver does not provide this interface.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @return mixed
	 */
	public function AcquireLock($mAccount, int $iStorageType, string $sKey)
	{
		return $this->verifyAccount($mAccount, $iStorageType)
			&& $this->oDriver instanceof \RainLoop\Providers\Storage\ILockingStorage
			? $this->oDriver->AcquireLock($mAccount, $iStorageType, $sKey)
			: false;
	}

	public function SupportsLocking() : bool
	{
		return $this->oDriver instanceof \RainLoop\Providers\Storage\ILockingStorage;
	}

	/**
	 * @param mixed $mLock
	 */
	public function ReleaseLock($mLock) : void
	{
		if ($this->oDriver instanceof \RainLoop\Providers\Storage\ILockingStorage) {
			$this->oDriver->ReleaseLock($mLock);
		}
	}

	/**
	 * @param \RainLoop\Model\Account|string $mAccount
	 */
	public function DeleteStorage($mAccount) : bool
	{
		return $this->oDriver->DeleteStorage($mAccount);
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function GenerateFilePath($mAccount, int $iStorageType, bool $bMkDir = false) : string
	{
		return $this->oDriver->GenerateFilePath($mAccount, $iStorageType, $bMkDir);
	}

	public function IsActive() : bool
	{
		return true;
	}

	public function IsLocal() : bool
	{
		return $this->oDriver->IsLocal();
	}

	public function GC() : void
	{
		$this->oDriver->GC();
	}
}
