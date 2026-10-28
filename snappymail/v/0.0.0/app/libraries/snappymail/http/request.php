<?php

namespace SnappyMail\HTTP;

abstract class Request
{
	// Includes status lines, interim responses, chunk metadata and trailers.
	const MAX_RESPONSE_HEADERS = 65536;
	const DEFAULT_MAX_RESPONSE_KB = 1024;

	const
		/**
		 * Authentication
		 * These are bitwise options
		 */
		AUTH_BASIC = 1,
		AUTH_DIGEST = 2,
		AUTH_BEARER = 4;

	public
		$timeout = 5, // timeout in seconds.
		$max_response_kb = self::DEFAULT_MAX_RESPONSE_KB,
		$user_agent,
		$max_redirects = 0,
		$verify_peer = true,
		$proxy = null,
		$proxy_auth = null;

	protected
		$public_destination_required = false,
		$public_destination = null,
		$response_limit = 0,
		$response_bytes = 0,
		$response_deadline = 0,
		$auth = [
			'type' => 0,
			'user' => '',
			'pass' => ''
		],
		$stream = null,
		$headers = array(),
		$ca_bundle = null;

	protected static $scheme_ports = array(
		'http'  => 80,
		'https' => 443
	);

	public static function factory(string $type = 'curl')
	{
		if ('curl' === $type && \function_exists('curl_init')) {
			return new Request\CURL();
		}
		return new Request\Socket();
	}

	function __construct()
	{
		$this->user_agent = 'SnappyMail/' . APP_VERSION;
	}

	public function setAuth(int $type, string $user,
		#[\SensitiveParameter]
		string $pass
	) : void
	{
		$this->auth = [
			'type' => $type,
			'user' => $user,
			'pass' => $pass
		];
	}

	public function addHeader($header)
	{
		$this->headers[] = $header;
		return $this;
	}

	public function streamBodyTo($stream)
	{
		if (!\is_resource($stream)) {
			throw new \Exception('Invalid body target');
		}
		if ($this->stream !== $stream) {
			$this->response_bytes = 0;
		}
		$this->stream = $stream;
	}

	public function setCABundleFile($file)
	{
		$this->ca_bundle = $file;
	}

	/** Latching opt-in for untrusted external-image URLs, never an ordinary HTTP default. */
	public function requirePublicDestination() : void
	{
		$this->public_destination_required = true;
	}

	protected function resolvePublicDestination(string $uri) : array
	{
		return (new PublicDestination())->resolve($uri, function () { $this->remainingResponseTime(); });
	}

	/**
	 * Return whether a URI can be fetched.  Returns false if the URI scheme is not allowed
	 * or is not supported by this fetcher implementation; returns true otherwise.
	 *
	 * @return bool
	 */
	public function canFetchURI($uri)
	{
		if ('https:' === \substr($uri, 0, 6) && !$this->supportsSSL()) {
			\trigger_error('HTTPS URI unsupported fetching '.$uri, E_USER_WARNING);
			return false;
		}
		if (!self::URIHasAllowedScheme($uri)) {
			\trigger_error('URI fetching not allowed for '.$uri, E_USER_WARNING);
			return false;
		}
		return true;
	}

	/**
	 * Does this fetcher implementation (and runtime) support fetching HTTPS URIs?
	 * May inspect the runtime environment.
	 *
	 * @return bool $support True if this fetcher supports HTTPS
	 * fetching; false if not.
	 */
	abstract public function supportsSSL() : bool;

	abstract protected function __doRequest(string &$method, string &$request_url, &$body, array $extra_headers) : Response;

	public function doRequest($method, $request_url, $body = null, array $extra_headers = array()) : ?Response
	{
		if (!\is_int($this->max_response_kb) || $this->max_response_kb < 0
			|| $this->max_response_kb > \intdiv(PHP_INT_MAX, 1024)) {
			throw new \InvalidArgumentException('Invalid HTTP response limit');
		}
		$this->response_limit = $this->max_response_kb * 1024;
		$this->response_deadline = \hrtime(true) / 1000000000 + $this->timeout;
		$method = \strtoupper($method);
		$url    = $request_url;
		$etime  = \time() + $this->timeout;
		$redirects = \max(0, $this->max_redirects);
		if (\is_array($body)) {
			$body = \http_build_query($body, '', '&');
		}
		if ($body && 'GET' === $method) {
			$url .= (\strpos($url, '?') ? '&' : '?') . $body;
			$body = null;
		}
		do
		{
			$this->public_destination = null;
			if ($this->public_destination_required) {
				$this->public_destination = $this->resolvePublicDestination($url);
				$url = $this->public_destination['uri'];
			}
			if (!$this->canFetchURI($url)) {
				throw new \RuntimeException("Can't fetch URL: {$url}");
			}

			if (!self::URIHasAllowedScheme($url)) {
				throw new \RuntimeException("Fetching URL not allowed: {$url}");
			}

			$this->resetResponseBody();
			$result = $this->__doRequest($method, $url, $body, \array_merge($this->headers, $extra_headers));

			// http://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html#sec10.3
			// In response to a request other than GET or HEAD, the user agent MUST NOT
			// automatically redirect the request unless it can be confirmed by the user
			if ($redirects-- && \in_array($result->status, array(301, 302, 303, 307)) && \in_array($method, ['GET','HEAD'])) {
				$location = $result->getRedirectLocation();
				$origin = self::redirectOrigin($url);
				$target = self::redirectOrigin($location ?? '');
				if (('https' === $origin[0] && 'https' !== $target[0])
					|| ($origin !== $target && ($this->auth['type'] || $this->headers || $extra_headers))) {
					throw new \RuntimeException('Unsafe HTTP redirect');
				}
				$url = $location;
			} else {
				$result->final_uri = $url;
				$result->request_uri = $request_url;
				return $result;
			}

		} while ($etime-time() > 0);

		return null;
	}

	protected function resetResponseBody() : void
	{
		if ($this->stream) {
			if (!\stream_get_meta_data($this->stream)['seekable']) {
				// Pipes support a single response, but cannot erase a previous body.
				if ($this->response_bytes) {
					throw new \RuntimeException('Cannot reset HTTP body target');
				}
			} else if (!\rewind($this->stream) || !\ftruncate($this->stream, 0)) {
				throw new \RuntimeException('Cannot reset HTTP body target');
			}
		}
		$this->response_bytes = 0;
	}

	protected function limitResponseForStatus(int $status) : void
	{
		// The trusted archive exception applies only to successful downloads.
		if (0 === $this->max_response_kb) {
			$this->response_limit = 200 === $status ? 0 : self::DEFAULT_MAX_RESPONSE_KB * 1024;
		}
	}

	protected function remainingResponseTime() : float
	{
		$remaining = $this->response_deadline - \hrtime(true) / 1000000000;
		if ($remaining <= 0) {
			throw new \RuntimeException('HTTP request timed out');
		}
		return $remaining;
	}

	protected function checkResponseSize(int $length) : void
	{
		if ($this->response_limit && $length > $this->response_limit - $this->response_bytes) {
			throw new \RuntimeException('HTTP response exceeds configured limit');
		}
	}

	protected function receiveBody(string $data, string &$body) : int
	{
		$length = \strlen($data);
		$this->checkResponseSize($length);
		if ($this->stream) {
			$offset = 0;
			while ($offset < $length) {
				$written = \fwrite($this->stream, \substr($data, $offset));
				if (!$written) {
					throw new \RuntimeException('Cannot write HTTP body target');
				}
				$offset += $written;
				$this->response_bytes += $written;
			}
		} else {
			$body .= $data;
			$this->response_bytes += $length;
		}
		return $length;
	}

	private static function redirectOrigin(string $uri) : array
	{
		$parts = \parse_url($uri);
		if (!self::URIHasAllowedScheme($uri) || !isset($parts['scheme'], $parts['host'])
			|| isset($parts['user']) || isset($parts['pass'])
			|| \str_contains($uri, '\\') || \preg_match('/[\x00-\x20\x7f]/', $uri)) {
			throw new \RuntimeException('Invalid HTTP redirect target');
		}
		$scheme = \strtolower($parts['scheme']);
		return [$scheme, \strtolower($parts['host']), $parts['port'] ?? self::getSchemePort($scheme)];
	}

	/**
	 * Return whether a URI should be allowed. Override this method to conform to your local policy.
	 * By default, will attempt to fetch any http or https URI.
	 */
	public static function URIHasAllowedScheme($uri) : bool
	{
		return (bool) \preg_match('#^https?://#i', $uri);
	}

	public static function getSchemePort($scheme) : int
	{
		return self::$scheme_ports[$scheme] ?? 0;
	}
}
