<?php

namespace RainLoop\Actions;

use RainLoop\Exceptions\ClientException;
use RainLoop\Notifications;
use RainLoop\Providers\Storage\Enumerations\StorageType;
use RainLoop\Utils;
use SnappyMail\TwoFactor as TwoFactorService;

trait TwoFactor
{
	/**
	 * Apply the native two-factor bootstrap policy after application data is assembled.
	 */
	public function ApplyTwoFactorAppData(bool $bAdmin, array $aResult) : array
	{
		if ($bAdmin) {
			return $aResult;
		}

		$bRequired = $this->twoFactorIsRequired();
		$aResult['RequireTwoFactor'] = $bRequired;
		$aResult['SetupTwoFactor'] = false;

		$oAccount = $this->getMainAccountFromToken(false);
		$sState = $this->twoFactorRestrictionState($oAccount);
		if ('normal' === $sState || 'none' === $sState && empty($aResult['Auth']) || 'none' === $sState && !$bRequired) {
			return $aResult;
		}

		$bPending = 'pending' === $sState && $oAccount && !empty($aResult['Auth']);
		$aResult = $this->limitedTwoFactorAppData($aResult, (bool) $bPending, $oAccount, $bRequired);
		return $aResult;
	}

	public function isTwoFactorServiceAllowed(string $sMethodName, bool $bAdmin) : bool
	{
		// JSON actions perform their own gate after decoding the action. Avoid
		// restoring Remember-Me before Logout can revoke its stored lineage.
		if ('ServiceJson' === $sMethodName) {
			return true;
		}

		if (!$this->twoFactorAccountIsRestricted()) {
			return true;
		}

		if ('ServiceAdminAppData' === $sMethodName) {
			return $bAdmin && $this->IsAdminLoggined(false);
		}

		return \in_array($sMethodName, [
			'ServiceJson',
			'ServiceAppData',
			'ServiceLang'
		], true);
	}

	public function isTwoFactorJsonActionAllowed($sAction, bool $bAdmin) : bool
	{
		if (!\is_string($sAction)) {
			return false;
		}
		if ('Logout' === $sAction) {
			// Under forced policy, resolve explicit account cookies before the
			// ordinary logout handler so mismatched bindings cannot be mistaken
			// for a valid factor-assured session. With policy off, leave the
			// existing logout/legacy Remember-Me cleanup path unchanged.
			if ($this->twoFactorIsRequired() && isset($_COOKIE[self::AUTH_SPEC_TOKEN_KEY])) {
				$this->getMainAccountFromToken(false);
			}
			return true;
		}

		if ($bAdmin && ('AdminLogin' === $sAction || 'AdminLogout' === $sAction || 0 === \stripos($sAction, 'Admin'))) {
			return true;
		}
		if (!$this->twoFactorAccountIsRestricted()) {
			return true;
		}

		if (!\in_array($sAction, [
			'Login',
			'Logout',
			'TwoFactorState',
			'TwoFactorSetup',
			'TwoFactorCompleteEnrollment'
		], true)) {
			return false;
		}

		return !\in_array($sAction, ['TwoFactorSetup', 'TwoFactorCompleteEnrollment'], true)
			|| 'POST' === \strtoupper($_SERVER['REQUEST_METHOD'] ?? '');
	}

	private function twoFactorAccountIsRestricted() : bool
	{
		return \in_array($this->twoFactorRestrictionState(), ['pending', 'invalid', 'stale'], true);
	}

	private function twoFactorRestrictionState(?\RainLoop\Model\MainAccount $oAccount = null) : string
	{
		$oAccount = $oAccount ?: $this->getMainAccountFromToken(false);
		if (!$oAccount) {
			return 'none';
		}

		try {
			$aState = $this->twoFactorService($oAccount)->LoadState();
		} catch (\Throwable $oException) {
			return 'invalid';
		}

		if (TwoFactorService::STATE_INVALID === ($aState['Status'] ?? null)) {
			return 'invalid';
		}
		if (TwoFactorService::STATE_ENABLED === ($aState['Status'] ?? null)) {
			return $this->IsMainSessionVerified($oAccount) ? 'normal' : 'stale';
		}

		return $this->twoFactorIsRequired() ? 'pending' : 'normal';
	}

	private function limitedTwoFactorAppData(array $aResult, bool $bAuth, ?\RainLoop\Model\MainAccount $oAccount, bool $bRequireTwoFactor) : array
	{
		$aSystem = \array_intersect_key($aResult['System'] ?? [], \array_flip([
			'version',
			'token',
			'languages',
			'webPath',
			'webVersionPath',
			'petujaEmailVersion',
			'petujaEmailSnappyMailVersion',
			'customLogoutLink'
		]));

		$aLimited = [
			'Auth' => $bAuth,
			'title' => $aResult['title'] ?? '',
			'loadingDescription' => $aResult['loadingDescription'] ?? '',
			'System' => $aSystem,
			'allowLanguagesOnLogin' => $aResult['allowLanguagesOnLogin'] ?? false,
			'RequireTwoFactor' => $bRequireTwoFactor,
			'SetupTwoFactor' => $bAuth,
			'StaticLibsJs' => $aResult['StaticLibsJs'] ?? '',
			'language' => $aResult['language'] ?? '',
			'clientLanguage' => $aResult['clientLanguage'] ?? ''
		];

		if ($bAuth && $oAccount) {
			$aLimited['Email'] = $oAccount->Email();
			$aLimited['mainEmail'] = $oAccount->Email();
		}

		return $aLimited;
	}

	public function DoTwoFactorState() : array
	{
		$oAccount = $this->getMainAccountFromToken();
		$oTwoFactor = $this->twoFactorService($oAccount);
		$aState = $oTwoFactor->LoadState();
		$this->assertTwoFactorStateValid($aState);

		return $this->DefaultResponse([
			'Status' => $aState['Status'],
			'Enabled' => TwoFactorService::STATE_ENABLED === $aState['Status'],
			'Required' => $this->twoFactorIsRequired(),
			'CanDisable' => !$this->twoFactorIsRequired()
		]);
	}

	/**
	 * M1D backend entry point for native two-step public login.
	 */
	public function DoTwoFactorLoginBegin() : array
	{
		$this->requireTwoFactorPost();
		$sEmail = $this->loginActionString('Email');
		$sPassword = $this->loginActionRawString('Password');
		$oAccount = $this->AuthenticatePublicPasswordPrimary(
			\MailSo\Base\Utils::Trim($sEmail),
			new \SnappyMail\SensitiveString($sPassword)
		);
		if (!$oAccount instanceof \RainLoop\Model\MainAccount) {
			throw new ClientException(Notifications::AuthError);
		}

		try {
			$aState = $this->twoFactorService($oAccount)->LoadState();
			$this->assertTwoFactorStateValid($aState);
			if (TwoFactorService::STATE_ENABLED === $aState['Status']) {
				$aBinding = $this->twoFactorLoginBinding();
				$aChallenge = $this->beginTwoFactorLoginChallenge(
					$oAccount,
					$aBinding,
					$this->loginSignMeRequested()
				);

				return $this->DefaultResponse([
					'RequiresTwoFactor' => true,
					'Challenge' => $aChallenge['Challenge'],
					'ExpiresAt' => $aChallenge['ExpiresAt'],
					'Account' => $oAccount->Email()
				]);
			}

			$this->finalizeMainAuthSession(
				$oAccount,
				$this->twoFactorIsRequired() ? 'pending' : 'primary'
			);
			$this->loginSignMeRequested() && $this->SetSignMeToken($oAccount);
			$this->persistLoginLanguage($oAccount);
			return $this->DefaultResponse($this->AppData(false));
		} catch (\Throwable $oException) {
			$this->loginErrorDelay();
			throw $oException;
		}
	}

	/**
	 * Re-authenticate the primary credential, redeem one bound challenge, then
	 * issue normal session and optional Remember-Me authority.
	 */
	public function DoTwoFactorLoginVerify() : array
	{
		$this->requireTwoFactorPost();
		$sEmail = $this->loginActionString('Email');
		$sPassword = $this->loginActionRawString('Password');
		$oAccount = $this->AuthenticatePublicPasswordPrimary(
			\MailSo\Base\Utils::Trim($sEmail),
			new \SnappyMail\SensitiveString($sPassword)
		);
		if (!$oAccount instanceof \RainLoop\Model\MainAccount) {
			throw new ClientException(Notifications::AuthError);
		}

		try {
			$aBinding = $this->twoFactorLoginBinding();
			$sChallenge = $this->loginActionString('Challenge');
			$sCode = $this->loginActionString('Code');
			$aRedemption = $this->redeemTwoFactorLoginChallenge($oAccount, $sChallenge, $sCode, $aBinding);
			$this->finalizeMainAuthSession($oAccount, $aRedemption['Assurance']);
			$aRedemption['SignMe'] && $this->SetSignMeToken($oAccount);
			$this->persistLoginLanguage($oAccount);
			return $this->DefaultResponse($this->AppData(false));
		} catch (\Throwable $oException) {
			$this->loginErrorDelay();
			throw $oException;
		}
	}

	/**
	 * Abort is deliberately non-authenticating: it can only revoke this browser's
	 * own challenge and always has the same response shape.
	 */
	public function DoTwoFactorLoginAbort() : array
	{
		$this->requireTwoFactorPost();
		$sEmail = \SnappyMail\IDN::emailToAscii(\MailSo\Base\Utils::Trim($this->loginActionString('Account')));
		$sChallenge = $this->loginActionString('Challenge');
		try {
			$aBinding = $this->twoFactorLoginBinding();
			if ($this->validTwoFactorChallengeId($sChallenge) && '' !== $sEmail) {
				$oStorage = $this->StorageProvider();
				$mLock = $this->acquireSignMeLock($sEmail);
				if ($mLock) {
					try {
						$sChallengeKey = $this->twoFactorChallengeKey($sChallenge);
						$mValue = false;
						if (true === $oStorage->Inspect($sEmail, StorageType::SESSION, $sChallengeKey, $mValue)) {
							$aChallenge = $this->decodeTwoFactorChallenge($mValue);
							if ($aChallenge
								&& $this->twoFactorChallengeMatches($aChallenge, $sEmail, $aBinding)
								&& \hash_equals($aChallenge['ChallengeHash'], \hash('sha256', $sChallenge))) {
								// Never discard a live attempt ledger: doing so would let a
								// later Begin replace consumed factor attempts with a fresh budget.
								if ($aChallenge['ExpiresAt'] <= \time()
									|| ('active' === $aChallenge['Status'] && 0 === $aChallenge['Attempts'])) {
									$this->revokeTwoFactorChallenge($oStorage, $sEmail, $sChallenge, $aBinding);
								}
							}
						}
					} finally {
						$oStorage->ReleaseLock($mLock);
					}
				}
			}
		} catch (\Throwable $oException) {
			// Abort is best-effort cleanup; TTL and SESSION storage GC remain the
			// fallback, and the response never confirms challenge existence.
		}

		return $this->TrueResponse();
	}

	/**
	 * The shipped injected-code form remains synchronous, but uses the same
	 * session-bound challenge ledger and bounded redemption as the M1D API.
	 */
	protected function useBoundChallengeForPublicLoginFactor(
		\RainLoop\Model\MainAccount $oAccount,
		string $sCode
	) : ?string {
		$aBinding = $this->twoFactorLoginBinding();
		$aChallenge = $this->beginTwoFactorLoginChallenge($oAccount, $aBinding, false);
		$aRedemption = $this->redeemTwoFactorLoginChallenge($oAccount, $aChallenge['Challenge'], $sCode, $aBinding);
		return $aRedemption['Assurance'] ?? null;
	}

	/**
	 * Begin or resume enrollment. Existing incomplete setup is stable across
	 * refreshes; only an explicit Restart rotates its secret and recovery codes.
	 */
	public function DoTwoFactorSetup() : array
	{
		$this->requireTwoFactorPost();
		$oAccount = $this->getMainAccountFromToken();
		return $this->withTwoFactorAccountLock($oAccount, function ($oTwoFactor, $aState) use ($oAccount) : array {
			if (TwoFactorService::STATE_ENABLED === $aState['Status']) {
				throw new ClientException(Notifications::AuthError);
			}

			if ($this->twoFactorIsRequired() && 'pending' !== $this->twoFactorSessionState($oAccount)) {
				throw new ClientException(Notifications::AuthError);
			}

			$mRestart = $this->GetActionParam('Restart', false);
			$bRestart = true === $mRestart || 1 === $mRestart || '1' === $mRestart || 'true' === \strtolower((string) $mRestart);
			if (TwoFactorService::STATE_DISABLED === $aState['Status'] && !$bRestart) {
				return $this->DefaultResponse($this->twoFactorEnrollmentData($oAccount, $aState['Record']));
			}

			$mRecord = $aState['Record'] ?? [
				'User' => $oAccount->Email(),
				'Enable' => false
			];
			$mRecord['Enable'] = false;
			$mRecord['Secret'] = TwoFactorService::CreateSecret();
			$mRecord['QRCode'] = $this->twoFactorQRCode($oAccount, $mRecord['Secret']);
			$mRecord['BackupCodes'] = \implode(' ', TwoFactorService::GenerateRecoveryCodes());
			$mRecord['FactorGeneration'] = TwoFactorService::NewGeneration();
			$mRecord['TotpGeneration'] = TwoFactorService::NewGeneration();
			$mRecord['LastTotpCounter'] = null;

			if (!$oTwoFactor->Save($mRecord)) {
				throw new ClientException(Notifications::UnknownError);
			}

			return $this->DefaultResponse($this->twoFactorEnrollmentData($oAccount, $mRecord));
		});
	}

	public function DoTwoFactorEnable() : array
	{
		$this->requireTwoFactorPost();
		$oAccount = $this->getMainAccountFromToken();
		return $this->withTwoFactorAccountLock($oAccount, function ($oTwoFactor, $aState) use ($oAccount) : array {
			if ($this->twoFactorIsRequired() || TwoFactorService::STATE_DISABLED !== $aState['Status']) {
				throw new ClientException(Notifications::AuthError);
			}

			if (!$oTwoFactor->VerifyAndConsumeTotp($this->twoFactorCode(), TwoFactorService::STATE_DISABLED)) {
				throw new ClientException(Notifications::AuthError);
			}

			$aUpdated = $oTwoFactor->LoadState();
			$this->assertTwoFactorStateValid($aUpdated);
			$mRecord = $aUpdated['Record'];
			$mRecord['Enable'] = true;
			$mRecord['FactorGeneration'] = TwoFactorService::NewGeneration();
			if (!$oTwoFactor->Save($mRecord)) {
				throw new ClientException(Notifications::UnknownError);
			}
			if (!$this->setTwoFactorSessionAssurance($oAccount, 'verified:'.$mRecord['FactorGeneration'])) {
				throw new ClientException(Notifications::UnknownError);
			}

			return $this->DefaultResponse(true);
		});
	}

	public function DoTwoFactorDisable() : array
	{
		$this->requireTwoFactorPost();
		$oAccount = $this->getMainAccountFromToken();
		return $this->withTwoFactorAccountLock($oAccount, function ($oTwoFactor, $aState) : array {
			if ($this->twoFactorIsRequired()) {
				throw new ClientException(Notifications::AuthError);
			}

			if (TwoFactorService::STATE_ENABLED === $aState['Status']) {
				$mRecord = $aState['Record'];
				$mRecord['Enable'] = false;
				$mRecord['FactorGeneration'] = TwoFactorService::NewGeneration();
				if (!$oTwoFactor->Save($mRecord)) {
					throw new ClientException(Notifications::UnknownError);
				}
			}

			return $this->DefaultResponse(true);
		});
	}

	public function DoTwoFactorClear() : array
	{
		$this->requireTwoFactorPost();
		$oAccount = $this->getMainAccountFromToken();
		return $this->withTwoFactorAccountLock($oAccount, function ($oTwoFactor, $aState) : array {
			if ($this->twoFactorIsRequired()) {
				throw new ClientException(Notifications::AuthError);
			}
			if (TwoFactorService::STATE_MISSING !== $aState['Status'] && !$oTwoFactor->Clear()) {
				throw new ClientException(Notifications::UnknownError);
			}

			return $this->DefaultResponse(true);
		});
	}

	public function DoTwoFactorCompleteEnrollment() : array
	{
		$this->requireTwoFactorPost();
		$oAccount = $this->getMainAccountFromToken();
		$this->withTwoFactorAccountLock($oAccount, function ($oTwoFactor, $aState) use ($oAccount) : bool {
			if (!$this->twoFactorIsRequired()
				|| 'pending' !== $this->twoFactorSessionState($oAccount)
				|| TwoFactorService::STATE_DISABLED !== $aState['Status']) {
				throw new ClientException(Notifications::AuthError);
			}

			// Enrollment proof shares the account/source budget used by enabled
			// factor login. A failed proof remains charged; a verified proof is
			// refunded before the factor is enabled.
			$oFactorLimiter = new \SnappyMail\LoginAbuseLimiter(APP_PRIVATE_DATA . 'login-abuse', APP_SALT);
			$aFactorTicket = $oFactorLimiter->reserve(
				'two-factor',
				$this->Http()->GetClientIp(),
				[$oAccount->Email()]
			);
			if (!$aFactorTicket) {
				throw new ClientException(Notifications::AuthError);
			}

			if (!$oTwoFactor->VerifyAndConsumeTotp($this->twoFactorCode(), TwoFactorService::STATE_DISABLED)) {
				throw new ClientException(Notifications::AuthError);
			}
			if (!$oFactorLimiter->release($aFactorTicket)) {
				throw new ClientException(Notifications::AuthError);
			}

			$aUpdated = $oTwoFactor->LoadState();
			$this->assertTwoFactorStateValid($aUpdated);
			$mRecord = $aUpdated['Record'];
			$mRecord['Enable'] = true;
			$mRecord['FactorGeneration'] = TwoFactorService::NewGeneration();
			if (!$oTwoFactor->Save($mRecord)) {
				throw new ClientException(Notifications::UnknownError);
			}
			return true;
		});

		// The new factor does not promote the pending bearer session. Preserve
		// the established logout, Remember-Me revocation, and fresh-login boundary.
		return $this->DoLogout();
	}

	private function twoFactorService(\RainLoop\Model\MainAccount $oAccount) : TwoFactorService
	{
		return new TwoFactorService($this->StorageProvider(), $oAccount);
	}

	private function withTwoFactorAccountLock(\RainLoop\Model\MainAccount $oAccount, callable $mCallback)
	{
		$mLock = $this->acquireSignMeLock($oAccount);
		if (!$mLock) {
			throw new ClientException(Notifications::AuthError);
		}

		try {
			$oTwoFactor = $this->twoFactorService($oAccount);
			$aState = $oTwoFactor->LoadState();
			$this->assertTwoFactorStateValid($aState);
			$sAssurance = $this->twoFactorSessionState($oAccount);
			if (!$this->sessionAssuranceAllowed($oAccount, $sAssurance)) {
				throw new ClientException(Notifications::AuthError);
			}

			return $mCallback($oTwoFactor, $aState);
		} finally {
			$this->StorageProvider()->ReleaseLock($mLock);
		}
	}

	private function loginActionString(string $sName) : string
	{
		$mValue = $this->GetActionParam($sName, '');
		return \is_string($mValue) ? \trim($mValue) : '';
	}

	private function loginActionRawString(string $sName) : string
	{
		$mValue = $this->GetActionParam($sName, '');
		return \is_string($mValue) ? $mValue : '';
	}

	private function loginSignMeRequested() : bool
	{
		$mValue = $this->GetActionParam('signMe', false);
		return true === $mValue || 1 === $mValue || '1' === $mValue || 'true' === \strtolower((string) $mValue);
	}

	/**
	 * The guest session cookie and existing CSRF connection token jointly bind
	 * every pre-auth action. The challenge identifier is never enough by itself.
	 */
	private function twoFactorLoginBinding() : array
	{
		$sCsrf = Utils::GetCsrfToken();
		if ($this->getMainAccountFromToken(false)) {
			throw new ClientException(Notifications::AuthError);
		}

		$sSession = Utils::GetSessionToken();
		if (!$sSession || '' === $sCsrf) {
			throw new ClientException(Notifications::AuthError);
		}

		$sSessionHash = \hash('sha256', $sSession);
		$sCsrfHash = \hash('sha256', $sCsrf);
		return [
			'SessionHash' => $sSessionHash,
			'CsrfHash' => $sCsrfHash,
			'ContextHash' => \hash('sha256', $sSessionHash."\0".$sCsrfHash)
		];
	}

	private function beginTwoFactorLoginChallenge(
		\RainLoop\Model\MainAccount $oAccount,
		array $aBinding,
		bool $bSignMe
	) : array {
		$oStorage = $this->StorageProvider();
		$mLock = $this->acquireSignMeLock($oAccount);
		if (!$mLock) {
			throw new ClientException(Notifications::AuthError);
		}

		try {
			$sAccountHash = \hash('sha256', $oAccount->Email());
			$sActiveKey = $this->twoFactorActiveChallengeKey($aBinding);
			$mActiveRaw = false;
			$mActive = $oStorage->Inspect($oAccount, StorageType::SESSION, $sActiveKey, $mActiveRaw);
			if (null === $mActive) {
				throw new ClientException(Notifications::AuthError);
			}

			if ($mActive) {
				$aActive = $this->decodeTwoFactorActivePointer($mActiveRaw);
				if (!$aActive
					|| !\hash_equals($sAccountHash, $aActive['AccountHash'])
					|| !\hash_equals($aBinding['SessionHash'], $aActive['SessionHash'])
					|| !\hash_equals($aBinding['CsrfHash'], $aActive['CsrfHash'])) {
					$this->revokeTwoFactorActivePointer($oStorage, $oAccount, $sActiveKey);
					throw new ClientException(Notifications::AuthError);
				}

				$sChallengeKey = $this->twoFactorChallengeKey($aActive['Challenge']);
				$mChallengeRaw = false;
				$mChallenge = $oStorage->Inspect($oAccount, StorageType::SESSION, $sChallengeKey, $mChallengeRaw);
				if (null === $mChallenge) {
					throw new ClientException(Notifications::AuthError);
				}
				if ($mChallenge) {
					$aChallenge = $this->decodeTwoFactorChallenge($mChallengeRaw);
					if (!$aChallenge || !$this->twoFactorChallengeMatches($aChallenge, $oAccount->Email(), $aBinding)
						|| !\hash_equals($aChallenge['ChallengeHash'], \hash('sha256', $aActive['Challenge']))) {
						$this->revokeTwoFactorChallenge($oStorage, $oAccount, $aActive['Challenge'], $aBinding);
						throw new ClientException(Notifications::AuthError);
					}

					if ($aChallenge['ExpiresAt'] <= \time()) {
						if (!$this->revokeTwoFactorChallenge($oStorage, $oAccount, $aActive['Challenge'], $aBinding)) {
							throw new ClientException(Notifications::AuthError);
						}
					} else if ('active' === $aChallenge['Status']) {
						return [
							'Challenge' => $aActive['Challenge'],
							'ExpiresAt' => $aChallenge['ExpiresAt']
						];
					} else {
						// An exhausted challenge cannot be replaced in the same guest
						// context until its original expiry.
						throw new ClientException(Notifications::AuthError);
					}
				}
				if (!$this->revokeTwoFactorActivePointer($oStorage, $oAccount, $sActiveKey)) {
					throw new ClientException(Notifications::AuthError);
				}
			}

			$sChallenge = \rtrim(\strtr(\base64_encode(\random_bytes(32)), '+/', '-_'), '=');
			$sChallengeHash = \hash('sha256', $sChallenge);
			$iNow = \time();
			$aChallenge = [
				'Version' => 1,
				'ChallengeHash' => $sChallengeHash,
				'AccountHash' => $sAccountHash,
				'SessionHash' => $aBinding['SessionHash'],
				'CsrfHash' => $aBinding['CsrfHash'],
				'CreatedAt' => $iNow,
				'ExpiresAt' => $iNow + 300,
				'Attempts' => 0,
				'Status' => 'active',
				'SignMe' => $bSignMe
			];
			$sChallengeKey = 'preauth:v1:challenge:'.$sChallengeHash;
			$sChallengeJson = \json_encode($aChallenge, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
			if (!$this->storeTwoFactorPreAuthState($oStorage, $oAccount, $sChallengeKey, $sChallengeJson)) {
				throw new ClientException(Notifications::AuthError);
			}

			$aActive = [
				'Version' => 1,
				'Challenge' => $sChallenge,
				'ChallengeHash' => $sChallengeHash,
				'AccountHash' => $sAccountHash,
				'SessionHash' => $aBinding['SessionHash'],
				'CsrfHash' => $aBinding['CsrfHash']
			];
			$sActiveJson = \json_encode($aActive, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
			if (!$this->storeTwoFactorPreAuthState($oStorage, $oAccount, $sActiveKey, $sActiveJson)) {
				$this->revokeTwoFactorPreAuthKey($oStorage, $oAccount, $sChallengeKey);
				throw new ClientException(Notifications::AuthError);
			}

			return ['Challenge' => $sChallenge, 'ExpiresAt' => $aChallenge['ExpiresAt']];
		} finally {
			$oStorage->ReleaseLock($mLock);
		}
	}

	private function redeemTwoFactorLoginChallenge(
		\RainLoop\Model\MainAccount $oAccount,
		string $sChallenge,
		string $sCode,
		array $aBinding
	) : array {
		if (!$this->validTwoFactorChallengeId($sChallenge)) {
			throw new ClientException(Notifications::AuthError);
		}

		$oStorage = $this->StorageProvider();
		$mLock = $this->acquireSignMeLock($oAccount);
		if (!$mLock) {
			throw new ClientException(Notifications::AuthError);
		}

		try {
			$sChallengeKey = $this->twoFactorChallengeKey($sChallenge);
			$mValue = false;
			$mExists = $oStorage->Inspect($oAccount, StorageType::SESSION, $sChallengeKey, $mValue);
			if (true !== $mExists) {
				throw new ClientException(Notifications::AuthError);
			}

			$aChallenge = $this->decodeTwoFactorChallenge($mValue);
			if (!$aChallenge
				|| !$this->twoFactorChallengeMatches($aChallenge, $oAccount->Email(), $aBinding)
				|| !\hash_equals($aChallenge['ChallengeHash'], \hash('sha256', $sChallenge))) {
				throw new ClientException(Notifications::AuthError);
			}

			if ($aChallenge['ExpiresAt'] <= \time()) {
				$this->revokeTwoFactorChallenge($oStorage, $oAccount, $sChallenge, $aBinding);
				throw new ClientException(Notifications::AuthError);
			}
			if ('active' !== $aChallenge['Status'] || $aChallenge['Attempts'] >= 5) {
				throw new ClientException(Notifications::AuthError);
			}

			$oTwoFactor = $this->twoFactorService($oAccount);
			$aFactorState = $oTwoFactor->LoadState();
			if (TwoFactorService::STATE_ENABLED !== $aFactorState['Status']) {
				$aChallenge['Status'] = 'exhausted';
				$this->storeChallengeAttemptState($oStorage, $oAccount, $sChallengeKey, $aChallenge);
				throw new ClientException(Notifications::AuthError);
			}

			// This distinct realm counts failed factors across guest sessions and
			// challenges, while reusing the established 10/account, 30/source,
			// five-minute LoginAbuseLimiter budget.
			$oFactorLimiter = new \SnappyMail\LoginAbuseLimiter(APP_PRIVATE_DATA . 'login-abuse', APP_SALT);
			$aFactorTicket = $oFactorLimiter->reserve(
				'two-factor',
				$this->Http()->GetClientIp(),
				[$oAccount->Email()]
			);
			if (!$aFactorTicket) {
				throw new ClientException(Notifications::AuthError);
			}

			try {
				$aProof = $oTwoFactor->ClassifyEnabledLoginProof($aFactorState, $sCode);
			} catch (\Throwable $oException) {
				// An unexpected verifier error cannot authorize the account. Keep the
				// reservation conservatively until its normal expiry.
				throw new ClientException(Notifications::AuthError);
			}

			if (!$aProof) {
				// Only a rejected proof consumes the local challenge failure budget.
				++$aChallenge['Attempts'];
				if ($aChallenge['Attempts'] >= 5) {
					$aChallenge['Status'] = 'exhausted';
				}
				if (!$this->storeChallengeAttemptState($oStorage, $oAccount, $sChallengeKey, $aChallenge)) {
					$this->revokeTwoFactorChallenge($oStorage, $oAccount, $sChallenge, $aBinding);
				}
				throw new ClientException(Notifications::AuthError);
			}

			// Refund a valid proof before consuming its TOTP counter or recovery
			// code. The account lock remains held, so no same-account request can
			// use this admission slot between release and consumption.
			if (!$oFactorLimiter->release($aFactorTicket)) {
				throw new ClientException(Notifications::AuthError);
			}

			$sVerifiedAssurance = $this->verifyMainLoginFactorWhileLocked(
				$oAccount,
				$sCode,
				$aFactorState,
				$aProof
			);
			if (!\is_string($sVerifiedAssurance)) {
				throw new ClientException(Notifications::AuthError);
			}

			$aChallenge['Status'] = 'consumed';
			if (!$this->storeChallengeAttemptState($oStorage, $oAccount, $sChallengeKey, $aChallenge)) {
				$this->revokeTwoFactorChallenge($oStorage, $oAccount, $sChallenge, $aBinding);
				throw new ClientException(Notifications::AuthError);
			}
			$this->revokeTwoFactorChallenge($oStorage, $oAccount, $sChallenge, $aBinding);
			return [
				'SignMe' => $aChallenge['SignMe'],
				'Assurance' => $sVerifiedAssurance
			];
		} finally {
			$oStorage->ReleaseLock($mLock);
		}
	}

	private function storeChallengeAttemptState($oStorage, $oAccount, string $sKey, array $aChallenge) : bool
	{
		try {
			$sJson = \json_encode($aChallenge, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
			return $this->storeTwoFactorPreAuthState($oStorage, $oAccount, $sKey, $sJson);
		} catch (\Throwable $oException) {
			return false;
		}
	}

	private function storeTwoFactorPreAuthState($oStorage, $oAccount, string $sKey, string $sValue) : bool
	{
		if (!$oStorage->Put($oAccount, StorageType::SESSION, $sKey, $sValue)) {
			return false;
		}
		$mSaved = false;
		return true === $oStorage->Inspect($oAccount, StorageType::SESSION, $sKey, $mSaved)
			&& \is_string($mSaved)
			&& \hash_equals($sValue, $mSaved);
	}

	private function revokeTwoFactorChallenge($oStorage, $mAccount, string $sChallenge, array $aBinding) : bool
	{
		$sChallengeKey = $this->twoFactorChallengeKey($sChallenge);
		$sActiveKey = $this->twoFactorActiveChallengeKey($aBinding);
		return $this->revokeTwoFactorPreAuthKey($oStorage, $mAccount, $sChallengeKey)
			&& $this->revokeTwoFactorActivePointer($oStorage, $mAccount, $sActiveKey);
	}

	private function revokeTwoFactorActivePointer($oStorage, $mAccount, string $sKey) : bool
	{
		return null !== $oStorage->Revoke($mAccount, StorageType::SESSION, $sKey);
	}

	private function revokeTwoFactorPreAuthKey($oStorage, $mAccount, string $sKey) : bool
	{
		return null !== $oStorage->Revoke($mAccount, StorageType::SESSION, $sKey);
	}

	private function decodeTwoFactorChallenge($mValue) : ?array
	{
		if (!\is_string($mValue)) {
			return null;
		}
		try {
			$aChallenge = \json_decode($mValue, true, 16, JSON_THROW_ON_ERROR);
		} catch (\Throwable $oException) {
			return null;
		}

		if (!\is_array($aChallenge)
			|| 1 !== ($aChallenge['Version'] ?? null)
			|| !\is_string($aChallenge['ChallengeHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aChallenge['ChallengeHash'])
			|| !\is_string($aChallenge['AccountHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aChallenge['AccountHash'])
			|| !\is_string($aChallenge['SessionHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aChallenge['SessionHash'])
			|| !\is_string($aChallenge['CsrfHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aChallenge['CsrfHash'])
			|| !\is_int($aChallenge['CreatedAt'] ?? null)
			|| !\is_int($aChallenge['ExpiresAt'] ?? null)
			|| $aChallenge['ExpiresAt'] !== $aChallenge['CreatedAt'] + 300
			|| !\is_int($aChallenge['Attempts'] ?? null)
			|| $aChallenge['Attempts'] < 0 || $aChallenge['Attempts'] > 5
			|| !\in_array($aChallenge['Status'] ?? null, ['active', 'exhausted', 'consumed'], true)
			|| !\is_bool($aChallenge['SignMe'] ?? null)) {
			return null;
		}

		return $aChallenge;
	}

	private function decodeTwoFactorActivePointer($mValue) : ?array
	{
		if (!\is_string($mValue)) {
			return null;
		}
		try {
			$aActive = \json_decode($mValue, true, 16, JSON_THROW_ON_ERROR);
		} catch (\Throwable $oException) {
			return null;
		}

		if (!\is_array($aActive)
			|| 1 !== ($aActive['Version'] ?? null)
			|| !\is_string($aActive['Challenge'] ?? null)
			|| !$this->validTwoFactorChallengeId($aActive['Challenge'])
			|| !\is_string($aActive['ChallengeHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aActive['ChallengeHash'])
			|| !\hash_equals($aActive['ChallengeHash'], \hash('sha256', $aActive['Challenge']))
			|| !\is_string($aActive['AccountHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aActive['AccountHash'])
			|| !\is_string($aActive['SessionHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aActive['SessionHash'])
			|| !\is_string($aActive['CsrfHash'] ?? null)
			|| !\preg_match('/\A[a-f0-9]{64}\z/D', $aActive['CsrfHash'])) {
			return null;
		}

		return $aActive;
	}

	private function twoFactorChallengeMatches(array $aChallenge, string $sEmail, array $aBinding) : bool
	{
		return \hash_equals($aChallenge['AccountHash'], \hash('sha256', $sEmail))
			&& \hash_equals($aChallenge['SessionHash'], $aBinding['SessionHash'])
			&& \hash_equals($aChallenge['CsrfHash'], $aBinding['CsrfHash']);
	}

	private function validTwoFactorChallengeId(string $sChallenge) : bool
	{
		return 43 === \strlen($sChallenge) && 1 === \preg_match('/\A[A-Za-z0-9_-]{43}\z/D', $sChallenge);
	}

	private function twoFactorChallengeKey(string $sChallenge) : string
	{
		return 'preauth:v1:challenge:'.\hash('sha256', $sChallenge);
	}

	private function twoFactorActiveChallengeKey(array $aBinding) : string
	{
		return 'preauth:v1:active:'.$aBinding['ContextHash'];
	}

	private function requireTwoFactorPost() : void
	{
		if ('POST' !== \strtoupper($_SERVER['REQUEST_METHOD'] ?? '')) {
			throw new ClientException(Notifications::AuthError);
		}
	}

	private function twoFactorCode() : string
	{
		$mCode = $this->GetActionParam('Code', '');
		return \is_string($mCode) ? \trim($mCode) : '';
	}

	private function twoFactorIsRequired() : bool
	{
		return (bool) $this->Config()->Get('security', 'require_two_factor_auth', false);
	}

	private function twoFactorSessionState(\RainLoop\Model\MainAccount $oAccount) : string
	{
		$sToken = Utils::GetSessionToken(false);
		$mState = $sToken
			? $this->StorageProvider()->Get($oAccount, StorageType::SESSION, $sToken, '')
			: '';
		return \is_string($mState) ? $mState : '';
	}

	private function setTwoFactorSessionAssurance(\RainLoop\Model\MainAccount $oAccount, string $sAssurance) : bool
	{
		$sToken = Utils::GetSessionToken(false);
		if (!$sToken) {
			return false;
		}

		$oStorage = $this->StorageProvider();
		$this->assertLoginAssuranceAllowed($oAccount, $sAssurance);
		return $oStorage->Put($oAccount, StorageType::SESSION, $sToken, $sAssurance)
			&& $oStorage->Get($oAccount, StorageType::SESSION, $sToken) === $sAssurance;
	}

	private function assertTwoFactorStateValid(array $aState) : void
	{
		if (TwoFactorService::STATE_INVALID === $aState['Status']) {
			throw new ClientException(Notifications::AuthError);
		}
	}

	private function twoFactorEnrollmentData(\RainLoop\Model\MainAccount $oAccount, array $mRecord) : array
	{
		return [
			'User' => $oAccount->Email(),
			'Secret' => $mRecord['Secret'],
			'QRCode' => $this->twoFactorQRCode($oAccount, $mRecord['Secret']),
			'BackupCodes' => $mRecord['BackupCodes']
		];
	}

	private function twoFactorQRCode(\RainLoop\Model\MainAccount $oAccount, string $sSecret) : string
	{
		$QR = \SnappyMail\QRCode::getMinimumQRCode(
			'otpauth://totp/'.\rawurlencode($oAccount->Email()).'?secret='.$sSecret,
			\SnappyMail\QRCode::ERROR_CORRECT_LEVEL_M
		);
		return $QR->__toString();
	}
}
