#!/usr/bin/env php
<?php

// Explicit offline operator tool. Does not initialize the application or log
// identities. Ownership must come from the operator's authoritative records.
if ('cli' !== PHP_SAPI) {
	exit(1);
}
$options = getopt('', ['offline', 'storage:', 'map:', 'resume', 'reattest', 'dry-run']);
if (!isset($options['offline'], $options['storage'], $options['map'])) {
	fwrite(STDERR, "Usage: php cli/account-storage.php --offline [--dry-run] [--resume] --storage=/absolute/private/storage --map=/private/authoritative.json\n");
	exit(2);
}
if (isset($options['dry-run'], $options['reattest'])) {
	fwrite(STDERR, "Dry-run cannot be combined with re-attestation.\n");
	exit(2);
}
require dirname(__DIR__).'/snappymail/v/0.0.0/app/libraries/MailSo/Base/Utils.php';
require dirname(__DIR__).'/snappymail/v/0.0.0/app/libraries/snappymail/storage/accountpath.php';
try {
	$path = $options['map'];
	$isWindows = 'Windows' === PHP_OS_FAMILY;
	$privateMapStat = static function ($stat) use ($isWindows) : bool {
		return $stat && 0100000 === ($stat['mode'] & 0170000) && 1 === $stat['nlink']
			&& ($isWindows || !($stat['mode'] & 0077)) && $stat['size'] <= 8388608;
	};
	$absoluteStoragePath = $isWindows
		? 1 === preg_match('/^[A-Za-z]:[\\\\\/]/D', $options['storage'])
		: str_starts_with($options['storage'], '/');
	$stat = @lstat($path);
	if (!$privateMapStat($stat) || !$absoluteStoragePath) {
		throw new RuntimeException('Invalid private ownership map');
	}
	if ($isWindows) {
		\SnappyMail\Storage\AccountPath::CheckPrivateFile($path);
	}
	$handle = @fopen($path, 'rb');
	if (!$handle) {
		throw new RuntimeException('Invalid private ownership map');
	}
	try {
		$opened = fstat($handle);
		$current = @lstat($path);
		if (!$privateMapStat($opened) || !$privateMapStat($current)
			|| $stat['dev'] !== $opened['dev'] || $stat['ino'] !== $opened['ino']
			|| $opened['dev'] !== $current['dev'] || $opened['ino'] !== $current['ino']) {
			throw new RuntimeException('Invalid private ownership map');
		}
		$contents = stream_get_contents($handle, 8388609);
		$afterRead = fstat($handle);
		$current = @lstat($path);
		if (false === $contents || !$privateMapStat($afterRead) || !$privateMapStat($current)
			|| $afterRead['dev'] !== $opened['dev']
			|| $afterRead['ino'] !== $opened['ino'] || $afterRead['size'] !== strlen($contents)
			|| $current['dev'] !== $opened['dev'] || $current['ino'] !== $opened['ino']
			|| strlen($contents) > 8388608) {
			throw new RuntimeException('Invalid private ownership map');
		}
		if ($isWindows) {
			\SnappyMail\Storage\AccountPath::CheckPrivateFile($path);
		}
	} finally {
		fclose($handle);
	}
	$map = json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
	$storage = new \SnappyMail\Storage\AccountPath($options['storage'], !isset($options['dry-run']));
	if (isset($options['dry-run'])) {
		$storage->PreviewAdoption($map, isset($options['resume']));
		fwrite(STDOUT, "Dry-run metadata preflight passed; adoption is not confirmed.\n");
		exit(0);
	} else if (isset($options['reattest'])) {
		$storage->Reattest($map, isset($options['resume']));
	} else {
		$storage->Adopt($map, isset($options['resume']));
	}
	fwrite(STDOUT, "Ownership registry published; no account data moved.\n");
} catch (Throwable $error) {
	fwrite(STDERR, "Account storage unavailable; offline operator ownership review required. No automatic recovery.\n");
	exit(1);
}
