<?php

namespace RainLoop\Providers\Files;

class FileStorage implements \RainLoop\Providers\Files\IFiles
{
	/**
	 * @var array
	 */
	private $aResources;

	/**
	 * @var string
	 */
	private $sDataPath;

	public function __construct(string $sStoragePath)
	{
		$this->aResources = array();
		$this->sDataPath = \rtrim(\trim($sStoragePath), '\\/');
	}

	public function GenerateLocalFullFileName(\RainLoop\Model\Account $oAccount, string $sKey) : string
	{
		return $this->generateFullFileName($oAccount, $sKey, true);
	}

	public function PutFile(\RainLoop\Model\Account $oAccount, string $sKey, /*resource*/ $rSource) : bool
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($oAccount, $sKey, $rSource) {
			$bResult = false;
			if ($rSource) {
				$rOpenOutput = \fopen($this->generateFullFileName($oAccount, $sKey, true), 'w+b');
				if ($rOpenOutput) {
					$bResult = (false !== \MailSo\Base\Utils::WriteStream($rSource, $rOpenOutput));
					\fclose($rOpenOutput);
				}
			}
			return $bResult;
		});
	}

	public function MoveUploadedFile(\RainLoop\Model\Account $oAccount, string $sKey, string $sSource) : bool
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($oAccount, $sKey, $sSource) {
			$sFileName = $this->generateFullFileName($oAccount, $sKey, true);
			if ('Windows' !== PHP_OS_FAMILY) {
				return \move_uploaded_file($sSource, $sFileName);
			}

			// Moving a PHP upload temp file can preserve its broader temp-directory
			// ACL. Create the stored file under the already-verified private parent.
			if (!\is_uploaded_file($sSource)) {
				return false;
			}

			$rSource = \fopen($sSource, 'rb');
			if (!$rSource) {
				return false;
			}

			$rTarget = null;
			$bCreated = false;
			$bStored = false;
			try {
				$rTarget = \fopen($sFileName, 'x+b');
				if (!$rTarget) {
					return false;
				}
				$bCreated = true;
				if (!\chmod($sFileName, 0600)) {
					return false;
				}

				$iCopied = \stream_copy_to_stream($rSource, $rTarget);
				if (false === $iCopied || !\fflush($rTarget)) {
					return false;
				}

				\fclose($rSource);
				$rSource = null;
				\fclose($rTarget);
				$rTarget = null;
				(new \SnappyMail\Storage\AccountPath($this->sDataPath))->CheckFile($sFileName);
				if (!\unlink($sSource)) {
					return false;
				}

				$bStored = true;
				return true;
			} finally {
				if (\is_resource($rSource)) {
					\fclose($rSource);
				}
				if (\is_resource($rTarget)) {
					\fclose($rTarget);
				}
				if (!$bStored && $bCreated && (\file_exists($sFileName) || \is_link($sFileName))) {
					\unlink($sFileName);
				}
			}
		});
	}

	/**
	 * @return resource|bool
	 */
	public function GetFile(\RainLoop\Model\Account $oAccount, string $sKey, string $sOpenMode = 'rb')
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($oAccount, $sKey, $sOpenMode) {
			$mResult = false;
			$bCreate = !!\preg_match('/[wac]/', $sOpenMode);

			$sFileName = $this->generateFullFileName($oAccount, $sKey, $bCreate);
			if ($bCreate || \file_exists($sFileName))
			{
				$mResult = \fopen($sFileName, $sOpenMode);

				if (\is_resource($mResult))
				{
					$this->aResources[$sFileName] = $mResult;
				}
			}

			return $mResult;
		});
	}

	public function GetFileName(\RainLoop\Model\Account $oAccount, string $sKey) /*: string|false*/
	{
		$sFileName = $this->generateFullFileName($oAccount, $sKey);
		return \file_exists($sFileName) ? $sFileName : false;
	}

	public function Clear(\RainLoop\Model\Account $oAccount, string $sKey) : bool
	{
		return (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Atomic(function () use ($oAccount, $sKey) {
			$sFileName = $this->generateFullFileName($oAccount, $sKey);
			if (\file_exists($sFileName)) {
				if (isset($this->aResources[$sFileName]) && \is_resource($this->aResources[$sFileName])) {
					\fclose($this->aResources[$sFileName]);
				}
				return \unlink($sFileName);
			}
			return false;
		});
	}

	public function FileSize(\RainLoop\Model\Account $oAccount, string $sKey) /*: int|false*/
	{
		$sFileName = $this->generateFullFileName($oAccount, $sKey);
		return \file_exists($sFileName) ? \filesize($sFileName) : false;
	}

	public function FileExists(\RainLoop\Model\Account $oAccount, string $sKey) : bool
	{
		return \file_exists($this->generateFullFileName($oAccount, $sKey));
	}

	public function GC(int $iTimeToClearInHours = 24) : bool
	{
		if (0 < $iTimeToClearInHours) {
			$iTimeToClear = 3600 * $iTimeToClearInHours;
			$oPaths = new \SnappyMail\Storage\AccountPath($this->sDataPath);
			$oLocks = new \RainLoop\Providers\Storage\FileStorage($this->sDataPath);
			foreach ($oPaths->Owned() as $owner) {
				$mLock = $oLocks->AcquireLock($owner['identity'], \RainLoop\Providers\Storage\Enumerations\StorageType::SIGN_ME, 'files-gc');
				if (!$mLock) {
					throw new \RuntimeException('Account files GC lock unavailable');
				}
				try {
					$oPaths->Resolve($owner['identity']);
					foreach (\array_merge([$owner['path']], $owner['childPaths']) as $sRoot) {
						$oPaths->Collect($sRoot.'/.files', $iTimeToClear);
					}
				} finally {
					$oLocks->ReleaseLock($mLock);
				}
			}
			return true;
		}

		return false;
	}

	public function CloseAllOpenedFiles() : bool
	{
		if (\is_array($this->aResources) && \count($this->aResources))
		{
			foreach ($this->aResources as $sFileName => $rFile)
			{
				if (!empty($sFileName) && \is_resource($rFile))
				{
					\fclose($rFile);
				}
			}
		}

		return true;
	}

	private function generateFullFileName(\RainLoop\Model\Account $oAccount, string $sKey, bool $bMkDir = false) : string
	{
		if ($oAccount instanceof \RainLoop\Model\AdditionalAccount) {
			$sEmail = $oAccount->ParentEmail();
			$sSubEmail = $oAccount->Email();
		} else {
			$sEmail = $oAccount->Email();
			$sSubEmail = '';
		}

		$sFilePath = (new \SnappyMail\Storage\AccountPath($this->sDataPath))->Resolve($sEmail, $sSubEmail, false, $bMkDir)
			.'.files/'.\sha1($sKey);

		(new \SnappyMail\Storage\AccountPath($this->sDataPath))->CheckFile($sFilePath, $bMkDir);

		return $sFilePath;
	}

}
