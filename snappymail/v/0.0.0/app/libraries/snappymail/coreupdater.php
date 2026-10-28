<?php

namespace SnappyMail;

/**
 * Core release checker, downloader, and installer.
 */
class CoreUpdater
{
	private $oTransport;

	public function __construct(?RepositoryTransport $oTransport = null)
	{
		$this->oTransport = $oTransport ?: new RepositoryTransport();
	}

	/**
	 * return object
			$info->version
			$info->file
			$info->warnings
	 */
	public function getLatestCoreInfo()
	{
		\RainLoop\Api::Actions()->IsAdminLoggined();
		$sRep = $this->oTransport->get('core.json');
		if (!$sRep) {
			return null;
		}

		$info = \json_decode($sRep, false, 3, JSON_THROW_ON_ERROR);
		if (!\is_object($info) || !isset($info->version, $info->file)
			|| !\is_string($info->version) || !\strlen($info->version)
			|| !\is_string($info->file) || !\strlen($info->file))
		{
			throw new \UnexpectedValueException('Malformed Core repository metadata');
		}
		return $info;
	}

	public function downloadCore() : ?string
	{
		$info = $this->getLatestCoreInfo();
		return ($info && \version_compare(APP_VERSION, $info->version, '<'))
			? $this->oTransport->download($info->file)
			: null;
	}

	public function canUpdateCore() : bool
	{
		return \version_compare(APP_VERSION, '2.0', '>')
			&& \is_writable(\dirname(APP_VERSION_ROOT_PATH))
			&& \is_writable(APP_INDEX_ROOT_PATH . 'index.php')
			&& \RainLoop\Api::Config()->Get('admin_panel', 'allow_update', false);
	}

	public function update() : bool
	{
		$bResult = false;
		if ($this->canUpdateCore()) {
			$sTmp = null;
			try {
				Upgrade::backup();

				$sTmp = $this->downloadCore();
				if (!$sTmp) {
					throw new \Exception('Failed to download latest SnappyMail');
				}

				$bResult = CoreReleaseArchive::install($sTmp);
			} finally {
				$sTmp && \unlink($sTmp);
			}
		}
		return $bResult;
	}
}
