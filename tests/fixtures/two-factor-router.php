<?php

require_once __DIR__ . '/backup-restore-prepend.php';

if (!class_exists('TwoFactorWakeupProbe', false)) {
	class TwoFactorWakeupProbe
	{
		public function __wakeup() : void
		{
			$sMarker = (string) \getenv('PETUJA_TEST_UNSERIALIZE_MARKER');
			if ('' !== $sMarker) {
				@\file_put_contents($sMarker, 'wakeup');
			}
		}
	}
}

$sRepositoryRoot = dirname(__DIR__, 2);
$sRequestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ('/__test/sso-hash' === $sRequestPath) {
	$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
	require $sRepositoryRoot . '/index.php';

	$sEmail = is_string($_POST['Email'] ?? null) ? $_POST['Email'] : '';
	$sPassword = is_string($_POST['Password'] ?? null) ? $_POST['Password'] : '';
	$sHash = \RainLoop\Api::CreateUserSsoHash($sEmail, $sPassword);
	header('Content-Type: application/json; charset=utf-8');
	echo json_encode(['hash' => $sHash]);
	return true;
}

$sFailStoragePath = (string) \getenv('PETUJA_TEST_FAIL_TWO_FACTOR_WRITE_FILE');
if ('' !== $sFailStoragePath && \is_file($sFailStoragePath)) {
	$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
	require $sRepositoryRoot . '/index.php';
	require_once __DIR__ . '/two-factor-storage-failure.php';

	$oActions = \RainLoop\Api::Actions();
	foreach (array('oStorageProvider' => false, 'oLocalStorageProvider' => true) as $sProperty => $bLocal) {
		$oDriver = new \TestFailingTwoFactorFileStorage(APP_PRIVATE_DATA . 'storage', $bLocal);
		$oDriver->SetLogger($oActions->Logger());
		(new \ReflectionProperty(\RainLoop\Actions::class, $sProperty))->setValue(
			$oActions, new \RainLoop\Providers\Storage($oDriver)
		);
	}

	unset($_ENV['SNAPPYMAIL_INCLUDE_AS_API']);
	\RainLoop\Service::Handle();
	return true;
}

if ('1' === \getenv('PETUJA_TEST_SEC23_STORAGE')) {
	$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
	require $sRepositoryRoot . '/index.php';
	require_once __DIR__ . '/sec23-race-plugin/storage.php';

	$oActions = \RainLoop\Api::Actions();
	foreach (array('oStorageProvider' => false, 'oLocalStorageProvider' => true) as $sProperty => $bLocal) {
		$oFileStorage = new \RainLoop\Providers\Storage\FileStorage(APP_PRIVATE_DATA . 'storage', $bLocal);
		$oDriver = '1' === \getenv('PETUJA_TEST_STORAGE_FAIL_REVOCATION')
			? new \Sec23FailingStorage($oFileStorage)
			: ('1' === \getenv('PETUJA_TEST_STORAGE_UNSUPPORTED_LOCK')
				? new \Sec23UnlockedStorage($oFileStorage)
				: new \Sec23BarrierStorage(APP_PRIVATE_DATA . 'storage', $bLocal));
		if (\method_exists($oDriver, 'SetLogger')) {
			$oDriver->SetLogger($oActions->Logger());
		}
		(new \ReflectionProperty(\RainLoop\Actions::class, $sProperty))->setValue(
			$oActions, new \RainLoop\Providers\Storage($oDriver)
		);
	}

	unset($_ENV['SNAPPYMAIL_INCLUDE_AS_API']);
	\RainLoop\Service::Handle();
	return true;
}

unset($_ENV['SNAPPYMAIL_INCLUDE_AS_API']);
require $sRepositoryRoot . '/index.php';
