<?php

namespace SnappyMail;

/**
 * Neutral HTTP transport for Core release metadata and downloads.
 */
class RepositoryTransport
{
	const BASE_URL = 'https://snappymail.eu/repository/v2/';

	private $baseUrl;

	public function __construct(string $baseUrl = self::BASE_URL)
	{
		$this->baseUrl = $baseUrl;
	}

	public function get(string $path) : string
	{
		$oHTTP = HTTP\Request::factory(/*'socket' or 'curl'*/);
		$oHTTP->proxy = \RainLoop\Api::Config()->Get('labs', 'curl_proxy', '');
		$oHTTP->proxy_auth = \RainLoop\Api::Config()->Get('labs', 'curl_proxy_auth', '');
		$oHTTP->timeout = 15; // timeout in seconds.
		$oResponse = $oHTTP->doRequest('GET', $this->baseUrl . $path);
		if (!$oResponse) {
			throw new \Exception('No HTTP response from repository');
		}
		if (200 !== $oResponse->status) {
			throw new \Exception($this->body2plain($oResponse->body), $oResponse->status);
		}
		return $oResponse->body;
	}

	public function download(string $path) : string
	{
		$sTmp = APP_PRIVATE_DATA . \md5(\microtime(true).$path) . \preg_replace('/^.*?(\\.[a-z\\.]+)$/Di', '$1', $path);
		$pDest = \fopen($sTmp, 'w+b');
		if (!$pDest) {
			throw new \Exception('Cannot create temp file: '.$sTmp);
		}

		try {
			$oHTTP = HTTP\Request::factory(/*'socket' or 'curl'*/);
			$oHTTP->proxy = \RainLoop\Api::Config()->Get('labs', 'curl_proxy', '');
			$oHTTP->proxy_auth = \RainLoop\Api::Config()->Get('labs', 'curl_proxy_auth', '');
			$oHTTP->max_response_kb = 0;
			// Trusted Core archives are streamed to disk, never buffered in memory.
			$oHTTP->timeout = 15; // timeout in seconds.
			$oHTTP->streamBodyTo($pDest);
			\set_time_limit(120);
			$oResponse = $oHTTP->doRequest('GET', $this->baseUrl . $path);
			\fclose($pDest);
			$pDest = null;

			if (!$oResponse) {
				throw new \Exception('No HTTP response from repository');
			}
			if (200 !== $oResponse->status) {
				$body = \file_get_contents($sTmp, false, null, 0, 1024 * 1024);
				throw new \Exception($this->body2plain($body), $oResponse->status);
			}
			return $sTmp;
		} catch (\Throwable $e) {
			if (\is_resource($pDest)) {
				\fclose($pDest);
			}
			if (\is_file($sTmp)) {
				\unlink($sTmp);
			}
			throw $e;
		}
	}

	private function body2plain(string $body) : string
	{
		return \trim(\strip_tags(
			\preg_match('@<body[^>]*>(.*)</body@si', $body, $match) ? $match[1] : $body
		));
	}
}
