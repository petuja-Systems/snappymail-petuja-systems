<?php

namespace SnappyMail;

abstract class Integrity
{
	public const MINIMUM_PHP_VERSION = '8.2.35';

	/**
	 * Called by https://webmail.tld/?/Test
	 */
	public static function test()
	{
		$result = static::phpVersion();
		if ($result) {
			echo '<p style="color: red">' . $result . '</p>';
			return;
		}

		$result = static::phpExtensions();
		if ($result) {
			echo '<p>The following PHP extensions are not available in your PHP configuration!</p>';
			echo '<ul><li>' . \implode('</li>li><li>', $result) . '</li></ul>';
		}

		// Keep this public diagnostic local; request headers must not select a probe target.
	}

	public static function phpVersion()
	{
		if (!self::isPhpVersionSupported()) {
			return 'Your PHP version ('.PHP_VERSION.') is lower than the minimal required '.self::MINIMUM_PHP_VERSION.'!';
		}
	}

	public static function isPhpVersionSupported(string $sVersion = PHP_VERSION) : bool
	{
		return \version_compare($sVersion, self::MINIMUM_PHP_VERSION, '>=');
	}

	public static function phpExtensions()
	{
		$aRequirements = array(
			'openssl'  => extension_loaded('openssl'),
			'mbstring' => extension_loaded('mbstring'),
			'Zlib'     => extension_loaded('zlib'),
			// enabled by default:
			'json'     => function_exists('json_decode'),
			'libxml'   => function_exists('libxml_use_internal_errors'),
			'dom'      => class_exists('DOMDocument'),
			// https://github.com/the-djmaze/snappymail/issues/1392
			'fileinfo' => extension_loaded('fileinfo')
			// https://github.com/the-djmaze/snappymail/issues/392
		//	'phar'     => class_exists('PharData')
		);

		$aMissing = [];
		if (in_array(false, $aRequirements)) {
			foreach ($aRequirements as $sKey => $bValue) {
				if (!$bValue) {
					$aMissing[] = $sKey;
				}
			}
		}
		return $aMissing;
	}

}
