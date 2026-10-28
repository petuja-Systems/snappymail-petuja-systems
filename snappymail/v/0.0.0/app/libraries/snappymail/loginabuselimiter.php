<?php

namespace SnappyMail;

/**
 * Shared-host public-login admission budget. No account-storage paths or secrets
 * are stored here. Reservations count before authentication, including crashes.
 */
final class LoginAbuseLimiter
{
	const WINDOW = 300;
	const ACCOUNT_LIMIT = 10;
	const SOURCE_LIMIT = 30;
	const MAX_BUCKETS = 4096;
	const MAX_BYTES = 1048576;

	private string $directory;
	private string $secret;

	public function __construct(string $directory, string $secret)
	{
		$this->directory = $directory;
		$this->secret = $secret;
	}

	public function reserve(string $realm, string $source, array $identity): ?array
	{
		$address = @\inet_pton($source);
		// Treat IPv4-mapped IPv6 and its IPv4 spelling as the same peer.
		if (false !== $address && 16 === \strlen($address)
			&& \substr($address, 0, 12) === \str_repeat("\0", 10) . "\xff\xff") {
			$address = \substr($address, 12);
		}
		$account = \json_encode([$realm, 'account', $identity]);
		if (false === $account) {
			return null;
		}
		$keys = [
			\hash_hmac('sha256', \json_encode([$realm, 'source', false === $address ? 'unknown' : \bin2hex($address)]), $this->secret),
			\hash_hmac('sha256', $account, $this->secret)
		];
		return $this->update(function (array &$buckets, float $now) use ($keys): ?array {
			foreach ($keys as $index => $key) {
				if (\count($buckets[$key] ?? []) >= ($index ? self::ACCOUNT_LIMIT : self::SOURCE_LIMIT)) {
					return null;
				}
			}
			if (\count($buckets) + \count(\array_diff($keys, \array_keys($buckets))) > self::MAX_BUCKETS) {
				return null;
			}
			$id = \bin2hex(\random_bytes(16));
			foreach ($keys as $key) {
				$buckets[$key][$id] = (int) \ceil($now + self::WINDOW);
			}
			return ['id' => $id, 'keys' => $keys];
		});
	}

	/** Refund only this request, preserving every other failure/reservation. */
	public function release(array $ticket): bool
	{
		return null !== $this->update(function (array &$buckets) use ($ticket): array {
			foreach ($ticket['keys'] as $key) {
				unset($buckets[$key][$ticket['id']]);
				if (empty($buckets[$key])) {
					unset($buckets[$key]);
				}
			}
			return [];
		});
	}

	/** All disk work is bounded and serialized; never hold this lock over auth. */
	private function update(callable $operation): ?array
	{
		$lock = null;
		try {
			$directory = $this->directory;
			if (\is_link($directory)
				|| (!\is_dir($directory) && !@\mkdir($directory, 0700, true) && !\is_dir($directory))
				|| !@\chmod($directory, 0700) || \is_link($directory . '/lock')) {
				return null;
			}
			$lock = @\fopen($directory . '/lock', 'c+b');
			if (!$lock || !@\chmod($directory . '/lock', 0600) || !\flock($lock, LOCK_EX)) {
				return null;
			}
			$now = \microtime(true);
			$path = $directory . '/state.json';
			$buckets = [];
			\clearstatcache(true, $path);
			if (\is_link($path)) {
				return null;
			}
			if (\file_exists($path)) {
				if (!\is_file($path)) {
					return null;
				}
				$json = @\file_get_contents($path, false, null, 0, self::MAX_BYTES + 1);
				if (false === $json || \strlen($json) > self::MAX_BYTES) {
					return null;
				}
				$state = \json_decode($json, true, 8, JSON_THROW_ON_ERROR);
				if (!\is_array($state) || \array_keys($state) !== ['version', 'buckets']
					|| 1 !== $state['version'] || !\is_array($state['buckets'])
					|| \count($state['buckets']) > self::MAX_BUCKETS) {
					return null;
				}
				$buckets = $state['buckets'];
				foreach ($buckets as $key => &$events) {
					if (!\is_string($key) || !\preg_match('/^[a-f0-9]{64}$/D', $key)
						|| !\is_array($events) || \count($events) > self::SOURCE_LIMIT) {
						return null;
					}
					foreach ($events as $id => $expires) {
						if (!\is_string($id) || !\preg_match('/^[a-f0-9]{32}$/D', $id)
							|| !\is_int($expires) || $expires < 1 || $expires > \ceil($now + self::WINDOW)) {
							return null;
						}
						if ($expires <= $now) {
							unset($events[$id]);
						}
					}
					if (!$events) {
						unset($buckets[$key]);
					}
				}
				unset($events);
			}
			$result = $operation($buckets, $now);
			if (null === $result) {
				return null;
			}
			$json = \json_encode(['version' => 1, 'buckets' => $buckets], JSON_THROW_ON_ERROR);
			if (\strlen($json) > self::MAX_BYTES || \is_link($directory . '/state.tmp')) {
				return null;
			}
			$temp = @\fopen($directory . '/state.tmp', 'wb');
			if (!$temp) {
				return null;
			}
			try {
				$written = @\chmod($directory . '/state.tmp', 0600)
					&& \strlen($json) === \fwrite($temp, $json) && \fflush($temp);
			} finally {
				\fclose($temp);
			}
			if (!$written || !@\rename($directory . '/state.tmp', $path)) {
				@\unlink($directory . '/state.tmp');
				return null;
			}
			return $result;
		} catch (\Throwable $exception) {
			return null;
		} finally {
			if (\is_resource($lock)) {
				\flock($lock, LOCK_UN);
				\fclose($lock);
			}
		}
	}
}
