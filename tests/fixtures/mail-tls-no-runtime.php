<?php

namespace RainLoop {
	class API
	{
		public static function Config()
		{
			return new class {
				public function Get($section, $key, $default) { return $default; }
			};
		}
	}
}

namespace {
	// PHP 8 removes disabled functions: inject the missing TLS capability only in this subprocess.
	if (!function_exists('stream_get_transports')) {
		function stream_get_transports() { return ['tcp', 'udp', 'unix', 'udg']; }
	}
	if (function_exists('stream_socket_client')) {
		throw new \RuntimeException('This fixture requires the socket API disabled');
	}
	$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries/';
	require $libraries . 'polyfill/php8.php';
	spl_autoload_register(function($class) use ($libraries) {
		require $libraries . str_replace('\\', '/', $class) . '.php';
	});
	$results = [];
	foreach ([993, 995, 465] as $port) {
		$settings = new \MailSo\Net\ConnectSettings;
		$settings->host = '127.0.0.1';
		$settings->port = $port;
		$settings->type = \MailSo\Net\Enumerations\ConnectionSecurityType::AUTO_DETECT;
		$client = new class extends \MailSo\Net\NetClient {
			public function supportsAuthType(string $type) : bool { return false; }
			public function Logout() : void {}
			public function getLogName() : string { return 'TLS fixture'; }
		};
		try {
			$client->Connect($settings);
			$results[$port] = false;
		} catch (\MailSo\Net\Exceptions\SocketUnsuppoterdSecureConnectionException $error) {
			$results[$port] = true;
		}
	}
	echo json_encode(['ssl_available' => in_array('ssl', stream_get_transports()), 'rejected' => $results], JSON_THROW_ON_ERROR);
}
