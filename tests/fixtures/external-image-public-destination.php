<?php
/** Synthetic fixtures only. DNS is replaced only in explicitly disabled-function policy tests. */
namespace {
	$mode = $argv[1] ?? '';
	$input = json_decode($argv[2] ?? '{}', true, 512, JSON_THROW_ON_ERROR);
	define('APP_VERSION', 'isolated-public-image-fixture');
	$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries/';
	require $libraries . 'polyfill/php8.php';
	require $libraries . 'MailSo/Base/Utils.php';
	require $libraries . 'MailSo/Base/Http.php';
	spl_autoload_register(static function ($class) use ($libraries) {
		$file = $libraries . strtolower(str_replace('\\', '/', $class)) . '.php';
		if (is_file($file)) { require_once $file; }
	});
	if (!function_exists('dns_get_record')) {
		function dns_get_record($name, $type) {
			if ('policy' !== $GLOBALS['mode'] || !str_ends_with($name, '.test')) { throw new \RuntimeException('Fixture DNS only'); }
			$GLOBALS['queries'][] = [$name, $type];
			return $GLOBALS['dnsRecords'][$name . '#' . (DNS_CNAME === $type ? 'alias' : 'address')] ?? [];
		}
	}
	if (!function_exists('header')) {
		function header($header, $replace = true, $code = 0) {
			$GLOBALS['fixtureHeaders'][] = $header;
			if ($code) { http_response_code($code); }
		}
	}
	if (!function_exists('curl_version')) {
		function curl_version() { return ['version_number' => 0x073a00, 'protocols' => ['http', 'https']]; }
	}
}

namespace RainLoop\Config {
	class Application {
		public function Get($section, $key, $default = null) {
			if ('labs' === $section && 'use_local_proxy_for_external_images' === $key) { return $GLOBALS['input']['enabled'] ?? true; }
			return $default;
		}
	}
}

namespace RainLoop {
	/** Deliberate authentication/config doubles; no application account/session bootstrap. */
	class Actions {
		public static $events = [];
		public function getAccountFromToken() { return ($GLOBALS['input']['authenticated'] ?? true) ? (object) ['synthetic' => true] : null; }
		public function Config() : Config\Application { return new Config\Application(); }
		public function verifyCacheByKey($key) {
			self::$events[] = ['cache-check', $key];
			\MailSo\Base\Http::checkETag(md5($key . APP_VERSION));
		}
		public function cacheByKey($key) {
			self::$events[] = ['cache', $key];
			// Exercise the actual HTTP ETag/checkETag implementation, including its 304 exit.
			\MailSo\Base\Http::ServerUseCache(md5($key . APP_VERSION), 0, 3600);
		}
	}
}

namespace SnappyMail\HTTP\Request {
	if ('service-contract' === $GLOBALS['mode']) {
		/** Fake native transfer only: actual Request loop, Service method, MIME and ETag code. */
		class CURL extends \SnappyMail\HTTP\Request {
			public function supportsSSL() : bool { return true; }
			protected function resolvePublicDestination(string $uri) : array {
				\RainLoop\Actions::$events[] = ['policy', $this->public_destination_required];
				return \SnappyMail\HTTP\PublicDestination::parseURI($uri) + ['addresses' => ['8.8.8.8']];
			}
			protected function __doRequest(string &$method, string &$uri, &$body, array $headers) : \SnappyMail\HTTP\Response {
				\RainLoop\Actions::$events[] = ['fetch', $this->max_redirects];
				$bytes = 'text' === ($GLOBALS['input']['body'] ?? '') ? 'ordinary text' : base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=');
				$unused = '';
				$this->receiveBody($bytes, $unused);
				return new \SnappyMail\HTTP\Response($uri, $GLOBALS['input']['status'] ?? 200, ['Content-Type: text/plain'], '');
			}
		}
	}
}

namespace {
	if ('policy' === $mode) {
		if (function_exists('dns_get_record') && !(new ReflectionFunction('dns_get_record'))->isUserDefined()) { exit(3); }
		$results = [];
		foreach ($input as $case) {
			$queries = [];
			$dnsRecords = $case['records'] ?? [];
			$checks = 0;
			try {
				if (isset($case['address'])) {
					$result = ['public' => \SnappyMail\HTTP\PublicDestination::isPublicAddress($case['address'])];
				} else {
					$result = ['destination' => (new \SnappyMail\HTTP\PublicDestination())->resolve($case['url'], function () use (&$checks, $case) {
						if (++$checks > ($case['deadlineChecks'] ?? 100)) { throw new \RuntimeException('Synthetic deadline'); }
					})];
				}
			} catch (\Throwable $e) { $result = ['rejected' => true]; }
			$results[] = $result + ['queries' => $queries, 'checks' => $checks];
		}
		echo json_encode($results, JSON_THROW_ON_ERROR);
		exit;
	}
	if ('request' === $mode) {
		trait PinnedLoopbackFixture {
			public $policyCalls = [];
			protected function resolvePublicDestination(string $uri) : array {
				$endpoint = \SnappyMail\HTTP\PublicDestination::parseURI($uri);
				$this->policyCalls[] = $endpoint['uri'];
				// Fixed synthetic names and own-loopback literals only; no production opt-out.
				$literal = 'ipv6' === ($GLOBALS['input']['family'] ?? '') ? '::1' : '127.0.0.1';
				if ((in_array($endpoint['host'], ['images.example.test', 'second.example.test', 'wrong.example.test'], true)
					|| (!empty($GLOBALS['input']['literal']) && $endpoint['host'] === $literal))
					&& $endpoint['port'] === (int) $GLOBALS['input']['port']) {
					return $endpoint + ['addresses' => ['ipv6' === ($GLOBALS['input']['family'] ?? '') ? '::1' : '127.0.0.1']];
				}
				return parent::resolvePublicDestination($uri);
			}
		}
		class PinnedCurlFixture extends \SnappyMail\HTTP\Request\CURL { use PinnedLoopbackFixture; }
		class PinnedSocketFixture extends \SnappyMail\HTTP\Request\Socket { use PinnedLoopbackFixture; }
		$request = 'curl' === $input['backend'] ? new PinnedCurlFixture() : new PinnedSocketFixture();
		$request->requirePublicDestination();
		$request->max_redirects = 2;
		if (!empty($input['ca'])) { $request->setCABundleFile($input['ca']); }
		try {
			$response = $request->doRequest('GET', $input['url']);
			$result = ['status' => $response->status, 'body' => $response->body, 'final' => $response->final_uri];
		} catch (\Throwable $e) { $result = ['rejected' => true]; }
		echo json_encode($result + ['backend' => get_parent_class($request), 'policyCalls' => $request->policyCalls], JSON_THROW_ON_ERROR);
		exit;
	}
	if (in_array($mode, ['service-denied', 'service-contract'], true)) {
		require $libraries . 'RainLoop/ServiceActions.php';
		$key = \MailSo\Base\Utils::UrlSafeBase64Encode($input['url']);
		if (!empty($input['malformed'])) { $key = '%%%'; }
		$etagKey = ('old' === ($input['validator'] ?? '') ? '' : 'external-image-public-v1:') . $key;
		if (!empty($input['validator'])) { $_SERVER['HTTP_IF_NONE_MATCH'] = '"' . md5($etagKey . APP_VERSION) . '"'; }
		register_shutdown_function(static function () {
			fwrite(STDERR, json_encode(['status' => http_response_code() ?: 200, 'events' => \RainLoop\Actions::$events,
				'headers' => $GLOBALS['fixtureHeaders'] ?? [], 'backend' => get_class(\SnappyMail\HTTP\Request::factory())], JSON_THROW_ON_ERROR));
		});
		$service = new \RainLoop\ServiceActions(new \MailSo\Base\Http(), new \RainLoop\Actions());
		$paths = !empty($input['legacy']) ? ['ProxyExternal', $key] : ['ProxyExternal', 'public-v1', $key];
		echo $service->SetPaths($paths)->ServiceProxyExternal();
		exit;
	}
	exit(2);
}
