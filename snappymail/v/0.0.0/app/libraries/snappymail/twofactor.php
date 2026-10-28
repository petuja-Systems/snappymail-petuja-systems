<?php

namespace SnappyMail;

use RainLoop\Model\Account;
use RainLoop\Providers\Storage;
use RainLoop\Providers\Storage\Enumerations\StorageType;

/**
 * Native operations for the existing per-account two_factor CONFIG value.
 * Login/session orchestration remains with the 2FA integration layer.
 */
final class TwoFactor
{
	const
		STATE_MISSING = 'missing',
		STATE_DISABLED = 'disabled',
		STATE_ENABLED = 'enabled',
		STATE_INVALID = 'invalid';

	private Storage $oStorage;
	private $mStorageAccount;
	private string $sEmail;

	/** @param Account|string $mAccount */
	public function __construct(Storage $oStorage, $mAccount)
	{
		if ($mAccount instanceof Account) {
			$this->mStorageAccount = $mAccount;
			$this->sEmail = $mAccount->Email();
		} else if (\is_string($mAccount) && '' !== $mAccount) {
			// A target email is needed when checking a mailbox represented by an
			// AdditionalAccount: its CONFIG storage namespace belongs to the parent.
			$this->mStorageAccount = $mAccount;
			$this->sEmail = $mAccount;
		} else {
			throw new \InvalidArgumentException('Invalid two-factor account');
		}
		$this->oStorage = $oStorage;
	}

	/**
	 * @return array{Status:string,Record:?array,User:string,IsSet:bool,Enable:bool,Secret:string,BackupCodes:string}
	 */
	public function LoadState() : array
	{
		$mRaw = false;
		try {
			$iPresent = $this->oStorage->Inspect(
				$this->mStorageAccount,
				StorageType::CONFIG,
				'two_factor',
				$mRaw
			);
		} catch (\Throwable $e) {
			return $this->emptyState(self::STATE_INVALID);
		}

		if (false === $iPresent) {
			return $this->emptyState(self::STATE_MISSING);
		}
		if (true !== $iPresent || !\is_string($mRaw) || '' === $mRaw) {
			return $this->emptyState(self::STATE_INVALID);
		}

		$mRecord = self::decodeRecord($mRaw);
		if (!\is_array($mRecord)) {
			return $this->emptyState(self::STATE_INVALID);
		}

		$mRecord = self::normalizeRecord($mRecord, $this->sEmail);
		if (null === $mRecord) {
			return $this->emptyState(self::STATE_INVALID);
		}

		return [
			'Status' => $mRecord['Enable'] ? self::STATE_ENABLED : self::STATE_DISABLED,
			'Record' => $mRecord,
			'User' => $mRecord['User'],
			'IsSet' => true,
			'Enable' => $mRecord['Enable'],
			'Secret' => $mRecord['Secret'],
			'BackupCodes' => $mRecord['BackupCodes'],
			'FactorGeneration' => $mRecord['FactorGeneration'] ?? null,
			'TotpGeneration' => $mRecord['TotpGeneration'] ?? null,
			'LastTotpCounter' => $mRecord['LastTotpCounter'] ?? null
		];
	}

	public static function CreateSecret() : string
	{
		return TOTP::CreateSecret();
	}

	public static function VerifyTotp(string $sSecret, string $sCode) : bool
	{
		return TOTP::Verify($sSecret, $sCode);
	}

	/**
	 * Classify a login proof against a loaded enabled-factor snapshot without
	 * consuming it. The caller must hold the account lock through later use.
	 *
	 * @return array{Type:string,Counter?:int}|null
	 */
	public function ClassifyEnabledLoginProof(array $aState, string $sCode) : ?array
	{
		if (self::STATE_ENABLED !== ($aState['Status'] ?? null)
			|| !\is_string($aState['Secret'] ?? null)
			|| !\is_string($aState['BackupCodes'] ?? null)
			|| !\is_array($aState['Record'] ?? null)) {
			return null;
		}

		if (self::containsRecoveryCode($aState['BackupCodes'], $sCode)) {
			return ['Type' => 'recovery'];
		}

		$iCounter = TOTP::MatchingCounter($aState['Secret'], $sCode);
		$iLastCounter = $aState['LastTotpCounter'] ?? null;
		if (null === $iCounter || (\is_int($iLastCounter) && $iCounter <= $iLastCounter)) {
			return null;
		}

		return ['Type' => 'totp', 'Counter' => $iCounter];
	}

	public static function NewGeneration() : string
	{
		return UUID::generate(UUID::TYPE_RANDOM);
	}

	public static function IsValidGeneration($mGeneration) : bool
	{
		return \is_string($mGeneration) && UUID::isValid($mGeneration);
	}

	/**
	 * Verify and persist one TOTP time step. The caller must hold the shared
	 * per-account SIGN_ME lock so login, enrollment, and factor mutations share
	 * one replay boundary across workers.
	 */
	public function VerifyAndConsumeTotp(string $sCode, string $sExpectedStatus = self::STATE_ENABLED) : bool
	{
		$mState = $this->LoadState();
		if ($sExpectedStatus !== $mState['Status'] || !\in_array($sExpectedStatus, [self::STATE_ENABLED, self::STATE_DISABLED], true)) {
			return false;
		}

		$iCounter = TOTP::MatchingCounter($mState['Secret'], $sCode);
		return null !== $iCounter
			&& $this->consumeMatchedTotpCounter($mState, $iCounter, $sExpectedStatus);
	}

	/**
	 * Consume the exact counter returned by ClassifyEnabledLoginProof(). This
	 * avoids re-evaluating a valid code across a TOTP time-step boundary.
	 */
	public function ConsumeClassifiedTotpCounter(array $aState, int $iCounter) : bool
	{
		return $this->consumeMatchedTotpCounter($aState, $iCounter, self::STATE_ENABLED);
	}

	private function consumeMatchedTotpCounter(array $aExpectedState, int $iCounter, string $sExpectedStatus) : bool
	{
		$aExpectedRecord = $aExpectedState['Record'] ?? null;
		if ($sExpectedStatus !== ($aExpectedState['Status'] ?? null)
			|| !\in_array($sExpectedStatus, [self::STATE_ENABLED, self::STATE_DISABLED], true)
			|| !\is_array($aExpectedRecord)
			|| !\is_string($aExpectedRecord['Secret'] ?? null)
			|| $iCounter < 0) {
			return false;
		}

		$mState = $this->LoadState();
		if ($sExpectedStatus !== $mState['Status']
			|| $aExpectedRecord['Secret'] !== ($mState['Record']['Secret'] ?? null)
			|| ($aExpectedState['FactorGeneration'] ?? null) !== $mState['FactorGeneration']
			|| ($aExpectedState['TotpGeneration'] ?? null) !== $mState['TotpGeneration']
			|| ($aExpectedState['LastTotpCounter'] ?? null) !== $mState['LastTotpCounter']) {
			return false;
		}

		$mRecord = $mState['Record'];
		$iLastCounter = $mRecord['LastTotpCounter'] ?? null;
		if (null !== $iLastCounter && (!\is_int($iLastCounter) || $iCounter <= $iLastCounter)) {
			return false;
		}

		if (!isset($mRecord['FactorGeneration'])) {
			$mRecord['FactorGeneration'] = self::NewGeneration();
		}
		if (!isset($mRecord['TotpGeneration'])) {
			$mRecord['TotpGeneration'] = self::NewGeneration();
		}
		$mRecord['LastTotpCounter'] = $iCounter;

		if (!$this->Save($mRecord)) {
			return false;
		}

		$mUpdated = $this->LoadState();
		return $sExpectedStatus === $mUpdated['Status']
			&& $mUpdated['Record']['Secret'] === $mRecord['Secret']
			&& $mUpdated['FactorGeneration'] === $mRecord['FactorGeneration']
			&& $mUpdated['TotpGeneration'] === $mRecord['TotpGeneration']
			&& $mUpdated['LastTotpCounter'] === $iCounter;
	}

	/**
	 * Upgrade a legacy factor record after successful recovery-code proof. The
	 * caller must hold the shared account lock; this does not consume a TOTP
	 * counter because recovery codes are an independent factor proof.
	 */
	public function EnsureFactorGenerationAfterRecovery() : bool
	{
		$mState = $this->LoadState();
		if (self::STATE_ENABLED !== $mState['Status']) {
			return false;
		}

		$mRecord = $mState['Record'];
		$bChanged = false;
		if (!isset($mRecord['FactorGeneration'])) {
			$mRecord['FactorGeneration'] = self::NewGeneration();
			$bChanged = true;
		}
		if (!isset($mRecord['TotpGeneration'])) {
			$mRecord['TotpGeneration'] = self::NewGeneration();
			$bChanged = true;
		}

		if ($bChanged && !$this->Save($mRecord)) {
			return false;
		}

		$mUpdated = $this->LoadState();
		return self::STATE_ENABLED === $mUpdated['Status']
			&& $mUpdated['FactorGeneration'] === $mRecord['FactorGeneration']
			&& $mUpdated['TotpGeneration'] === $mRecord['TotpGeneration'];
	}

	/**
	 * Return eight nine-digit numeric recovery codes in the existing format.
	 */
	public static function GenerateRecoveryCodes() : array
	{
		$aCodes = [];
		for ($i = 0; $i < 8; ++$i) {
			$aCodes[] = (string) \random_int(100000000, 900000000);
		}
		return $aCodes;
	}

	public function VerifyRecoveryCode(string $sCode) : bool
	{
		$mState = $this->LoadState();
		return self::STATE_ENABLED === $mState['Status']
			&& self::containsRecoveryCode($mState['BackupCodes'], $sCode);
	}

	/**
	 * Verify and consume a code from the authoritative store. Persistence must
	 * be confirmed by a reread before the caller may authenticate the account.
	 */
	public function ConsumeRecoveryCode(string $sCode) : bool
	{
		$mState = $this->LoadState();
		if (self::STATE_ENABLED !== $mState['Status']
			|| !self::containsRecoveryCode($mState['BackupCodes'], $sCode)) {
			return false;
		}

		$mRecord = $mState['Record'];
		$aCodes = self::recoveryCodeTokens($mState['BackupCodes']);
		$mRecord['BackupCodes'] = \implode(' ', \array_values(\array_filter(
			$aCodes,
			static function (string $sStoredCode) use ($sCode) : bool {
				return $sStoredCode !== $sCode;
			}
		)));

		if (!$this->Save($mRecord)) {
			return false;
		}

		$mUpdated = $this->LoadState();
		return self::STATE_ENABLED === $mUpdated['Status']
			&& !self::containsRecoveryCode($mUpdated['BackupCodes'], $sCode);
	}

	/**
	 * Persist a validated state to the existing CONFIG record and verify the
	 * value after writing. Existing extra scalar fields are retained.
	 */
	public function Save(array $mRecord) : bool
	{
		$mRecord = self::normalizeRecord($mRecord, $this->sEmail);
		if (null === $mRecord) {
			return false;
		}

		try {
			$sJson = \json_encode($mRecord, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
			if (!$this->oStorage->Put($this->mStorageAccount, StorageType::CONFIG, 'two_factor', $sJson)) {
				return false;
			}
		} catch (\Throwable $e) {
			return false;
		}

		$mSaved = $this->LoadState();
		return self::STATE_INVALID !== $mSaved['Status']
			&& self::STATE_MISSING !== $mSaved['Status']
			&& $mSaved['Record'] === $mRecord;
	}

	public function Clear() : bool
	{
		try {
			return $this->oStorage->Clear($this->mStorageAccount, StorageType::CONFIG, 'two_factor');
		} catch (\Throwable $e) {
			return false;
		}
	}

	private function emptyState(string $sStatus) : array
	{
		return [
			'Status' => $sStatus,
			'Record' => null,
			'User' => $this->sEmail,
			'IsSet' => false,
			'Enable' => false,
			'Secret' => '',
			'BackupCodes' => '',
			'FactorGeneration' => null,
			'TotpGeneration' => null,
			'LastTotpCounter' => null
		];
	}

	private static function decodeRecord(string $sData) : ?array
	{
		$mRecord = self::decodeJsonOrSerialized($sData);
		if (\is_array($mRecord)) {
			return $mRecord;
		}

		// Older plugin records were URL-safe-base64 encoded XXTEA payloads.
		$sBase64 = \strtr($sData, '-_', '+/');
		$sCiphertext = \base64_decode($sBase64, true);
		if (!\is_string($sCiphertext) || '' === $sCiphertext) {
			return null;
		}

		try {
			$sKey = \md5(APP_SALT);
			$sPlaintext = \is_callable('xxtea_decrypt')
				? \xxtea_decrypt($sCiphertext, $sKey)
				: \MailSo\Base\Xxtea::decrypt($sCiphertext, $sKey);
		} catch (\Throwable $e) {
			return null;
		}

		return \is_string($sPlaintext) ? self::decodeJsonOrSerialized($sPlaintext) : null;
	}

	private static function decodeJsonOrSerialized(string $sData) : ?array
	{
		try {
			$mDecoded = \json_decode($sData, true, 512, JSON_THROW_ON_ERROR);
			if (\is_array($mDecoded) && self::isSafeValueTree($mDecoded)) {
				return $mDecoded;
			}
		} catch (\Throwable $e) {
			// Continue to the serialized legacy representation.
		}

		try {
			$mDecoded = @\unserialize($sData, [
				'allowed_classes' => false,
				'max_depth' => 16
			]);
		} catch (\Throwable $e) {
			return null;
		}

		return \is_array($mDecoded) && self::isSafeValueTree($mDecoded) ? $mDecoded : null;
	}

	private static function normalizeRecord(array $mRecord, string $sEmail) : ?array
	{
		if (!self::isSafeValueTree($mRecord)
			|| !isset($mRecord['User'])
			|| !\is_string($mRecord['User'])
			|| '' === $mRecord['User']
			|| $sEmail !== $mRecord['User']
			|| !isset($mRecord['Secret'])
			|| !\is_string($mRecord['Secret'])
			|| '' === $mRecord['Secret']) {
			return null;
		}

		$bEnable = false;
		if (\array_key_exists('Enable', $mRecord)) {
			$mEnable = $mRecord['Enable'];
			if (\is_bool($mEnable)) {
				$bEnable = $mEnable;
			} else if (\is_int($mEnable) && (0 === $mEnable || 1 === $mEnable)) {
				$bEnable = 1 === $mEnable;
			} else if (\is_string($mEnable) && ('' === $mEnable || '0' === $mEnable || '1' === $mEnable)) {
				$bEnable = '1' === $mEnable;
			} else {
				return null;
			}
		}

		if (\array_key_exists('BackupCodes', $mRecord) && !\is_string($mRecord['BackupCodes'])) {
			return null;
		}
		if (\array_key_exists('QRCode', $mRecord) && !\is_string($mRecord['QRCode'])) {
			return null;
		}
		foreach (['FactorGeneration', 'TotpGeneration'] as $sGenerationField) {
			if (\array_key_exists($sGenerationField, $mRecord)
				&& !self::IsValidGeneration($mRecord[$sGenerationField])) {
				return null;
			}
		}
		if (\array_key_exists('LastTotpCounter', $mRecord)
			&& null !== $mRecord['LastTotpCounter']
			&& (!\is_int($mRecord['LastTotpCounter']) || 0 > $mRecord['LastTotpCounter'])) {
			return null;
		}
		if (\array_key_exists('LastTotpCounter', $mRecord)
			&& \is_int($mRecord['LastTotpCounter'])
			&& !isset($mRecord['TotpGeneration'])) {
			return null;
		}
		foreach ($mRecord as $sField => $mValue) {
			if (!\is_string($sField)) {
				return null;
			}
			if (!\in_array($sField, ['User', 'Enable', 'Secret', 'BackupCodes', 'QRCode'], true)
				&& null !== $mValue && !\is_scalar($mValue)) {
				return null;
			}
		}

		$mRecord['Enable'] = $bEnable;
		$mRecord['BackupCodes'] = $mRecord['BackupCodes'] ?? '';
		return $mRecord;
	}

	private static function isSafeValueTree($mValue, int $iDepth = 0) : bool
	{
		if ($iDepth > 16) {
			return false;
		}
		if (\is_array($mValue)) {
			foreach ($mValue as $mKey => $mChild) {
				if (!\is_int($mKey) && !\is_string($mKey)) {
					return false;
				}
				if (!self::isSafeValueTree($mChild, $iDepth + 1)) {
					return false;
				}
			}
			return true;
		}
		return null === $mValue
			|| \is_bool($mValue)
			|| \is_int($mValue)
			|| (\is_float($mValue) && \is_finite($mValue))
			|| \is_string($mValue);
	}

	private static function containsRecoveryCode(string $sCodes, string $sCode) : bool
	{
		return \strlen($sCode) > 6
			&& 1 === \preg_match('/\A[0-9]+\z/', $sCode)
			&& \in_array($sCode, self::recoveryCodeTokens($sCodes), true);
	}

	private static function recoveryCodeTokens(string $sCodes) : array
	{
		\preg_match_all('/[0-9]+/', $sCodes, $aMatches);
		return $aMatches[0] ?? [];
	}
}
