<?php

$sDataPath = getenv('PETUJA_TEST_DATA_PATH');
if (!$sDataPath) {
	throw new \RuntimeException('PETUJA_TEST_DATA_PATH is required');
}

define('APP_DATA_FOLDER_PATH', rtrim($sDataPath, '\\/') . DIRECTORY_SEPARATOR);
