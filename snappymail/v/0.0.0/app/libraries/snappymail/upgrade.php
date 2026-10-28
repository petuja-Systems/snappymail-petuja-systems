<?php

namespace SnappyMail;

use RainLoop\Providers\Storage\Enumerations\StorageType;

abstract class Upgrade
{

	public static function FileStorage(string $sDataPath)
	{
		throw new \RuntimeException('Legacy account storage requires an offline authoritative ownership map');
	}

	/**
	 * Attempt to convert the old less secure data into better secured data
	 */
	public static function ConvertInsecureAccounts(\RainLoop\Actions $oActions, \RainLoop\Model\MainAccount $oMainAccount) : array
	{
		$oStorage = $oActions->StorageProvider();
		$sAccounts = $oStorage->Get($oMainAccount, StorageType::CONFIG, 'accounts');
		if (!$sAccounts || '{' !== $sAccounts[0]) {
			return [];
		}

		$aAccounts = \json_decode($sAccounts, true);
		if (!$aAccounts || !\is_array($aAccounts)) {
			return [];
		}

		$aNewAccounts = [];
		if (1 < \count($aAccounts)) {
			$sOrder = $oStorage->Get($oMainAccount, StorageType::CONFIG, 'accounts_identities_order');
			$aOrder = $sOrder ? \json_decode($sOrder, true) : [];
			if (!empty($aOrder['Accounts']) && \is_array($aOrder['Accounts']) && 1 < \count($aOrder['Accounts'])) {
				$aAccounts = \array_filter(\array_merge(
					\array_fill_keys($aOrder['Accounts'], null),
					$aAccounts
				));
			}
			$sHash = $oMainAccount->CryptKey();
			foreach ($aAccounts as $sEmail => $sToken) {
				if ($oMainAccount->Email() == $sEmail) {
					continue;
				}
				try {
					$aNewAccounts[$sEmail] = [
						'email' => $sEmail,
						'login' => $sEmail,
						'pass' => '',
						'hmac' => \hash_hmac('sha1', '', $sHash)
					];
					if (!$sToken) {
						\SnappyMail\Log::warning('UPGRADE', "ConvertInsecureAccount {$sEmail} no token");
						continue;
					}
					$aAccountHash = static::DecodeKeyValues($sToken);
					if (empty($aAccountHash[0]) || 'token' !== $aAccountHash[0] // simple token validation
						|| 8 > \count($aAccountHash) // length checking
					) {
						\SnappyMail\Log::warning('UPGRADE', "ConvertInsecureAccount {$sEmail} invalid aAccountHash: " . \print_r($aAccountHash,1));
						continue;
					}
					$aAccountHash[3] = Crypt::EncryptUrlSafe($aAccountHash[3], $sHash);
					$aNewAccounts[$sEmail] = [
						'email' => $aAccountHash[1],
						'login' => $aAccountHash[2],
						'pass' => $aAccountHash[3],
						'hmac' => \hash_hmac('sha1', $aAccountHash[3], $sHash)
					];
				} catch (\Throwable $e) {
					\SnappyMail\Log::warning('UPGRADE', "ConvertInsecureAccount {$sEmail} failed");
				}
			}

			$oActions->SetAccounts($oMainAccount, $aNewAccounts);
		}

		$oStorage->Clear($oMainAccount, StorageType::CONFIG, 'accounts');

		return $aNewAccounts;
	}

	/**
	 * Attempt to convert the old less secure data into better secured data
	 */
	public static function ConvertInsecureContactsSync(\RainLoop\Actions $oActions, \RainLoop\Model\Account $oAccount) : ?array
	{
		$sData = $oActions->StorageProvider()->Get($oAccount,
			\RainLoop\Providers\Storage\Enumerations\StorageType::CONFIG,
			'contacts_sync'
		);

		if (!empty($sData)) {
			$aData = \json_decode($sData, true);
			if (!$aData) {
				$aData = static::DecodeKeyValues($sData);
				if ($aData) {
					$aData = array(
						'Mode' => empty($aData['Enable']) ? 0 : 1,
						'Url' => isset($aData['Url']) ? \trim($aData['Url']) : '',
						'User' => isset($aData['User']) ? \trim($aData['User']) : '',
						'Password' => isset($aData['Password']) ? $aData['Password'] : ''
					);
					$oActions->setContactsSyncData($oAccount, $aData);
					return $aData;
				}
			}
		}
		return null;
	}

	/**
	 * Decodes old less secure data
	 */
	private static function DecodeKeyValues(string $sData) : array
	{
		$sData = \MailSo\Base\Utils::UrlSafeBase64Decode($sData);
		if (!\strlen($sData)) {
			return '';
		}
		$sKey = \md5(APP_SALT);
		$sData = \is_callable('xxtea_decrypt')
			? \xxtea_decrypt($sData, $sKey)
			: \MailSo\Base\Xxtea::decrypt($sData, $sKey);
		try {
			return \json_decode($sData, true, 512, JSON_THROW_ON_ERROR) ?: array();
		} catch (\Throwable $e) {
			return \unserialize($sData) ?: array();
		}
	}

	public static function backup() : string
	{
//		$tar_destination = APP_DATA_FOLDER_PATH . APP_VERSION . '.tar';
		$tar_destination = APP_DATA_FOLDER_PATH . 'backup-' . \date('YmdHis');
		if (\class_exists('PharData')) {
			$tar_destination .= '.tar';
			$tar = new \PharData($tar_destination);
		} else {
			$tar_destination .= '.tgz';
			$tar = new \SnappyMail\Stream\TAR($tar_destination);
		}
		$files = new \RecursiveIteratorIterator(
			new \RecursiveDirectoryIterator(APP_DATA_FOLDER_PATH . '_data_'),
			\RecursiveIteratorIterator::SELF_FIRST
		);
		$l = \strlen(APP_DATA_FOLDER_PATH);
		foreach ($files as $file) {
			$file = \str_replace('\\', '/', $file);
			if (\is_file($file) && !\strpos($file, '/cache/')) {
				$tar->addFile($file, \substr($file, $l));
			}
		}
		if ($tar instanceof \SnappyMail\Stream\TAR) {
			return $tar_destination;
		}
		$tar->compress(\Phar::GZ);
		\unlink($tar_destination);
		return $tar_destination . '.gz';
	}

	// Prevents Apache access error due to directories being 0700
	public static function fixPermissions($mode = 0755) : void
	{
		\clearstatcache(true);
		\umask(0022);
		$target = \rtrim(APP_INDEX_ROOT_PATH, '\\/');
		// Prevent Apache access error due to directories being 0700
		foreach (\glob("{$target}/snappymail/v/*", \GLOB_ONLYDIR) as $dir) {
			\chmod($dir, 0755);
			foreach (['static','themes'] as $folder) {
				$path = "{$dir}/{$folder}";
				if (!\is_dir($path)) {
					continue;
				}
				\chmod($path, 0755);
				$iterator = new \RecursiveIteratorIterator(
					new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS),
					\RecursiveIteratorIterator::SELF_FIRST
				);
				foreach ($iterator as $item) {
					if ($item->isDir()) {
						\chmod($item, 0755);
					} else if ($item->isFile()) {
						\chmod($item, 0644);
					}
				}
			}
		}
	}

}
