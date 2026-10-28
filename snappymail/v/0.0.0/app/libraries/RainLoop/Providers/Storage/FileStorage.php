<?php

namespace RainLoop\Providers\Storage;

use RainLoop\Providers\Storage\Enumerations\StorageType;

class FileStorage implements \RainLoop\Providers\Storage\IStorage, \RainLoop\Providers\Storage\ILockingStorage, \RainLoop\Providers\Storage\IRevocationStorage
{
	use \MailSo\Log\Inherit;

	protected string $sDataPath;

	private bool $bLocal;

	public function __construct(string $sStoragePath, bool $bLocal = false)
	{
		$this->sDataPath = \rtrim(\trim($sStoragePath), '\\/');
		$this->bLocal = $bLocal;
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function Put($mAccount, int $iStorageType, string $sKey, string $sValue) : bool
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($mAccount, $iStorageType, $sKey, $sValue) {
			$sFileName = $this->generateFileName($mAccount, $iStorageType, $sKey, true);
			if (!$sFileName) {
				return false;
			}
			try {
				\RainLoop\Utils::saveFile($sFileName, $sValue);
				return true;
			} catch (\Throwable $e) {
				\SnappyMail\Log::warning('FileStorage', $e->getMessage());
			}
			return false;
		});
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @param mixed $mDefault = false
	 *
	 * @return mixed
	 */
	public function Get($mAccount, int $iStorageType, string $sKey, $mDefault = false)
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($mAccount, $iStorageType, $sKey, $mDefault) {
			$mValue = false;
			$sFileName = $this->generateFileName($mAccount, $iStorageType, $sKey);
			if ($sFileName && \file_exists($sFileName)) {
				$mValue = \file_get_contents($sFileName);
				// Update mtime to prevent garbage collection
				if (StorageType::SESSION === $iStorageType) {
					\touch($sFileName);
				}
			}
			return false === $mValue ? $mDefault : $mValue;
		});
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function Clear($mAccount, int $iStorageType, string $sKey) : bool
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($mAccount, $iStorageType, $sKey) {
			$sFileName = $this->generateFileName($mAccount, $iStorageType, $sKey);
			return $sFileName && \file_exists($sFileName) && \unlink($sFileName);
		});
	}

	/**
	 * Inspect an exact record while distinguishing an absent entry from a
	 * directory or file I/O failure.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @param mixed $mValue
	 */
	public function Inspect($mAccount, int $iStorageType, string $sKey, &$mValue) : ?bool
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($mAccount, $iStorageType, $sKey, &$mValue) {
			$sFileName = $this->generateFileName($mAccount, $iStorageType, $sKey);
			if (!$sFileName) {
				$mValue = false;
				return null;
			}

			$bExists = $this->checkedFileExists($sFileName);
			if (null === $bExists) {
				$mValue = false;
				return null;
			}
			if (!$bExists) {
				$mValue = false;
				return false;
			}

			$mValue = @\file_get_contents($sFileName);
			return false === $mValue ? null : true;
		});
	}

	/**
	 * Delete an exact record. A failed unlink is considered absent only when its
	 * parent path remains inspectable and the entry is confirmed missing.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function Revoke($mAccount, int $iStorageType, string $sKey) : ?bool
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($mAccount, $iStorageType, $sKey) {
			$sFileName = $this->generateFileName($mAccount, $iStorageType, $sKey);
			if (!$sFileName) {
				return null;
			}

			if (@\unlink($sFileName)) {
				return true;
			}

			return false === $this->checkedFileExists($sFileName) ? false : null;
		});
	}

	/**
	 * Check a file path by walking only its directory components. If a parent
	 * cannot be listed or traversed, absence is unknown rather than confirmed.
	 */
	private function checkedFileExists(string $sFileName) : ?bool
	{
		$sParent = \realpath(\dirname($this->sDataPath));
		if (false === $sParent) {
			return null;
		}
		$sRoot = $sParent.'/'.\basename($this->sDataPath);
		if (0 === \strpos($sFileName, $sRoot.'-v2/')) {
			$sRoot .= '-v2';
		}
		$sPrefix = $sRoot.'/';
		if (0 !== \strpos($sFileName, $sPrefix)) {
			return null;
		}
		if (!\is_dir($sRoot)) {
			$sParent = \dirname($sRoot);
			if (!\file_exists($sRoot) && !\is_link($sRoot)
				&& $this->isAccessibleDirectory($sParent)) {
				return false;
			}
			return null;
		}

		$aParts = \explode('/', \substr($sFileName, \strlen($sPrefix)));
		if (!$aParts || \in_array('', $aParts, true) || \in_array('.', $aParts, true) || \in_array('..', $aParts, true)) {
			return null;
		}

		$sDirectory = $sRoot;
		$iLast = \count($aParts) - 1;
		foreach ($aParts as $iIndex => $sPart) {
			if (!$this->isAccessibleDirectory($sDirectory)) {
				return null;
			}

			$sNextPath = $sDirectory.'/'.$sPart;
			if (!\file_exists($sNextPath) && !\is_link($sNextPath)) {
				return false;
			}

			if ($iIndex < $iLast) {
				if (!\is_dir($sNextPath)) {
					return null;
				}
				$sDirectory = $sNextPath;
			}
		}

		return true;
	}

	private function isAccessibleDirectory(string $sDirectory) : bool
	{
		return \is_dir($sDirectory)
			&& \is_readable($sDirectory)
			&& ('\\' === DIRECTORY_SEPARATOR || \is_executable($sDirectory));
	}

	/**
	 * Return the lock file path for an account root. The lock lives outside the
	 * account tree so GC and DeleteStorage cannot unlink an inode while locked.
	 */
	private function accountLockFilePath(string $sAccountRoot) : string
	{
		$sLockDirectory = $this->sDataPath.'/.signme-locks';
		if (!\is_dir($sLockDirectory)) {
			@mkdir($sLockDirectory, 0700, true);
		}
		if (!\is_dir($sLockDirectory)) {
			return '';
		}
		@\chmod($sLockDirectory, 0700);

		return $sLockDirectory.'/'.\hash('sha256', \rtrim($sAccountRoot, '\\/')).'.lock';
	}

	/**
	 * Acquire the stable account lock shared by SignMe mutations, GC, and
	 * account storage deletion.
	 *
	 * @return mixed
	 */
	private function acquireAccountLockForRoot(string $sAccountRoot)
	{
		$sLockFile = $this->accountLockFilePath($sAccountRoot);
		if (!$sLockFile) {
			return false;
		}

		try {
			$mLock = @\fopen($sLockFile, 'c');
			if (\is_resource($mLock)) {
				@\chmod($sLockFile, 0600);
				if (@\flock($mLock, LOCK_EX)) {
					return $mLock;
				}
				@\fclose($mLock);
			}
		} catch (\Throwable $e) {
			\SnappyMail\Log::warning('FileStorage', $e->getMessage());
		}

		return false;
	}

	/**
	 * SignMe mutations are serialized per account.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @return mixed
	 */
	public function AcquireLock($mAccount, int $iStorageType, string $sKey)
	{
		if (StorageType::SIGN_ME !== $iStorageType) {
			return false;
		}

		$sMain = $mAccount instanceof \RainLoop\Model\AdditionalAccount ? $mAccount->ParentEmail()
			: ($mAccount instanceof \RainLoop\Model\Account ? $mAccount->Email() : $mAccount);
		$sAccountRoot = (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Resolve($sMain, '', 'delete-storage' === $sKey,
			$mAccount instanceof \RainLoop\Model\Account && 'delete-storage' !== $sKey);
		return \is_dir($sAccountRoot) ? $this->acquireAccountLockForRoot($sAccountRoot) : false;
	}

	/**
	 * @param mixed $mLock
	 */
	public function ReleaseLock($mLock) : void
	{
		if (\is_resource($mLock)) {
			@\flock($mLock, LOCK_UN);
			@\fclose($mLock);
		}
	}

	/**
	 * @param \RainLoop\Model\Account|string $mAccount
	 */
	public function DeleteStorage($mAccount) : bool
	{
		$mLock = $this->AcquireLock($mAccount, StorageType::SIGN_ME, 'delete-storage');
		if (!$mLock) {
			return false;
		}

		try {
			$sMain = $mAccount instanceof \RainLoop\Model\AdditionalAccount ? $mAccount->ParentEmail()
				: ($mAccount instanceof \RainLoop\Model\Account ? $mAccount->Email() : $mAccount);
			$sChild = $this->bLocal && $mAccount instanceof \RainLoop\Model\AdditionalAccount ? $mAccount->Email() : '';
			return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Delete($sMain, $sChild);
		} finally {
			$this->ReleaseLock($mLock);
		}
	}

	public function IsLocal() : bool
	{
		return $this->bLocal;
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function GenerateFilePath($mAccount, int $iStorageType, bool $bMkDir = false) : string
	{
		$sEmail = $sSubFolder = $sFilePath = '';
		if (null === $mAccount || StorageType::NOBODY === $iStorageType) {
			$sFilePath = $this->sDataPath.'/__nobody__/';
		} else {
			if ($mAccount instanceof \RainLoop\Model\MainAccount) {
				$sEmail = $mAccount->Email();
			} else if ($mAccount instanceof \RainLoop\Model\AdditionalAccount) {
				$sEmail = $mAccount->ParentEmail();
				if ($this->bLocal) {
					$sSubFolder = $mAccount->Email();
				}
			} else if (\is_string($mAccount)) {
				$sEmail = $mAccount;
			}

			if ($sEmail) {
				// these are never local
				if (StorageType::SIGN_ME === $iStorageType) {
					$sSubFolder = '.sign_me';
				} else if (StorageType::SESSION === $iStorageType) {
					$sSubFolder = '.sessions';
				} else if (StorageType::PGP === $iStorageType) {
					$sSubFolder = '.pgp';
				} else if (StorageType::ROOT === $iStorageType) {
					$sSubFolder = '';
				}
			}

			switch ($iStorageType)
			{
				case StorageType::CONFIG:
				case StorageType::SIGN_ME:
				case StorageType::SESSION:
				case StorageType::PGP:
				case StorageType::ROOT:
					if (empty($sEmail)) {
						return '';
					}
					$sChild = $sSubFolder && !\in_array($sSubFolder, ['.sign_me', '.sessions', '.pgp'], true) ? $sSubFolder : '';
					$sFilePath = (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Resolve($sEmail, $sChild, false, $bMkDir);
					if ($sSubFolder && !$sChild) {
						$sFilePath .= $sSubFolder.'/';
					}
					break;
				default:
					throw new \Exception("Invalid storage type {$iStorageType}");
			}
		}

		$bMkDir && !empty($sFilePath) && \MailSo\Base\Utils::mkdir($sFilePath);

		return $sFilePath;
	}

	/**
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	protected function generateFileName($mAccount, int $iStorageType, string $sKey, bool $bMkDir = false) : string
	{
		$sFilePath = $this->GenerateFilePath($mAccount, $iStorageType, $bMkDir);
		if ($sFilePath) {
			if (StorageType::NOBODY === $iStorageType) {
				$sFilePath .= \sha1($sKey ?: \time());
			} else {
				$sFilePath .= ($sKey ? \MailSo\Base\Utils::SecureFileName($sKey) : '');
			}
			if ($sKey || StorageType::NOBODY === $iStorageType) {
				(new \SnappyMail\Storage\AccountPath($this->sDataPath))->CheckFile($sFilePath, $bMkDir);
			}
		}
		return $sFilePath;
	}

	public function GC() : void
	{
		foreach ((new \SnappyMail\Storage\AccountPath($this->sDataPath))->Owned() as $owner) {
			$mLock = $this->acquireAccountLockForRoot($owner['path']);
			if (!$mLock) {
				throw new \RuntimeException('Account storage GC lock unavailable');
			}
			try {
				// Resolve again after acquiring the same lock used by deletion.
				$sRoot = (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Resolve($owner['identity']);
				(new \SnappyMail\Storage\AccountPath($this->sDataPath))->Collect($sRoot.'.sign_me', 3600 * 24 * 30);
				(new \SnappyMail\Storage\AccountPath($this->sDataPath))->Collect($sRoot.'.sessions', 3600 * 3);
			} finally {
				$this->ReleaseLock($mLock);
			}
		}
	}
}
