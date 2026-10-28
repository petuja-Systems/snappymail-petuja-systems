<?php

$dataPath = rtrim($argv[1], '\\/').DIRECTORY_SEPARATOR;
$indexRoot = rtrim($argv[2], '\\/').DIRECTORY_SEPARATOR;
define('APP_DATA_FOLDER_PATH', $dataPath);
define('APP_INDEX_ROOT_PATH', $indexRoot);
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require $argv[3];

class M3A4AutoconfigFixtureStream
{
	public $context;
	public static array $requests = [];
	private string $data = '';
	private int $position = 0;

	public function stream_open($path, $mode, $options, &$openedPath) : bool
	{
		self::$requests[] = $path;
		$this->data = <<<'XML'
<clientConfig version="1.1">
  <emailProvider id="example.test">
    <domain>example.test</domain>
    <incomingServer type="imap">
      <hostname>imap.example.test</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.test</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
XML;
		return true;
	}

	public function stream_read(int $count) : string
	{
		$chunk = substr($this->data, $this->position, $count);
		$this->position += strlen($chunk);
		return $chunk;
	}

	public function stream_eof() : bool
	{
		return $this->position >= strlen($this->data);
	}

	public function stream_stat() : array
	{
		return [];
	}
}

if (!stream_wrapper_unregister('https') || !stream_wrapper_register('https', M3A4AutoconfigFixtureStream::class)) {
	exit('Unable to register the local HTTPS fixture stream');
}

try {
	$config = \RainLoop\Providers\Domain\Autoconfig::discover('alice@example.test');
} finally {
	stream_wrapper_restore('https');
}

echo json_encode([
	'config' => $config,
	'requests' => M3A4AutoconfigFixtureStream::$requests
]);
