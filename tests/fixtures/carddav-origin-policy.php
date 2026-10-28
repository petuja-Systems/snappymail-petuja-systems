<?php
namespace SnappyMail {
	class Log {
		public static function debug(...$args) {}
		public static function info(...$args) {}
		public static function warning(...$args) {}
	}
}
namespace {
	if ('cli' !== PHP_SAPI) { exit(1); }
	define('APP_VERSION', 'synthetic-dav-origin-fixture');
	$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries/';
	require $libraries . 'polyfill/php8.php';
	spl_autoload_register(static function ($class) use ($libraries) {
		$file = $libraries . ('RainLoop\\' === substr($class, 0, 9)
			? str_replace('\\', '/', $class) : strtolower(str_replace('\\', '/', $class))) . '.php';
		if (is_file($file)) { require_once $file; }
	});
	class DavOriginFixture {
		use \RainLoop\Providers\AddressBook\CardDAV;
		public $oLogger;
		public function __construct() { $this->oLogger = new class { public function WriteDump(...$args) {} }; }
		protected function logMask(...$args) {}
		protected function logWrite(...$args) {}
		protected function logException(...$args) {}
		public function client() { return $this->getDavClient(); }
	}
	[$script, $kind, $encoded] = $argv;
	$input = json_decode($encoded, true, 512, JSON_THROW_ON_ERROR);
	if ('pure' === $kind) {
		$results = [];
		foreach ($input as $case) {
			try {
				if (isset($case['allowed'])) {
					$results[] = \RainLoop\Providers\AddressBook\DavOriginPolicy::allows($case['url'], $case['allowed']);
				} else {
					$result = isset($case['base']) ? \SnappyMail\DAV\Uri::resolve($case['base'], $case['url'])
						: \SnappyMail\DAV\Uri::parse($case['url']);
					$results[] = $result['uri'];
				}
			} catch (\SnappyMail\DAV\UriException $e) { $results[] = ['rejected' => true]; }
		}
		echo json_encode($results, JSON_THROW_ON_ERROR);
		exit;
	}
	if (!preg_match('~^http://127\.0\.0\.1:[0-9]+/~D', $input['base'])) { exit(2); }
	$result = ['backend' => get_class(\SnappyMail\HTTP\Request::factory())];
	try {
		if ('discovery' === $input['action']) {
			$fixture = new DavOriginFixture();
			$fixture->setDAVClientConfig(['Mode' => 2, 'Url' => $input['base'],
				'User' => 'synthetic-dav-user', 'Password' => 'synthetic-dav-password'], $input['allowed']);
			$client = $fixture->client();
			$result['path'] = $client ? $client->urlPath : null;
		} else {
			$client = new \SnappyMail\DAV\Client(['baseUri' => $input['base'],
				'userName' => 'synthetic-dav-user', 'password' => 'synthetic-dav-password']);
			if ('propfind' === $input['action']) {
				$result['properties'] = $client->propFind($input['reference'], ['{DAV:}current-user-principal'], 1);
			} else {
				$result['status'] = $client->request('GET', $input['reference'])->status;
			}
		}
	} catch (\SnappyMail\DAV\UriException $e) { $result['rejected'] = true; }
	echo json_encode($result, JSON_THROW_ON_ERROR);
}
