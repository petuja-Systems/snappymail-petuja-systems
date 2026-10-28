<?php

namespace RainLoop\Actions;

use RainLoop\Enumerations\Capa;
use RainLoop\Exceptions\ClientException;
use RainLoop\Notifications;
use RainLoop\Providers\Suggestions;
use RainLoop\Utils;

trait User
{
	use Accounts;
	use Contacts;
	use Filters;
	use Folders;
	use TwoFactor;
	use Messages;
	use Attachments;
	use Pgp;
	use SMime;

	private ?Suggestions $oSuggestionsProvider = null;

	public function SuggestionsProvider(): Suggestions
	{
		if (null === $this->oSuggestionsProvider) {
			$this->oSuggestionsProvider = new Suggestions($this->fabrica('suggestions'));
		}

		return $this->oSuggestionsProvider;
	}

	/**
	 * @throws \MailSo\RuntimeException
	 */
	public function DoLogin() : array
	{
		$sEmail = $this->GetActionParam('Email', '');
		$sPassword = $this->GetActionParam('Password', '');
		$sEmail = \is_scalar($sEmail) ? (string) $sEmail : '';
		$sPassword = \is_scalar($sPassword) ? (string) $sPassword : '';

		$oAccount = $this->LoginPublicPassword(
			\MailSo\Base\Utils::Trim($sEmail),
			new \SnappyMail\SensitiveString($sPassword)
		);

		empty($this->GetActionParam('signMe', 0)) || $this->SetSignMeToken($oAccount);

		$this->persistLoginLanguage($oAccount);

		return $this->DefaultResponse($this->AppData(false));
	}

	/**
	 * Preserve the selected public-login language only after primary/final auth.
	 */
	private function persistLoginLanguage(\RainLoop\Model\MainAccount $oAccount) : void
	{
		$mLanguage = $this->GetActionParam('language', '');
		$sLanguage = \is_scalar($mLanguage) ? (string) $mLanguage : '';
		if ('' === $sLanguage) {
			return;
		}

		$oSettings = $this->SettingsProvider()->Load($oAccount);
		if ($oSettings) {
			$sLanguage = $this->ValidateLanguage($sLanguage);
			if ($oSettings->GetConf('language', '') !== $sLanguage) {
				$oSettings->SetConf('language', $sLanguage);
				$oSettings->save();
			}
		}
	}

	public function DoLogout() : array
	{
		$bMain = true; // empty($_COOKIE[self::AUTH_ADDITIONAL_TOKEN_KEY]);
		$this->Logout($bMain, true);
		$bMain && $this->ClearSignMeData();
		return $this->TrueResponse();
	}

	public function DoAppDelayStart() : array
	{
		Utils::UpdateConnectionToken();

		$bMainCache = false;
		$bFilesCache = false;

		$iOneDay1 = 3600 * 23;
		$iOneDay2 = 3600 * 25;

		$sTimers = $this->StorageProvider()->Get(null,
			\RainLoop\Providers\Storage\Enumerations\StorageType::NOBODY, 'Cache/Timers', '');

		$aTimers = \explode(',', $sTimers);

		$iMainCacheTime = !empty($aTimers[0]) && \is_numeric($aTimers[0]) ? (int) $aTimers[0] : 0;
		$iFilesCacheTime = !empty($aTimers[1]) && \is_numeric($aTimers[1]) ? (int) $aTimers[1] : 0;

		if (0 === $iMainCacheTime || $iMainCacheTime + $iOneDay1 < \time()) {
			$bMainCache = true;
			$iMainCacheTime = \time();
		}

		if (0 === $iFilesCacheTime || $iFilesCacheTime + $iOneDay2 < \time()) {
			$bFilesCache = true;
			$iFilesCacheTime = \time();
		}

		if ($bMainCache || $bFilesCache) {
			if (!$this->StorageProvider()->Put(null,
				\RainLoop\Providers\Storage\Enumerations\StorageType::NOBODY, 'Cache/Timers',
				\implode(',', array($iMainCacheTime, $iFilesCacheTime))))
			{
				$bMainCache = $bFilesCache = false;
			}
		}

		if ($bMainCache) {
			$this->logWrite('Cacher GC: Begin');
			$this->Cacher()->GC(48);
			$this->logWrite('Cacher GC: End');

			$this->logWrite('Storage GC: Begin');
			$this->StorageProvider()->GC();
			$this->logWrite('Storage GC: End');
		} else if ($bFilesCache) {
			$this->logWrite('Files GC: Begin');
			$this->FilesProvider()->GC(48);
			$this->logWrite('Files GC: End');
		}

		return $this->TrueResponse();
	}

	public function DoSettingsUpdate() : array
	{
		if (!$this->Http()->IsPost()) {
			throw new ClientException(Notifications::AuthError);
		}

		$oAccount = $this->getAccountFromToken();
		$aActionParams = $this->GetActionParams();
		$bHasAppearance = \array_key_exists('Appearance', $aActionParams);
		$mAppearance = $bHasAppearance ? $aActionParams['Appearance'] : null;
		if ($bHasAppearance && !\RainLoop\Actions::IsAppearancePreference($mAppearance)) {
			throw new ClientException(Notifications::InvalidInputArgument);
		}

		$self = $this;
		$oConfig = $this->Config();

		$oSettings = $this->SettingsProvider()->Load($oAccount);
		$oSettingsLocal = $this->SettingsProvider(true)->Load($oAccount);
		if ($bHasAppearance) {
			$oSettings->SetConf('Appearance', $mAppearance);
		}

		if ($oConfig->Get('webmail', 'allow_languages_on_settings', true)) {
			$this->setSettingsFromParams($oSettings, 'language', 'string', function ($sLanguage) use ($self) {
				return $self->ValidateLanguage($sLanguage);
			});
		} else {
//			$oSettings->SetConf('language', $this->ValidateLanguage($oConfig->Get('webmail', 'language', 'en')));
		}
		$this->setSettingsFromParams($oSettings, 'hourCycle', 'string');

		$this->setSettingsFromParams($oSettings, 'MessagesPerPage', 'int', function ($iValue) {
			return \min(100, \max(10, $iValue));
		});

		$this->setSettingsFromParams($oSettings, 'Layout', 'int', function ($iValue) {
			return (int) (\in_array((int) $iValue, array(\RainLoop\Enumerations\Layout::NO_PREVIEW,
				\RainLoop\Enumerations\Layout::SIDE_PREVIEW, \RainLoop\Enumerations\Layout::BOTTOM_PREVIEW)) ?
					$iValue : \RainLoop\Enumerations\Layout::SIDE_PREVIEW);
		});

		$this->setSettingsFromParams($oSettings, 'EditorDefaultType', 'string');
		$this->setSettingsFromParams($oSettings, 'editorWysiwyg', 'string');
		$this->setSettingsFromParams($oSettings, 'requestReadReceipt', 'bool');
		$this->setSettingsFromParams($oSettings, 'requestDsn', 'bool');
		$this->setSettingsFromParams($oSettings, 'requireTLS', 'bool');
		$this->setSettingsFromParams($oSettings, 'pgpSign', 'bool');
		$this->setSettingsFromParams($oSettings, 'pgpEncrypt', 'bool');
		$this->setSettingsFromParams($oSettings, 'allowSpellcheck', 'bool');

		$this->setSettingsFromParams($oSettings, 'ViewHTML', 'bool');
		$this->setSettingsFromParams($oSettings, 'ViewImages', 'string');
		$this->setSettingsFromParams($oSettings, 'ViewImagesWhitelist', 'string');
		$this->setSettingsFromParams($oSettings, 'RemoveColors', 'bool');
		$this->setSettingsFromParams($oSettings, 'AllowStyles', 'bool');
		$this->setSettingsFromParams($oSettings, 'ListInlineAttachments', 'bool');
		$this->setSettingsFromParams($oSettings, 'CollapseBlockquotes', 'bool');
		$this->setSettingsFromParams($oSettings, 'MaxBlockquotesLevel', 'int');
		$this->setSettingsFromParams($oSettings, 'simpleAttachmentsList', 'bool');
		$this->setSettingsFromParams($oSettings, 'listGrouped', 'bool');
		$this->setSettingsFromParams($oSettings, 'ContactsAutosave', 'bool');
		$this->setSettingsFromParams($oSettings, 'DesktopNotifications', 'bool');
		$this->setSettingsFromParams($oSettings, 'SoundNotification', 'bool');
		$this->setSettingsFromParams($oSettings, 'NotificationSound', 'string');
		$this->setSettingsFromParams($oSettings, 'UseCheckboxesInList', 'bool');
		$this->setSettingsFromParams($oSettings, 'AllowDraftAutosave', 'bool');
		$this->setSettingsFromParams($oSettings, 'AutoLogout', 'int');
		$this->setSettingsFromParams($oSettings, 'keyPassForget', 'int');
		$this->setSettingsFromParams($oSettings, 'messageNewWindow', 'bool');
		$this->setSettingsFromParams($oSettings, 'messageReadAuto', 'bool');
		$this->setSettingsFromParams($oSettings, 'MessageReadDelay', 'int');
		$this->setSettingsFromParams($oSettings, 'MsgDefaultAction', 'int');
		$this->setSettingsFromParams($oSettings, 'showNextMessage', 'bool');
		$this->setSettingsFromParams($oSettings, 'markdown', 'bool');

		$this->setSettingsFromParams($oSettings, 'Resizer4Width', 'int');
		$this->setSettingsFromParams($oSettings, 'Resizer5Width', 'int');
		$this->setSettingsFromParams($oSettings, 'Resizer5Height', 'int');

		$this->setSettingsFromParams($oSettingsLocal, 'UseThreads', 'bool');
		$this->setSettingsFromParams($oSettingsLocal, 'threadAlgorithm', 'string');
		$this->setSettingsFromParams($oSettingsLocal, 'ReplySameFolder', 'bool');
		$this->setSettingsFromParams($oSettingsLocal, 'HideUnsubscribed', 'bool');
		$this->setSettingsFromParams($oSettingsLocal, 'HideDeleted', 'bool');
		$this->setSettingsFromParams($oSettingsLocal, 'UnhideKolabFolders', 'bool');
		$this->setSettingsFromParams($oSettingsLocal, 'ShowUnreadCount', 'bool');
		$this->setSettingsFromParams($oSettingsLocal, 'CheckMailInterval', 'int');

		return $this->DefaultResponse($oSettings->save() && $oSettingsLocal->save());
	}

	public function DoQuota() : array
	{
		$oAccount = $this->initMailClientConnection();
		try
		{
			return $this->DefaultResponse($this->ImapClient()->QuotaRoot() ?: [0, 0, 0, 0]);
		}
		catch (\Throwable $oException)
		{
			throw new ClientException(Notifications::MailServerError, $oException);
		}
	}

	public function DoSuggestions() : array
	{
		$oAccount = $this->getAccountFromToken();

		$sQuery = \trim($this->GetActionParam('Query', ''));
		$iLimit = (int) $this->Config()->Get('contacts', 'suggestions_limit', 20);

		$aResult = array();

		if ($oSuggestionsProvider = $this->SuggestionsProvider()) {
			$aResult = $oSuggestionsProvider->Process($oAccount, $sQuery, $iLimit);
		}

		return $this->DefaultResponse($aResult);
	}

	private function setSettingsFromParams(\RainLoop\Settings $oSettings, string $sConfigName, string $sType = 'string', ?callable $cCallback = null) : void
	{
		if ($this->HasActionParam($sConfigName)) {
			$sValue = $this->GetActionParam($sConfigName, '');
			switch ($sType)
			{
				default:
				case 'string':
					$sValue = (string) $sValue;
					if ($cCallback) {
						$sValue = $cCallback($sValue);
					}
					$oSettings->SetConf($sConfigName, (string) $sValue);
					break;

				case 'int':
					$iValue = (int) $sValue;
					if ($cCallback) {
						$sValue = $cCallback($iValue);
					}
					$oSettings->SetConf($sConfigName, $iValue);
					break;

				case 'bool':
					$oSettings->SetConf($sConfigName, !empty($sValue) && 'false' !== $sValue);
					break;
			}
		}
	}
}
