<?php

namespace RainLoop {
	class CoreUpdaterFixtureActions
	{
		public $adminChecks = 0;

		public function IsAdminLoggined() : void
		{
			++$this->adminChecks;
		}
	}

	class CoreUpdaterFixtureConfig
	{
		public function Get($section, $key, $default = null)
		{
			if ('admin_panel' === $section && 'allow_update' === $key) {
				return '1' === \getenv('PETUJA_TEST_CORE_ALLOW_UPDATE');
			}
			if ('labs' === $section && 'curl_proxy' === $key) {
				return \getenv('PETUJA_TEST_CORE_PROXY') ?: $default;
			}
			if ('labs' === $section && 'curl_proxy_auth' === $key) {
				return \getenv('PETUJA_TEST_CORE_PROXY_AUTH') ?: $default;
			}
			return $default;
		}
	}

	class Api
	{
		private static $actions;
		private static $config;

		public static function Actions() : CoreUpdaterFixtureActions
		{
			return self::$actions ?: (self::$actions = new CoreUpdaterFixtureActions());
		}

		public static function Config() : CoreUpdaterFixtureConfig
		{
			return self::$config ?: (self::$config = new CoreUpdaterFixtureConfig());
		}
	}
}

namespace {
	$sRoot = \dirname(__DIR__, 2);
	$sLibraries = $sRoot . '/snappymail/v/0.0.0/app/libraries/';
	$sTestRoot = \getenv('PETUJA_TEST_CORE_ROOT');
	$sPrivateData = \getenv('PETUJA_TEST_CORE_PRIVATE_DATA');

	\define('APP_VERSION', \getenv('PETUJA_TEST_CORE_VERSION') ?: '2.38.2');
	\define('APP_VERSION_ROOT_PATH', $sTestRoot . '/snappymail/v/2.38.2/');
	\define('APP_INDEX_ROOT_PATH', $sTestRoot . '/application/');
	\define('APP_PRIVATE_DATA', \rtrim($sPrivateData, '\\/') . DIRECTORY_SEPARATOR);

	\spl_autoload_register(static function($class) use ($sLibraries) {
		$file = $sLibraries . \strtolower(\strtr($class, '\\', DIRECTORY_SEPARATOR)) . '.php';
		if (\is_file($file)) {
			require_once $file;
		}
	});

	$oUpdater = new \SnappyMail\CoreUpdater(
		new \SnappyMail\RepositoryTransport(\getenv('PETUJA_TEST_CORE_BASE_URL'))
	);
	$aResult = [];
	try {
		switch ($argv[1] ?? '') {
			case 'info':
				$info = $oUpdater->getLatestCoreInfo();
				$aResult = [
					'ok' => true,
					'version' => $info->version,
					'file' => $info->file,
					'warnings' => $info->warnings ?? [],
					'can_update' => $oUpdater->canUpdateCore(),
					'admin_checks' => \RainLoop\Api::Actions()->adminChecks
				];
				break;

			case 'download':
				$file = $oUpdater->downloadCore();
				$aResult = [
					'ok' => true,
					'downloaded' => $file ? \base64_encode(\file_get_contents($file)) : null,
					'admin_checks' => \RainLoop\Api::Actions()->adminChecks
				];
				if ($file) {
					\unlink($file);
				}
				break;

			case 'gate':
				$aResult = ['ok' => true, 'can_update' => $oUpdater->canUpdateCore()];
				break;

			default:
				throw new \InvalidArgumentException('Unknown fixture operation');
		}
	} catch (\Throwable $e) {
		$aResult = [
			'ok' => false,
			'error_class' => \get_class($e),
			'error_code' => $e->getCode(),
			'error' => $e->getMessage()
		];
	}

	$aResult['private_files'] = \array_values(\array_map('basename', \glob(APP_PRIVATE_DATA . '*') ?: []));
	\header('Content-Type: application/json');
	echo \json_encode($aResult, JSON_THROW_ON_ERROR);
}
