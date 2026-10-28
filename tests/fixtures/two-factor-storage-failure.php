<?php

class TestFailingTwoFactorFileStorage extends \RainLoop\Providers\Storage\FileStorage
{
	public function Put($mAccount, int $iStorageType, string $sKey, string $sValue) : bool
	{
		$sFlag = \getenv('PETUJA_TEST_FAIL_TWO_FACTOR_WRITE_FILE') ?: '';
		if ('' !== $sFlag
			&& \is_file($sFlag)
			&& \RainLoop\Providers\Storage\Enumerations\StorageType::CONFIG === $iStorageType
			&& 'two_factor' === $sKey) {
			return false;
		}

		return parent::Put($mAccount, $iStorageType, $sKey, $sValue);
	}
}
