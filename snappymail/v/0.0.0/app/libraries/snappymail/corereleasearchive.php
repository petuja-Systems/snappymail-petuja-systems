<?php

namespace SnappyMail;

/**
 * Installs files from a downloaded Core release archive.
 */
class CoreReleaseArchive
{
	public static function install(string $archive) : bool
	{
		$oArchive = null;
		if (\class_exists('PharData')) {
			$oArchive = new \PharData($archive, 0, null, \Phar::GZ);
		}

		$target = \rtrim(APP_INDEX_ROOT_PATH, '\\/');
		\umask(0022);
		\error_log('Extract to ' . $target);
		$bResult = $oArchive
			? ($oArchive->extractTo($target, 'snappymail/')
				&& $oArchive->extractTo($target, 'index.php', true))
			: CoreReleaseTarExtractor::extract($archive);

		if (!$bResult) {
			throw new \Exception('Extract core files failed');
		}

		Upgrade::fixPermissions();

		\error_log('Update success');
		// opcache_reset is a terrible solution
//		\is_callable('opcache_reset') && \opcache_reset();
		\is_callable('opcache_invalidate') && \opcache_invalidate($target.'/index.php', true);
		return $bResult;
	}
}
