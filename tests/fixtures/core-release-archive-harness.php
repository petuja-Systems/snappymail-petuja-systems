<?php

namespace SnappyMail {
	class Upgrade
	{
		public static function fixPermissions() : void {}
	}
}

namespace {
	$action = $argv[1];
	$archive = $argv[2];
	$target = $argv[3];
	\define('APP_INDEX_ROOT_PATH', $target . DIRECTORY_SEPARATOR);
	$libraries = \realpath(__DIR__ . '/../../snappymail/v/0.0.0/app/libraries');
	\set_include_path($libraries . PATH_SEPARATOR . \get_include_path());
	\spl_autoload_extensions('.php');
	\spl_autoload_register();

	try {
		if ('fallback' === $action) {
			$result = \SnappyMail\CoreReleaseTarExtractor::extract($archive);
		} else {
			$result = \SnappyMail\CoreReleaseArchive::install($archive);
		}
		echo \json_encode(array('ok' => $result));
	} catch (\Throwable $e) {
		echo \json_encode(array('ok' => false, 'error' => $e->getMessage()));
	}
}
