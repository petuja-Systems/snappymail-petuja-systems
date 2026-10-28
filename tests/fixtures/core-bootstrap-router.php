<?php

$dataPath = rtrim($argv[1], '\\/').DIRECTORY_SEPARATOR;
$indexRoot = rtrim($argv[2], '\\/').DIRECTORY_SEPARATOR;
define('APP_DATA_FOLDER_PATH', $dataPath);
define('APP_INDEX_ROOT_PATH', $indexRoot);
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';

require $argv[3];

$pluginDirectories = glob(APP_PRIVATE_DATA.'plugins/*', GLOB_ONLYDIR) ?: [];
$pluginDirectories = array_map('basename', $pluginDirectories);
sort($pluginDirectories);
echo json_encode([
	'ready' => true,
	'api_mode' => !empty($_ENV['SNAPPYMAIL_INCLUDE_AS_API']),
	'installed_version' => trim(file_get_contents(APP_DATA_FOLDER_PATH.'INSTALLED')),
	'plugin_directories' => $pluginDirectories
]);
