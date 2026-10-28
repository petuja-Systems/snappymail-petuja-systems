<?php

namespace RainLoop\Actions;

use RainLoop\Enumerations\Capa;
use RainLoop\Notifications;
use RainLoop\Utils;
use RainLoop\Model\Account;
use RainLoop\Model\MainAccount;
use RainLoop\Model\AdditionalAccount;
use RainLoop\Providers\Storage\Enumerations\StorageType;
use RainLoop\Exceptions\ClientException;
use SnappyMail\Cookies;
use SnappyMail\SensitiveString;

trait UserAuth
{
	/**
	 * @var bool | null | Account
	 */
	private $oAdditionalAuthAccount = false;
	private $oMainAuthAccount = false;
	private string $sSignMeTwoFactorState = '';
	private ?string $sLogoutRevokedSignMeLineage = null;

	private function sessionAuthStorageKey(string $sToken): string
	{
		return 'auth-'.$sToken;
	}

	private function sessionAuthBinding(string $sAuthToken): string
	{
		return 'v2:'.\hash('sha256', $sAuthToken);
	}

	private function sessionAuthBindingMatches($mBinding, string $sAuthToken, bool $bAllowLegacy = false): bool
	{
		if (!\is_string($mBinding)) {
			return false;
		}

		$sHash = \hash('sha256', $sAuthToken);
		return \hash_equals($mBinding, 'v2:'.$sHash)
			|| ($bAllowLegacy && \hash_equals($mBinding, $sHash));
	}

	private function parseSessionAssurance(string $sAssurance) : ?array
	{
		// Keep the historical marker only as a no-factor compatibility state.
		if ('true' === $sAssurance) {
			return ['State' => 'legacy', 'Generation' => null];
		}
		if (\in_array($sAssurance, ['primary', 'pending', 'legacy'], true)) {
			return ['State' => $sAssurance, 'Generation' => null];
		}

		if (1 === \preg_match('/\Averified:([a-f0-9-]{36})\z/iD', $sAssurance, $aMatches)
			&& \SnappyMail\TwoFactor::IsValidGeneration($aMatches[1])) {
			return ['State' => 'verified', 'Generation' => $aMatches[1]];
		}

		return null;
	}

	private function verifiedSessionAssurance(MainAccount $oAccount) : string
	{
		$aState = $this->twoFactorService($oAccount)->LoadState();
		if (\SnappyMail\TwoFactor::STATE_ENABLED !== $aState['Status']
			|| !\SnappyMail\TwoFactor::IsValidGeneration($aState['FactorGeneration'])) {
			throw new ClientException(Notifications::AuthError);
		}

		return 'verified:'.$aState['FactorGeneration'];
	}

	private function pendingTwoFactorAuthorityRequired(string $sAssurance) : bool
	{
		$aAssurance = $this->parseSessionAssurance($sAssurance);
		return $this->twoFactorIsRequired()
			&& \is_array($aAssurance)
			&& 'pending' === $aAssurance['State'];
	}

	/**
	 * @return array{Limiter:\SnappyMail\LoginAbuseLimiter, Ticket:array}|false|null
	 */
	private function reservePendingTwoFactorAuthority(MainAccount $oAccount, string $sAssurance)
	{
		if (!$this->pendingTwoFactorAuthorityRequired($sAssurance)) {
			return null;
		}

		$oLimiter = new \SnappyMail\LoginAbuseLimiter(APP_PRIVATE_DATA . 'login-abuse', APP_SALT);
		$aTicket = $oLimiter->reserve(
			'two-factor',
			$this->Http()->GetClientIp(),
			[$oAccount->Email()]
		);

		return $aTicket ? ['Limiter' => $oLimiter, 'Ticket' => $aTicket] : false;
	}

	private function releasePendingTwoFactorAuthority(array $aAdmission) : bool
	{
		return $aAdmission['Limiter']->release($aAdmission['Ticket']);
	}

	private function decodeSignMeStorageRecord($mRecord) : ?array
	{
		if (!\is_string($mRecord) || '' === $mRecord) {
			return null;
		}

		try {
			$aRecord = \json_decode($mRecord, true, 8, JSON_THROW_ON_ERROR);
		} catch (\Throwable $e) {
			$aRecord = null;
		}

		if (!\is_array($aRecord) || !\array_key_exists('Version', $aRecord)) {
			return ['Version' => 2, 'Token' => $mRecord, 'StoredValue' => $mRecord];
		}

		if (3 !== ($aRecord['Version'] ?? null)
			|| !\is_string($aRecord['Token'] ?? null)
			|| '' === $aRecord['Token']
			|| !\is_string($aRecord['Assurance'] ?? null)
			|| !\array_key_exists('Generation', $aRecord)) {
			return null;
		}
		$mToken = \base64_decode($aRecord['Token'], true);
		if (!\is_string($mToken) || '' === $mToken) {
			return null;
		}

		$sAssurance = $aRecord['Assurance'];
		$sGeneration = $aRecord['Generation'];
		if ('verified' === $sAssurance) {
			if (!\SnappyMail\TwoFactor::IsValidGeneration($sGeneration)) {
				return null;
			}
		} else if (!\in_array($sAssurance, ['primary', 'pending', 'legacy'], true) || null !== $sGeneration) {
			return null;
		}

		return [
			'Version' => 3,
			'Token' => $mToken,
			'Assurance' => $sAssurance,
			'Generation' => $sGeneration,
			'StoredValue' => $mRecord
		];
	}

	private function acquireSignMeLock($mAccount)
	{
		$oStorage = $this->StorageProvider();
		if (!$oStorage->SupportsLocking()) {
			return false;
		}

		return $oStorage->AcquireLock($mAccount, StorageType::SIGN_ME, 'account');
	}

	private function signMeCookieValue(
		MainAccount $oAccount,
		string $sUuid,
		string $sTwoFactorAssurance,
		?string &$sStoredAuthToken = null
	): string
	{
		$aAssurance = $this->parseSessionAssurance($sTwoFactorAssurance);
		if (!$aAssurance) {
			throw new \RuntimeException('Invalid Remember-Me assurance');
		}

		$oStorage = $this->StorageProvider();
		$aData = \SnappyMail\Crypt::Encrypt($oAccount, 'signme');
		$aStoredRecord = [
			'Version' => 3,
			'Token' => \base64_encode($aData[2]),
			'Assurance' => $aAssurance['State'],
			'Generation' => $aAssurance['Generation']
		];
		$sStoredRecord = \json_encode($aStoredRecord, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
		$sStoredAuthToken = $sStoredRecord;
		if (!$oStorage->Put($oAccount, StorageType::SIGN_ME, $sUuid, $sStoredRecord)
			|| $oStorage->Get($oAccount, StorageType::SIGN_ME, $sUuid) !== $sStoredRecord) {
			throw new \RuntimeException('Unable to persist SignMe token');
		}

		return \SnappyMail\Crypt::EncryptUrlSafe([
			'e' => $oAccount->Email(),
			'u' => $sUuid,
			'v' => 3,
			'c' => $aData[0],
			'd' => \base64_encode($aData[1]),
			'm' => $aAssurance['State'],
			'g' => $aAssurance['Generation']
		], 'signme');
	}

	private function sessionSignMeIsActive(MainAccount $oAccount, array $aAuthData, $oStorage): bool
	{
		if (!\array_key_exists('_signMeLineage', $aAuthData)) {
			return true;
		}

		$sLineage = $aAuthData['_signMeLineage'];
		if (!\is_string($sLineage) || !\SnappyMail\UUID::isValid($sLineage)) {
			return false;
		}

		$mLock = $this->acquireSignMeLock($oAccount);
		if (!$mLock) {
			return false;
		}

		try {
			$sSignMeToken = $oStorage->Get($oAccount, StorageType::SIGN_ME, $sLineage);
			if (!\is_string($sSignMeToken) || '' === $sSignMeToken) {
				return false;
			}

			// The SESSION record slides on authenticated use. Keep its linked
			// SignMe record alive for the same active lifetime, under the lock
			// shared with FileStorage GC and explicit logout.
			return $oStorage->Put($oAccount, StorageType::SIGN_ME, $sLineage, $sSignMeToken)
				&& $oStorage->Get($oAccount, StorageType::SIGN_ME, $sLineage) === $sSignMeToken;
		} catch (\Throwable $e) {
			\SnappyMail\Log::warning(self::AUTH_SPEC_TOKEN_KEY, $e->getMessage());
			return false;
		} finally {
			$oStorage->ReleaseLock($mLock);
		}
	}

	private function clearSignMeRecordIfCurrent(
		string $sEmail,
		string $sUuid,
		?string $sExpectedToken
	): void {
		if (null === $sExpectedToken) {
			return;
		}

		$oStorage = $this->StorageProvider();
		if (!$oStorage->SupportsLocking()) {
			return;
		}
		$mLock = $this->acquireSignMeLock($sEmail);
		if (!$mLock) {
			return;
		}
		try {
			$sCurrentToken = $oStorage->Get($sEmail, StorageType::SIGN_ME, $sUuid);
			if (\is_string($sCurrentToken) && \hash_equals($sExpectedToken, $sCurrentToken)) {
				$this->clearSignMeRecord($oStorage, $sEmail, $sUuid);
			}
		} catch (\Throwable $e) {
			\SnappyMail\Log::warning(self::AUTH_SIGN_ME_TOKEN_KEY, $e->getMessage());
		} finally {
			$oStorage->ReleaseLock($mLock);
		}
	}

	private function storeSessionAuthBinding(MainAccount $oAccount): void
	{
		$sSessionToken = Utils::GetSessionToken(false);
		$sAuthToken = Cookies::get(self::AUTH_SPEC_TOKEN_KEY);
		if (!$sSessionToken || !$sAuthToken) {
			throw new \RuntimeException('Unable to bind account token to session');
		}

		$sKey = $this->sessionAuthStorageKey($sSessionToken);
		$sHash = $this->sessionAuthBinding($sAuthToken);
		$oStorage = $this->StorageProvider();
		if (!$oStorage->Put($oAccount, StorageType::SESSION, $sKey, $sHash)
			|| $oStorage->Get($oAccount, StorageType::SESSION, $sKey) !== $sHash) {
			$oStorage->Clear($oAccount, StorageType::SESSION, $sKey);
			$oStorage->Clear($oAccount, StorageType::SESSION, $sSessionToken);
			Cookies::clear(self::AUTH_SPEC_TOKEN_KEY);
			Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
			Cookies::clear(Utils::SESSION_TOKEN);
			throw new \RuntimeException('Unable to bind account token to session');
		}
	}

	public function DoResealCryptKey() : array
	{
		return $this->DefaultResponse(
			$this->getMainAccountFromToken()->resealCryptKey(
				new SensitiveString($this->GetActionParam('passphrase', ''))
			)
		);
	}

	/**
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	protected function resolveLoginCredentials(string $sEmail, SensitiveString $oPassword): array
	{
		$sEmail = \SnappyMail\IDN::emailToAscii(\MailSo\Base\Utils::Trim($sEmail));

		$oDomain = null;
		$oDomainProvider = $this->DomainProvider();

		// When email address is missing the domain, try to add it
		if (!\str_contains($sEmail, '@')) {
			$this->logWrite("The email address '{$sEmail}' is incomplete", \LOG_INFO, 'LOGIN');
			if ($this->Config()->Get('login', 'determine_user_domain', false)) {
				$sUserHost = \SnappyMail\IDN::toAscii($this->Http()->GetHost(false, true));
				$this->logWrite("Determined user domain: {$sUserHost}", \LOG_INFO, 'LOGIN');

				// Determine without wildcard
				$aDomainParts = \explode('.', $sUserHost);
				$iLimit = \min(\count($aDomainParts), 14);
				while (0 < $iLimit--) {
					$sDomain = \implode('.', $aDomainParts);
					$oDomain = $oDomainProvider->Load($sDomain, false);
					if ($oDomain) {
						$sEmail .= '@' . $sDomain;
						$this->logWrite("Check '{$sDomain}': OK", \LOG_INFO, 'LOGIN');
						break;
					} else {
						$this->logWrite("Check '{$sDomain}': NO", \LOG_INFO, 'LOGIN');
					}
					\array_shift($aDomainParts);
				}

				// Else determine with wildcard
				if (!$oDomain) {
					$oDomain = $oDomainProvider->Load($sUserHost, true);
					if ($oDomain) {
						$sEmail .= '@' . $sUserHost;
						$this->logWrite("Check '{$sUserHost}' with wildcard: OK", \LOG_INFO, 'LOGIN');
					} else {
						$this->logWrite("Check '{$sUserHost}' with wildcard: NO", \LOG_INFO, 'LOGIN');
					}
				}

				if (!$oDomain) {
					$this->logWrite("Domain '{$sUserHost}' was not determined!", \LOG_INFO, 'LOGIN');
				}
			}

			// Else try default domain
			if (!$oDomain) {
				$sDefDomain = \trim($this->Config()->Get('login', 'default_domain', ''));
				if (\strlen($sDefDomain)) {
					if ('HTTP_HOST' === $sDefDomain || 'SERVER_NAME' === $sDefDomain) {
						$sDefDomain = \preg_replace('/:[0-9]+$/D', '', $_SERVER[$sDefDomain]);
					} else if ('gethostname' === $sDefDomain) {
						$sDefDomain = \gethostname();
					}
					$sEmail .= '@' . $sDefDomain;
					$this->logWrite("Default domain '{$sDefDomain}' will be used.", \LOG_INFO, 'LOGIN');
				} else {
					$this->logWrite('Default domain not configured.', \LOG_INFO, 'LOGIN');
				}
			}
		}

		$sPassword = $oPassword->getValue();
		$this->logMask($sPassword);

		$sImapUser = $sEmail;
		$sSmtpUser = $sEmail;
		if (\str_contains($sEmail, '@')
		 && ($oDomain || ($oDomain = $oDomainProvider->Load(\MailSo\Base\Utils::getEmailAddressDomain($sEmail), true)))
		) {
			$sEmail = $oDomain->ImapSettings()->fixUsername($sEmail, false);
			$sImapUser = $oDomain->ImapSettings()->fixUsername($sImapUser);
			$sSmtpUser = $oDomain->SmtpSettings()->fixUsername($sSmtpUser);
		}

		return [
			'email' => $sEmail,
			'domain' => $oDomain,
			'imapUser' => $sImapUser,
			'smtpUser' => $sSmtpUser,
			'pass' => $oPassword
		];
	}

	/**
	 * Shared boundary for public interactive password logins.
	 *
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	public function LoginPublicPassword(string $sEmail, SensitiveString $oPassword): Account
	{
		$oAccount = $this->AuthenticatePublicPasswordPrimary($sEmail, $oPassword);

		try {
			if ($oAccount instanceof MainAccount) {
				$mCode = $this->GetActionParam('totp_code', '');
				$this->completePrimaryMainLogin(
					$oAccount,
					\is_string($mCode) ? \trim($mCode) : '',
					true
				);
			}
			return $oAccount;
		} catch (\Throwable $oException) {
			$this->loginErrorDelay();
			throw $oException;
		}
	}

	/**
	 * Authenticate public password credentials without creating mailbox authority.
	 * The short-lived native 2FA login actions use this for their primary step.
	 */
	protected function AuthenticatePublicPasswordPrimary(string $sEmail, SensitiveString $oPassword): Account
	{
		try {
			$aCredentials = $this->resolveLoginCredentials($sEmail, $oPassword);
			$oSettings = $aCredentials['domain'] ? $aCredentials['domain']->ImapSettings() : null;
			$oLimiter = new \SnappyMail\LoginAbuseLimiter(APP_PRIVATE_DATA . 'login-abuse', APP_SALT);
			$aTicket = $oLimiter->reserve('mail', $this->Http()->GetClientIp(), $oSettings
				? [$oSettings->host, $oSettings->port, $aCredentials['imapUser']] : ['unresolved']);
			if (!$aTicket) {
				throw new ClientException(Notifications::AuthError);
			}
			try {
				$oAccount = $this->authenticatePrimaryCredentials($sEmail, $oPassword, true, $aCredentials);
			} catch (\Throwable $oException) {
				// Only an explicit backend credential rejection spends the failure
				// budget. TLS, connection and provider outages must not lock users out.
				if (!($oException instanceof ClientException
					&& $oException->getPrevious() instanceof \MailSo\Imap\Exceptions\LoginBadCredentialsException)
					&& !$oLimiter->release($aTicket)) {
					throw new ClientException(Notifications::AuthError);
				}
				throw $oException;
			}
			if (!$oLimiter->release($aTicket)) {
				throw new ClientException(Notifications::AuthError);
			}
			return $oAccount;
		} catch (\Throwable $oException) {
			$this->loginErrorDelay();
			throw $oException;
		}
	}

	/**
	 * Low-level authentication primitive. Public interactive password entry
	 * points should use LoginPublicPassword() so native login policy applies.
	 * Trusted/provider authentication flows intentionally keep calling this
	 * method directly.
	 *
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	public function LoginProcess(string $sEmail, SensitiveString $oPassword, bool $bMainAccount = true): Account
	{
		$oAccount = $this->authenticatePrimaryCredentials($sEmail, $oPassword, $bMainAccount);
		if ($bMainAccount && $oAccount instanceof MainAccount) {
			// Trusted/provider callers keep their own entry policy. They still
			// cannot issue a main-account session for an enabled
			// factor without supplying proof through a supported native flow.
			$this->completePrimaryMainLogin($oAccount, '', false);
		}

		return $oAccount;
	}

	private function authenticatePrimaryCredentials(string $sEmail, SensitiveString $oPassword, bool $bMainAccount, ?array $aCredentials = null): Account
	{
		$aCredentials = $aCredentials ?? $this->resolveLoginCredentials($sEmail, $oPassword);

		if (!\str_contains($aCredentials['email'], '@') || !\strlen($oPassword)) {
			throw new ClientException(Notifications::InvalidInputArgument);
		}

		$oDomain = $this->DomainProvider()->getByEmailAddress($aCredentials['email']);

		$oAccount = null;
		try {
			$oAccount = $bMainAccount ? new MainAccount : new AdditionalAccount;
			$oAccount->setCredentials(
				$aCredentials['domain'],
				$aCredentials['email'],
				$aCredentials['imapUser'],
				$oPassword,
				$aCredentials['smtpUser']
//				,new SensitiveString($oPassword)
			);
		} catch (\Throwable $oException) {
			$this->LoggerAuthHelper($oAccount, $sEmail);
			throw $oException;
		}

		$this->imapConnect($oAccount, true);
		return $oAccount;
	}

	/**
	 * Verify any required factor, then create the ordinary authenticated session.
	 */
	private function completePrimaryMainLogin(MainAccount $oAccount, string $sCode, bool $bPublicLogin): void
	{
		$oTwoFactor = $this->twoFactorService($oAccount);
		$aState = $oTwoFactor->LoadState();
		if (\SnappyMail\TwoFactor::STATE_INVALID === $aState['Status']) {
			throw new ClientException(Notifications::AuthError);
		}

		if (\SnappyMail\TwoFactor::STATE_ENABLED === $aState['Status']) {
			$sAssurance = null;
			try {
				$sAssurance = $bPublicLogin
					? $this->useBoundChallengeForPublicLoginFactor($oAccount, $sCode)
					: null;
			} catch (\Throwable $oException) {
				if ($bPublicLogin) {
					$this->rejectCurrentTwoFactorLogin($oAccount);
				}
				throw $oException;
			}

			if (!\is_string($sAssurance)) {
				if ($bPublicLogin) {
					$this->rejectCurrentTwoFactorLogin($oAccount);
				}
				throw new ClientException(Notifications::AuthError);
			}
			$this->finalizeMainAuthSession($oAccount, $sAssurance);
			return;
		}

		$this->finalizeMainAuthSession(
			$oAccount,
			$this->twoFactorIsRequired() ? 'pending' : 'primary'
		);
	}

	/**
	 * Factor verification uses the same account lock as Remember-Me mutations.
	 * Recovery-code persistence remains authoritative and fail-closed.
	 */
	protected function verifyMainLoginFactorWhileLocked(
		MainAccount $oAccount,
		string $sCode,
		array $aFactorState,
		array $aProof
	): ?string
	{
		$oTwoFactor = $this->twoFactorService($oAccount);
		if ('recovery' === ($aProof['Type'] ?? null) && $oTwoFactor->ConsumeRecoveryCode($sCode)) {
			return $oTwoFactor->EnsureFactorGenerationAfterRecovery()
				? $this->verifiedSessionAssurance($oAccount)
				: null;
		}

		return 'totp' === ($aProof['Type'] ?? null)
			&& \is_int($aProof['Counter'] ?? null)
			&& $oTwoFactor->ConsumeClassifiedTotpCounter($aFactorState, $aProof['Counter'])
			? $this->verifiedSessionAssurance($oAccount)
			: null;
	}

	/**
	 * Final session issuance binds the account cookie to a new SESSION record.
	 */
	protected function finalizeMainAuthSession(MainAccount $oAccount, string $sAssurance): void
	{
		$this->assertLoginAssuranceAllowed($oAccount, $sAssurance);
		$oStorage = $this->StorageProvider();
		$mPendingAdmission = $this->reservePendingTwoFactorAuthority($oAccount, $sAssurance);
		if (false === $mPendingAdmission) {
			throw new ClientException(Notifications::AuthError);
		}

		$sSessionToken = null;
		try {
			$sSessionToken = Utils::RegenerateSessionToken();
			if (!$oStorage->Put($oAccount, StorageType::SESSION, $sSessionToken, $sAssurance)
				|| $oStorage->Get($oAccount, StorageType::SESSION, $sSessionToken) !== $sAssurance) {
				throw new \RuntimeException('Unable to persist authenticated session state');
			}

			// Must be here due to bug #1241.
			$this->SetMainAuthAccount($oAccount);
			$this->SetAuthToken($oAccount);
			$this->SetAdditionalAuthToken(null);
			if (\is_array($mPendingAdmission) && !$this->releasePendingTwoFactorAuthority($mPendingAdmission)) {
				throw new \RuntimeException('Unable to release pending two-factor admission');
			}
			$mPendingAdmission = null;
		} catch (\Throwable $oException) {
			if (\is_array($mPendingAdmission)) {
				$this->releasePendingTwoFactorAuthority($mPendingAdmission);
			}
			if ($sSessionToken) {
				$oStorage->Clear($oAccount, StorageType::SESSION, $sSessionToken);
				$oStorage->Clear($oAccount, StorageType::SESSION, $this->sessionAuthStorageKey($sSessionToken));
			}
			$this->oMainAuthAccount = false;
			$this->oAdditionalAuthAccount = false;
			Cookies::clear(self::AUTH_SPEC_TOKEN_KEY);
			Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
			Cookies::clear(Utils::SESSION_TOKEN);
			throw $oException;
		}
	}

	private function assertLoginAssuranceAllowed(MainAccount $oAccount, string $sAssurance): void
	{
		$aAssurance = $this->parseSessionAssurance($sAssurance);
		if (!$aAssurance) {
			throw new ClientException(Notifications::AuthError);
		}

		$aState = $this->twoFactorService($oAccount)->LoadState();
		if (\SnappyMail\TwoFactor::STATE_INVALID === $aState['Status']) {
			throw new ClientException(Notifications::AuthError);
		}

		if (\SnappyMail\TwoFactor::STATE_ENABLED === $aState['Status']) {
			if ('verified' !== $aAssurance['State']
				|| !\SnappyMail\TwoFactor::IsValidGeneration($aState['FactorGeneration'])
				|| !\hash_equals($aState['FactorGeneration'], $aAssurance['Generation'])) {
				throw new ClientException(Notifications::AuthError);
			}
		} else if ($this->twoFactorIsRequired()) {
			if ('pending' !== $aAssurance['State']) {
				throw new ClientException(Notifications::AuthError);
			}
		}
	}

	private function sessionAssuranceAllowed(MainAccount $oAccount, string $sAssurance): bool
	{
		$aState = $this->twoFactorService($oAccount)->LoadState();
		if (\SnappyMail\TwoFactor::STATE_INVALID === $aState['Status']) {
			return false;
		}
		$aAssurance = $this->parseSessionAssurance($sAssurance);
		if (!$aAssurance) {
			return false;
		}

		if (\SnappyMail\TwoFactor::STATE_ENABLED === $aState['Status']) {
			return 'verified' === $aAssurance['State']
				&& \SnappyMail\TwoFactor::IsValidGeneration($aState['FactorGeneration'])
				&& \hash_equals($aState['FactorGeneration'], $aAssurance['Generation']);
		}

		// Existing no-factor sessions can remain pending when policy is enabled;
		// the native SEC-02 gates limit their service and JSON authority.
		return true;
	}

	public function IsMainSessionVerified(MainAccount $oAccount) : bool
	{
		$sSessionToken = Utils::GetSessionToken(false);
		if (!$sSessionToken) {
			return false;
		}

		$aState = $this->twoFactorService($oAccount)->LoadState();
		if (\SnappyMail\TwoFactor::STATE_ENABLED !== $aState['Status']) {
			return false;
		}
		$sAssurance = $this->StorageProvider()->Get($oAccount, StorageType::SESSION, $sSessionToken, '');
		return \is_string($sAssurance)
			&& $this->sessionAssuranceAllowed($oAccount, $sAssurance)
			&& 'verified' === ($this->parseSessionAssurance($sAssurance)['State'] ?? null);
	}

	private function rejectCurrentTwoFactorLogin(MainAccount $oAccount): void
	{
		$sSessionToken = Utils::GetSessionToken(false);
		if ($sSessionToken) {
			$oStorage = $this->StorageProvider();
			$oStorage->Clear($oAccount, StorageType::SESSION, $sSessionToken);
			$oStorage->Clear($oAccount, StorageType::SESSION, $this->sessionAuthStorageKey($sSessionToken));
		}

		// Keep the guest identifier so inline-login retries retain their bounded
		// pre-auth attempt state; account authority cookies are cleared below.
		$this->oMainAuthAccount = false;
		$this->oAdditionalAuthAccount = false;
		Cookies::clear(self::AUTH_SPEC_TOKEN_KEY);
		Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
	}

	public function switchAccount(string $sEmail) : bool
	{
		$this->Http()->ServerNoCache();
		$oMainAccount = $this->getMainAccountFromToken(false);
		if ($sEmail && $oMainAccount && $this->GetCapa(Capa::ADDITIONAL_ACCOUNTS)) {
			$oAccount = null;
			if ($oMainAccount->Email() !== $sEmail) {
				$sEmail = \SnappyMail\IDN::emailToAscii($sEmail);
				$aAccounts = $this->GetAccounts($oMainAccount);
				if (!isset($aAccounts[$sEmail])) {
					throw new ClientException(Notifications::AccountDoesNotExist);
				}
				try {
					$oAccount = AdditionalAccount::NewInstanceFromTokenArray(
						$this, $aAccounts[$sEmail], true
					);
				} catch (\Throwable $e) {
					throw new ClientException(Notifications::AccountSwitchFailed, $e);
				}
				if (!$oAccount) {
					throw new ClientException(Notifications::AccountSwitchFailed);
				}
				// Test the login
				$oImapClient = new \MailSo\Imap\ImapClient;
				$oImapClient->SetLogger($this->Logger());
				$this->imapConnect($oAccount, false, $oImapClient);
			}
			$this->SetAdditionalAuthToken($oAccount);
			return true;
		}
		return false;
	}

	/**
	 * Returns RainLoop\Model\AdditionalAccount when it exists,
	 * else returns RainLoop\Model\MainAccount when it exists,
	 * else null
	 *
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	public function getAccountFromToken(bool $bThrowExceptionOnFalse = true): ?Account
	{
		$this->getMainAccountFromToken($bThrowExceptionOnFalse);

		if (false === $this->oAdditionalAuthAccount && isset($_COOKIE[self::AUTH_ADDITIONAL_TOKEN_KEY])) {
			$aData = Cookies::getSecure(self::AUTH_ADDITIONAL_TOKEN_KEY);
			if ($aData) {
				$this->oAdditionalAuthAccount = AdditionalAccount::NewInstanceFromTokenArray(
					$this,
					$aData,
					$bThrowExceptionOnFalse
				);
			}
			if (!$this->oAdditionalAuthAccount) {
				$this->oAdditionalAuthAccount = null;
				Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
			}
		}

		return $this->oAdditionalAuthAccount ?: $this->oMainAuthAccount;
	}

	/**
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	public function getMainAccountFromToken(bool $bThrowExceptionOnFalse = true): ?MainAccount
	{
		if (false === $this->oMainAuthAccount) try {
			$this->oMainAuthAccount = null;

			$aData = Cookies::getSecure(self::AUTH_SPEC_TOKEN_KEY);
			if ($aData) {
				/**
				 * Server side control/kickout of logged in sessions
				 * https://github.com/the-djmaze/snappymail/issues/151
				 */
				$sToken = Utils::GetSessionToken(false);
				if (!$sToken) {
//					\MailSo\Base\Http::StatusHeader(401);
					if (isset($_COOKIE[Utils::SESSION_TOKEN])) {
						\SnappyMail\Log::notice('TOKENS', 'SESSION_TOKEN invalid');
					} else {
						\SnappyMail\Log::notice('TOKENS', 'SESSION_TOKEN not set');
					}
				} else {
					$oMainAuthAccount = MainAccount::NewInstanceFromTokenArray(
						$this,
						$aData,
						$bThrowExceptionOnFalse
					);
					if ($oMainAuthAccount) {
						$oStorage = $this->StorageProvider();
						$sAuthKey = $this->sessionAuthStorageKey($sToken);
						$sBoundAuthToken = $oStorage->Get($oMainAuthAccount, StorageType::SESSION, $sAuthKey);
						$sAuthToken = Cookies::get(self::AUTH_SPEC_TOKEN_KEY);
						$sAuthHash = $sAuthToken ?: '';
						if (false === $sBoundAuthToken
							|| !$this->sessionAuthBindingMatches($sBoundAuthToken, $sAuthHash)) {
							$this->oAdditionalAuthAccount = false;
							Cookies::clear(self::AUTH_SPEC_TOKEN_KEY);
							Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
							throw new ClientException(Notifications::InvalidToken, null, 'Session account token binding missing or mismatched');
						}
						$sTokenValue = $oStorage->Get($oMainAuthAccount, StorageType::SESSION, $sToken);
						if (\is_string($sTokenValue)
							&& $this->sessionAssuranceAllowed($oMainAuthAccount, $sTokenValue)
							&& $this->sessionSignMeIsActive($oMainAuthAccount, $aData, $oStorage)) {
							$this->oMainAuthAccount = $oMainAuthAccount;
						} else {
							$oStorage->Clear($oMainAuthAccount, StorageType::SESSION, $sToken);
							$oStorage->Clear($oMainAuthAccount, StorageType::SESSION, $sAuthKey);
							\SnappyMail\Log::notice('TOKENS', 'SESSION_TOKEN value invalid: ' . \get_debug_type($sTokenValue));
						}
					} else {
						\SnappyMail\Log::notice('TOKENS', 'AUTH_SPEC_TOKEN_KEY invalid');
					}
				}
				if (!$this->oMainAuthAccount) {
//					\MailSo\Base\Http::StatusHeader(401);
					$this->Logout(true);
//					$sAdditionalMessage = $this->StaticI18N('SESSION_GONE');
					throw new ClientException(Notifications::InvalidToken, null, 'Session gone');
				}
			} else {
				$oAccount = $this->GetAccountFromSignMeToken();
				if ($oAccount) {
					$this->sSignMeTwoFactorState = '';
				}
			}

			if (!$this->oMainAuthAccount) {
				throw new ClientException(Notifications::InvalidToken, null, 'Account undefined');
			}
		} catch (\Throwable $e) {
			if ($bThrowExceptionOnFalse) {
				throw $e;
			}
		}

		return $this->oMainAuthAccount;
	}

	public function SetMainAuthAccount(MainAccount $oAccount): void
	{
		$sSessionToken = Utils::GetSessionToken(false);
		$sAssurance = $sSessionToken
			? $this->StorageProvider()->Get($oAccount, StorageType::SESSION, $sSessionToken, '')
			: '';
		if (!\is_string($sAssurance)) {
			throw new ClientException(Notifications::AuthError);
		}
		$this->assertLoginAssuranceAllowed($oAccount, $sAssurance);

		$this->oAdditionalAuthAccount = false;
		$this->oMainAuthAccount = $oAccount;
	}

	public function SetAuthToken(MainAccount $oAccount, ?string $sSignMeLineage = null): void
	{
		$this->SetMainAuthAccount($oAccount);
		$aTokenData = $oAccount->jsonSerialize();
		if (null !== $sSignMeLineage) {
			$aTokenData['_signMeLineage'] = $sSignMeLineage;
		}
		Cookies::setSecure(self::AUTH_SPEC_TOKEN_KEY, $aTokenData);
		$this->storeSessionAuthBinding($oAccount);
	}

	public function SetAdditionalAuthToken(?AdditionalAccount $oAccount): void
	{
		if ($oAccount && !$this->AdditionalAccountFactorAllowed($oAccount->Email())) {
			throw new ClientException(Notifications::AuthError);
		}
		$this->oAdditionalAuthAccount = $oAccount ?: false;
		Cookies::setSecure(self::AUTH_ADDITIONAL_TOKEN_KEY, $oAccount);
	}

	/**
	 * SignMe methods used for the "remember me" cookie
	 */

	private static function GetSignMeToken(): ?array
	{
		$sSignMeToken = Cookies::get(self::AUTH_SIGN_ME_TOKEN_KEY);
		if ($sSignMeToken) {
			\SnappyMail\Log::notice(self::AUTH_SIGN_ME_TOKEN_KEY, 'decrypt');
			$aResult = \SnappyMail\Crypt::DecryptUrlSafe($sSignMeToken, 'signme');
			if (isset($aResult['e'], $aResult['u']) && \SnappyMail\UUID::isValid($aResult['u'])) {
				if (!isset($aResult['c'])) {
					$aResult['c'] = \array_key_last($aResult);
					$aResult['d'] = \end($aResult);
				}
				return $aResult;
			}
			\SnappyMail\Log::notice(self::AUTH_SIGN_ME_TOKEN_KEY, 'invalid');
			Cookies::clear(self::AUTH_SIGN_ME_TOKEN_KEY);
		}
		return null;
	}

	public function SetSignMeToken(MainAccount $oAccount, ?string $sTwoFactorState = null): void
	{
		$sSessionToken = Utils::GetSessionToken(false);
		$sStoredAssurance = $sSessionToken
			? $this->StorageProvider()->Get($oAccount, StorageType::SESSION, $sSessionToken, '')
			: '';
		if (!\is_string($sStoredAssurance)
			|| (null !== $sTwoFactorState && !\hash_equals($sStoredAssurance, $sTwoFactorState))) {
			throw new ClientException(Notifications::AuthError);
		}
		$sTwoFactorState = $sStoredAssurance;
		$this->assertLoginAssuranceAllowed($oAccount, $sTwoFactorState);
		$mPendingAdmission = $this->reservePendingTwoFactorAuthority($oAccount, $sTwoFactorState);
		if (false === $mPendingAdmission) {
			\SnappyMail\Log::warning(self::AUTH_SIGN_ME_TOKEN_KEY, 'Pending two-factor Remember-Me admission denied');
			return;
		}
		$bPendingAdmissionReleaseFailed = false;

		try {
			$this->ClearSignMeData();
			$oStorage = $this->StorageProvider();
			$mLock = $this->acquireSignMeLock($oAccount);
			if (!$mLock) {
				throw new \RuntimeException('SignMe storage locking unavailable');
			}

			$sUuid = \SnappyMail\UUID::generate();
			try {
				if ($oStorage->Get($oAccount, StorageType::SESSION, $sSessionToken, '') !== $sTwoFactorState) {
					throw new \RuntimeException('Session assurance changed before Remember-Me issuance');
				}
				$this->assertLoginAssuranceAllowed($oAccount, $sTwoFactorState);
				$sCookie = $this->signMeCookieValue($oAccount, $sUuid, $sTwoFactorState);
				// Bind the Remember-Me lineage to the password SESSION before the
				// login response can race with an explicit logout.
				$this->SetAuthToken($oAccount, $sUuid);
				Cookies::set(self::AUTH_SIGN_ME_TOKEN_KEY, $sCookie, \time() + 3600 * 24 * 30);
				if (\is_array($mPendingAdmission) && !$this->releasePendingTwoFactorAuthority($mPendingAdmission)) {
					$bPendingAdmissionReleaseFailed = true;
					throw new \RuntimeException('Unable to release pending two-factor Remember-Me admission');
				}
				$mPendingAdmission = null;
			} catch (\Throwable $e) {
				if (\is_array($mPendingAdmission)) {
					$this->releasePendingTwoFactorAuthority($mPendingAdmission);
					$mPendingAdmission = null;
				}
				$oStorage->Clear($oAccount, StorageType::SIGN_ME, $sUuid);
				if ($bPendingAdmissionReleaseFailed) {
					$oStorage->Clear($oAccount, StorageType::SESSION, $sSessionToken);
					$oStorage->Clear($oAccount, StorageType::SESSION, $this->sessionAuthStorageKey($sSessionToken));
					$this->oMainAuthAccount = false;
					$this->oAdditionalAuthAccount = false;
					Cookies::clear(self::AUTH_SPEC_TOKEN_KEY);
					Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
					Cookies::clear(Utils::SESSION_TOKEN);
				}
				throw $e;
			} finally {
				$oStorage->ReleaseLock($mLock);
			}
		} catch (\Throwable $e) {
			// Remember-Me is optional to a successful password login. An
			// unsupported or unavailable storage lock must not issue a cookie.
			Cookies::clear(self::AUTH_SIGN_ME_TOKEN_KEY);
			\SnappyMail\Log::warning(self::AUTH_SIGN_ME_TOKEN_KEY, $e->getMessage());
			if (\is_array($mPendingAdmission)) {
				$this->releasePendingTwoFactorAuthority($mPendingAdmission);
			}
			if ($bPendingAdmissionReleaseFailed) {
				throw new ClientException(Notifications::AuthError);
			}
		}
	}

	public function GetAccountFromSignMeToken(): ?MainAccount
	{
		$this->sSignMeTwoFactorState = '';
		$aTokenData = static::GetSignMeToken();
		if ($aTokenData) {
			$sCleanupToken = null;
			$mPendingAdmission = null;
			$bPendingAdmissionDenied = false;
			try
			{
				$iCookieVersion = $aTokenData['v'] ?? null;
				if (!\in_array($iCookieVersion, [2, 3], true)
					|| !\is_string($aTokenData['e'] ?? null)
					|| '' === $aTokenData['e']
					|| !\is_string($aTokenData['c'] ?? null)
					|| !\is_string($aTokenData['d'] ?? null)) {
					throw new \RuntimeException('unsupported Remember-Me cookie version');
				}
				$oStorage = $this->StorageProvider();
				$sStoredRecord = $oStorage->Get(
					$aTokenData['e'],
					StorageType::SIGN_ME,
					$aTokenData['u']
				);
				$aStoredRecord = $this->decodeSignMeStorageRecord($sStoredRecord);
				if (!$aStoredRecord) {
					throw new \RuntimeException('Remember-Me server record not found');
				}

				if (3 === $iCookieVersion) {
					if (3 !== $aStoredRecord['Version']
						|| !\array_key_exists('m', $aTokenData)
						|| !\array_key_exists('g', $aTokenData)
						|| $aTokenData['m'] !== $aStoredRecord['Assurance']
						|| $aTokenData['g'] !== $aStoredRecord['Generation']) {
						throw new \RuntimeException('Remember-Me assurance metadata mismatch');
					}
					$sCookieAssurance = 'verified' === $aStoredRecord['Assurance']
						? 'verified:'.$aStoredRecord['Generation']
						: $aStoredRecord['Assurance'];
				} else {
					if (2 !== $aStoredRecord['Version']) {
						throw new \RuntimeException('Remember-Me storage version mismatch');
					}
					$sLegacyState = $aTokenData['m'] ?? null;
					// Old verified cookies did not bind proof to a factor generation.
					$sCookieAssurance = \in_array($sLegacyState, ['primary', 'pending', 'legacy'], true)
						? $sLegacyState
						: 'legacy';
				}

				$mIv = \base64_decode($aTokenData['d'], true);
				if (!\is_string($mIv)) {
					throw new \RuntimeException('invalid Remember-Me encryption data');
				}
				$aAccountHash = \SnappyMail\Crypt::Decrypt([
					$aTokenData['c'],
					$mIv,
					$aStoredRecord['Token']
				], 'signme');
				if (!\is_array($aAccountHash)) {
					throw new \RuntimeException('token decrypt failed');
				}
				$sCleanupToken = $aStoredRecord['StoredValue'];
				$oAccount = MainAccount::NewInstanceFromTokenArray($this, $aAccountHash);
				if (!$oAccount) {
					throw new \RuntimeException('token has no account');
				}
				$this->sSignMeTwoFactorState = $sCookieAssurance;
				$this->imapConnect($oAccount);
				$sCurrentRecord = $oStorage->Get(
					$aTokenData['e'],
					StorageType::SIGN_ME,
					$aTokenData['u']
				);
				if (!\is_string($sCurrentRecord) || !\hash_equals($sCleanupToken, $sCurrentRecord)) {
					throw new \RuntimeException('SignMe token was revoked during authentication');
				}

				$mLock = $this->acquireSignMeLock($oAccount);
				if (!$mLock) {
					throw new \RuntimeException('SignMe storage locking unavailable');
				}

				$sSessionToken = null;
				try {
					$aFactorState = $this->twoFactorService($oAccount)->LoadState();
					if (\SnappyMail\TwoFactor::STATE_INVALID === $aFactorState['Status']) {
						throw new \RuntimeException('Invalid two-factor state');
					}
					if (\SnappyMail\TwoFactor::STATE_ENABLED === $aFactorState['Status']) {
						$aAssurance = $this->parseSessionAssurance($this->sSignMeTwoFactorState);
						if (3 !== $iCookieVersion
							|| !$aAssurance
							|| 'verified' !== $aAssurance['State']
							|| !\SnappyMail\TwoFactor::IsValidGeneration($aFactorState['FactorGeneration'])
							|| !\hash_equals($aFactorState['FactorGeneration'], $aAssurance['Generation'])) {
							throw new \RuntimeException('Remember-Me lacks second-factor assurance');
						}
					} else if ($this->twoFactorIsRequired()) {
						// Legacy sessions restored under a newly enabled enrollment policy
						// enter only the established restricted pending-enrollment state.
						$this->sSignMeTwoFactorState = 'pending';
					}
					$this->assertLoginAssuranceAllowed($oAccount, $this->sSignMeTwoFactorState);
					$mPendingAdmission = $this->reservePendingTwoFactorAuthority($oAccount, $this->sSignMeTwoFactorState);
					if (false === $mPendingAdmission) {
						$bPendingAdmissionDenied = true;
						throw new ClientException(Notifications::AuthError);
					}

					// This locked read is the redemption/logout linearization point.
					// The post-IMAP read above is only an early rejection check.
					$sLockedAuthToken = $oStorage->Get($oAccount, StorageType::SIGN_ME, $aTokenData['u']);
					if (!\is_string($sLockedAuthToken) || !\hash_equals($sCleanupToken, $sLockedAuthToken)) {
						throw new \RuntimeException('SignMe token was revoked during authentication');
					}

					// Rotate the encrypted token material in the same server-side
					// lineage, then bind the new SESSION to that lineage.
					$sSignMeCookie = $this->signMeCookieValue(
						$oAccount,
						$aTokenData['u'],
						$this->sSignMeTwoFactorState,
						$sCleanupToken
					);
					$sSessionToken = Utils::RegenerateSessionToken();
					if (!$oStorage->Put($oAccount, StorageType::SESSION, $sSessionToken, $this->sSignMeTwoFactorState)
						|| $oStorage->Get($oAccount, StorageType::SESSION, $sSessionToken) !== $this->sSignMeTwoFactorState) {
						throw new \RuntimeException('Unable to persist session state');
					}

					$this->SetAuthToken($oAccount, $aTokenData['u']);
					Cookies::set(self::AUTH_SIGN_ME_TOKEN_KEY, $sSignMeCookie, \time() + 3600 * 24 * 30);
					if (\is_array($mPendingAdmission) && !$this->releasePendingTwoFactorAuthority($mPendingAdmission)) {
						$this->clearSignMeRecord($oStorage, $oAccount->Email(), $aTokenData['u']);
						throw new \RuntimeException('Unable to release pending two-factor Remember-Me redemption');
					}
					$mPendingAdmission = null;
				} catch (\Throwable $e) {
					if (\is_array($mPendingAdmission)) {
						$this->releasePendingTwoFactorAuthority($mPendingAdmission);
						$mPendingAdmission = null;
					}
					if ($sSessionToken) {
						$oStorage->Clear($oAccount, StorageType::SESSION, $sSessionToken);
						$oStorage->Clear($oAccount, StorageType::SESSION, $this->sessionAuthStorageKey($sSessionToken));
						Cookies::clear(self::AUTH_SPEC_TOKEN_KEY);
						Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
						Cookies::clear(Utils::SESSION_TOKEN);
					}
					throw $e;
				} finally {
					$oStorage->ReleaseLock($mLock);
				}

				return $oAccount;
			}
			catch (\Throwable $oException)
			{
				\SnappyMail\Log::warning(self::AUTH_SIGN_ME_TOKEN_KEY, $oException->getMessage());
				$this->oMainAuthAccount = null;
				$this->oAdditionalAuthAccount = false;
				$this->sSignMeTwoFactorState = '';
				if (!$bPendingAdmissionDenied) {
					$this->clearSignMeRecordIfCurrent($aTokenData['e'], $aTokenData['u'], $sCleanupToken);
					Cookies::clear(self::AUTH_SIGN_ME_TOKEN_KEY);
				}
			}
		}
		return null;
	}

	protected function ClearSignMeData() : void
	{
		$aTokenData = static::GetSignMeToken();
		try {
			if ($aTokenData && $aTokenData['u'] !== $this->sLogoutRevokedSignMeLineage) {
				$oStorage = $this->StorageProvider();
				$this->clearSignMeLineage($oStorage, $aTokenData['e'], $aTokenData['u']);
			}
		} finally {
			Cookies::clear(self::AUTH_SIGN_ME_TOKEN_KEY);
		}
	}

	private function clearSignMeRecord($oStorage, string $sEmail, string $sUuid): void
	{
		if (null === $oStorage->Revoke($sEmail, StorageType::SIGN_ME, $sUuid)) {
			throw new \RuntimeException('Unable to revoke SignMe token');
		}
	}

	private function revokeSessionRecord($oStorage, $mAccount, string $sKey, string $sDescription): void
	{
		if (null === $oStorage->Revoke($mAccount, StorageType::SESSION, $sKey)) {
			throw new \RuntimeException('Unable to revoke '.$sDescription);
		}
	}

	private function clearSignMeLineage($oStorage, $mAccount, string $sUuid): void
	{
		if (!$oStorage->SupportsLocking()) {
			// Such a driver cannot redeem Remember-Me tokens, so there is no
			// concurrent lineage mutation to serialize during explicit cleanup.
			$sEmail = $mAccount instanceof MainAccount ? $mAccount->Email() : (string) $mAccount;
			$this->clearSignMeRecord($oStorage, $sEmail, $sUuid);
			return;
		}

		$mLock = $this->acquireSignMeLock($mAccount);
		if (!$mLock) {
			throw new \RuntimeException('SignMe storage locking unavailable');
		}
		try {
			$sEmail = $mAccount instanceof MainAccount ? $mAccount->Email() : (string) $mAccount;
			$this->clearSignMeRecord($oStorage, $sEmail, $sUuid);
		} finally {
			$oStorage->ReleaseLock($mLock);
		}
	}

	/**
	 * Logout methods
	 */

	public function Logout(bool $bMain, bool $bRevokeSignMeLineage = false) : void
	{
		if ($bMain) {
			$sSessionToken = Utils::GetSessionToken(false);
			$mSessionAccount = $this->oMainAuthAccount instanceof MainAccount ? $this->oMainAuthAccount : null;
			$aAccountData = null;
			try {
				$aAccountData = Cookies::getSecure(self::AUTH_SPEC_TOKEN_KEY);
				if (!$mSessionAccount && \is_array($aAccountData)) {
					$aAccountData = MainAccount::convertArray($aAccountData);
					$sEmail = $aAccountData['email'] ?? '';
					if (\is_string($sEmail) && '' !== \trim($sEmail)) {
						$mSessionAccount = \SnappyMail\IDN::emailToAscii(\trim($sEmail));
					}
				}
			} catch (\Throwable $oException) {
				\SnappyMail\Log::debug('TOKENS', 'Unable to reconstruct logout account');
			}
			if ($mSessionAccount && $sSessionToken) {
				$oStorage = $this->StorageProvider();
				$sAuthKey = $this->sessionAuthStorageKey($sSessionToken);
				$sBoundAuthToken = false;
				$mBindingState = $oStorage->Inspect(
					$mSessionAccount,
					StorageType::SESSION,
					$sAuthKey,
					$sBoundAuthToken
				);
				if (null === $mBindingState) {
					throw new \RuntimeException('Unable to verify current session binding');
				}
				$sAuthToken = Cookies::get(self::AUTH_SPEC_TOKEN_KEY);
				$sAuthHash = $sAuthToken ?: '';
				$bMatchingBinding = $mBindingState && $this->sessionAuthBindingMatches($sBoundAuthToken, $sAuthHash, true);
				$bBindingMismatch = $mBindingState && !$bMatchingBinding;
				$sLineage = \is_array($aAccountData) ? ($aAccountData['_signMeLineage'] ?? null) : null;
				$bHasLineage = \is_string($sLineage) && \SnappyMail\UUID::isValid($sLineage);
				if ($bBindingMismatch) {
					\SnappyMail\Log::notice('TOKENS', 'Logout session binding mismatch');
					if ($bRevokeSignMeLineage && $bHasLineage) {
						throw new \RuntimeException('Unable to verify current session lineage');
					}
				} else if ($bRevokeSignMeLineage && $bHasLineage) {
					$mLock = $this->acquireSignMeLock($mSessionAccount);
					if ($oStorage->SupportsLocking() && !$mLock) {
						throw new \RuntimeException('SignMe storage locking unavailable');
					}
					try {
						$sCurrentBinding = false;
						$mCurrentBindingState = $oStorage->Inspect(
							$mSessionAccount,
							StorageType::SESSION,
							$sAuthKey,
							$sCurrentBinding
						);
						if (null === $mCurrentBindingState) {
							throw new \RuntimeException('Unable to verify current session binding');
						}
						$bCurrentBindingMatches = $mCurrentBindingState
							&& $this->sessionAuthBindingMatches($sCurrentBinding, $sAuthHash, true);
						if ($bCurrentBindingMatches) {
							$sEmail = $mSessionAccount instanceof MainAccount
								? $mSessionAccount->Email()
								: (string) $mSessionAccount;
							$this->clearSignMeRecord($oStorage, $sEmail, $sLineage);
							$this->sLogoutRevokedSignMeLineage = $sLineage;
							$this->revokeSessionRecord($oStorage, $mSessionAccount, $sSessionToken, 'current session');
							$this->revokeSessionRecord($oStorage, $mSessionAccount, $sAuthKey, 'current session binding');
						} else if (!$mCurrentBindingState) {
							// The encrypted account cookie can carry a valid lineage
							// claim while being paired with an unrelated, unbound
							// SESSION cookie. Without a matching server-side binding,
							// this request cannot prove which lineage owns that session.
							throw new \RuntimeException('Unable to verify current session lineage');
						} else {
							\SnappyMail\Log::notice('TOKENS', 'Logout session binding mismatch');
							throw new \RuntimeException('Unable to verify current session lineage');
						}
					} finally {
						if ($mLock) {
							$oStorage->ReleaseLock($mLock);
						}
					}
				} else if ($bMatchingBinding) {
					$this->revokeSessionRecord($oStorage, $mSessionAccount, $sSessionToken, 'current session');
					$this->revokeSessionRecord($oStorage, $mSessionAccount, $sAuthKey, 'current session binding');
				}
			} else if ($mSessionAccount && $bRevokeSignMeLineage) {
				$sLineage = \is_array($aAccountData) ? ($aAccountData['_signMeLineage'] ?? null) : null;
				if (\is_string($sLineage) && \SnappyMail\UUID::isValid($sLineage)) {
					// With no SESSION cookie, the signed account cookie can still
					// identify exactly one Remember-Me lineage. Revoke that lineage
					// under the redemption lock, but do not guess a SESSION key.
					$oStorage = $this->StorageProvider();
					$this->clearSignMeLineage($oStorage, $mSessionAccount, $sLineage);
					$this->sLogoutRevokedSignMeLineage = $sLineage;
				}
			}
			$this->oMainAuthAccount = null;
			$this->oAdditionalAuthAccount = null;
			Cookies::clear(Utils::SESSION_TOKEN);
			Cookies::clear(self::AUTH_SPEC_TOKEN_KEY);
		}
		Cookies::clear(self::AUTH_ADDITIONAL_TOKEN_KEY);
		// Explicit main logout clears SignMe data in DoLogout().
	}

	/**
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	protected function imapConnect(Account $oAccount, bool $bAuthLog = false, ?\MailSo\Imap\ImapClient $oImapClient = null): void
	{
		try {
			if (!$oImapClient) {
				$oImapClient = $this->ImapClient();
			}
			$oAccount->ImapConnectAndLogin($oImapClient, $this->Config());
		} catch (ClientException $oException) {
			throw $oException;
		} catch (\MailSo\Net\Exceptions\ConnectionException $oException) {
			throw new ClientException(Notifications::ConnectionError, $oException);
		} catch (\MailSo\Imap\Exceptions\LoginBadCredentialsException $oException) {
			if ($bAuthLog) {
				$this->LoggerAuthHelper($oAccount);
			}

			if ($this->Config()->Get('imap', 'show_login_alert', true)) {
				throw new ClientException(Notifications::AuthError, $oException, $oException->getAlertFromStatus());
			} else {
				throw new ClientException(Notifications::AuthError, $oException);
			}
		} catch (\Throwable $oException) {
			throw new ClientException(Notifications::AuthError, $oException);
		}
	}

}
