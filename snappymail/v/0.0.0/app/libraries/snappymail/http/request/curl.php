<?php

namespace SnappyMail\HTTP\Request;

use SnappyMail\HTTP\Response;

class CURL extends \SnappyMail\HTTP\Request
{
	private
		$response_headers = array(),
		$header_block = array(),
		$header_bytes = 0,
		$headers_complete = false,
		$response_body = '';

	public function supportsSSL() : bool
	{
		$v = \curl_version();
		if (\is_array($v)) {
			return \in_array('https', $v['protocols']);
		}
		return \is_string($v) ? !!\preg_match('/OpenSSL/i', $v) : false;
	}

	protected function __doRequest(string &$method, string &$request_url, &$body, array $extra_headers) : Response
	{
		$c = \curl_init();
		if (false === $c) {
			throw new \RuntimeException("Could not initialize CURL for URL '{$request_url}'");
		}

		try {
			// php.net/curl_setopt
			\curl_setopt_array($c, array(
				CURLOPT_USERAGENT      => $this->user_agent,
				CURLOPT_CONNECTTIMEOUT => $this->timeout,
				CURLOPT_TIMEOUT_MS     => \max(1, (int) \ceil($this->remainingResponseTime() * 1000)),
				CURLOPT_URL            => $request_url,
				CURLOPT_HEADERFUNCTION => array($this, 'fetchHeader'),
				CURLOPT_WRITEFUNCTION  => array($this, \is_resource($this->stream) ? 'streamData' : 'fetchData'),
				CURLOPT_SSL_VERIFYPEER => ($this->verify_peer || $this->ca_bundle),
				CURLOPT_SSL_VERIFYHOST => 2,
	//			CURLOPT_FOLLOWLOCATION => false,       // follow redirects
	//			CURLOPT_MAXREDIRS      => 0,           // stop after 0 redirects
			));
	//		\curl_setopt($c, CURLOPT_ENCODING , 'gzip');
			if (\defined('CURLOPT_NOSIGNAL')) {
				\curl_setopt($c, CURLOPT_NOSIGNAL, true);
			}
			if ($this->ca_bundle) {
				\curl_setopt($c, CURLOPT_CAINFO, $this->ca_bundle);
			}
			if ($extra_headers) {
				\curl_setopt($c, CURLOPT_HTTPHEADER, $extra_headers);
			}
			if ($this->auth['user'] && $this->auth['type']) {
				if ($this->auth['type'] & self::AUTH_BEARER ) {
					\curl_setopt($c, CURLOPT_HTTPAUTH, CURLAUTH_BEARER);
					\curl_setopt($c, CURLOPT_XOAUTH2_BEARER, $this->auth['pass']);
				} else {
					$auth = 0;
					if ($this->auth['type'] & self::AUTH_BASIC) {
						$auth |= CURLAUTH_BASIC;
					}
					if ($this->auth['type'] & self::AUTH_DIGEST) {
						$auth |= CURLAUTH_DIGEST;
					}
					\curl_setopt($c, CURLOPT_HTTPAUTH, $auth);
					\curl_setopt($c, CURLOPT_USERPWD,  $this->auth['user'] . ':' . $this->auth['pass']);
				}
			}
			if ($this->public_destination_required) {
				// A proxy can resolve the URL itself and would invalidate our checked snapshot.
				if (!$this->public_destination) {
					throw new \RuntimeException('Missing public image destination');
				}
				$options = [CURLOPT_PROXY => ''];
				if (!\filter_var($this->public_destination['host'], FILTER_VALIDATE_IP)) {
					if (!\defined('CURLOPT_RESOLVE') || \curl_version()['version_number'] < 0x073b00) {
						throw new \RuntimeException('Public image destination pinning unavailable');
					}
					$addresses = \array_map(function ($ip) {
						return false !== \strpos($ip, ':') ? '[' . $ip . ']' : $ip;
					}, $this->public_destination['addresses']);
					$options[CURLOPT_RESOLVE] = [$this->public_destination['host'] . ':'
						. $this->public_destination['port'] . ':' . \implode(',', $addresses)];
				}
				if (!\curl_setopt_array($c, $options)) {
					throw new \RuntimeException('Cannot pin public image destination');
				}
			} else if ($this->proxy) {
				\curl_setopt($c, CURLOPT_PROXY, $this->proxy);
				if ($this->proxy_auth) {
					\curl_setopt($c, CURLOPT_PROXYUSERPWD, $this->proxy_auth);
				}
			}
			if ('HEAD' === $method) {
				\curl_setopt($c, CURLOPT_NOBODY, true);
			} else if ('GET' !== $method) {
				if ('POST' === $method) {
					\curl_setopt($c, CURLOPT_POST, true);
				} else {
					\curl_setopt($c, CURLOPT_CUSTOMREQUEST, $method);
				}
				if (!\is_null($body)) {
					\curl_setopt($c, CURLOPT_POSTFIELDS, $body);
				}
			}

			$success = \curl_exec($c);
			$code = \curl_getinfo($c, CURLINFO_RESPONSE_CODE);
			if (false === $success || !$code || !$this->headers_complete) {
				throw new \RuntimeException("Error " . \curl_errno($c) . ": " . \curl_error($c) . " for {$request_url}");
			}
			return new Response($request_url, $code, $this->response_headers, $this->response_body, $this->response_limit);
		} finally {
			\curl_close($c);
			$this->response_headers = array();
			$this->header_block = array();
			$this->header_bytes = 0;
			$this->headers_complete = false;
			$this->response_body = '';
		}
	}

	protected function fetchHeader($ch, $header)
	{
		$this->header_bytes += \strlen($header);
		if ($this->header_bytes > self::MAX_RESPONSE_HEADERS) {
			throw new \RuntimeException('HTTP response headers exceed limit');
		}
		if (\preg_match('/^HTTP\/\S+\s+([0-9]{3})\b/i', $header, $status)) {
			$this->limitResponseForStatus((int) $status[1]);
			$this->header_block = [];
			$this->headers_complete = false;
			$this->response_body = '';
			$this->resetResponseBody();
		}
		if (!\strlen(\rtrim($header))) {
			$this->response_headers = $this->header_block;
			$this->headers_complete = true;
		} else {
			$this->header_block[] = \rtrim($header);
		}
		return \strlen($header);
	}

	protected function fetchData($ch, $data)
	{
		return $this->receiveBody($data, $this->response_body);
	}

	protected function streamData($ch, $data)
	{
		return $this->receiveBody($data, $this->response_body);
	}

}
