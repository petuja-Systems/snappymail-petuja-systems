<?php

namespace SnappyMail\Storage;

/**
 * Account identity, not a lossy filename, owns storage. Legacy bindings require
 * an offline operator attestation; authentication is never ownership evidence.
 * The private registry and directory skeletons survive account-data deletion.
 */
final class AccountPath
{
	private string $base;
	private string $namespace;
	private ?string $localDemoRoot = null;
	private static array $gates = [];
	private static array $windowsAclVerified = [];
	private static array $windowsAclAbsentVerified = [];
	private const MAIN_DIRS = ['.sessions', '.sign_me', '.pgp', '.gnupg', '.smime', '.files'];
	private const MAX_REGISTRY_BYTES = 8388608;

	public function __construct(string $base, bool $createParent = true)
	{
		$base = \rtrim($base, '/\\');
		$this->localDemoRoot = $this->detectLocalDemoRoot($base);
		$windowsBaseKey = \strtolower(\str_replace('/', '\\', $base));
		if ('Windows' === PHP_OS_FAMILY && !$this->localDemoRoot && !isset(self::$windowsAclVerified[$windowsBaseKey])) {
			$verified = $this->runWindowsAclHelper('VerifyStorageBasePath', $base);
			if (!\in_array($verified, ['OK', 'MISSING'], true)) {
				$this->fail();
			}
			if ('OK' === $verified) {
				self::$windowsAclVerified[$windowsBaseKey] = true;
			}
		}
		$parent = \realpath(\dirname($base));
		if (false === $parent && $createParent) {
			\MailSo\Base\Utils::mkdir(\dirname($base));
			if ('Windows' === PHP_OS_FAMILY && !$this->localDemoRoot) {
				$verified = $this->runWindowsAclHelper('VerifyStorageBasePath', $base);
				if (!\in_array($verified, ['OK', 'MISSING'], true)) {
					$this->fail();
				}
				if ('OK' === $verified) {
					self::$windowsAclVerified[$windowsBaseKey] = true;
				}
			}
			$parent = \realpath(\dirname($base));
		}
		if (false === $parent || !\is_dir($parent)) {
			$this->fail();
		}
		$this->base = $parent.'/'.\basename($base);
		$this->namespace = $this->base.'-v2';
	}

	private function fail() : void
	{
		throw new \RuntimeException('Account storage unavailable; operator ownership review required');
	}

	public static function Identity(string $main, string $child = '') : string
	{
		foreach ([$main, $child] as $value) {
			if ('' !== $value && (\strlen($value) > 1024 || !\preg_match('//u', $value)
				|| \preg_match('/[\x00-\x1f\x7f]/', $value) || false === \strpos($value, '@')
				|| '@' === $value[0] || '@' === \substr($value, -1))) {
				throw new \InvalidArgumentException('Invalid account storage identity');
			}
		}
		if ('' === $main) {
			throw new \InvalidArgumentException('Invalid account storage identity');
		}
		return \hash('sha256', "petuja.email/account-storage/v2\0".\pack('N', \strlen($main)).$main
			.\pack('N', \strlen($child)).$child);
	}

	/** No links, special files, cross-device objects or multiply-linked files. */
	private function stat(string $path, ?int $device = null, bool $allowMissing = false) : ?array
	{
		\clearstatcache(true, $path);
		$stat = @\lstat($path);
		$isDirectory = $stat && 0040000 === ($stat['mode'] & 0170000);
		if (!$stat || !\in_array($stat['mode'] & 0170000, [0040000, 0100000], true)
			|| (null !== $device && $stat['dev'] !== $device)
			|| (0100000 === ($stat['mode'] & 0170000) && 1 !== $stat['nlink'])
			|| ($isDirectory ? !$this->readableDirectory($path) : !\is_readable($path))) {
			$this->fail();
		}
		if (!$this->assertWindowsAcl($path, $allowMissing)) {
			return null;
		}
		return $stat;
	}

	private function readableDirectory(string $path) : bool
	{
		if ('Windows' === PHP_OS_FAMILY) {
			$handle = @\opendir($path);
			if (!$handle) {
				return false;
			}
			\closedir($handle);
			return true;
		}
		return \is_readable($path);
	}

	/** Windows chmod mode bits are synthetic; verify the actual ACL chain instead. */
	private function privatePermissions(string $path, array $stat) : bool
	{
		if ('Windows' === PHP_OS_FAMILY) {
			// stat() invokes the ACL verifier for this exact object and its ancestors.
			return true;
		}
		return 0 === ($stat['mode'] & 0077);
	}

	/** ACL verification is part of the storage boundary, not a launcher trust marker. */
	private function assertWindowsAcl(string $path, bool $allowMissing = false) : bool
	{
		if ('Windows' !== PHP_OS_FAMILY) {
			return true;
		}
		if ($this->localDemoRoot && $this->isLocalDemoPath($path, $allowMissing)) {
			return true;
		}
		$key = \strtolower(\str_replace('/', '\\', $path));
		if ($allowMissing && isset(self::$windowsAclAbsentVerified[$key])) {
			return false;
		}
		if (isset(self::$windowsAclVerified[$key])) {
			return true;
		}
		$result = $this->runWindowsAclHelper($allowMissing ? 'VerifyStoragePathOrMissing' : 'VerifyStoragePath', $path);
		if ('MISSING' === $result && $allowMissing) {
			// The verified private parent ACL is stable for this PHP request and
			// prevents untrusted identities from creating or replacing the leaf.
			self::$windowsAclAbsentVerified[$key] = true;
			return false;
		}
		if ('OK' !== $result) {
			$this->fail();
		}
		// PHP request state is reset between requests; protected ACLs prevent
		// untrusted identities from changing this validated path during one request.
		self::$windowsAclVerified[$key] = true;
		return true;
	}

	/**
	 * The local visual demo owns a disposable, marker-validated workspace. Under
	 * PHP's loopback development server only, that workspace may skip repeated
	 * PowerShell ACL subprocesses. Production requests keep the full ACL policy.
	 */
	private function detectLocalDemoRoot(string $path) : ?string
	{
		if ('Windows' !== PHP_OS_FAMILY || 'cli-server' !== PHP_SAPI
			|| !\defined('PETUJA_LOCAL_DEMO_ROOT') || !\defined('PETUJA_LOCAL_DEMO_MARKER_CONTENTS')
			|| !\defined('APP_DATA_FOLDER_PATH')) {
			return null;
		}
		$serverAddress = $_SERVER['SERVER_ADDR'] ?? '';
		$remoteAddress = $_SERVER['REMOTE_ADDR'] ?? '';
		if (!\in_array($remoteAddress, ['127.0.0.1', '::1'], true)
			|| ('' !== $serverAddress && !\in_array($serverAddress, ['127.0.0.1', '::1'], true))) {
			return null;
		}

		$rootPath = (string) \constant('PETUJA_LOCAL_DEMO_ROOT');
		$root = @\realpath($rootPath);
		$rootInfo = false === $root ? false : @\lstat($rootPath);
		if (false === $root || !$rootInfo || 0040000 !== ($rootInfo['mode'] & 0170000) || @\is_link($rootPath)) {
			return null;
		}
		$markerPath = $root.'\\.petuja-email-demo-root.json';
		$markerInfo = @\lstat($markerPath);
		if (!$markerInfo || 0100000 !== ($markerInfo['mode'] & 0170000) || @\is_link($markerPath)
			|| 2048 < $markerInfo['size']
			|| @\file_get_contents($markerPath) !== (string) \constant('PETUJA_LOCAL_DEMO_MARKER_CONTENTS')) {
			return null;
		}
		$dataRoot = @\realpath((string) \constant('APP_DATA_FOLDER_PATH'));
		if (false === $dataRoot || !$this->sameWindowsPath($root, $dataRoot)) {
			return null;
		}

		$this->localDemoRoot = $root;
		if (!$this->isLocalDemoPath($path, true)) {
			$this->localDemoRoot = null;
			return null;
		}
		return $root;
	}

	private function sameWindowsPath(string $left, string $right) : bool
	{
		return \strtolower(\rtrim(\str_replace('/', '\\', $left), '\\'))
			=== \strtolower(\rtrim(\str_replace('/', '\\', $right), '\\'));
	}

	private function isLocalDemoPath(string $path, bool $allowMissing = false) : bool
	{
		if (!$this->localDemoRoot) {
			return false;
		}
		$root = \rtrim(\str_replace('/', '\\', $this->localDemoRoot), '\\');
		$resolved = @\realpath($path);
		if (false === $resolved) {
			if (!$allowMissing) {
				return false;
			}
			$parent = @\realpath(\dirname($path));
			if (false === $parent) {
				return false;
			}
			$resolved = \rtrim(\str_replace('/', '\\', $parent), '\\').'\\'.\basename($path);
		}
		$resolved = \str_replace('/', '\\', $resolved);
		$prefix = $root.'\\';
		if (0 !== \stripos($resolved, $prefix)) {
			return false;
		}

		$current = $resolved;
		while (!$this->sameWindowsPath($current, $root)) {
			\clearstatcache(true, $current);
			$stat = @\lstat($current);
			if (!$stat) {
				if (!$allowMissing) {
					return false;
				}
				$current = \dirname($current);
				continue;
			}
			$type = $stat['mode'] & 0170000;
			if (!\in_array($type, [0040000, 0100000], true) || @\is_link($current)) {
				return false;
			}
			$current = \dirname($current);
		}
		return true;
	}

	private function runWindowsAclHelper(string $operation, string $path) : ?string
	{
		if (!\function_exists('proc_open')) {
			return null;
		}
		$systemRoot = \getenv('SystemRoot');
		$canonicalRoot = false === $systemRoot ? false : @\realpath($systemRoot);
		$powerShell = false === $canonicalRoot ? false
			: @\realpath($canonicalRoot.'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
		if (false === $powerShell || !\is_file($powerShell)
			|| 0 !== \stripos($powerShell, \rtrim($canonicalRoot, '\\\/').'\\')) {
			return null;
		}
		$environment = \getenv();
		if (!\is_array($environment)) {
			return null;
		}
		$environment['SystemRoot'] = $canonicalRoot;
		$environment['PSModulePath'] = $canonicalRoot.'\\System32\\WindowsPowerShell\\v1.0\\Modules';
		$helper = __DIR__.'/accountpath-acl.ps1';
		$command = [
			$powerShell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
			'-File', $helper, '-Operation', $operation, '-Path', $path
		];
		if (isset($this->base)) {
			$command[] = '-PrivateBase';
			$command[] = \dirname($this->base);
		}
		$process = @\proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $environment, ['bypass_shell' => true]);
		if (!\is_resource($process)) {
			return null;
		}
		$stdout = \stream_get_contents($pipes[1]);
		$stderr = \stream_get_contents($pipes[2]);
		\fclose($pipes[1]);
		\fclose($pipes[2]);
		$status = \proc_close($process);
		$result = \trim($stdout);
		return 0 === $status && \in_array($result, ['OK', 'MISSING'], true) ? $result : null;
	}

	/** Validate an offline ownership map with the Windows ACL policy. */
	public static function CheckPrivateFile(string $path) : void
	{
		if ('Windows' !== PHP_OS_FAMILY) {
			return;
		}
		$instance = new self(\dirname($path), false);
		if ('OK' !== $instance->runWindowsAclHelper('VerifyPrivateFile', $path)) {
			$instance->fail();
		}
	}

	private function directory(string $path) : array
	{
		$stat = $this->stat($path);
		if (0040000 !== ($stat['mode'] & 0170000)
			|| ('Windows' !== PHP_OS_FAMILY && !\is_executable($path))) {
			$this->fail();
		}
		return $stat;
	}

	private function names(string $path) : array
	{
		$this->directory($path);
		$names = @\scandir($path);
		if (false === $names) {
			$this->fail();
		}
		return \array_values(\array_diff($names, ['.', '..']));
	}

	private function mkdir(string $path) : void
	{
		if (!\file_exists($path) && !\is_link($path) && !@\mkdir($path, 0700)) {
			$this->fail();
		}
		$this->directory($path);
	}

	/** Every caller participates in the gate. Offline publication never waits. */
	private function locked(callable $callback, bool $offline = false)
	{
		if (isset(self::$gates[$this->namespace])) {
			if ($offline) {
				$this->fail();
			}
			return $callback();
		}
		$newBase = !\file_exists($this->base) && !\is_link($this->base);
		$newNamespace = !\file_exists($this->namespace) && !\is_link($this->namespace);
		$this->mkdir($this->base);
		$this->mkdir($this->namespace);
		if (($newBase || $newNamespace) && \function_exists('fsync')) {
			$this->syncDirectory(\dirname($this->namespace));
		}
		$namespaceStat = $this->directory($this->namespace);
		if (!$this->privatePermissions($this->namespace, $namespaceStat)) {
			$this->fail();
		}
		$path = $this->namespace.'/.identity.lock';
		if (\file_exists($path) || \is_link($path)) {
			$this->stat($path);
		}
		$lock = @\fopen($path, 'c+b');
		if (!$lock || !@\chmod($path, 0600) || !@\flock($lock, LOCK_EX | ($offline ? LOCK_NB : 0))) {
			$lock && \fclose($lock);
			$this->fail();
		}
		try {
			self::$gates[$this->namespace] = true;
			$accountLocks = [];
			if ($offline && \is_dir($this->base.'/.signme-locks')) {
				foreach ($this->names($this->base.'/.signme-locks') as $name) {
					$file = $this->base.'/.signme-locks/'.$name;
					$this->stat($file);
					$account = @\fopen($file, 'r+b');
					if (!$account || !@\flock($account, LOCK_EX | LOCK_NB)) {
						$account && \fclose($account);
						$this->fail();
					}
					$accountLocks[] = $account;
				}
			}
			return $callback();
		} finally {
			unset(self::$gates[$this->namespace]);
			foreach ($accountLocks ?? [] as $account) {
				\flock($account, LOCK_UN);
				\fclose($account);
			}
			\flock($lock, LOCK_UN);
			\fclose($lock);
		}
	}

	/** Span resolution and provider-managed I/O without nested account locks. */
	public function Atomic(callable $callback)
	{
		return $this->locked($callback);
	}

	/** Parent paths come from Resolve; reject unexpected leaf objects as well. */
	public function CheckFile(string $path, bool $createParent = false) : void
	{
		$parent = \dirname($path);
		if (!\file_exists($parent) && !\is_link($parent)) {
			if (!$createParent) {
				// A lookup may name a clean, never-allocated main or child.
				// Confirm traversal of its existing ancestor without provisioning it.
				$ancestor = \dirname($parent);
				while (!\file_exists($ancestor) && !\is_link($ancestor)) {
					$ancestor = \dirname($ancestor);
				}
				$this->directory($ancestor);
				return;
			}
			$this->directory(\dirname($parent));
			$this->mkdir($parent);
		}
		$parentStat = $this->directory($parent);
		\clearstatcache(true, $path);
		if (\file_exists($path) || \is_link($path)) {
			$stat = $this->stat($path, $parentStat['dev'], true);
			if (null === $stat) {
				return;
			}
			if (0100000 !== ($stat['mode'] & 0170000)) {
				$this->fail();
			}
		}
	}

	private function read() : array
	{
		if (\file_exists($this->namespace.'/.pending') || \is_link($this->namespace.'/.pending')) {
			$this->fail();
		}
		$path = $this->namespace.'/.identity.json';
		if (!\file_exists($path) && !\is_link($path)) {
			if ($this->legacyRoots() || \array_diff($this->names($this->namespace), ['.identity.lock'])) {
				$this->fail();
			}
			$state = ['version' => 2, 'owners' => []];
			return $state;
		}
		$stat = $this->stat($path);
		if (0100000 !== ($stat['mode'] & 0170000) || $stat['size'] > self::MAX_REGISTRY_BYTES
			|| !$this->privatePermissions($path, $stat)) {
			$this->fail();
		}
		try {
			$state = \json_decode(\file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
		} catch (\Throwable $error) {
			$this->fail();
		}
		if (2 !== ($state['version'] ?? null) || !\is_array($state['owners'] ?? null)) {
			$this->fail();
		}
		$legacy = [];
		$allocating = false;
		$deleting = false;
		foreach ($state['owners'] as $id => $owner) {
			if (!\is_array($owner) || self::Identity($owner['identity'] ?? '') !== $id) {
				$this->fail();
			}
			$this->validateOwner($owner, true);
			$allocating = $allocating || isset($owner['allocating']);
			$deleting = $deleting || isset($owner['deleting']);
			foreach ($owner['children'] as $child) {
				$allocating = $allocating || isset($child['allocating']);
			}
			if (isset($owner['legacy'])) {
				$legacy[] = $owner['legacy'];
			}
		}
		$actual = \array_keys($this->legacyRoots());
		\sort($legacy);
		\sort($actual);
		if ($legacy !== $actual) {
			$this->fail();
		}
		foreach ($this->names($this->namespace) as $name) {
			if (($allocating || $deleting) && \preg_match('/^\.identity-[a-f0-9]{24}$/D', $name)) {
				continue;
			}
			if (!\in_array($name, ['.identity.lock', '.identity.json'], true)
				&& (!isset($state['owners'][$name]) || isset($state['owners'][$name]['legacy']))) {
				$this->fail();
			}
		}
		if ($allocating) {
			$fresh = [];
			foreach ($state['owners'] as $id => &$owner) {
				if (!isset($owner['legacy'])) {
					$fresh[] = $id;
				}
				if (isset($owner['allocating'])) {
					$this->finishAllocation($this->namespace, $id, $owner);
				}
				foreach ($owner['children'] as $childId => &$child) {
					if (isset($child['allocating'])) {
						$this->finishAllocation($this->path($owner).'/.accounts-v2', $childId, $child);
					}
				}
				unset($child);
				$this->validateOwner($owner);
			}
			unset($owner);
			$temps = $this->metadataTemps(true, $fresh);
			$this->removeTemps($temps, \function_exists('fsync'));
			$this->save($state, \function_exists('fsync'));
		} else if ($deleting) {
			$fresh = [];
			foreach ($state['owners'] as $id => $owner) {
				if (!isset($owner['legacy'])) {
					$fresh[] = $id;
				}
			}
			$temps = $this->metadataTemps(true, $fresh);
			if ($temps) {
				// Keep the committed exact-scope deletion marker until its retry
				// succeeds; scratch is never authoritative account state.
				$this->removeTemps($temps);
			}
		}
		return $state;
	}

	/** Atomic metadata publication. A torn/missing receipt always blocks. */
	private function save(array $state, bool $durable = false) : void
	{
		// Directory metadata flushes do not replace flushing the registry file.
		// Refuse durable state transitions before creating or replacing anything
		// when this PHP build cannot sync the file contents.
		if ($durable && !\function_exists('fsync')) {
			$this->fail();
		}
		$data = \json_encode($state, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
		if (\strlen($data) > self::MAX_REGISTRY_BYTES) {
			$this->fail();
		}
		$temp = $this->namespace.'/.identity-'.\bin2hex(\random_bytes(12));
		$handle = @\fopen($temp, 'xb');
		if (!$handle) {
			$this->fail();
		}
		try {
			if (!\chmod($temp, 0600) || \fwrite($handle, $data) !== \strlen($data) || !\fflush($handle)
				|| (\function_exists('fsync') && !\fsync($handle))) {
				$this->fail();
			}
		} finally {
			\fclose($handle);
		}
		if (!@\rename($temp, $this->namespace.'/.identity.json')) {
			$this->fail();
		}
		if ($durable) {
			$this->syncDirectory();
		}
	}

	private function syncDirectory(?string $path = null) : void
	{
		if ('Windows' === PHP_OS_FAMILY) {
			// FlushFileBuffers is attempted through a native directory handle. Windows
			// documents the API's flush behavior, not stronger crash-durability guarantees.
			if ('OK' !== $this->runWindowsAclHelper('SyncDirectory', $path ?? $this->namespace)) {
				$this->fail();
			}
			return;
		}
		$handle = @\fopen($path ?? $this->namespace, 'r');
		if (!$handle) {
			$this->fail();
		}
		try {
			if (!\function_exists('fsync') || !@\fsync($handle)) {
				$this->fail();
			}
		} finally {
			\fclose($handle);
		}
	}

	/** List only directory metadata, never infer account identity from a name. */
	private function legacyRoots() : array
	{
		$roots = [];
		$device = $this->directory($this->base)['dev'];
		foreach ($this->names($this->base) as $domain) {
			if (\in_array($domain, ['.signme-locks', '__nobody__'], true)) {
				$this->directory($this->base.'/'.$domain);
				continue;
			}
			if (\in_array($domain, ['cfg', 'data', 'files'], true)) {
				$this->fail();
			}
			$this->stat($this->base.'/'.$domain, $device);
			foreach ($this->names($this->base.'/'.$domain) as $local) {
				$relative = $domain.'/'.$local;
				$this->stat($this->base.'/'.$relative, $device);
				$roots[$relative] = $this->directory($this->base.'/'.$relative);
			}
		}
		return $roots;
	}

	private function path(array $owner) : string
	{
		return isset($owner['legacy']) ? $this->base.'/'.$owner['legacy']
			: $this->namespace.'/'.self::Identity($owner['identity']);
	}

	private function checkReceipt(string $path, array $receipt) : void
	{
		$stat = $this->directory($path);
		if (($receipt['dev'] ?? null) !== $stat['dev'] || ($receipt['ino'] ?? null) !== $stat['ino']) {
			$this->fail();
		}
	}

	private function validateOwner(array $owner, bool $allowAllocating = false) : void
	{
		if (isset($owner['allocating'])) {
			if (!$allowAllocating || isset($owner['legacy']) || [] !== ($owner['children'] ?? null)) {
				$this->fail();
			}
			$this->checkAllocation($this->namespace, self::Identity($owner['identity']), $owner);
			return;
		}
		if (isset($owner['legacy'])) {
			$this->relative($owner['legacy'], 2);
			$this->checkReceipt($this->base.'/'.\dirname($owner['legacy']), $owner['parent'] ?? []);
			if (($owner['parent']['dev'] ?? null) !== $this->directory($this->base)['dev']) {
				$this->fail();
			}
		}
		$path = $this->path($owner);
		$this->checkReceipt($path, $owner);
		$device = $this->directory(isset($owner['legacy']) ? $this->base : $this->namespace)['dev'];
		if ($owner['dev'] !== $device) {
			$this->fail();
		}
		if (!\is_array($owner['children'] ?? null)) {
			$this->fail();
		}
		if (isset($owner['deleting'])) {
			$target = $owner['deleting'];
			if (!\is_array($target) || ['child'] !== \array_keys($target) || !\is_string($target['child'])
				|| ('' !== $target['child'] && !isset($owner['children'][self::Identity($owner['identity'], $target['child'])]))) {
				$this->fail();
			}
		}
		$legacyChildren = [];
		foreach ($owner['children'] as $id => $child) {
			if (self::Identity($owner['identity'], $child['identity'] ?? '') !== $id) {
				$this->fail();
			}
			if (isset($child['legacy'])) {
				$this->relative($child['legacy'], 1);
				$legacyChildren[] = $child['legacy'];
			} else {
				$this->directory($path.'/.accounts-v2');
			}
			if (isset($child['allocating'])) {
				if (!$allowAllocating || isset($child['legacy'])) {
					$this->fail();
				}
				$this->checkAllocation($path.'/.accounts-v2', $id, $child);
			} else {
				$this->checkReceipt($this->childPath($owner, $child), $child);
				if ($child['dev'] !== $device) {
					$this->fail();
				}
			}
		}
		foreach ($this->names($path) as $name) {
			$stat = $this->stat($path.'/'.$name, $owner['dev']);
			if ('sign_me' === $name || (0040000 === ($stat['mode'] & 0170000)
				&& !\in_array($name, \array_merge(self::MAIN_DIRS, $legacyChildren, ['.accounts-v2']), true))) {
				$this->fail();
			}
		}
		$namespace = $path.'/.accounts-v2';
		if (\file_exists($namespace) || \is_link($namespace)) {
			foreach ($this->names($namespace) as $name) {
				if (!isset($owner['children'][$name]) || isset($owner['children'][$name]['legacy'])) {
					$this->fail();
				}
			}
		}
	}

	private function relative(string $path, int $count) : void
	{
		$parts = \explode('/', $path);
		if (\count($parts) !== $count || \preg_match('/[\\\\\x00-\x1f\x7f]/', $path)
			|| \array_intersect($parts, ['', '.', '..'])) {
			$this->fail();
		}
	}

	private function childPath(array $owner, array $child) : string
	{
		return $this->path($owner).'/'.($child['legacy'] ?? ('.accounts-v2/'.self::Identity($owner['identity'], $child['identity'])));
	}

	/** A lossy path is only a conflict probe, never a source of ownership. */
	private function conflict(string $main, string $child, ?array $receipt) : void
	{
		$parts = \explode('@', $main);
		$domain = \array_pop($parts);
		$path = $this->base.'/'.\MailSo\Base\Utils::SecureFileName($domain ?: 'unknown.tld')
			.'/'.\MailSo\Base\Utils::SecureFileName(\implode('@', $parts) ?: '.unknown');
		if ('' !== $child) {
			$path .= '/'.\MailSo\Base\Utils::SecureFileName($child);
		}
		if (\file_exists($path) || \is_link($path)) {
			if (null === $receipt) {
				$this->fail();
			}
			$this->checkReceipt($path, $receipt);
		}
	}

	public function Resolve(string $main, string $child = '', bool $forDeletion = false, bool $create = true) : string
	{
		$id = self::Identity($main);
		self::Identity($main, $child);
		return $this->locked(function () use ($main, $child, $id, $forDeletion, $create) {
			$state = $this->read();
			$owner = $state['owners'][$id] ?? null;
			$this->conflict($main, '', $owner);
			if (null === $owner) {
				$path = $this->namespace.'/'.$id;
				if (\file_exists($path) || \is_link($path)) {
					$this->fail();
				}
				if (!$create) {
					return $path.('' === $child ? '/' : '/.accounts-v2/'.self::Identity($main, $child).'/');
				}
				$owner = ['identity' => $main, 'children' => [], 'allocating' => $this->allocation($this->namespace, $id)];
				$state['owners'][$id] = $owner;
				$this->save($state, \function_exists('fsync'));
				$this->finishAllocation($this->namespace, $id, $owner);
				$state['owners'][$id] = $owner;
				$this->save($state, \function_exists('fsync'));
			}
			if (!empty($owner['deleting']) && !$forDeletion) {
				$this->fail();
			}
			if ('' === $child) {
				return $this->path($owner).'/';
			}
			$childId = self::Identity($main, $child);
			$record = $owner['children'][$childId] ?? null;
			// Under a bound legacy parent, preserve its native name-alias rules.
			if (isset($owner['legacy'])) {
				$probe = $this->path($owner).'/'.\MailSo\Base\Utils::SecureFileName($child);
				if (\file_exists($probe) || \is_link($probe)) {
					if (null === $record) {
						$this->fail();
					}
					$this->checkReceipt($probe, $record);
				}
			}
			if (null === $record) {
				$parent = $this->path($owner).'/.accounts-v2';
				if (!$create) {
					$path = $parent.'/'.$childId;
					if (\file_exists($path) || \is_link($path)) {
						$this->fail();
					}
					return $path.'/';
				}
				$this->mkdir($parent);
				if (\function_exists('fsync')) {
					$this->syncDirectory($this->path($owner));
				}
				$path = $parent.'/'.$childId;
				if (\file_exists($path) || \is_link($path)) {
					$this->fail();
				}
				$record = ['identity' => $child, 'allocating' => $this->allocation($parent, $childId)];
				$state['owners'][$id]['children'][$childId] = $record;
				$this->save($state, \function_exists('fsync'));
				$this->finishAllocation($parent, $childId, $record);
				$state['owners'][$id]['children'][$childId] = $record;
				$this->save($state, \function_exists('fsync'));
			}
			return $this->childPath($owner, $record).'/';
		});
	}

	public function Owned() : array
	{
		return $this->locked(function () {
			$owners = $this->read()['owners'];
			foreach ($owners as &$owner) {
				if (!empty($owner['deleting'])) {
					$this->fail();
				}
				$owner['path'] = $this->path($owner);
				$owner['childPaths'] = [];
				foreach ($owner['children'] as $child) {
					$owner['childPaths'][] = $this->childPath($owner, $child);
				}
			}
			return $owners;
		});
	}

	/** Clear contents only; root/child reservations must never be unlinked. */
	public function Delete(string $main, string $child = '') : bool
	{
		return $this->locked(function () use ($main, $child) {
			// Destructive operations need durable directory updates even though
			// ordinary storage does not require this operation on every request.
			$this->syncDirectory();
			$state = $this->read();
			$id = self::Identity($main);
			$owner = $state['owners'][$id] ?? null;
			if (null === $owner) {
				$this->fail();
			}
			$path = $this->path($owner);
			$keep = [$path];
			foreach ($owner['children'] as $record) {
				$keep[] = $this->childPath($owner, $record);
			}
			if ('' !== $child) {
				$record = $owner['children'][self::Identity($main, $child)] ?? null;
				if (null === $record) {
					$this->fail();
				}
				$path = $this->childPath($owner, $record);
			}
			$target = ['child' => $child];
			if (isset($owner['deleting']) && $owner['deleting'] !== $target) {
				$this->fail();
			}
			$this->inventory($path, $owner['dev']);
			$state['owners'][$id]['deleting'] = $target;
			$this->save($state, true);
			$this->clear($path, $keep, $owner['dev']);
			unset($state['owners'][$id]['deleting']);
			$this->save($state, true);
			return true;
		});
	}

	private function clear(string $path, array $keep, int $device) : void
	{
		foreach ($this->names($path) as $name) {
			$item = $path.'/'.$name;
			$stat = $this->stat($item, $device);
			if (0040000 === ($stat['mode'] & 0170000)) {
				$this->clear($item, $keep, $device);
				if (!\in_array($item, $keep, true) && '.accounts-v2' !== $name && !@\rmdir($item)) {
					$this->fail();
				}
			} else if (!@\unlink($item)) {
				$this->fail();
			}
		}
		$this->syncDirectory($path);
	}

	/** Provider-selected cleanup stays under the same gate as managed I/O. */
	public function Collect(string $path, int $age) : void
	{
		$this->locked(function () use ($path, $age) {
			if (!\in_array(\basename($path), ['.sessions', '.sign_me', '.files'], true)) {
				$this->fail();
			}
			$parent = $this->directory(\dirname($path));
			if (\file_exists($path) || \is_link($path)) {
				$this->stat($path, $parent['dev']);
				$this->inventory($path, $parent['dev']);
				\MailSo\Base\Utils::RecTimeDirRemove($path, $age);
			}
		});
	}

	/** Read-only offline inventory. This is advisory and does not acquire locks. */
	public function PreviewAdoption(array $map, bool $resume = false) : void
	{
		if ('cli' !== PHP_SAPI || !\is_array($map['accounts'] ?? null)
			|| true !== ($map['authoritative_ownership'] ?? null)) {
			$this->fail();
		}
		$this->directory($this->base);
		$this->preflightAdoption($map, $resume);
	}

	/** Offline only. The map attests ownership; file names do not prove it. */
	public function Adopt(array $map, bool $resume = false) : void
	{
		if ('cli' !== PHP_SAPI || !\function_exists('fsync') || !\is_array($map['accounts'] ?? null)
			|| true !== ($map['authoritative_ownership'] ?? null)) {
			$this->fail();
		}
		$this->locked(function () use ($map, $resume) {
			$this->syncDirectory();
			[$state, $temps] = $this->preflightAdoption($map, $resume);
			$pending = $this->namespace.'/.pending';
			if (!$resume) {
				$handle = @\fopen($pending, 'xb');
				if (!$handle || !\chmod($pending, 0600) || !\fflush($handle) || !\fsync($handle)) {
					$handle && \fclose($handle);
					$this->fail();
				}
				\fclose($handle);
			}
			$this->syncDirectory();
			$this->removeTemps($temps);
			$this->save($state, true);
			if (!\unlink($pending)) {
				$this->fail();
			}
			$this->syncDirectory();
		}, true);
	}

	/** Shared ownership and filesystem preflight; this method never mutates. */
	private function preflightAdoption(array $map, bool $resume) : array
	{
		$manifest = $this->namespace.'/.identity.json';
		$pending = $this->namespace.'/.pending';
		if ((!$resume && (\file_exists($manifest) || \is_link($manifest)))
			|| ($resume && (!\is_file($pending) || \is_link($pending)))) {
			$this->fail();
		}
		$roots = $this->legacyRoots();
		$state = ['version' => 2, 'owners' => []];
		$seen = [];
		foreach ($map['accounts'] as $entry) {
			$identity = $entry['identity'] ?? '';
			$id = self::Identity($identity);
			$source = $entry['source'] ?? '';
			$this->relative($source, 2);
			if (!isset($roots[$source]) || isset($state['owners'][$id]) || isset($seen[$source])) {
				$this->fail();
			}
			$stat = $roots[$source];
			$physical = $stat['dev'].':'.$stat['ino'];
			if (isset($seen[$physical])) {
				$this->fail();
			}
			$seen[$source] = $seen[$physical] = true;
			$parent = $this->directory($this->base.'/'.\dirname($source));
			$owner = ['identity' => $identity, 'legacy' => $source, 'dev' => $stat['dev'], 'ino' => $stat['ino'],
				'parent' => ['dev' => $parent['dev'], 'ino' => $parent['ino']], 'children' => []];
			$children = [];
			foreach (($entry['children'] ?? []) as $child) {
				$childId = self::Identity($identity, $child['identity'] ?? '');
				$name = $child['source'] ?? '';
				$this->relative($name, 1);
				if ('' === ($child['identity'] ?? '') || isset($children[$name]) || isset($owner['children'][$childId])
					|| '.' === $name[0] || \in_array($name, self::MAIN_DIRS, true)) {
					$this->fail();
				}
				$childStat = $this->directory($this->base.'/'.$source.'/'.$name);
				$childPhysical = $childStat['dev'].':'.$childStat['ino'];
				if (isset($seen[$childPhysical])) {
					$this->fail();
				}
				$seen[$childPhysical] = true;
				$children[$name] = true;
				$owner['children'][$childId] = ['identity' => $child['identity'], 'legacy' => $name,
					'dev' => $childStat['dev'], 'ino' => $childStat['ino']];
			}
			$path = $this->base.'/'.$source;
			foreach ($this->names($path) as $name) {
				$item = $this->stat($path.'/'.$name, $stat['dev']);
				if ('sign_me' === $name || '.accounts-v2' === $name
					|| (0040000 === ($item['mode'] & 0170000) && !isset($children[$name]) && !\in_array($name, self::MAIN_DIRS, true))) {
					$this->fail();
				}
			}
			$this->inventory($path, $stat['dev']);
			$state['owners'][$id] = $owner;
		}
		if (\count($map['accounts']) !== \count($roots)) {
			$this->fail();
		}

		$namespaceExists = \file_exists($this->namespace) || \is_link($this->namespace);
		$temps = [];
		if ($namespaceExists) {
			$namespaceStat = $this->directory($this->namespace);
			if (!$this->privatePermissions($this->namespace, $namespaceStat)) {
				$this->fail();
			}
			$lock = $this->namespace.'/.identity.lock';
			if (\file_exists($lock) || \is_link($lock)) {
				$lockStat = $this->stat($lock);
				if (0100000 !== ($lockStat['mode'] & 0170000)) {
					$this->fail();
				}
			}
			$temps = $this->metadataTemps($resume || !$state['owners'], []);
		} else if ($resume) {
			$this->fail();
		}

		if ($resume) {
			$this->checkPending($pending);
			if (\file_exists($manifest) || \is_link($manifest)) {
				$this->stat($manifest);
				if (\json_decode(\file_get_contents($manifest), true, 512, JSON_THROW_ON_ERROR) !== $state) {
					$this->fail();
				}
			}
		} else if (\file_exists($pending) || \is_link($pending)) {
			$this->fail();
		}
		return [$state, $temps];
	}

	private function inventory(string $path, int $device) : void
	{
		foreach ($this->names($path) as $name) {
			$item = $path.'/'.$name;
			$stat = $this->stat($item, $device);
			if (0040000 === ($stat['mode'] & 0170000)) {
				$this->inventory($item, $device);
			}
		}
	}

	/** Re-attest only existing identity/path bindings after an offline restore. */
	public function Reattest(array $map, bool $resume = false) : void
	{
		if ('cli' !== PHP_SAPI || !\function_exists('fsync') || true !== ($map['authoritative_ownership'] ?? null)
			|| !\is_array($map['accounts'] ?? null)) {
			$this->fail();
		}
		$this->locked(function () use ($map, $resume) {
			$this->syncDirectory();
			$manifest = $this->namespace.'/.identity.json';
			$stat = $this->stat($manifest);
			if (!$this->privatePermissions($manifest, $stat) || $stat['size'] > self::MAX_REGISTRY_BYTES) {
				$this->fail();
			}
			$state = \json_decode(\file_get_contents($manifest), true, 512, JSON_THROW_ON_ERROR);
			if (2 !== ($state['version'] ?? null) || !\is_array($state['owners'] ?? null)
				|| \count($map['accounts']) !== \count($state['owners'])) {
				$this->fail();
			}
			$seen = $physical = $legacy = $fresh = [];
			foreach ($map['accounts'] as $entry) {
				$id = self::Identity($entry['identity'] ?? '');
				$owner = $state['owners'][$id] ?? null;
				if (null === $owner || isset($seen[$id]) || !empty($owner['deleting'])
					|| ($owner['identity'] ?? null) !== $entry['identity']) {
					$this->fail();
				}
				$seen[$id] = true;
				$isLegacy = isset($owner['legacy']);
				if (($entry['layout'] ?? 'legacy') !== ($isLegacy ? 'legacy' : 'v2')
					|| ($entry['source'] ?? null) !== ($isLegacy ? $owner['legacy'] : $id)) {
					$this->fail();
				}
				if ($isLegacy) {
					$this->relative($owner['legacy'], 2);
					$legacy[] = $owner['legacy'];
					$parent = $this->directory($this->base.'/'.\dirname($owner['legacy']));
					$owner['parent'] = ['dev' => $parent['dev'], 'ino' => $parent['ino']];
				} else {
					$fresh[] = $id;
				}
				$path = $this->path($owner);
				$this->refreshReceipt($path, $owner, $physical);
				if (!\is_array($entry['children'] ?? []) || !\is_array($owner['children'] ?? null)
					|| \count($entry['children'] ?? []) !== \count($owner['children'])) {
					$this->fail();
				}
				$children = [];
				foreach (($entry['children'] ?? []) as $childEntry) {
					$childId = self::Identity($owner['identity'], $childEntry['identity'] ?? '');
					$child = $owner['children'][$childId] ?? null;
					if (null === $child || isset($children[$childId]) || '' === $child['identity']) {
						$this->fail();
					}
					$children[$childId] = true;
					$isLegacyChild = isset($child['legacy']);
					if (($childEntry['layout'] ?? 'legacy') !== ($isLegacyChild ? 'legacy' : 'v2')
						|| ($childEntry['source'] ?? null) !== ($isLegacyChild ? $child['legacy'] : $childId)) {
						$this->fail();
					}
					if ($isLegacyChild) {
						$this->relative($child['legacy'], 1);
					} else {
						$this->directory($path.'/.accounts-v2');
					}
					$this->refreshReceipt($this->childPath($owner, $child), $child, $physical);
					$owner['children'][$childId] = $child;
				}
				$this->validateOwner($owner);
				$this->inventory($path, $owner['dev']);
				$state['owners'][$id] = $owner;
			}
			$actualLegacy = \array_keys($this->legacyRoots());
			$temps = $this->metadataTemps(true, $fresh);
			\sort($legacy); \sort($actualLegacy);
			if ($legacy !== $actualLegacy) {
				$this->fail();
			}
			$pending = $this->namespace.'/.pending';
			if ($resume) {
				$this->checkPending($pending);
			} else {
				$handle = @\fopen($pending, 'xb');
				if (!$handle || !\chmod($pending, 0600) || !\fflush($handle) || !\fsync($handle)) {
					$handle && \fclose($handle);
					$this->fail();
				}
				\fclose($handle);
			}
			$this->syncDirectory();
			$this->removeTemps($temps);
			$this->save($state, true);
			if (!\unlink($pending)) {
				$this->fail();
			}
			$this->syncDirectory();
		}, true);
	}

	private function refreshReceipt(string $path, array &$receipt, array &$seen) : void
	{
		$stat = $this->directory($path);
		$key = $stat['dev'].':'.$stat['ino'];
		if (isset($seen[$key])) {
			$this->fail();
		}
		$seen[$key] = true;
		$receipt['dev'] = $stat['dev'];
		$receipt['ino'] = $stat['ino'];
	}

	private function checkPending(string $path) : void
	{
		$stat = $this->stat($path);
		if (0100000 !== ($stat['mode'] & 0170000) || !$this->privatePermissions($path, $stat) || 0 !== $stat['size']) {
			$this->fail();
		}
	}

	/** Only private generated registry scratch files may be retired offline. */
	private function metadataTemps(bool $allow, array $fresh) : array
	{
		$temps = $actualFresh = [];
		foreach ($this->names($this->namespace) as $name) {
			if (\in_array($name, ['.identity.lock', '.identity.json', '.pending'], true)) {
				continue;
			}
			if (\preg_match('/^\.identity-[a-f0-9]{24}$/D', $name)) {
				$path = $this->namespace.'/'.$name;
				$stat = $this->stat($path, $this->directory($this->namespace)['dev']);
				if (!$allow || 0100000 !== ($stat['mode'] & 0170000) || !$this->privatePermissions($path, $stat)
					|| $stat['size'] > self::MAX_REGISTRY_BYTES) {
					$this->fail();
				}
				$temps[$name] = [$stat['dev'], $stat['ino']];
			} else {
				$actualFresh[] = $name;
			}
		}
		\sort($fresh); \sort($actualFresh);
		if ($fresh !== $actualFresh) {
			$this->fail();
		}
		return $temps;
	}

	private function removeTemps(array $temps, bool $durable = true) : void
	{
		foreach ($temps as $name => $receipt) {
			$path = $this->namespace.'/'.$name;
			$stat = $this->stat($path);
			if ([$stat['dev'], $stat['ino']] !== $receipt || !@\unlink($path)) {
				$this->fail();
			}
		}
		if ($durable) {
			$this->syncDirectory();
		}
	}

	private function allocation(string $parent, string $target) : array
	{
		$stat = $this->directory($parent);
		return ['target' => $target, 'parent' => ['dev' => $stat['dev'], 'ino' => $stat['ino']]];
	}

	private function checkAllocation(string $parent, string $target, array $record) : void
	{
		$intent = $record['allocating'];
		if (($intent['target'] ?? null) !== $target || isset($record['dev']) || isset($record['ino'])) {
			$this->fail();
		}
		$this->checkReceipt($parent, $intent['parent'] ?? []);
		$path = $parent.'/'.$target;
		if (\file_exists($path) || \is_link($path)) {
			$stat = $this->directory($path);
			$parentStat = $this->directory($parent);
			if ($stat['dev'] !== $parentStat['dev'] || $stat['uid'] !== $parentStat['uid']
				|| !$this->privatePermissions($path, $stat) || $this->names($path)) {
				$this->fail();
			}
		}
	}

	private function finishAllocation(string $parent, string $target, array &$record) : void
	{
		$this->checkAllocation($parent, $target, $record);
		$this->mkdir($parent.'/'.$target);
		$stat = $this->directory($parent.'/'.$target);
		if (\function_exists('fsync')) {
			$this->syncDirectory($parent);
		}
		unset($record['allocating']);
		$record['dev'] = $stat['dev'];
		$record['ino'] = $stat['ino'];
	}
}
