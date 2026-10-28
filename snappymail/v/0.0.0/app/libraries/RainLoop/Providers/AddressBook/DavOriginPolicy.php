<?php

namespace RainLoop\Providers\AddressBook;

use SnappyMail\DAV\Uri;
use SnappyMail\DAV\UriException;

class DavOriginPolicy
{
	public static function endpoint(string $url) : array
	{
		$url = \explode('|', $url, 2)[0];
		if (!\preg_match('~^https?://~i', $url)) {
			$url = \preg_replace_callback('~^(fruux\.com|icloud\.com|gmail\.com)(?=[:/]|$)~i',
				static function ($match) {
					return ['fruux.com' => 'dav.fruux.com', 'icloud.com' => 'contacts.icloud.com',
						'gmail.com' => 'google.com'][\strtolower($match[1])];
				}, $url);
			$url = 'https://' . $url;
		}
		return Uri::parse($url);
	}

	public static function allows(string $url, string $allowedOrigins) : bool
	{
		try {
			$origin = self::endpoint($url)['origin'];
			$approved = [];
			foreach (\explode(',', $allowedOrigins) as $entry) {
				$entry = \trim($entry);
				if (!\preg_match('~^https?://[^/?#]+/?$~iD', $entry)) {
					return false;
				}
				$parsed = Uri::parse($entry);
				if ('/' !== $parsed['path'] || null !== $parsed['query']) {
					return false;
				}
				$approved[] = $parsed['origin'];
			}
			return \in_array($origin, $approved, true);
		} catch (UriException $e) {
			return false;
		}
	}
}
