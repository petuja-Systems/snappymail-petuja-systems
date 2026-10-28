<?php
// PHP's development server does not apply .htaccess. Keep the worker's
// existing root scope available in the synthetic local demo.
$root = dirname(__DIR__);
$metadata = json_decode((string) file_get_contents($root . '/snappymail/v/0.0.0/app/petuja-product.json'), true);
$version = is_array($metadata) ? ($metadata['version'] ?? null) : null;
if (is_string($version) && preg_match('/\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\z/', $version)) {
	$worker = '/snappymail/v/0.0.0/static/petuja-email-' . $version . '/js/serviceworker.js';
	if (parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) === $worker && is_file($root . $worker)) {
		header('Content-Type: application/javascript; charset=utf-8');
		header('Service-Worker-Allowed: /');
		readfile($root . $worker);
		return true;
	}
}
return false;
