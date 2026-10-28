<?php

namespace SnappyMail {
	class Log
	{
		public static function debug(...$args) {}
		public static function info(...$args) {}
		public static function warning(...$args) {}
	}
}

namespace {
	define('APP_VERSION', 'isolated-tls-fixture');
	$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries/';
	require_once $libraries . 'polyfill/php8.php';
	foreach (['snappymail/http/response.php', 'snappymail/http/request.php',
		'snappymail/http/request/curl.php', 'snappymail/http/request/socket.php',
		'snappymail/dav/uriexception.php', 'snappymail/dav/uri.php',
		'RainLoop/Providers/AddressBook/DavOriginPolicy.php', 'snappymail/dav/client.php', 'RainLoop/Providers/AddressBook/CardDAV.php'] as $file) {
		require_once $libraries . $file;
	}

	class CardDavTlsFixture
	{
		use \RainLoop\Providers\AddressBook\CardDAV;
		protected function logMask(...$args) {}
		protected function logWrite(...$args) {}
		public function client($url)
		{
			return $this->getDavClientFromUrl($url, 'synthetic-user', 'synthetic-password');
		}
	}

	[$script, $kind, $case, $url, $ca, $redirects] = $argv;
	try {
		if ('oauth' === $kind) {
			require_once $libraries . 'OAuth2/Client.php';
			$client = new \OAuth2\Client('synthetic-client', 'synthetic-secret', 0, 'custom' === $case ? $ca : null);
			$client->setAccessToken('synthetic-token');
			$client->setAccessTokenType(\OAuth2\Client::ACCESS_TOKEN_BEARER);
			$result = $client->fetch($url);
			echo json_encode(['status' => $result['code']], JSON_THROW_ON_ERROR);
			exit;
		} else if (in_array($kind, ['carddav', 'carddav-socket'], true)) {
			$response = (new CardDavTlsFixture())->client($url)->request('GET', '/');
		} else {
			$request = 'curl' === $kind
				? new \SnappyMail\HTTP\Request\CURL()
				: new \SnappyMail\HTTP\Request\Socket();
			$request->timeout = 3;
			$request->max_redirects = (int) $redirects;
			if ('explicit-self-signed' === $case) {
				$request->verify_peer = false;
			}
			if (in_array($case, ['custom', 'header', 'auth', 'cache', 'anonymous', 'no-follow'], true)) {
				$request->setCABundleFile($ca);
			}
			if (in_array($case, ['auth', 'cache', 'no-follow'], true)) {
				$request->setAuth(1, 'synthetic-user', 'synthetic-password');
			}
			$headers = 'header' === $case ? ['Authorization: Bearer synthetic-token'] : [];
			$response = $request->doRequest('GET', $url, null, $headers);
			if ('cache' === $case) {
				$request = \SnappyMail\HTTP\Request::factory($kind);
				$request->setCABundleFile($ca);
				$response = $request->doRequest('GET', str_replace('/challenge', '/cache-probe', $url));
			}
		}
		echo json_encode(['status' => $response->status], JSON_THROW_ON_ERROR);
	} catch (\Throwable $error) {
		echo json_encode(['rejected' => true], JSON_THROW_ON_ERROR);
	}
}
