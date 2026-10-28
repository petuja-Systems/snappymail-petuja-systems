<?php

// Only the owned-loopback test server may run this synthetic metadata router.
if ('cli-server' !== PHP_SAPI) {
	exit(1);
}
require __DIR__ . '/backup-restore-prepend.php';

$cases = [
	'http' => [],
	'port443' => ['SERVER_PORT' => '443'],
	'on' => ['HTTPS' => 'on'],
	'upper-on' => ['HTTPS' => 'ON'],
	'one' => ['HTTPS' => '1'],
	'scheme' => ['REQUEST_SCHEME' => 'https'],
	'upper-scheme' => ['REQUEST_SCHEME' => 'HtTpS'],
	'offload' => ['HTTPS' => 'on', 'REQUEST_SCHEME' => 'http'],
	'off-scheme' => ['HTTPS' => 'off', 'REQUEST_SCHEME' => 'https'],
	'off' => ['HTTPS' => 'off'],
	'upper-off' => ['HTTPS' => 'OFF'],
	'empty' => ['HTTPS' => ''],
	'unknown' => ['HTTPS' => 'false'],
	'padded' => ['HTTPS' => ' on '],
	'array' => ['HTTPS' => ['on']],
	'boolean' => ['HTTPS' => true],
	'integer' => ['HTTPS' => 1],
	'scheme-array' => ['REQUEST_SCHEME' => ['https']]
];
$case = $_GET['case'] ?? 'http';
$mode = $_GET['mode'] ?? 'inspect';
$sameSite = $_GET['sameSite'] ?? 'Strict';
if (!isset($cases[$case]) || !in_array($mode, ['inspect', 'clear', 'split', 'page'], true)
	|| !in_array($sameSite, ['Strict', 'Lax', 'None', 'none', 'nOnE'], true)) {
	http_response_code(400);
	exit;
}
$force = '1' === ($_GET['force'] ?? '0');
$secure = '1' === ($_GET['secure'] ?? '0');
unset($_SERVER['HTTPS'], $_SERVER['REQUEST_SCHEME']);
foreach ($cases[$case] as $name => $value) {
	$_SERVER[$name] = $value;
}

// Bootstrap the real app with disposable storage; CGI values are fixture data,
// not values promoted from request headers. The underlying server is plain HTTP.
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require dirname(__DIR__, 2) . '/index.php';
$config = \RainLoop\Api::Config();
$config->Set('security', 'force_https', $force);
$config->Set('security', 'cookie_samesite', $sameSite);
$config->Set('labs', 'cookie_default_secure', $secure);

if ('page' === $mode) {
	$_SERVER['QUERY_STRING'] = '';
	$_GET = [];
	\RainLoop\Service::Handle();
	return true;
}

if ('clear' === $mode) {
	$_COOKIE['m7_transport'] = 'harmless';
	\SnappyMail\Cookies::clear('m7_transport');
} else {
	\SnappyMail\Cookies::set('m7_transport', 'split' === $mode ? str_repeat('a', 9000) : 'harmless');
}
$http = \MailSo\Base\Http::SingletonInstance();
header('Content-Type: application/json');
echo json_encode([
	'transport' => $http->IsSecure(),
	'withoutProxy' => $http->IsSecure(false),
	'scheme' => $http->GetScheme(),
	'normalizedHttps' => $_SERVER['HTTPS'] ?? null,
	'cookieSecure' => \SnappyMail\Cookies::isSecure()
], JSON_THROW_ON_ERROR);
return true;
