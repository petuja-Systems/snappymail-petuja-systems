<?php

namespace RainLoop\Providers\Storage;

interface IRevocationStorage
{
	/**
	 * Inspect one stored value without conflating confirmed absence and I/O
	 * failure. Return true when present, false when confirmed absent, or null
	 * when the result cannot be determined. On true, $mValue receives the value.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 * @param mixed $mValue
	 */
	public function Inspect($mAccount, int $iStorageType, string $sKey, &$mValue) : ?bool;

	/**
	 * Remove one exact stored value. Return true when removed, false when
	 * confirmed absent, or null when the result cannot be determined.
	 *
	 * @param \RainLoop\Model\Account|string|null $mAccount
	 */
	public function Revoke($mAccount, int $iStorageType, string $sKey) : ?bool;
}
