<?php
namespace SnappyMail {
	class Log {
		public static function debug(...$args) {}
		public static function warning(...$args) {}
		public static function info(...$args) {}
	}
}
namespace {
	if ('cli' !== PHP_SAPI) { exit(1); }
	define('APP_VERSION', 'synthetic-response-bounds');
	$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries/';
	require $libraries . 'polyfill/php8.php';
	spl_autoload_register(static function ($class) use ($libraries) {
		$file = $libraries . strtolower(str_replace('\\', '/', $class)) . '.php';
		if (is_file($file)) { require_once $file; }
	});
	class ShortBodyTarget {
		public $context;
		public static $bytes = 0;
		public static $stop = false;
		public static $partial = false;
		public function stream_open($path, $mode, $options, &$opened) { self::$bytes = 0; return true; }
		public function stream_seek($offset, $whence) { return true; }
		public function stream_tell() { return self::$bytes; }
		public function stream_truncate($size) { self::$bytes = $size; return true; }
		public function stream_write($data) {
			$length = self::$stop || (self::$partial && self::$bytes >= 3) ? 0 : min(3, strlen($data));
			self::$bytes += $length;
			return $length;
		}
		public function stream_stat() { return []; }
	}
	stream_wrapper_register('shortbody', ShortBodyTarget::class);
	[$script, $backend, $encoded] = $argv;
	$cases = json_decode($encoded, true, 512, JSON_THROW_ON_ERROR);
	$request = \SnappyMail\HTTP\Request::factory($backend);
	$results = [];
	foreach ($cases as $case) {
		if (!preg_match('#^http://127\.0\.0\.1:[0-9]+/#D', $case['url'])) { exit(2); }
		$request->timeout = 1;
		$request->max_response_kb = $case['limit'] ?? 1;
		$request->max_redirects = $case['redirects'] ?? 0;
		$stream = null;
		$pipe = null;
		if (!empty($case['stream'])) {
			ShortBodyTarget::$stop = 'fail' === $case['stream'];
			ShortBodyTarget::$partial = 'partial' === $case['stream'];
			if ('pipe' === $case['stream']) {
				$pipe = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
				$stream = $pipe[0];
			} else {
				$stream = true === $case['stream'] ? tmpfile() : fopen('shortbody://target', 'w+b');
			}
		}
		// A fresh object when switching between buffered and streamed contracts.
		$property = new ReflectionProperty(\SnappyMail\HTTP\Request::class, 'stream');
		if (PHP_VERSION_ID < 80100) { $property->setAccessible(true); }
		if ($stream) { $request->streamBodyTo($stream); } else { $property->setValue($request, null); }
		$result = ['ok' => false, 'bytes' => 0, 'backend' => get_class($request)];
		try {
			$pgp = new ReflectionMethod(\SnappyMail\PGP\Keyservers::class, 'HTTP');
			if (PHP_VERSION_ID < 80100) { $pgp->setAccessible(true); }
			$result['pgp_default_kb'] = $pgp->invoke(null)->max_response_kb;
			if (!empty($case['dav'])) {
				$client = new \SnappyMail\DAV\Client(['baseUri' => $case['url']]);
				$http = new ReflectionProperty($client, 'HTTP');
				if (PHP_VERSION_ID < 80100) { $http->setAccessible(true); }
				$result['dav_default_kb'] = $http->getValue($client)->max_response_kb;
				$http->setValue($client, $request);
				$listing = $client->propFind('', ['{DAV:}getetag'], 1);
				$result['entries'] = count($listing);
				$result['ok'] = true;
			} else {
				$response = $request->doRequest($case['method'] ?? 'GET', $case['url']);
				$result['ok'] = null !== $response;
				$result['status'] = $response->status;
				$result['bytes'] = strlen($response->body ?? '');
				$result['hash'] = hash('sha256', $response->body ?? '');
				$result['stale_header'] = $response->getHeader('x-stale');
			}
		} catch (Throwable $error) {
			$result['error_class'] = get_class($error);
		}
		$counter = new ReflectionProperty(\SnappyMail\HTTP\Request::class, 'response_bytes');
		if (PHP_VERSION_ID < 80100) { $counter->setAccessible(true); }
		$result['counted_bytes'] = $counter->getValue($request);
		if ($stream) {
			if ($pipe) {
				fclose($stream);
				$content = stream_get_contents($pipe[1]);
				$result['bytes'] = strlen($content);
				$result['hash'] = hash('sha256', $content);
				fclose($pipe[1]);
			} else if (true === $case['stream']) {
				$result['bytes'] = fstat($stream)['size'];
				rewind($stream);
				$result['hash'] = hash('sha256', stream_get_contents($stream));
			} else {
				$result['bytes'] = ShortBodyTarget::$bytes;
			}
			if (is_resource($stream)) { fclose($stream); }
		}
		$results[] = $result;
	}
	echo json_encode($results, JSON_THROW_ON_ERROR);
}
