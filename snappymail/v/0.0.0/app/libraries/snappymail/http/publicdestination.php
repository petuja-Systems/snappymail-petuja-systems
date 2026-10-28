<?php

namespace SnappyMail\HTTP;

/** Public-image destinations only; ordinary trusted HTTP callers do not use this policy. */
class PublicDestination
{
	public static function parseURI(string $uri) : array
	{
		if (\preg_match('/[\x00-\x20\x7f\\\\]/', $uri)
			|| !\preg_match('~\A(https?)://([^/?#]+)([^#]*)(?:#.*)?\z~isD', $uri, $parts)) {
			throw new \RuntimeException('Invalid public image URI');
		}
		$scheme = \strtolower($parts[1]);
		$authority = $parts[2];
		if (false !== \strpos($authority, '@') || false !== \strpos($authority, '%')) {
			throw new \RuntimeException('Invalid public image authority');
		}
		if ('[' === $authority[0]) {
			if (!\preg_match('/^\[([0-9a-f:.]+)\](?::([0-9]+))?$/iD', $authority, $host)
				|| !\filter_var($host[1], FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
				throw new \RuntimeException('Invalid public image IPv6 address');
			}
		} else if (!\preg_match('/^([^:]+)(?::([0-9]+))?$/D', $authority, $host)) {
			throw new \RuntimeException('Invalid public image authority');
		}
		$port = 'https' === $scheme ? 443 : 80;
		if (isset($host[2])) {
			if (\strlen($host[2]) > 5 || (int) $host[2] < 1 || (int) $host[2] > 65535) {
				throw new \RuntimeException('Invalid public image port');
			}
			$port = (int) $host[2];
		}
		$name = self::canonicalHost($host[1]);
		$authority = false !== \strpos($name, ':') ? '[' . $name . ']' : $name;
		if ($port !== ('https' === $scheme ? 443 : 80)) {
			$authority .= ':' . $port;
		}
		$path = $parts[3];
		if ('' === $path || '?' === $path[0]) {
			$path = '/' . $path;
		}
		return ['uri' => $scheme . '://' . $authority . $path, 'host' => $name, 'port' => $port];
	}

	private static function canonicalHost(string $host) : string
	{
		if (\preg_match('/[^\x00-\x7f]/', $host)) {
			$host = \SnappyMail\IDN::toAscii($host);
		}
		$host = \strtolower($host);
		if ('.' === \substr($host, -1)) {
			$host = \substr($host, 0, -1);
		}
		if (\filter_var($host, FILTER_VALIDATE_IP)) {
			return \inet_ntop(\inet_pton($host));
		}
		// Native clients must never reinterpret an old decimal/octal/hex IPv4 spelling.
		if (\preg_match('/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/iD', $host)
			|| \strlen($host) > 253 || false === \strpos($host, '.')) {
			throw new \RuntimeException('Invalid public image hostname');
		}
		foreach (\explode('.', $host) as $label) {
			if (!\preg_match('/^(?!-)[a-z0-9-]{1,63}(?<!-)$/D', $label)) {
				throw new \RuntimeException('Invalid public image hostname');
			}
		}
		return $host;
	}

	/** IANA special-purpose registries, reviewed 2026-10-19; deliberately conservative. */
	public static function isPublicAddress(string $address) : bool
	{
		$packed = @\inet_pton($address);
		if (false === $packed) {
			return false;
		}
		if (4 === \strlen($packed)) {
			$ranges = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
				'169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
				'192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
				'192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
				'224.0.0.0/4', '240.0.0.0/4'];
		} else {
			if (!self::inRange($packed, '2000::/3')) {
				return false;
			}
			$ranges = ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20'];
		}
		foreach ($ranges as $range) {
			if (self::inRange($packed, $range)) {
				return false;
			}
		}
		return true;
	}

	private static function inRange(string $packed, string $range) : bool
	{
		[$base, $bits] = \explode('/', $range);
		$base = \inet_pton($base);
		$bytes = \intdiv((int) $bits, 8);
		$remaining = (int) $bits % 8;
		return \substr($packed, 0, $bytes) === \substr($base, 0, $bytes)
			&& (!$remaining || (\ord($packed[$bytes]) & (255 << (8 - $remaining))) === \ord($base[$bytes]));
	}

	public function resolve(string $uri, callable $checkDeadline) : array
	{
		$destination = self::parseURI($uri);
		$name = $destination['host'];
		if (\filter_var($name, FILTER_VALIDATE_IP)) {
			if (!self::isPublicAddress($name)) {
				throw new \RuntimeException('Non-public image destination');
			}
			$destination['addresses'] = [$name];
			return $destination;
		}
		$seen = [];
		for ($hop = 0; $hop < 8; ++$hop) {
			if (isset($seen[$name])) {
				break;
			}
			$seen[$name] = true;
			$records = $this->lookup($name, DNS_A | DNS_AAAA, $checkDeadline);
			$addresses = [];
			foreach ($records as $record) {
				$type = $record['type'] ?? '';
				if ('CNAME' === $type) {
					continue; // Native A/AAAA answers may already be from the terminal alias owner.
				}
				$address = 'A' === $type ? ($record['ip'] ?? '') : ('AAAA' === $type ? ($record['ipv6'] ?? '') : '');
				if (!\is_string($address) || !\filter_var($address, FILTER_VALIDATE_IP,
					'A' === $type ? FILTER_FLAG_IPV4 : FILTER_FLAG_IPV6) || !self::isPublicAddress($address)) {
					throw new \RuntimeException('Non-public or invalid image DNS answer');
				}
				$addresses[] = \inet_ntop(\inet_pton($address));
			}
			if ($addresses) {
				$destination['addresses'] = \array_values(\array_unique($addresses));
				return $destination;
			}
			$targets = [];
			foreach ($this->lookup($name, DNS_CNAME, $checkDeadline) as $record) {
				if ('CNAME' !== ($record['type'] ?? '') || !\is_string($record['host'] ?? null)
					|| !\is_string($record['target'] ?? null)) {
					throw new \RuntimeException('Invalid image DNS alias');
				}
				if (self::canonicalHost($record['host']) === $name) {
					$targets[] = self::canonicalHost($record['target']);
				}
			}
			if (1 !== \count(\array_unique($targets)) || \filter_var($targets[0], FILTER_VALIDATE_IP)) {
				break;
			}
			$name = $targets[0];
		}
		throw new \RuntimeException('Unresolved public image destination');
	}

	protected function lookup(string $name, int $type, callable $checkDeadline) : array
	{
		$checkDeadline();
		$records = @\dns_get_record($name, $type);
		$checkDeadline();
		if (!\is_array($records) || \count($records) > 64) {
			throw new \RuntimeException('Image DNS lookup failed');
		}
		return $records;
	}
}
