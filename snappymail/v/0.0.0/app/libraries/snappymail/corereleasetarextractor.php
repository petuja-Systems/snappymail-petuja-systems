<?php

namespace SnappyMail;

/**
 * Strict reader for the USTAR Core release archives installed by CoreReleaseArchive.
 * It intentionally has no generic file selection or destination API.
 */
class CoreReleaseTarExtractor
{
	private const BLOCK_SIZE = 512;

	public static function extract(string $archive) : bool
	{
		$archive = \realpath($archive);
		$target = \realpath(APP_INDEX_ROOT_PATH);
		if (!$archive || !$target || !\is_file($archive) || !\is_dir($target)) {
			return false;
		}

		$stream = @\gzopen($archive, 'rb');
		if (!$stream) {
			return false;
		}

		$stage = null;
		try {
			$stage = self::createStage($target);
			if (!$stage) {
				return false;
			}

			$files = [];
			$seen = [];
			$hasCoreFile = false;
			$hasIndex = false;
			$zeroBlocks = 0;

			while (true) {
				$header = self::read($stream, self::BLOCK_SIZE);
				if (false === $header) {
					return false;
				}
				if ('' === $header) {
					break;
				}
				if (self::BLOCK_SIZE !== \strlen($header)) {
					return false;
				}
				if ("\0" === $header[0] && !\trim($header, "\0")) {
					++$zeroBlocks;
					continue;
				}
				if ($zeroBlocks || false === ($entry = self::parseHeader($header))) {
					return false;
				}

				$path = self::normalizePath($entry['path'], '5' === $entry['type']);
				if (false === $path || ('5' === $entry['type'] && $entry['size'])) {
					return false;
				}

				$isDirectory = '5' === $entry['type'];
				$isIndex = !$isDirectory && 'index.php' === $path;
				$isCoreFile = !$isDirectory && 0 === \strpos($path, 'snappymail/');
				$isSelected = $isIndex || $isCoreFile;

				if (!$isDirectory && 'snappymail' === $path) {
					return false;
				}
				if ($isSelected && isset($seen[$path])) {
					return false;
				}

				if ($isSelected) {
					$seen[$path] = true;
					$stageFile = $stage . '/' . $path;
					$stageDirectory = \dirname($stageFile);
					if (!\is_dir($stageDirectory) && !@\mkdir($stageDirectory, 0700, true)) {
						return false;
					}
					$destination = @\fopen($stageFile, 'xb');
					if (!$destination || !self::copyEntry($stream, $destination, $entry['size'])) {
						if (\is_resource($destination)) {
							\fclose($destination);
						}
						return false;
					}
					if (!\fclose($destination) || !@\chmod($stageFile, $entry['mode'] & 0777)) {
						return false;
					}
					$files[$path] = array(
						'stage' => $stageFile,
						'overwrite' => $isIndex
					);
					$hasIndex = $hasIndex || $isIndex;
					$hasCoreFile = $hasCoreFile || $isCoreFile;
				} else if (!self::skipEntry($stream, $entry['size'])) {
					return false;
				}

				$padding = (self::BLOCK_SIZE - ($entry['size'] % self::BLOCK_SIZE)) % self::BLOCK_SIZE;
				if ($padding) {
					$paddingData = self::read($stream, $padding);
					if (false === $paddingData || $padding !== \strlen($paddingData)) {
						return false;
					}
				}
			}

			if ($zeroBlocks < 2 || !self::zeroTail($stream) || !$hasIndex || !$hasCoreFile) {
				return false;
			}
			if (!self::preflight($target, $files)) {
				return false;
			}

			// Keep the application entry point as the final update switch, matching the
			// PharData path and the previous fallback's two-pass order.
			$index = $files['index.php'];
			unset($files['index.php']);
			foreach ($files as $path => $file) {
				if (!self::publish($target, $path, $file)) {
					return false;
				}
			}
			return self::publish($target, 'index.php', $index);
		} catch (\Throwable $e) {
			return false;
		} finally {
			\gzclose($stream);
			if ($stage) {
				self::removeTree($stage);
			}
		}
	}

	private static function createStage(string $target)
	{
		for ($attempt = 0; $attempt < 3; ++$attempt) {
			$stage = $target . '/.core-update-' . \bin2hex(\random_bytes(12));
			if (@\mkdir($stage, 0700)) {
				return $stage;
			}
		}
		return false;
	}

	private static function read($stream, int $length)
	{
		$data = '';
		while (\strlen($data) < $length) {
			$chunk = @\gzread($stream, $length - \strlen($data));
			if (false === $chunk) {
				return false;
			}
			if ('' === $chunk) {
				break;
			}
			$data .= $chunk;
		}
		return $data;
	}

	private static function parseHeader(string $header)
	{
		if ("ustar\0" !== \substr($header, 257, 6) || '00' !== \substr($header, 263, 2)) {
			return false;
		}

		$checksum = self::octal(\substr($header, 148, 8));
		if (false === $checksum) {
			return false;
		}
		$sum = 0;
		for ($i = 0; $i < self::BLOCK_SIZE; ++$i) {
			$sum += ($i >= 148 && $i < 156) ? 32 : \ord($header[$i]);
		}
		if ($sum !== $checksum) {
			return false;
		}

		$name = self::stringField(\substr($header, 0, 100));
		$prefix = self::stringField(\substr($header, 345, 155));
		$mode = self::octal(\substr($header, 100, 8));
		$size = self::octal(\substr($header, 124, 12));
		$type = \substr($header, 156, 1);
		if (false === $name || false === $prefix || false === $mode || false === $size
			|| '' === $name || !\in_array($type, array("\0", '0', '5'), true))
		{
			return false;
		}

		return array(
			'path' => $prefix ? $prefix . '/' . $name : $name,
			'mode' => $mode,
			'size' => $size,
			'type' => '5' === $type ? '5' : '0'
		);
	}

	private static function stringField(string $field)
	{
		$zero = \strpos($field, "\0");
		if (false === $zero) {
			return $field;
		}
		$value = \substr($field, 0, $zero);
		return \trim(\substr($field, $zero), "\0 ") ? false : $value;
	}

	private static function octal(string $field)
	{
		$value = \trim($field, "\0 ");
		if ('' === $value) {
			return 0;
		}
		if (!\preg_match('/^[0-7]+$/D', $value)) {
			return false;
		}
		$result = 0;
		for ($i = 0, $length = \strlen($value); $i < $length; ++$i) {
			$digit = \ord($value[$i]) - 48;
			if ($result > (PHP_INT_MAX - $digit) / 8) {
				return false;
			}
			$result = ($result * 8) + $digit;
		}
		return $result;
	}

	private static function normalizePath(string $path, bool $directory)
	{
		if ('' === $path || '\\' === $path[0] || '/' === $path[0]
			|| \preg_match('/[\\\\\x00-\x1F\x7F]/', $path)
			|| \preg_match('/^[A-Za-z]:/', $path))
		{
			return false;
		}

		if ($directory && '/' === \substr($path, -1)) {
			$path = \substr($path, 0, -1);
		} else if (!$directory && '/' === \substr($path, -1)) {
			return false;
		}
		$parts = \explode('/', $path);
		foreach ($parts as $part) {
			if ('' === $part || '.' === $part || '..' === $part
				|| \preg_match('/[<>:"|?*]/', $part)
				|| \preg_match('/[. ]$/', $part))
			{
				return false;
			}
		}
		return \implode('/', $parts);
	}

	private static function copyEntry($stream, $destination, int $size) : bool
	{
		while ($size > 0) {
			$chunkSize = \min($size, 8192);
			$data = self::read($stream, $chunkSize);
			if (false === $data || '' === $data) {
				return false;
			}
			$written = 0;
			while ($written < \strlen($data)) {
				$count = @\fwrite($destination, \substr($data, $written));
				if (false === $count || 0 === $count) {
					return false;
				}
				$written += $count;
			}
			$size -= \strlen($data);
		}
		return true;
	}

	private static function skipEntry($stream, int $size) : bool
	{
		while ($size > 0) {
			$data = self::read($stream, \min($size, 8192));
			if (false === $data || '' === $data) {
				return false;
			}
			$size -= \strlen($data);
		}
		return true;
	}

	private static function zeroTail($stream) : bool
	{
		while (true) {
			$data = @\gzread($stream, 8192);
			if (false === $data) {
				return false;
			}
			if ('' === $data) {
				return true;
			}
			if (\trim($data, "\0")) {
				return false;
			}
		}
	}

	private static function preflight(string $root, array $files) : bool
	{
		foreach ($files as $path => $file) {
			$parent = \dirname($path);
			if ('.' !== $parent) {
				$current = $root;
				foreach (\explode('/', $parent) as $part) {
					$current .= '/' . $part;
					$stat = @\lstat($current);
					if (false !== $stat && 0040000 !== ($stat['mode'] & 0170000)) {
						return false;
					}
				}
			}
			$destination = $root . '/' . $path;
			$stat = @\lstat($destination);
			if (false !== $stat) {
				if (0100000 !== ($stat['mode'] & 0170000)) {
					return false;
				}
				if (!$file['overwrite']) {
					continue;
				}
			}
		}
		return true;
	}

	private static function publish(string $root, string $path, array $file) : bool
	{
		$parent = \dirname($path);
		$current = $root;
		if ('.' !== $parent) {
			foreach (\explode('/', $parent) as $part) {
				$current .= '/' . $part;
				$stat = @\lstat($current);
				if (false === $stat) {
					if (!@\mkdir($current, 0755)) {
						return false;
					}
				} else if (0040000 !== ($stat['mode'] & 0170000)) {
					return false;
				}
			}
		}

		$destination = $root . '/' . $path;
		$stat = @\lstat($destination);
		if (false !== $stat) {
			if (0100000 !== ($stat['mode'] & 0170000)) {
				return false;
			}
			if (!$file['overwrite']) {
				return true;
			}
		}
		return @\rename($file['stage'], $destination);
	}

	private static function removeTree(string $directory) : void
	{
		if (!\is_dir($directory) || \is_link($directory)) {
			@\unlink($directory);
			return;
		}
		$iterator = new \FilesystemIterator($directory, \FilesystemIterator::SKIP_DOTS);
		foreach ($iterator as $item) {
			$path = $item->getPathname();
			if ($item->isDir() && !$item->isLink()) {
				self::removeTree($path);
			} else {
				@\unlink($path);
			}
		}
		@\rmdir($directory);
	}
}
