<?php

if ('cli' !== PHP_SAPI) { exit(1); }
define('APP_VERSION', 'synthetic-contacts-csv');
$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries/';
require $libraries . 'polyfill/php8.php';
spl_autoload_register(static function ($class) use ($libraries) {
	$file = str_replace('\\', '/', $class) . '.php';
	foreach ([$file, strtolower($file)] as $path) {
		if (is_file($libraries . $path)) { require_once $libraries . $path; return; }
	}
});

// Preserve and count the existing array coercion warning; unexpected warnings fail the fixture.
$arrayWarnings = 0;
set_error_handler(static function ($severity, $message, $file, $line) use (&$arrayWarnings) {
	if (!(error_reporting() & $severity)) { return false; }
	if (E_WARNING === $severity && 'Array to string conversion' === $message) { ++$arrayWarnings; return true; }
	throw new ErrorException($message, 0, $severity, $file, $line);
});

$cases = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$results = [];
foreach ($cases as $index => $case) {
	$value = $case['value'];
	$properties = [
		['version', [], 'text', '4.0'], ['uid', [], 'text', 'synthetic-csv-' . $index],
		['fn', [], 'text', $value], ['n', [], 'text', [$value, $value, $value, '', '']],
		['nickname', [], 'text', $value], ['org', [], 'text', $value],
		['email', [], 'text', $value], ['note', [], 'text', $value],
		['url', [], 'text', $value], ['bday', [], 'text', $value],
		['tel', ['type' => ['cell']], 'text', $value],
		['email', ['type' => ['home']], 'text', $value], ['tel', ['type' => ['home']], 'text', $value],
		['email', ['type' => ['work']], 'text', $value], ['tel', ['type' => ['work']], 'text', $value],
		['adr', ['type' => ['home']], 'text', ['', '', $value, $value, $value, $value, $value]],
		['adr', ['type' => ['work']], 'text', ['', '', $value, $value, $value, $value, $value]]
	];
	$vCard = \Sabre\VObject\Reader::readJson(json_encode(['vcard', $properties], JSON_THROW_ON_ERROR));
	if (!empty($case['mixed'])) {
		$vCard->N->setParts([-1, ['One', 'Two'], null, '', '']);
		$vCard->getByType('ADR', 'HOME')->setParts(['', ['One'], ['Two'], ['City'], '', '', '']);
	}
	if (isset($case['invalid'])) { $vCard->FN = base64_decode($case['invalid'], true); }
	$before = $vCard->serialize();
	$original = ['fn' => base64_encode((string) $vCard->FN), 'note' => base64_encode((string) $vCard->NOTE)];
	$stream = fopen('php://temp', 'w+');
	$warningsBefore = $arrayWarnings;
	\RainLoop\Providers\AddressBook\Utils::VCardToCsv($stream, $vCard, true);
	rewind($stream);
	$csv = stream_get_contents($stream);
	rewind($stream);
	$rows = [];
	while (false !== ($row = fgetcsv($stream, 0, ',', '"', ''))) { $rows[] = array_map('base64_encode', $row); }
	fclose($stream);
	$result = ['csv' => base64_encode($csv), 'rows' => $rows, 'original' => $original,
		'unchanged' => $before === $vCard->serialize(), 'arrayWarnings' => $arrayWarnings - $warningsBefore];
	if (!empty($case['import'])) {
		$stream = fopen('php://temp', 'w+'); fwrite($stream, $csv); rewind($stream);
		$contacts = iterator_to_array(\RainLoop\Providers\AddressBook\Utils::CsvStreamToContacts($stream, ','));
		fclose($stream);
		$result['imported'] = array_map(static function ($contact) {
			return ['fn' => (string) $contact->vCard->FN, 'note' => (string) $contact->vCard->NOTE];
		}, $contacts);
	}
	$results[] = $result;
}
echo json_encode($results, JSON_THROW_ON_ERROR);
