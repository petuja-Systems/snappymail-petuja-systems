<?php

namespace SnappyMail\DAV;

/** DAV URI syntax and origin identity; private destinations require operator policy elsewhere. */
class Uri
{
	public static function parse(string $uri) : array
	{
		if (\preg_match('/[\x00-\x20\x7f\\\\]/', $uri)
			|| !\preg_match('~\A(https?)://([^/?#]+)([^#]*)\z~isD', $uri, $parts)) {
			throw new UriException('Invalid DAV URI');
		}
		$scheme = \strtolower($parts[1]);
		$authority = $parts[2];
		if (false !== \strpos($authority, '@') || false !== \strpos($authority, '%')) {
			throw new UriException('Invalid DAV authority');
		}
		if ('[' === $authority[0]) {
			if (!\preg_match('/^\[([0-9a-f:.]+)\](?::([0-9]+))?$/iD', $authority, $host)
				|| !\filter_var($host[1], FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
				throw new UriException('Invalid DAV IPv6 address');
			}
		} else if (!\preg_match('/^([^:]+)(?::([0-9]+))?$/D', $authority, $host)) {
			throw new UriException('Invalid DAV authority');
		}
		$port = 'https' === $scheme ? 443 : 80;
		if (isset($host[2])) {
			if (\strlen($host[2]) > 5 || (int) $host[2] < 1 || (int) $host[2] > 65535) {
				throw new UriException('Invalid DAV port');
			}
			$port = (int) $host[2];
		}
		$name = $host[1];
		if (\preg_match('/[^\x00-\x7f]/', $name)) {
			$name = \SnappyMail\IDN::toAscii($name);
		}
		$name = \strtolower($name);
		if ('.' === \substr($name, -1)) {
			$name = \substr($name, 0, -1);
		}
		if (\filter_var($name, FILTER_VALIDATE_IP)) {
			$name = \inet_ntop(\inet_pton($name));
		} else {
			// Do not let native transports reinterpret decimal, octal or hexadecimal IPv4.
			if (\preg_match('/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/iD', $name)
				|| \strlen($name) > 253) {
				throw new UriException('Invalid DAV hostname');
			}
			foreach (\explode('.', $name) as $label) {
				if (!\preg_match('/^(?!-)[a-z0-9-]{1,63}(?<!-)$/D', $label)) {
					throw new UriException('Invalid DAV hostname');
				}
			}
		}
		$authority = false !== \strpos($name, ':') ? '[' . $name . ']' : $name;
		if ($port !== ('https' === $scheme ? 443 : 80)) {
			$authority .= ':' . $port;
		}
		$origin = $scheme . '://' . $authority;
		[$path, $query] = \array_pad(\explode('?', $parts[3], 2), 2, null);
		$path = self::removeDotSegments($path ?: '/');
		return ['uri' => $origin . $path . (null === $query ? '' : '?' . $query),
			'origin' => $origin, 'path' => $path, 'query' => $query];
	}

	public static function resolve(string $base, string $reference) : array
	{
		$base = self::parse($base);
		if (\preg_match('/[\x00-\x20\x7f\\\\#]/', $reference)) {
			throw new UriException('Invalid DAV reference');
		}
		if (\preg_match('/^[a-z][a-z0-9+.-]*:/i', $reference)) {
			return self::parse($reference);
		}
		if ('//' === \substr($reference, 0, 2)) {
			return self::parse(\explode(':', $base['origin'], 2)[0] . ':' . $reference);
		}
		if ('' === $reference) {
			return $base;
		}
		if ('?' === $reference[0]) {
			return self::parse($base['origin'] . $base['path'] . $reference);
		}
		$path = '/' === $reference[0] ? $reference
			: \substr($base['path'], 0, \strrpos($base['path'], '/') + 1) . $reference;
		return self::parse($base['origin'] . $path);
	}

	private static function removeDotSegments(string $path) : string
	{
		$result = [];
		$segments = \explode('/', $path);
		$last = \count($segments) - 1;
		foreach ($segments as $index => $segment) {
			if ('.' === $segment || '..' === $segment) {
				if ('..' === $segment && 1 < \count($result)) {
					\array_pop($result);
				}
				if ($index === $last) {
					$result[] = '';
				}
			} else {
				$result[] = $segment;
			}
		}
		return \implode('/', $result) ?: '/';
	}
}
