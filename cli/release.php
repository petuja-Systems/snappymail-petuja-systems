#!/usr/bin/php
<?php
define('ROOT_DIR', dirname(__DIR__));
chdir(ROOT_DIR);

function releaseArchiveFailure(string $message): never
{
	foreach (['zip_destination', 'tar_destination'] as $destinationName) {
		if (isset($GLOBALS[$destinationName])) {
			$destination = $GLOBALS[$destinationName];
			@unlink($destination);
			@unlink($destination . '.gz');
		}
	}
	fwrite(STDERR, "Release archive error: {$message}\n");
	exit(1);
}

function releaseArchiveTimestamp(): int
{
	$sourceDateEpoch = getenv('SOURCE_DATE_EPOCH');
	if (false === $sourceDateEpoch || '' === $sourceDateEpoch) {
		$timestampOutput = [];
		exec('git -C ' . escapeshellarg(ROOT_DIR) . ' log -1 --format=%ct 2>/dev/null', $timestampOutput, $exitCode);
		if (0 !== $exitCode || !isset($timestampOutput[0])) {
			releaseArchiveFailure('set SOURCE_DATE_EPOCH or run from a Git checkout to provide a stable archive timestamp');
		}
		$sourceDateEpoch = trim($timestampOutput[0]);
	}

	$timestamp = filter_var($sourceDateEpoch, FILTER_VALIDATE_INT, [
		'options' => ['min_range' => 315532800, 'max_range' => 4354819198]
	]);
	if (false === $timestamp) {
		releaseArchiveFailure('SOURCE_DATE_EPOCH must be a Unix timestamp supported by the ZIP format');
	}

	return $timestamp;
}

function releaseArchiveSourcePath(string $sourcePath): string
{
	$sourcePath = str_replace('\\', '/', $sourcePath);
	if ('' === $sourcePath || str_starts_with($sourcePath, '/') || preg_match('~(?:^|/)\.\.?(/|$)~', $sourcePath)) {
		releaseArchiveFailure("unsafe release source path: {$sourcePath}");
	}

	$rootPath = realpath(ROOT_DIR);
	if (false === $rootPath) {
		releaseArchiveFailure('unable to resolve the release source root');
	}

	$path = $rootPath;
	foreach (explode('/', $sourcePath) as $component) {
		$path .= DIRECTORY_SEPARATOR . $component;
		if (is_link($path)) {
			releaseArchiveFailure("symbolic links are not allowed in release sources: {$sourcePath}");
		}
	}

	$resolvedPath = realpath($path);
	if (false === $resolvedPath || !str_starts_with($resolvedPath, $rootPath . DIRECTORY_SEPARATOR)) {
		releaseArchiveFailure("release source is missing or outside the source root: {$sourcePath}");
	}

	return $resolvedPath;
}

function releaseArchiveEnsureOutputDirectory(string $relativePath): void
{
	$relativePath = str_replace('\\', '/', $relativePath);
	if ('' === $relativePath || str_starts_with($relativePath, '/') || preg_match('~(?:^|/)\.\.?(/|$)~', $relativePath)) {
		releaseArchiveFailure("unsafe release output path: {$relativePath}");
	}
	$relativePath = trim($relativePath, '/');

	$rootPath = realpath(ROOT_DIR);
	if (false === $rootPath) {
		releaseArchiveFailure('unable to resolve the release source root');
	}

	$path = $rootPath;
	foreach (explode('/', $relativePath) as $component) {
		$path .= DIRECTORY_SEPARATOR . $component;
		if (is_link($path)) {
			releaseArchiveFailure("symbolic links are not allowed in release output paths: {$relativePath}");
		}
		if (!is_dir($path) && !@mkdir($path, 0755)) {
			releaseArchiveFailure("unable to create release output directory: {$relativePath}");
		}
		$resolvedPath = realpath($path);
		if (false === $resolvedPath || !str_starts_with($resolvedPath, $rootPath . DIRECTORY_SEPARATOR)) {
			releaseArchiveFailure("release output path is outside the source root: {$relativePath}");
		}
		$path = $resolvedPath;
	}
}

function releaseZipSetMetadata(ZipArchive $zip, string $name, int $type, int $permissions, int $timestamp): void
{
	$entryName = (0040000 === $type) ? rtrim($name, '/') . '/' : $name;
	$externalAttributes = (($type | $permissions) << 16);
	if (!$zip->setExternalAttributesName($entryName, ZipArchive::OPSYS_UNIX, $externalAttributes)
		|| !$zip->setMtimeName($entryName, $timestamp)) {
		releaseArchiveFailure("unable to set canonical metadata for ZIP entry: {$entryName}");
	}
}

function releaseZipAddFile(ZipArchive $zip, string $sourcePath, string $name, int $timestamp): void
{
	$sourcePath = releaseArchiveSourcePath($sourcePath);
	if (!is_file($sourcePath)) {
		releaseArchiveFailure("release source is not a regular file: {$name}");
	}

	$versionPrefix = 'snappymail/v/' . $GLOBALS['package']->version . '/';
	$relativePath = str_starts_with($name, $versionPrefix) ? substr($name, strlen($versionPrefix)) : '';
	static $executablePaths = [
		'app/libraries/RainLoop/Providers/Identities.php',
		'app/libraries/RainLoop/Providers/Identities/FileIdentities.php',
		'app/libraries/RainLoop/Providers/Identities/IIdentities.php',
		'app/libraries/snappymail/http/csp.php',
		'imapsync.php',
	];
	$permissions = in_array($relativePath, $executablePaths, true) ? 0755 : 0644;

	if (!$zip->addFile($sourcePath, $name)) {
		releaseArchiveFailure("unable to add ZIP file: {$name}");
	}
	releaseZipSetMetadata($zip, $name, 0100000, $permissions, $timestamp);
}

function releaseZipAddDirectory(ZipArchive $zip, string $sourcePath, string $name, int $timestamp): void
{
	$sourcePath = releaseArchiveSourcePath($sourcePath);
	if (!is_dir($sourcePath)) {
		releaseArchiveFailure("release source is not a directory: {$name}");
	}

	if (!$zip->addEmptyDir($name)) {
		releaseArchiveFailure("unable to add ZIP directory: {$name}");
	}
	releaseZipSetMetadata($zip, $name, 0040000, 0755, $timestamp);
}

function releaseZipAddString(ZipArchive $zip, string $name, string $contents, int $timestamp): void
{
	if (!$zip->addFromString($name, $contents)) {
		releaseArchiveFailure("unable to add generated ZIP file: {$name}");
	}
	releaseZipSetMetadata($zip, $name, 0100000, 0644, $timestamp);
}

$options = getopt('', ['aur','docker','skip-gulp','debian','sign']);

$gulp = trim(`which gulp`);
if (!$gulp) {
	exit('gulp not installed, run as root: npm install --global gulp-cli');
}

$packageContents = file_get_contents(releaseArchiveSourcePath('package.json'));
$package = false !== $packageContents ? json_decode($packageContents) : null;
if (!is_object($package) || !isset($package->version) || !is_string($package->version)
	|| !preg_match('/\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\z/', $package->version)) {
	releaseArchiveFailure('package.json must provide a valid SnappyMail version');
}
$product = json_decode((string) file_get_contents(releaseArchiveSourcePath('snappymail/v/0.0.0/app/petuja-product.json')));
if (!is_object($product) || ($product->product ?? null) !== 'petuja.email'
	|| !is_string($product->version ?? null)
	|| !preg_match('/\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\z/', $product->version)
	|| ($product->snappymailVersion ?? null) !== $package->version) {
	releaseArchiveFailure('invalid petuja.email product metadata');
}
$staticNamespace = 'petuja-email-' . $product->version;

/**
 * Update files that contain version
 */
// cloudron
$file = releaseArchiveSourcePath('integrations/cloudron/Dockerfile');
file_put_contents($file, preg_replace('/VERSION=[0-9.]+/', "VERSION={$package->version}", file_get_contents($file)));
$file = releaseArchiveSourcePath('integrations/cloudron/DESCRIPTION.md');
file_put_contents($file, preg_replace('/<upstream>[^<]*</', "<upstream>{$package->version}<", file_get_contents($file)));
// virtualmin
$file = releaseArchiveSourcePath('integrations/virtualmin/snappymail.pl');
file_put_contents($file, preg_replace('/return \\( "[0-9]+\\.[0-9]+\\.[0-9]+" \\)/', "return ( \"{$package->version}\" )", file_get_contents($file)));

// Arch User Repository
// https://aur.archlinux.org/packages/snappymail/
$options['aur'] = isset($options['aur']);

// Docker build
$options['docker'] = isset($options['docker']);
if ($options['docker'] && !($docker = trim(`which docker`))) {
	exit('docker not found');
}
if ($options['docker'] && $options['aur']) {
	exit('Conflict between docker and aur');
}

$destPath = "build/dist/releases/webmail/{$package->version}/";
releaseArchiveEnsureOutputDirectory($destPath);

$zip_destination = "{$destPath}snappymail-{$package->version}.zip";
$tar_destination = "{$destPath}snappymail-{$package->version}.tar";

@unlink($zip_destination);
@unlink($tar_destination);
@unlink("{$tar_destination}.gz");

if (!isset($options['skip-gulp'])) {
	echo "\x1b[33;1m === Gulp === \x1b[0m\n";
	passthru($gulp, $return_var);
	if ($return_var) {
		exit("gulp failed with error code {$return_var}\n");
	}

	$cmddir = escapeshellcmd(ROOT_DIR) . '/snappymail/v/0.0.0/static';

	if ($gzip = trim(`which gzip`)) {
		echo "\x1b[33;1m === Gzip *.js and *.css === \x1b[0m\n";
		passthru("{$gzip} -n -k -f --best {$cmddir}/js/*.js", $return_var);
		if ($return_var) releaseArchiveFailure("gzip failed with error code {$return_var}\n");
		passthru("{$gzip} -n -k -f --best {$cmddir}/js/min/*.js", $return_var);
		if ($return_var) releaseArchiveFailure("gzip failed with error code {$return_var}\n");
		passthru("{$gzip} -n -k -f --best {$cmddir}/css/admin*.css", $return_var);
		if ($return_var) releaseArchiveFailure("gzip failed with error code {$return_var}\n");
		passthru("{$gzip} -n -k -f --best {$cmddir}/css/app*.css", $return_var);
		if ($return_var) releaseArchiveFailure("gzip failed with error code {$return_var}\n");
		unlink(ROOT_DIR . '/snappymail/v/0.0.0/static/js/boot.js.gz');
		unlink(ROOT_DIR . '/snappymail/v/0.0.0/static/js/min/boot.min.js.gz');
	}

	if ($brotli = trim(`which brotli`)) {
		echo "\x1b[33;1m === Brotli *.js and *.css === \x1b[0m\n";
		foreach (['js/*.js', 'js/min/*.js', 'css/admin*.css', 'css/app*.css'] as $pattern) {
			passthru("{$brotli} -f -k --best {$cmddir}/{$pattern}", $return_var);
			if ($return_var) releaseArchiveFailure("brotli failed with error code {$return_var}");
		}
		unlink(ROOT_DIR . '/snappymail/v/0.0.0/static/js/boot.js.br');
		unlink(ROOT_DIR . '/snappymail/v/0.0.0/static/js/min/boot.min.js.br');
	}
}

// Compression happens after Gulp, so refresh the complete namespaced tree,
// including all compressed variants, before producing either archive.
passthru(escapeshellarg($gulp) . ' prepareProductStatic', $return_var);
if ($return_var) releaseArchiveFailure("static namespace preparation failed with error code {$return_var}");
releaseArchiveSourcePath('snappymail/v/0.0.0/static/' . $staticNamespace);
foreach (['css/app.min.css', 'css/admin.min.css', 'css/boot.min.css',
	'js/min/boot.min.js', 'js/min/libs.min.js', 'js/min/app.min.js', 'js/min/admin.min.js',
	'js/serviceworker.js', 'manifest.json', 'images/petuja-systems-logo.svg'] as $asset) {
	if (!is_file(releaseArchiveSourcePath('snappymail/v/0.0.0/static/' . $staticNamespace . '/' . $asset))) {
		releaseArchiveFailure("missing required static asset: {$asset}");
	}
}

// Temporary rename folder to speed up PharData
//if (!rename('snappymail/v/0.0.0', "snappymail/v/{$package->version}")){
if (!rename('snappymail/v/0.0.0', "snappymail/v/{$package->version}")) {
	exit('Failed to temporary rename snappymail/v/0.0.0');
}
register_shutdown_function(function(){
	// Rename folder back to original
	@rename("snappymail/v/{$GLOBALS['package']->version}", 'snappymail/v/0.0.0');
});

echo "\x1b[33;1m === Zip/Tar === \x1b[0m\n";

$zipTimestamp = releaseArchiveTimestamp();
putenv('TZ=UTC');
date_default_timezone_set('UTC');

$zip = new ZipArchive();
if (!$zip->open($zip_destination, ZIPARCHIVE::CREATE)) {
	exit("Failed to create {$zip_destination}");
}

$tar = new PharData($tar_destination);
$tar->startBuffering();

$files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('snappymail/v'), RecursiveIteratorIterator::SELF_FIRST);
$archiveEntries = [];
foreach ($files as $file) {
	if ('.' !== $file->getFilename() && '..' !== $file->getFilename()) {
		$name = str_replace('\\', '/', $file->getPathname());
		$staticPrefix = 'snappymail/v/' . $package->version . '/static/';
		if (str_starts_with($name, $staticPrefix)) {
			$relative = substr($name, strlen($staticPrefix));
			$top = explode('/', $relative, 2)[0];
			if ($top !== $staticNamespace) {
				continue;
			}
		}
		$archiveEntries[] = [
			'name' => $name,
			'path' => $file->getPathname(),
			'is_directory' => $file->isDir(),
			'is_file' => $file->isFile(),
		];
	}
}
usort($archiveEntries, static fn (array $left, array $right): int => strcmp($left['name'], $right['name']));

foreach ($archiveEntries as $entry) {
	$tarName = $options['docker'] ? substr($entry['name'], strlen('snappymail/')) : $entry['name'];
	if ($entry['is_directory']) {
		releaseZipAddDirectory($zip, $entry['path'], $entry['name'], $zipTimestamp);
		$tar->addEmptyDir($tarName);
	} elseif ($entry['is_file']) {
		releaseZipAddFile($zip, $entry['path'], $entry['name'], $zipTimestamp);
		$tar->addFile($entry['path'], $tarName);
	} else {
		releaseArchiveFailure("unsupported release source type: {$entry['name']}");
	}
}

//$zip->addFile('cli/upgrade.sh');
//$tar->addFile('cli/upgrade.sh');

releaseZipAddFile($zip, 'data/.htaccess', 'data/.htaccess', $zipTimestamp);
$tar->addFile('data/.htaccess');

releaseZipAddString($zip, 'data/VERSION', $package->version, $zipTimestamp);
$tar->addFromString('data/VERSION', $package->version);

releaseZipAddFile($zip, 'data/README.md', 'data/README.md', $zipTimestamp);
$tar->addFile('data/README.md');

if ($options['aur']) {
	$data = '<?php
function __get_custom_data_full_path()
{
	return \'/var/lib/snappymail\';
}
';
	releaseZipAddString($zip, 'include.php', $data, $zipTimestamp);
	$tar->addFromString('include.php', $data);
} else {
	releaseZipAddFile($zip, '_include.php', '_include.php', $zipTimestamp);
	$tar->addFile('_include.php');
}

releaseZipAddFile($zip, '.htaccess', '.htaccess', $zipTimestamp);
$tar->addFile('.htaccess');

$index = file_get_contents(releaseArchiveSourcePath('index.php'));
if (false === $index) {
	releaseArchiveFailure('unable to read index.php');
}
$index = str_replace('0.0.0', $package->version, $index);
releaseZipAddString($zip, 'index.php', $index, $zipTimestamp);
$tar->addFromString('index.php', $index);

releaseZipAddFile($zip, 'README.md', 'README.md', $zipTimestamp);
$tar->addFile('README.md');

// Keep the application license with distributable release archives.
releaseZipAddFile($zip, 'LICENSE', 'LICENSE', $zipTimestamp);
$tar->addFile('LICENSE');
releaseZipAddFile($zip, 'vendors/lucide/LICENSE', 'LICENSES/lucide.txt', $zipTimestamp);
$tar->addFile('vendors/lucide/LICENSE', 'LICENSES/lucide.txt');
releaseZipAddFile($zip, 'vendors/squire2/LICENSE', 'LICENSES/squire.txt', $zipTimestamp);
$tar->addFile('vendors/squire2/LICENSE', 'LICENSES/squire.txt');
releaseZipAddFile($zip, 'vendors/openpgp-5/LICENSE', 'LICENSES/openpgp.txt', $zipTimestamp);
$tar->addFile('vendors/openpgp-5/LICENSE', 'LICENSES/openpgp.txt');
releaseZipAddFile($zip, 'vendors/THIRD_PARTY_NOTICES.txt', 'LICENSES/third-party.txt', $zipTimestamp);
$tar->addFile('vendors/THIRD_PARTY_NOTICES.txt', 'LICENSES/third-party.txt');

if (!$zip->close()) {
	releaseArchiveFailure("unable to finish ZIP archive: {$zip_destination}");
}

$tar->stopBuffering();
unset($tar);
releaseArchiveSourcePath('scripts/normalize-release-tar.py');
putenv('PETUJA_RELEASE_TAR=' . $tar_destination);
putenv('PETUJA_RELEASE_EPOCH=' . $zipTimestamp);
passthru(escapeshellarg($gulp) . ' normalizeReleaseTar', $return_var);
if ($return_var || !is_file($tar_destination . '.gz')) {
	releaseArchiveFailure('unable to create reproducible TAR.GZ archive');
}
unlink($tar_destination);
$tar_destination .= '.gz';

echo "{$zip_destination} created\n{$tar_destination} created\n";

rename("snappymail/v/{$package->version}", 'snappymail/v/0.0.0');

file_put_contents("{$destPath}core.json", '{
	"version": "'.$package->version.'",
	"file": "../latest.tar.gz",
	"warnings": []
}');

// Arch User Repository
if ($options['aur']) {
	// extension_loaded('blake2')
	if (!function_exists('b2sum') && $b2sum = trim(`which b2sum`)) {
		function b2sum($file) {
			$file = escapeshellarg($file);
			exec("b2sum --binary {$file} 2>&1", $output, $exitcode);
			$output = explode(' ', implode("\n", $output));
			return $output[0];
		}
	}

	$b2sums = function_exists('b2sum') ? [
		b2sum($tar_destination),
		b2sum(ROOT_DIR . '/build/arch/snappymail.sysusers'),
		b2sum(ROOT_DIR . '/build/arch/snappymail.tmpfiles')
	] : [];

	file_put_contents('build/arch/.SRCINFO', 'pkgbase = snappymail
	pkgdesc = modern PHP webmail client
	pkgver = '.$package->version.'
	pkgrel = 1
	url = https://github.com/the-djmaze/snappymail
	arch = any
	license = AGPL3
	makedepends = php
	makedepends = nodejs
	makedepends = yarn
	makedepends = gulp
	depends = php-fpm
	optdepends = mariadb: storage backend for contacts
	optdepends = php-pgsql: storage backend for contacts
	optdepends = php-sqlite: storage backend for contacts
	source = snappymail-'.$package->version.'.tar.gz::https://github.com/the-djmaze/snappymail/archive/v'.$package->version.'.tar.gz
	source = snappymail.sysusers
	source = snappymail.tmpfiles
	b2sums = '.implode("\n	b2sums = ", $b2sums).'

pkgname = snappymail
');

	$file = ROOT_DIR . '/build/arch/PKGBUILD';
	if (is_file($file)) {
		$PKGBUILD = file_get_contents($file);
		$PKGBUILD = preg_replace('/pkgver=[0-9.]+/', "pkgver={$package->version}", $PKGBUILD);
		$PKGBUILD = preg_replace('/b2sums=\\([^)]+\\)/s', "b2sums=('".implode("'\n        '", $b2sums)."')", $PKGBUILD);
		file_put_contents($file, $PKGBUILD);
	}
}
// Debian Repository
else if (isset($options['debian'])) {
	require(ROOT_DIR . '/build/deb.php');
}
// Docker build
else if ($options['docker']) {
	echo "\x1b[33;1m === Docker === \x1b[0m\n";
	$zip_filename = "snappymail-{$package->version}.zip";
	copy($zip_destination, "./.docker/release/{$zip_filename}");
	if ($docker) {
		passthru("{$docker} build --pull " . ROOT_DIR . "/.docker/release/ --build-arg FILES_ZIP={$zip_filename} -t snappymail:{$package->version}");
	} else {
		echo "Docker not installed!\n";
	}
}

if (isset($options['sign'])) {
	echo "\x1b[33;1m === PGP Sign === \x1b[0m\n";
	passthru('gpg --local-user 1016E47079145542F8BA133548208BA13290F3EB --armor --detach-sign '.escapeshellarg($tar_destination), $return_var);
	passthru('gpg --local-user 1016E47079145542F8BA133548208BA13290F3EB --armor --detach-sign '.escapeshellarg($zip_destination), $return_var);
	if (isset($options['debian'])) {
		passthru('gpg --local-user 1016E47079145542F8BA133548208BA13290F3EB --armor --detach-sign '
			. escapeshellarg(ROOT_DIR . "/build/dist/releases/webmail/{$package->version}/" . basename(DEB_DEST_DIR.'.deb')), $return_var);
		// https://github.com/the-djmaze/snappymail/issues/185#issuecomment-1059420588
		passthru('gpg --local-user 1016E47079145542F8BA133548208BA13290F3EB --digest-algo SHA512 --clearsign --output '
			. escapeshellarg(ROOT_DIR . "/build/dist/releases/webmail/{$package->version}/InRelease") . ' '
			. escapeshellarg(ROOT_DIR . "/build/dist/releases/webmail/{$package->version}/Release"), $return_var);
		passthru('gpg --local-user 1016E47079145542F8BA133548208BA13290F3EB --digest-algo SHA512 -abs --output '
			. escapeshellarg(ROOT_DIR . "/build/dist/releases/webmail/{$package->version}/Release.gpg") . ' '
			. escapeshellarg(ROOT_DIR . "/build/dist/releases/webmail/{$package->version}/Release"), $return_var);
	}
}
