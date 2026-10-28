<?php

$repo = dirname(__DIR__, 2);
require $repo . '/tests/fixtures/backup-restore-prepend.php';
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'] = '127.0.0.1';
require $repo . '/index.php';

$protocol = getenv('PETUJA_MAIL_TLS_PROTOCOL');
$transport = getenv('PETUJA_MAIL_TLS_TRANSPORT');
$mode = getenv('PETUJA_MAIL_TLS_MODE');
$ca = getenv('PETUJA_MAIL_TLS_CA');
$section = ['imap' => 'IMAP', 'smtp' => 'SMTP', 'sieve' => 'Sieve'][$protocol];
$data = json_decode(file_get_contents($repo . '/snappymail/v/0.0.0/app/domains/default.json'), true, 512, JSON_THROW_ON_ERROR);
$data[$section]['host'] = getenv('PETUJA_MAIL_TLS_HOST');
$data[$section]['port'] = (int) getenv('PETUJA_MAIL_TLS_PORT');
$data[$section]['type'] = ['implicit' => 1, 'starttls' => 2, 'none' => 0, 'auto' => 9][$transport];
$data[$section]['timeout'] = 5;
// Reproduce an old persisted configuration, including undeclared peer metadata.
$data[$section]['ssl'] = [
	'verify_peer' => false,
	'verify_peer_name' => false,
	'allow_self_signed' => true,
	'peer_name' => 'wrong.example.invalid',
	'security_level' => 2,
	'SNI_enabled' => true,
	'disable_compression' => true
];
if ($ca && !in_array($mode, ['system', 'ini'], true)) {
	$data[$section]['ssl']['capath' === $mode ? 'capath' : 'cafile'] = 'capath' === $mode ? dirname($ca) : $ca;
}
$provider = new \RainLoop\Providers\Domain\DefaultDomain(APP_PRIVATE_DATA . 'domains');
if ('ini' === $mode) {
	$legacy = [];
	foreach (['imap', 'smtp', 'sieve'] as $name) {
		$legacy[$name . '_host'] = $data[$section]['host'];
		$legacy[$name . '_port'] = $data[$section]['port'];
		$legacy[$name . '_secure'] = 'implicit' === $transport ? 'SSL' : 'TLS';
	}
	$domain = \RainLoop\Model\Domain::fromIniArray('fixture.invalid', $legacy);
} else if ('system' === $mode) {
	$domain = \RainLoop\Model\Domain::fromArray('fixture.invalid', $data);
} else {
	$file = 'wildcard' === $mode ? '_wildcard_.invalid' : 'fixture.invalid';
	$path = APP_PRIVATE_DATA . 'domains/' . $file . '.json';
	$json = json_encode($data, JSON_THROW_ON_ERROR);
	file_put_contents($path, $json);
	if ('alias' === $mode) {
		file_put_contents(APP_PRIVATE_DATA . 'domains/alias.invalid.alias', 'fixture.invalid');
	}
	$domain = $provider->Load('alias' === $mode ? 'alias.invalid' : ('wildcard' === $mode ? 'sub.invalid' : 'fixture.invalid'), true);
	if ($json !== file_get_contents($path)) {
		throw new \RuntimeException('TLS normalization must not rewrite private domain data');
	}
}
$getSettings = ['imap' => 'ImapSettings', 'smtp' => 'SmtpSettings', 'sieve' => 'SieveSettings'][$protocol];
$settings = $domain->$getSettings();
if ('direct' === $mode) {
	$settings->ssl->verify_peer = false;
	$settings->ssl->verify_peer_name = false;
	$settings->ssl->allow_self_signed = true;
}
$classes = ['imap' => \MailSo\Imap\ImapClient::class, 'smtp' => \MailSo\Smtp\SmtpClient::class, 'sieve' => \MailSo\Sieve\SieveClient::class];
$client = new $classes[$protocol]();
if ('smtp' === $protocol) {
	$settings->Ehlo = 'fixture.invalid';
}
try {
	$client->Connect($settings);
	$context = $client->StreamContextParams()['options']['ssl'];
	$result = [
		'connected' => true,
		'encrypted' => $client->Encrypted(),
		'verify_peer' => $context['verify_peer'],
		'verify_peer_name' => $context['verify_peer_name'],
		'allow_self_signed' => $context['allow_self_signed'],
		'custom_CA_preserved' => !$ca || 'system' === $mode
			|| ($context['cafile'] ?? '') === $ca
			|| ($context['capath'] ?? '') === dirname($ca),
		'security_level' => $context['security_level']
	];
	$client->Disconnect();
} catch (\Throwable $error) {
	$result = ['rejected' => true];
}
echo json_encode($result, JSON_THROW_ON_ERROR);
