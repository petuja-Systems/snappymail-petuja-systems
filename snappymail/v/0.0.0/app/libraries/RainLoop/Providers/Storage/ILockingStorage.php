<?php

namespace RainLoop\Providers\Storage;

interface ILockingStorage
{
	/**
	 * Acquire an exclusive lock for a storage key. For SIGN_ME, implementations
	 * must map all keys for one account to the same lock and use it when
	 * DeleteStorage or GC removes that account's SignMe records. Authentication
	 * and two-factor lifecycle code also use that account lock to serialize
	 * Remember-Me redemption with factor state and replay-counter mutations.
	 *
	 * The returned value is an opaque lock handle to pass to ReleaseLock().
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @return mixed
	 */
	public function AcquireLock($mAccount, int $iStorageType, string $sKey);

	/**
	 * @param mixed $mLock
	 */
	public function ReleaseLock($mLock) : void;
}
