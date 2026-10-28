<?php

namespace SnappyMail\HTTP\Request;

use SnappyMail\HTTP\Response;

class Socket extends \SnappyMail\HTTP\Request
{
	public function supportsSSL() : bool
	{
		return \function_exists('openssl_open');
	}

	protected function __doRequest(string &$method, string &$request_url, &$body, array $extra_headers) : Response
	{
		$parts = \parse_url($request_url);
		$parts['scheme'] = \strtolower($parts['scheme']);

		$host = $parts['host'];

		// Set a default port.
		if (\array_key_exists('port', $parts)) {
			$host .= ":{$parts['port']}";
		} else if ('http' === $parts['scheme'] || 'https' === $parts['scheme']) {
			$parts['port'] = self::getSchemePort($parts['scheme']);
		} else {
			throw new \RuntimeException("Scheme '{$parts['scheme']}' unsupported");
		}

		if (!\array_key_exists('path', $parts)) {
			$parts['path'] = '/';
		}

		$headers = array(
			"{$method} {$parts['path']}".(isset($parts['query']) ? "?{$parts['query']}" : '')." HTTP/1.1",
			"Host: {$host}",
			"User-Agent: {$this->user_agent}",
			'Connection: Close',
		);
		if ($extra_headers) {
			$headers = \array_merge($headers, $extra_headers);
		}
		$headers = \implode("\r\n", $headers);
		if (!\is_null($body)) {
			if (!\stripos($headers,'Content-Type')) {
				$headers .= "\r\nContent-Type: application/x-www-form-urlencoded";
			}
			$headers .= "\r\nContent-Length: ".\strlen($body);
		}

		$context = \stream_context_create();
		if ('https' === $parts['scheme']) {
			$parts['host'] = 'ssl://'.$parts['host'];
			\stream_context_set_option($context, 'ssl', 'verify_peer', true);
			\stream_context_set_option($context, 'ssl', 'verify_peer_name', true);
			if ($this->verify_peer || $this->ca_bundle) {
				\stream_context_set_option($context, 'ssl', 'allow_self_signed', false);
				if ($this->ca_bundle) {
					if (\is_dir($this->ca_bundle) || (\is_link($this->ca_bundle) && \is_dir(\readlink($this->ca_bundle)))) {
						\stream_context_set_option($context, 'ssl', 'capath', $this->ca_bundle);
					} else {
						\stream_context_set_option($context, 'ssl', 'cafile', $this->ca_bundle);
					}
				}
			} else {
				\stream_context_set_option($context, 'ssl', 'allow_self_signed', true);
			}
		} else {
			$parts['host'] = 'tcp://'.$parts['host'];
		}

		$errno = 0;
		$errstr = '';

		$targets = [$parts['host']];
		if ($this->public_destination_required) {
			if (!$this->public_destination) {
				throw new \RuntimeException('Missing public image destination');
			}
			\stream_context_set_option($context, 'ssl', 'peer_name', $this->public_destination['host']);
			\stream_context_set_option($context, 'ssl', 'SNI_enabled', true);
			$targets = \array_map(function ($ip) use ($parts) {
				return ('https' === $parts['scheme'] ? 'ssl://' : 'tcp://')
					. (false !== \strpos($ip, ':') ? '[' . $ip . ']' : $ip);
			}, $this->public_destination['addresses']);
		}
		$sock = false;
		foreach ($targets as $target) {
			$sock = $this->public_destination_required
				? @\stream_socket_client("{$target}:{$parts['port']}", $errno, $errstr, $this->remainingResponseTime(), STREAM_CLIENT_CONNECT, $context)
				: \stream_socket_client("{$target}:{$parts['port']}", $errno, $errstr, $this->remainingResponseTime(), STREAM_CLIENT_CONNECT, $context);
			if (false !== $sock) {
				break;
			}
		}
		if (false === $sock) {
			throw new \RuntimeException($errstr);
		}

		try {
			$this->setResponseTimeout($sock);
			\fwrite($sock, $headers . "\r\n\r\n");
			if (!\is_null($body)) {
				$this->setResponseTimeout($sock);
				\fwrite($sock, $body);
			}

			# Bound response metadata as well as the body.
			$header_bytes = 0;
			do {
				$response_headers = array();
				$data = $this->readResponseLine($sock, $header_bytes);
				if (!\preg_match('#^HTTP/1\.[01] ([1-5][0-9]{2})(?:[ \t].*)?\r\n$#D', $data, $status)) {
					throw new \RuntimeException('Invalid HTTP response status');
				}
				$code = (int) $status[1];
				$this->limitResponseForStatus($code);
				$data = \rtrim($data);
				while (\strlen($data)) {
					$response_headers[] = $data;

					if (401 === $code && $this->auth['user'] && !isset($extra_headers['Authorization'])) {
						// Basic authentication
						if ($this->auth['type'] & self::AUTH_BASIC && \preg_match("/WWW-Authenticate:\\s+Basic\\s+realm=([^\\r\\n]*)/i", $data, $match)) {
							$extra_headers['Authorization'] = "Authorization: Basic " . \base64_encode($this->auth['user'] . ':' . $this->auth['pass']);
							\fclose($sock);
							return $this->__doRequest($method, $request_url, $body, $extra_headers);
						}
						// Digest authentication
						if ($this->auth['type'] & self::AUTH_DIGEST && \preg_match("/WWW-Authenticate:\\s+Digest\\s+([^\\r\\n]*)/i", $data, $match)) {
							$challenge = [];
							foreach (\split(',', $match[1]) as $i) {
								$ii = \split('=', \trim($i), 2);
								if (!empty($ii[1]) && !empty($ii[0])) {
									$challenge[$ii[0]] = \preg_replace('/^"/','', \preg_replace('/"$/','', $ii[1]));
								}
							}
							$a1 = \md5($this->auth['user'] . ':' . $challenge['realm'] . ':' . $this->auth['pass']);
							$a2 = \md5($method . ':' . $request_url);
							if (empty($challenge['qop'])) {
								$digest = \md5($a1 . ':' . $challenge['nonce'] . ':' . $a2);
							} else {
								$challenge['cnonce'] = 'Req2.' . \random_int();
								if (empty($challenge['nc'])) {
									$challenge['nc'] = 1;
								}
								$nc     = \sprintf('%08x', $challenge['nc']++);
								$digest = \md5($a1 . ':' . $challenge['nonce'] . ':' . $nc . ':' . $challenge['cnonce'] . ':auth:' . $a2);
							}
							$extra_headers['Authorization'] = "Authorization: Digest "
								. ' username="' . \addcslashes($this->auth['user'], '\\"') . '",'
								. ' realm="' . $challenge['realm'] . '",'
								. ' nonce="' . $challenge['nonce'] . '",'
								. ' uri="' . $request_url . '",'
								. ' response="' . $digest . '"'
								. (empty($challenge['opaque']) ? '' : ', opaque="' . $challenge['opaque'] . '"')
								. (empty($challenge['qop']) ? '' : ', qop="auth", nc=' . $nc . ', cnonce="' . $challenge['cnonce'] . '"');

							\fclose($sock);
							return $this->__doRequest($method, $request_url, $body, $extra_headers);
						}
						if ($this->auth['type'] & self::AUTH_BEARER) {
							$extra_headers['Authorization'] = "Authorization: Bearer {$this->auth['pass']}";
							\fclose($sock);
							return $this->__doRequest($method, $request_url, $body, $extra_headers);
						}
					}

					$data = \rtrim($this->readResponseLine($sock, $header_bytes));
				}
				if (101 === $code) {
					throw new \RuntimeException('HTTP protocol switching unsupported');
				}
			} while ($code < 200);

			# Read body
			$response_body = '';
			$length = null;
			$chunked = false;
			foreach ($response_headers as $header) {
				if (\preg_match('/^Content-Length:\s*(.*?)\s*$/iD', $header, $match)) {
					$value = $this->parseResponseLength($match[1]);
					if (null !== $length && $value !== $length) {
						throw new \RuntimeException('Conflicting HTTP response lengths');
					}
					$length = $value;
				}
				if (\preg_match('/^Transfer-Encoding:\s*(.*?)\s*$/iD', $header, $match)) {
					if ($chunked || 'chunked' !== \strtolower($match[1])) {
						throw new \RuntimeException('Unsupported HTTP transfer encoding');
					}
					$chunked = true;
				}
			}
			if ($chunked && null !== $length) {
				throw new \RuntimeException('Ambiguous HTTP response framing');
			}
			if ('HEAD' !== $method && 204 !== $code && 304 !== $code) {
				if ($chunked) {
					while (true) {
						// Finite responses also bound aggregate chunk metadata. Trusted unlimited
						// archive streams bound each size line without capping the chunk count.
						$chunk_bytes = $this->response_limit ? $header_bytes : 0;
						$line = $this->readResponseLine($sock, $chunk_bytes);
						if ($this->response_limit) {
							$header_bytes = $chunk_bytes;
						}
						if (!\preg_match('/^([a-f0-9]+)(?:;[^\r\n]*)?\r\n$/iD', $line, $match)) {
							throw new \RuntimeException('Invalid HTTP chunk size');
						}
						$chunk = $this->parseResponseLength($match[1], 16);
						if (!$chunk) {
							while ("\r\n" !== $this->readResponseLine($sock, $header_bytes)) {}
							break;
						}
						$this->checkResponseSize($chunk);
						$this->readBodyLength($sock, $chunk, $response_body);
						$ending = $this->readResponseData($sock, 2);
						while (\strlen($ending) < 2) {
							$ending .= $this->readResponseData($sock, 2 - \strlen($ending));
						}
						if ("\r\n" !== $ending) {
							throw new \RuntimeException('Invalid HTTP chunk terminator');
						}
					}
				} else if (null !== $length) {
					$this->checkResponseSize($length);
					$this->readBodyLength($sock, $length, $response_body);
				} else {
					while (!\feof($sock)) {
						// One look-ahead byte distinguishes an exact limit from a truncated body.
						$read = $this->response_limit
							? \min(8192, $this->response_limit - $this->response_bytes + 1) : 8192;
						$data = $this->readResponseData($sock, $read, true);
						$this->receiveBody($data, $response_body);
					}
				}
			}
			return new Response($request_url, $code, $response_headers, $response_body, $this->response_limit);
		} finally {
			if (\is_resource($sock)) {
				\fclose($sock);
			}
		}
	}

	private function readResponseLine($sock, int &$bytes) : string
	{
		$this->setResponseTimeout($sock);
		$remaining = self::MAX_RESPONSE_HEADERS - $bytes;
		$line = $remaining > 0 ? \fgets($sock, $remaining + 1) : false;
		if (false === $line || "\r\n" !== \substr($line, -2)) {
			throw new \RuntimeException('Invalid, incomplete or oversized HTTP metadata');
		}
		$bytes += \strlen($line);
		return $line;
	}

	private function parseResponseLength(string $value, int $base = 10) : int
	{
		if (!\preg_match(16 === $base ? '/^[a-f0-9]+$/iD' : '/^[0-9]+$/D', $value)) {
			throw new \RuntimeException('Invalid HTTP response length');
		}
		$value = \strtolower(\ltrim($value, '0')) ?: '0';
		$max = 16 === $base ? \dechex(PHP_INT_MAX) : (string) PHP_INT_MAX;
		if (\strlen($value) > \strlen($max)
			|| (\strlen($value) === \strlen($max) && \strcmp($value, $max) > 0)) {
			throw new \RuntimeException('HTTP response length overflows integer');
		}
		return 16 === $base ? \hexdec($value) : (int) $value;
	}

	private function readResponseData($sock, int $length, bool $allow_eof = false) : string
	{
		$this->setResponseTimeout($sock);
		$data = \fread($sock, $length);
		if (false === $data || \stream_get_meta_data($sock)['timed_out']
			|| ('' === $data && (!$allow_eof || !\feof($sock)))) {
			throw new \RuntimeException('Incomplete HTTP response body');
		}
		return $data;
	}

	private function setResponseTimeout($sock) : void
	{
		$remaining = $this->remainingResponseTime();
		$seconds = (int) $remaining;
		if (!\stream_set_timeout($sock, $seconds, \max(1, (int) (($remaining - $seconds) * 1000000)))) {
			throw new \RuntimeException('Cannot set HTTP response timeout');
		}
	}

	private function readBodyLength($sock, int $length, string &$body) : void
	{
		while ($length > 0) {
			$data = $this->readResponseData($sock, \min(8192, $length));
			$this->receiveBody($data, $body);
			$length -= \strlen($data);
		}
	}
}
