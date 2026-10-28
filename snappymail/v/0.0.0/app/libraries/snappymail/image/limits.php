<?php

namespace SnappyMail\Image;

class Limits
{
	const MAX_SOURCE_BYTES = 8388608;
	const MAX_EDGE = 8192;
	const MAX_PIXELS = 8000000;

	public static function read($stream) : string
	{
		$data = \stream_get_contents($stream, self::MAX_SOURCE_BYTES + 1);
		if (false === $data || self::MAX_SOURCE_BYTES < \strlen($data)) {
			throw new \InvalidArgumentException('Image source exceeds processing limit');
		}
		return $data;
	}

	public static function checkGeometry(int $width, int $height) : void
	{
		if (1 > $width || 1 > $height || self::MAX_EDGE < $width || self::MAX_EDGE < $height
		 || $width > \intdiv(self::MAX_PIXELS, $height)) {
			throw new \InvalidArgumentException('Image geometry exceeds processing limit');
		}
	}

	public static function inspect(string &$data) : array
	{
		if (self::MAX_SOURCE_BYTES < \strlen($data)) {
			throw new \InvalidArgumentException('Image source exceeds processing limit');
		}
		$info = @\getimagesizefromstring($data);
		if (!$info || !\in_array($info[2], [IMAGETYPE_GIF, IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) {
			throw new \InvalidArgumentException('Unsupported image');
		}
		self::checkGeometry($info[0], $info[1]);
		return $info;
	}
}
