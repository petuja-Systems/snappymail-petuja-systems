<?php

$repo = dirname(__DIR__, 2);
require $repo . '/tests/fixtures/backup-restore-prepend.php';
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'] = '127.0.0.1';
require $repo . '/index.php';

class ClientSourceFixture extends \RainLoop\Actions
{
	public function __construct()
	{
		// Model an existing configuration that still returns the retired flag as true.
		$this->oConfig = new class {
			public function Get($section, $key, $default = null)
			{
				return 'labs' === $section && 'http_client_ip_check_proxy' === $key ? true : $default;
			}
		};
	}

	public function logAddresses() : string
	{
		return $this->compileLogParams('Auth failed: ip={request:ip} user-ip={user:ip}');
	}
}

$results = [];
foreach (['192.0.2.20', '2001:db8::20', ''] as $peer) {
	$_SERVER['REMOTE_ADDR'] = $peer;
	foreach ([
		[],
		['HTTP_X_REAL_IP' => '198.51.100.71'],
		['HTTP_X_FORWARDED_FOR' => '198.51.100.72, 203.0.113.1'],
		['HTTP_CLIENT_IP' => '198.51.100.73'],
		['HTTP_CLIENT_IP' => "198.51.100.74\r\nsynthetic", 'HTTP_X_FORWARDED_FOR' => '198.51.100.75', 'HTTP_X_REAL_IP' => '198.51.100.76'],
		['HTTP_FORWARDED' => 'for="[2001:db8::71]";proto=https']
	] as $headers) {
		foreach (['HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_CLIENT_IP', 'HTTP_FORWARDED'] as $name) {
			unset($_SERVER[$name]);
		}
		$_SERVER = array_merge($_SERVER, $headers);
		$results[] = ['peer' => $peer, 'log' => (new ClientSourceFixture)->logAddresses()];
	}
}
echo json_encode($results, JSON_THROW_ON_ERROR);
