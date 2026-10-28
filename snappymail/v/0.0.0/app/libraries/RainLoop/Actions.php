<?php

namespace RainLoop;

use RainLoop\Enumerations\Capa;
use RainLoop\Enumerations\SignMeType;

class Actions
{
	use Actions\Admin;
	use Actions\User;
	use Actions\UserAuth;
	use Actions\Raw;
	use Actions\Response;
	use Actions\Localization;

	use \MailSo\Log\Inherit;

	const AUTH_MAILTO_TOKEN_KEY = 'smmailtoauth';

	/**
	 * This 30 days cookie contains decrypt data,
	 * to decrypt a \RainLoop\Model\Account which is stored at
	 * /_data_/.../storage/DOMAIN/LOCAL/.sign_me/*
	 * Gets refreshed on each login
	 */
	const AUTH_SIGN_ME_TOKEN_KEY = 'smremember';

	/**
	 * This session cookie contains a \RainLoop\Model\Account
	 * Value is Base64 EncryptToJSON
	 */
	const AUTH_SPEC_TOKEN_KEY = 'smaccount';

	/**
	 * This session cookie optionally contains a \RainLoop\Model\AdditionalAccount
	 * Value is Base64 EncryptToJSON
	 */
	const AUTH_ADDITIONAL_TOKEN_KEY = 'smadditional';

	const APP_DUMMY = '********';

	private const APPEARANCE_PREFERENCES = ['light', 'dark', 'system'];

	/**
	 * Exact built-in theme IDs only. Values represent user preferences, not the
	 * effective color scheme. Clear is intentionally omitted because it defines
	 * no unambiguous light/dark appearance; unknown IDs use the safe Light fallback.
	 */
	private const LEGACY_THEME_APPEARANCE = [
		'A' => 'light',
		'BlackWood' => 'dark',
		'Blurred' => 'light',
		'BlurredDark' => 'dark',
		'DarkShine' => 'light',
		'Default' => 'light',
		'Linen' => 'light',
		'Love' => 'light',
		'LoveDark' => 'dark',
		'Magnetic' => 'dark',
		'NextcloudV25+' => 'system',
		'NightShine' => 'dark',
		'Snow' => 'light',
		'SnowDarkV1' => 'dark',
		'Squares' => 'light',
		'SquaresDark' => 'dark',
		'Stripes' => 'light',
		'StripesDark' => 'dark',
		'Wood' => 'light',
		'Xv' => 'light'
	];

	/**
	 * @var \MailSo\Base\Http
	 */
	protected $oHttp = null;

	/**
	 * @var array
	 */
	protected $aCurrentActionParams = array();

	/**
	 * @var \MailSo\Mail\MailClient
	 */
	protected $oMailClient = null;

	/**
	 * @var \MailSo\Log\Logger
	 */
	protected $oLoggerAuth;

	/**
	 * @var array of \MailSo\Cache\CacheClient
	 */
	protected $aCachers = array();

	/**
	 * @var \RainLoop\Providers\Storage
	 */
	protected $oStorageProvider = null;

	/**
	 * @var \RainLoop\Providers\Storage
	 */
	protected $oLocalStorageProvider = null;

	/**
	 * @var \RainLoop\Providers\Files
	 */
	protected $oFilesProvider = null;

	/**
	 * @var \RainLoop\Providers\Domain
	 */
	protected $oDomainProvider = null;

	/**
	 * @var \RainLoop\Providers\Settings
	 */
	protected $oSettingsProvider = null;

	/**
	 * @var \RainLoop\Providers\Settings
	 */
	protected $oLocalSettingsProvider = null;

	/**
	 * @var \RainLoop\Config\Application
	 */
	protected $oConfig = null;

	/**
	 * @var bool
	 */
	protected $bIsJson = false;

	function __construct()
	{
		$this->oConfig = Api::Config();

		$this->oLogger = API::Logger();
		if ($this->oConfig->Get('logs', 'enable', false) || $this->oConfig->Get('debug', 'enable', false)) {

			$oDriver = null;
			$sLogFileName = $this->oConfig->Get('logs', 'filename', '');
			if ('syslog' === $sLogFileName) {
				$oDriver = new \MailSo\Log\Drivers\Syslog();
			} else if ('stderr' === $sLogFileName) {
				$oDriver = new \MailSo\Log\Drivers\StderrStream();
			} else {
				$sLogFileFullPath = \trim($this->oConfig->Get('logs', 'path', '')) ?: \APP_PRIVATE_DATA . 'logs';
				\is_dir($sLogFileFullPath) || \mkdir($sLogFileFullPath, 0700, true);
				$oDriver = new \MailSo\Log\Drivers\File($sLogFileFullPath . '/' . $this->compileLogFileName($sLogFileName));
			}
			$this->oLogger->append($oDriver
				->SetTimeZone($this->oConfig->Get('logs', 'time_zone', 'UTC'))
			);

			$oHttp = $this->Http();

			$this->logWrite(
				'[SM:' . APP_VERSION . '][IP:'
				. $oHttp->GetClientIp()
				. '][PID:' . (\MailSo\Base\Utils::FunctionCallable('getmypid') ? \getmypid() : 'unknown')
				. '][' . \MailSo\Base\Http::GetServer('SERVER_SOFTWARE', '~')
				. '][' . \PHP_SAPI
				. '][Streams:' . \implode(',', \stream_get_transports())
				. '][' . $oHttp->GetMethod() . ' ' . $oHttp->GetScheme() . '://' . $oHttp->GetHost(false) . ']'
			);
		}
	}

	public function SetIsJson(bool $bIsJson): self
	{
		$this->bIsJson = $bIsJson;

		return $this;
	}

	public function GetIsJson(): bool
	{
		return $this->bIsJson;
	}

	public function Config(): Config\Application
	{
		return $this->oConfig;
	}

	/**
	 * @return mixed
	 */
	protected function fabrica(string $sName)
	{
		$mResult = null;

		if (null === $mResult) {
			switch ($sName) {
				case 'files':
					// RainLoop\Providers\Files\IFiles
					$mResult = new Providers\Files\FileStorage(APP_PRIVATE_DATA . 'storage');
					break;
				case 'storage':
				case 'storage-local':
					// RainLoop\Providers\Storage\IStorage
					$mResult = new Providers\Storage\FileStorage(
						APP_PRIVATE_DATA . 'storage', 'storage-local' === $sName);
					break;
				case 'settings':
					// RainLoop\Providers\Settings\ISettings
					$mResult = new Providers\Settings\DefaultSettings($this->StorageProvider());
					break;
				case 'settings-local':
					// RainLoop\Providers\Settings\ISettings
					$mResult = new Providers\Settings\DefaultSettings($this->LocalStorageProvider());
					break;
				case 'domain':
					// Providers\Domain\DomainInterface
					$mResult = new Providers\Domain\DefaultDomain(APP_PRIVATE_DATA . 'domains', $this->Cacher());
					break;
				case 'filters':
					// Providers\Filters\FiltersInterface
					$mResult = new Providers\Filters\SieveStorage();
					break;
				case 'address-book':
					// Providers\AddressBook\AddressBookInterface
					$mResult = new Providers\AddressBook\PdoAddressBook();
					break;
				case 'identities':
				case 'suggestions':
					$mResult = [];
					break;
/*				// See function Cacher
				case 'cache':
					$mResult = new \MailSo\Cache\Drivers\File(
						\trim($this->oConfig->Get('cache', 'path', '')) ?: APP_PRIVATE_DATA . 'cache'
					);
					break;
*/
			}
		}

		// Always give the file provider as last for identities, it is the override
		if ('identities' === $sName) {
			$mResult[] = new Providers\Identities\FileIdentities($this->LocalStorageProvider());
		}

		foreach (\is_array($mResult) ? $mResult : array($mResult) as $oItem) {
			if ($oItem && \method_exists($oItem, 'SetLogger')) {
				$oItem->SetLogger($this->oLogger);
			}
		}

		return $mResult;
	}

	public function BootEnd(): void
	{
/*
		try {
			if (!\SnappyMail\Shutdown::count() && $this->ImapClient()->IsLoggined()) {
				$this->ImapClient()->Disconnect();
			}
		} catch (\Throwable $oException) {
			unset($oException);
		}
*/
	}

	protected function compileLogParams(string $sLine, ?Model\Account $oAccount = null, array $aAdditionalParams = array(), bool $bAuthLog = false): string
	{
		$aClear = array();
		$encode = function ($value) use ($bAuthLog) {
			return $bAuthLog ? $this->escapeAuthLog((string) $value, true) : $value;
		};

		if (false !== \strpos($sLine, '{date:')) {
			$oConfig = $this->oConfig;
			$sLine = \preg_replace_callback('/\{date:([^}]+)\}/', function ($aMatch) use ($oConfig) {
				return (new \DateTime('now', new \DateTimeZone($oConfig->Get('logs', 'time_zone', 'UTC'))))->format($aMatch[1]);
			}, $sLine);

			$aClear['/\{date:([^}]*)\}/'] = 'date';
		}

		if (false !== \strpos($sLine, '{imap:') || false !== \strpos($sLine, '{smtp:')) {
			if (!$oAccount) {
				$oAccount = $this->getAccountFromToken(false);
			}

			if ($oAccount) {
				$sLine = \str_replace('{imap:login}', $encode($oAccount->ImapUser()), $sLine);
				$sLine = \str_replace('{smtp:login}', $encode($oAccount->SmtpUser()), $sLine);
				$oDomain = $oAccount->Domain();
				if ($oDomain) {
					$sLine = \str_replace('{imap:host}', $encode($oDomain->ImapSettings()->host), $sLine);
					$sLine = \str_replace('{imap:port}', $encode($oDomain->ImapSettings()->port), $sLine);
					$sLine = \str_replace('{smtp:host}', $encode($oDomain->SmtpSettings()->host), $sLine);
					$sLine = \str_replace('{smtp:port}', $encode($oDomain->SmtpSettings()->port), $sLine);
				}
			}

			$aClear['/\{imap:([^}]*)\}/i'] = 'imap';
			$aClear['/\{smtp:([^}]*)\}/i'] = 'smtp';
		}

		if (false !== \strpos($sLine, '{request:')) {
			if (false !== \strpos($sLine, '{request:ip}')) {
				$sLine = \str_replace('{request:ip}',
					$encode($this->Http()->GetClientIp()),
					$sLine);
			}

			if (false !== \strpos($sLine, '{request:domain}')) {
				$sLine = \str_replace('{request:domain}', $encode($this->Http()->GetHost(true, true)), $sLine);
			}

			if (false !== \strpos($sLine, '{request:domain-clear}')) {
				$sLine = \str_replace('{request:domain-clear}',
					$encode(\MailSo\Base\Utils::GetClearDomainName($this->Http()->GetHost(true, true))),
					$sLine);
			}

			$aClear['/\{request:([^}]*)\}/i'] = 'request';
		}

		if (false !== \strpos($sLine, '{user:')) {
			if (false !== \strpos($sLine, '{user:uid}')) {
				$sLine = \str_replace('{user:uid}',
					$encode(\base_convert(\sprintf('%u', \crc32(Utils::GetConnectionToken())), 10, 32)),
					$sLine
				);
			}

			if (false !== \strpos($sLine, '{user:ip}')) {
				$sLine = \str_replace('{user:ip}',
					$encode($this->Http()->GetClientIp()),
					$sLine);
			}

			if (\preg_match('/\{user:(email|login|domain)\}/i', $sLine)) {
				if (!$oAccount) {
					$oAccount = $this->getAccountFromToken(false);
				}

				if ($oAccount) {
					$sEmail = $oAccount->Email();

					$sLine = \str_replace('{user:email}', $encode($sEmail), $sLine);
					$sLine = \str_replace('{user:login}', $encode(\MailSo\Base\Utils::getEmailAddressLocalPart($sEmail)), $sLine);
					$sLine = \str_replace('{user:domain}', $encode(\MailSo\Base\Utils::getEmailAddressDomain($sEmail)), $sLine);
					$sLine = \str_replace('{user:domain-clear}',
						$encode(\MailSo\Base\Utils::GetClearDomainName(\MailSo\Base\Utils::getEmailAddressDomain($sEmail))),
						$sLine);
				}
			}

			$aClear['/\{user:([^}]*)\}/i'] = 'unknown';
		}

		if (false !== \strpos($sLine, '{labs:')) {
			$sLine = \preg_replace_callback('/\{labs:rand:([1-9])\}/', function ($aMatch) {
				return \rand(\pow(10, $aMatch[1] - 1), \pow(10, $aMatch[1]) - 1);
			}, $sLine);

			$aClear['/\{labs:([^}]*)\}/'] = 'labs';
		}

		foreach ($aAdditionalParams as $sKey => $sValue) {
			$sLine = \str_replace($sKey, $encode($sValue), $sLine);
		}

		foreach ($aClear as $sKey => $sValue) {
			$sLine = \preg_replace($sKey, $sValue, $sLine);
		}

		return $bAuthLog ? $this->escapeAuthLog($sLine, false) : $sLine;
	}

	private function escapeAuthLog(string $value, bool $field): string
	{
		// Fields cannot reproduce the space-delimited event marker of a log filter.
		$value = \addcslashes($value, $field ? "\0..\37\177\\" : "\0..\37\177");
		$value = \preg_replace_callback('/\xC2[\x80-\x9F]|\xE2\x80[\xA8\xA9]/', static function ($match) {
			return \addcslashes($match[0], "\0..\377");
		}, $value);
		return $field ? \str_replace(' ', '\x20', $value) : $value;
	}

	protected function compileLogFileName(string $sFileName): string
	{
		$sFileName = \trim($sFileName);

		if (\strlen($sFileName)) {
			$sFileName = $this->compileLogParams($sFileName);

			$sFileName = \preg_replace('/[\/]+/', '/', \preg_replace('/[.]+/', '.', $sFileName));
			$sFileName = \preg_replace('/[^a-zA-Z0-9@_+=\-\.\/!()\[\]]/', '', $sFileName);
		}

		if (!\strlen($sFileName)) {
			$sFileName = 'snappymail-log.txt';
		}

		return $sFileName;
	}

	/**
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	public function GetAccount(bool $bThrowExceptionOnFalse = false): ?Model\Account
	{
		return $this->getAccountFromToken($bThrowExceptionOnFalse);
	}

	public function Http(): \MailSo\Base\Http
	{
		if (null === $this->oHttp) {
			$this->oHttp = \MailSo\Base\Http::SingletonInstance();
		}

		return $this->oHttp;
	}

	public function MailClient(): \MailSo\Mail\MailClient
	{
		if (null === $this->oMailClient) {
			$this->oMailClient = new \MailSo\Mail\MailClient();
			$this->oMailClient->SetLogger($this->oLogger);
		}

		return $this->oMailClient;
	}

	public function ImapClient(): \MailSo\Imap\ImapClient
	{
//		$this->initMailClientConnection();
		return $this->MailClient()->ImapClient();
	}

	// Stores data in AdditionalAccount else MainAccount
	public function LocalStorageProvider(): Providers\Storage
	{
		if (!$this->oLocalStorageProvider) {
			$this->oLocalStorageProvider = new Providers\Storage($this->fabrica('storage-local'));
		}
		return $this->oLocalStorageProvider;
	}

	// Stores data in MainAccount
	public function StorageProvider(): Providers\Storage
	{
		if (!$this->oStorageProvider) {
			$this->oStorageProvider = new Providers\Storage($this->fabrica('storage'));
		}
		return $this->oStorageProvider;
	}

	public function SettingsProvider(bool $bLocal = false): Providers\Settings
	{
		if ($bLocal) {
			if (null === $this->oLocalSettingsProvider) {
				$this->oLocalSettingsProvider = new Providers\Settings(
					$this->fabrica('settings-local'));
			}

			return $this->oLocalSettingsProvider;
		} else {
			if (null === $this->oSettingsProvider) {
				$this->oSettingsProvider = new Providers\Settings(
					$this->fabrica('settings'));
			}

			return $this->oSettingsProvider;
		}
	}

	public function FilesProvider(): Providers\Files
	{
		if (null === $this->oFilesProvider) {
			$this->oFilesProvider = new Providers\Files(
				$this->fabrica('files'));
		}

		return $this->oFilesProvider;
	}

	public function DomainProvider(): Providers\Domain
	{
		if (null === $this->oDomainProvider) {
			$this->oDomainProvider = new Providers\Domain($this->fabrica('domain'));
		}

		return $this->oDomainProvider;
	}

	/**
	 * bForceFile is only used by admin session token
	 */
	public function Cacher(?Model\Account $oAccount = null, bool $bForceFile = false): \MailSo\Cache\CacheClient
	{
		$sKey = '';
		if ($oAccount) {
			$sKey = $this->GetMainEmail($oAccount);
		}

		$sIndexKey = empty($sKey) ? '_default_' : $sKey;
		if ($bForceFile) {
			$sIndexKey .= '/_files_';
		}

		if (!isset($this->aCachers[$sIndexKey])) {
			$this->aCachers[$sIndexKey] = new \MailSo\Cache\CacheClient();

			$oDriver = $bForceFile ? null : $this->fabrica('cache');
			if (!($oDriver instanceof \MailSo\Cache\DriverInterface)) {
				$oDriver = new \MailSo\Cache\Drivers\File(
					\trim($this->oConfig->Get('cache', 'path', '')) ?: APP_PRIVATE_DATA . 'cache'
				);
			}
			$oDriver->setPrefix($sKey);

			$this->aCachers[$sIndexKey]->SetDriver($oDriver);
			$this->aCachers[$sIndexKey]->SetCacheIndex($this->oConfig->Get('cache', 'fast_cache_index', ''));
		}

		return $this->aCachers[$sIndexKey];
	}

	protected function LoggerAuthHelper(?Model\Account $oAccount, string $sLogin = '', bool $admin = false): void
	{
		if ($sLogin) {
			$sHost = $admin ? $this->Http()->GetHost(true, true) : \MailSo\Base\Utils::getEmailAddressDomain($sLogin);
			$aAdditionalParams = array(
				'{imap:login}' => $sLogin,
				'{imap:host}' => $sHost,
				'{smtp:login}' => $sLogin,
				'{smtp:host}' => $sHost,
				'{user:email}' => $sLogin,
				'{user:login}' => $admin ? $sLogin : \MailSo\Base\Utils::getEmailAddressLocalPart($sLogin),
				'{user:domain}' => $sHost,
			);
		} else {
			$aAdditionalParams = array();
		}
		$sLine = $this->oConfig->Get('logs', 'auth_logging_format', '');
		if (!empty($sLine)) {
			if (!$this->oLoggerAuth) {
				$this->oLoggerAuth = new \MailSo\Log\Logger(false);
				if ($this->oConfig->Get('logs', 'auth_logging', false)) {
//					$this->oLoggerAuth->SetLevel(\LOG_WARNING);

					$sAuthLogFileFullPath = (\trim($this->oConfig->Get('logs', 'path', '') ?: \APP_PRIVATE_DATA . 'logs'))
						. '/' . $this->compileLogFileName($this->oConfig->Get('logs', 'auth_logging_filename', ''));
					$sLogFileDir = \dirname($sAuthLogFileFullPath);
					\is_dir($sLogFileDir) || \mkdir($sLogFileDir, 0755, true);
					$this->oLoggerAuth->append(
						(new \MailSo\Log\Drivers\File($sAuthLogFileFullPath))
							->DisableTimePrefix()
							->DisableGuidPrefix()
							->DisableTypedPrefix()
					);
				}
			}
			$this->oLoggerAuth->Write($this->compileLogParams($sLine, $oAccount, $aAdditionalParams, true), \LOG_WARNING);
		}
		if (($this->oConfig->Get('logs', 'auth_logging', false) || $this->oConfig->Get('logs', 'auth_syslog', false))
		 && \openlog('snappymail', 0, \LOG_AUTHPRIV)) {
			\syslog(\LOG_ERR, $this->compileLogParams(
				$admin ? 'Admin Auth failed: ip={request:ip} user={user:login}' : 'Auth failed: ip={request:ip} user={imap:login}',
				$oAccount, $aAdditionalParams, true
			));
			\closelog();
		}
	}

	public function AppData(bool $bAdmin): array
	{
		$oAccount = null;
		$oConfig = $this->oConfig;

		$aResult = array(
			'Auth' => false,
			'title' => $oConfig->Get('webmail', 'title', 'petuja.email'),
			'loadingDescription' => $oConfig->Get('webmail', 'loading_description', 'petuja.email'),
			'System' => array(
				'version' => APP_VERSION,
				'token' => Utils::GetCsrfToken(),
				'languages' => \SnappyMail\L10n::getLanguages(false),
				'webPath' => \RainLoop\Utils::WebPath(),
				'webVersionPath' => \RainLoop\Utils::WebVersionPath(),
				'webStaticPath' => \RainLoop\Utils::WebStaticPath()
			),
			'allowLanguagesOnLogin' => (bool) $oConfig->Get('login', 'allow_languages_on_login', true)
		);

		if (!$bAdmin) {
			$sProductMetadataPath = APP_VERSION_ROOT_PATH . 'app/petuja-product.json';
			$sProductMetadataJson = \is_readable($sProductMetadataPath)
				? @\file_get_contents($sProductMetadataPath)
				: false;
			$aProductMetadata = \is_string($sProductMetadataJson)
				? \json_decode($sProductMetadataJson, true)
				: null;

			if (\is_array($aProductMetadata)
				&& 'petuja.email' === ($aProductMetadata['product'] ?? null)
				&& \is_string($aProductMetadata['version'] ?? null)
				&& '' !== \trim($aProductMetadata['version'])
				&& \is_string($aProductMetadata['snappymailVersion'] ?? null)
				&& '' !== \trim($aProductMetadata['snappymailVersion'])) {
				$aResult['System']['petujaEmailVersion'] = $aProductMetadata['version'];
				$aResult['System']['petujaEmailSnappyMailVersion'] = $aProductMetadata['snappymailVersion'];
			}
		}

		if ($bAdmin) {
			ActionsAdmin::AdminAppData($this, $aResult);
		} else {
			$oAccount = $this->getAccountFromToken(false);
			if ($oAccount) {
				$aResult = \array_merge(
					$aResult,
					[
						'Auth' => true,
						'accountSignMe' => isset($_COOKIE[self::AUTH_SIGN_ME_TOKEN_KEY]),
						'allowSpellcheck' => $oConfig->Get('defaults', 'allow_spellcheck', false),
						'ViewHTML' => (bool) $oConfig->Get('defaults', 'view_html', true),
						'ViewImages' => $oConfig->Get('defaults', 'view_images', 'ask'),
						'ViewImagesWhitelist' => '',
						'RemoveColors' => (bool) $oConfig->Get('defaults', 'remove_colors', false),
						'AllowStyles' => false,
						'ListInlineAttachments' => false,
						'CollapseBlockquotes' => $oConfig->Get('defaults', 'collapse_blockquotes', true),
						'MaxBlockquotesLevel' => 0,
						'simpleAttachmentsList' => false,
						'listGrouped' => $oConfig->Get('defaults', 'mail_list_grouped', false),
						'MessagesPerPage' => \max(10, \intval($oConfig->Get('webmail', 'messages_per_page', 25)) ?: 25),
						'messageNewWindow' => false,
						'markdown' => false,
						'messageReadAuto' => true, // (bool) $oConfig->Get('webmail', 'message_read_auto', true),
						'MessageReadDelay' => (int) $oConfig->Get('webmail', 'message_read_delay', 2),
						'MsgDefaultAction' => (int) $oConfig->Get('defaults', 'msg_default_action', 1),
						'SoundNotification' => true,
						'NotificationSound' => 'new-mail',
						'DesktopNotifications' => true,
						'Layout' => (int) $oConfig->Get('defaults', 'view_layout', Enumerations\Layout::SIDE_PREVIEW),
						'EditorDefaultType' => \str_replace('Forced', '', $oConfig->Get('defaults', 'view_editor_type', '')),
						'editorWysiwyg' => 'Squire',
						'UseCheckboxesInList' => (bool) $oConfig->Get('defaults', 'view_use_checkboxes', true),
						'showNextMessage' => (bool) $oConfig->Get('defaults', 'view_show_next_message', false),
						'AutoLogout' => (int) $oConfig->Get('defaults', 'autologout', 30),
						'keyPassForget' => 15,
						'AllowDraftAutosave' => (bool) $oConfig->Get('defaults', 'allow_draft_autosave', true),
						'ContactsAutosave' => (bool) $oConfig->Get('defaults', 'contacts_autosave', true)
					],
					// MainAccount or AdditionalAccount
					$this->getAccountData($oAccount)
				);

				$aAttachmentsActions = array();
				if ($this->GetCapa(Capa::ATTACHMENTS_ACTIONS)) {
					if (\class_exists('PharData') || \class_exists('ZipArchive')) {
						$aAttachmentsActions[] = 'zip';
					}
				}
				$aResult['System'] = \array_merge(
					$aResult['System'], array(
						'allowAppendMessage' => (bool)$oConfig->Get('labs', 'allow_message_append', false),
						'folderSpecLimit' => (int)$oConfig->Get('labs', 'folders_spec_limit', 50),
						'listPermanentFiltered' => '' !== \trim($oConfig->Get('imap', 'message_list_permanent_filter', '')),
						'attachmentsActions' => $aAttachmentsActions,
						'customLogoutLink' => $oConfig->Get('labs', 'custom_logout_link', ''),
					)
				);

				if ($aResult['contactsAllowed'] && $oConfig->Get('contacts', 'allow_sync', false)) {
					$aData = $this->getContactsSyncData($oAccount) ?: [
						'Mode' => 0,
						'Url' => '',
						'User' => ''
					];
					$aData['Password'] = empty($aData['Password']) ? '' : static::APP_DUMMY;
					$aData['Interval'] = \max(20, \min(320, (int) $oConfig->Get('contacts', 'sync_interval', 20)));
					unset($aData['PasswordHMAC']);
					$aResult['ContactsSync'] = $aData;
				}

				$sToken = \SnappyMail\Cookies::get(self::AUTH_MAILTO_TOKEN_KEY);
				if (null !== $sToken) {
					\SnappyMail\Cookies::clear(self::AUTH_MAILTO_TOKEN_KEY);

					$mMailToData = Utils::DecodeKeyValuesQ($sToken);
					if (!empty($mMailToData['MailTo']) && 'MailTo' === $mMailToData['MailTo'] && !empty($mMailToData['To'])) {
						$aResult['mailToEmail'] = \SnappyMail\IDN::emailToUtf8($mMailToData['To']);
					}
				}

				// MainAccount
				$oSettings = $this->SettingsProvider()->Load($oAccount);
				if ($oSettings instanceof Settings) {
/*
					foreach ($oSettings->toArray() as $key => $value) {
						$aResult[\lcfirst($key)] = $value;
					}
*/
					$aResult['hourCycle'] = $oSettings->GetConf('hourCycle', '');
					$aResult['Appearance'] = $this->ResolveAppearancePreference($oSettings, $oAccount);

					if (!$oSettings->GetConf('MessagesPerPage')) {
						$oSettings->SetConf('MessagesPerPage', $oSettings->GetConf('MPP', $aResult['MessagesPerPage']));
					}

					$aResult['EditorDefaultType'] = \str_replace('Forced', '', $oSettings->GetConf('EditorDefaultType', $aResult['EditorDefaultType']));
					$aResult['editorWysiwyg'] = $oSettings->GetConf('editorWysiwyg', $aResult['editorWysiwyg']);
					$aResult['requestReadReceipt'] = (bool) $oSettings->GetConf('requestReadReceipt', false);
					$aResult['requestDsn'] = (bool) $oSettings->GetConf('requestDsn', false);
					$aResult['requireTLS'] = (bool) $oSettings->GetConf('requireTLS', false);
					$aResult['pgpSign'] = (bool) $oSettings->GetConf('pgpSign', false);
					$aResult['pgpEncrypt'] = (bool) $oSettings->GetConf('pgpEncrypt', false);
					$aResult['allowSpellcheck'] = (bool) $oSettings->GetConf('allowSpellcheck', $aResult['allowSpellcheck']);
//					$aResult['allowCtrlEnterOnCompose'] = (bool) $oSettings->GetConf('allowCtrlEnterOnCompose', true);

					$aResult['ViewHTML'] = (bool)$oSettings->GetConf('ViewHTML', $aResult['ViewHTML']);
					$show_images = (bool) $oSettings->GetConf('ShowImages', false);
					$aResult['ViewImages'] = $oSettings->GetConf('ViewImages', $show_images ? 'always' : $aResult['ViewImages']);
					$aResult['ViewImagesWhitelist'] = $oSettings->GetConf('ViewImagesWhitelist', '');
					$aResult['RemoveColors'] = (bool)$oSettings->GetConf('RemoveColors', $aResult['RemoveColors']);
					$aResult['AllowStyles'] = (bool)$oSettings->GetConf('AllowStyles', $aResult['AllowStyles']);
					$aResult['ListInlineAttachments'] = (bool)$oSettings->GetConf('ListInlineAttachments', $aResult['ListInlineAttachments']);
					$aResult['CollapseBlockquotes'] = (bool)$oSettings->GetConf('CollapseBlockquotes', $aResult['CollapseBlockquotes']);
					$aResult['MaxBlockquotesLevel'] = (int)$oSettings->GetConf('MaxBlockquotesLevel', $aResult['MaxBlockquotesLevel']);
					$aResult['simpleAttachmentsList'] = (bool)$oSettings->GetConf('simpleAttachmentsList', $aResult['simpleAttachmentsList']);
					$aResult['listGrouped'] = (bool)$oSettings->GetConf('listGrouped', $aResult['listGrouped']);
					$aResult['ContactsAutosave'] = (bool)$oSettings->GetConf('ContactsAutosave', $aResult['ContactsAutosave']);
					$aResult['MessagesPerPage'] = \max(10, \intval($oSettings->GetConf('MessagesPerPage', $aResult['MessagesPerPage']) ?: $aResult['MessagesPerPage']));
					$aResult['messageNewWindow'] = (bool)$oSettings->GetConf('messageNewWindow', $aResult['messageNewWindow']);
					$aResult['markdown'] = (bool)$oSettings->GetConf('markdown', $aResult['markdown']);
					$aResult['messageReadAuto'] = (int)$oSettings->GetConf('messageReadAuto', $aResult['messageReadAuto']);
					$aResult['MessageReadDelay'] = (int)$oSettings->GetConf('MessageReadDelay', $aResult['MessageReadDelay']);
					$aResult['MsgDefaultAction'] = (int)$oSettings->GetConf('MsgDefaultAction', $aResult['MsgDefaultAction']);
					$aResult['SoundNotification'] = (bool)$oSettings->GetConf('SoundNotification', $aResult['SoundNotification']);
					$aResult['NotificationSound'] = (string)$oSettings->GetConf('NotificationSound', $aResult['NotificationSound']);
					$aResult['DesktopNotifications'] = (bool)$oSettings->GetConf('DesktopNotifications', $aResult['DesktopNotifications']);
					$aResult['UseCheckboxesInList'] = (bool)$oSettings->GetConf('UseCheckboxesInList', $aResult['UseCheckboxesInList']);
					$aResult['showNextMessage'] = (bool)$oSettings->GetConf('showNextMessage', $aResult['showNextMessage']);
					$aResult['AllowDraftAutosave'] = (bool)$oSettings->GetConf('AllowDraftAutosave', $aResult['AllowDraftAutosave']);
					$aResult['AutoLogout'] = (int)$oSettings->GetConf('AutoLogout', $aResult['AutoLogout']);
					$aResult['keyPassForget'] = (int)$oSettings->GetConf('keyPassForget', $aResult['keyPassForget']);
					$aResult['Layout'] = (int)$oSettings->GetConf('Layout', $aResult['Layout']);
					$aResult['Resizer4Width'] = (int)$oSettings->GetConf('Resizer4Width', 0);
					$aResult['Resizer5Width'] = (int)$oSettings->GetConf('Resizer5Width', 0);
					$aResult['Resizer5Height'] = (int)$oSettings->GetConf('Resizer5Height', 0);

				}

				$aResult['newMailSounds'] = [];
				foreach (\glob(Utils::StaticFilePath('sounds/*.mp3')) as $file) {
					$aResult['newMailSounds'][] = \basename($file, '.mp3');
				}
//				foreach (\glob(APP_INDEX_ROOT_PATH.'notifications/*.mp3') as $file) {
//					$aResult['newMailSounds'][] = 'custom@'.\basename($file, '.mp3');
//				}
			}
			else {
				if (SNAPPYMAIL_DEV) {
					$aResult['DevEmail'] = $oConfig->Get('labs', 'dev_email', '');
					$aResult['DevPassword'] = '';
				} else {
					$aResult['DevEmail'] = '';
					$aResult['DevPassword'] = '';
				}

				$aResult['signMe'] = [
					SignMeType::DefaultOff => 0,
					SignMeType::DefaultOn => 1,
					SignMeType::Unused => 2
				][(string) $oConfig->Get('login', 'sign_me_auto', SignMeType::DefaultOff)];
			}
		}

		if ($aResult['Auth']) {
			$aResult['proxyExternalImages'] = (bool)$oConfig->Get('labs', 'use_local_proxy_for_external_images', false);
			$aResult['autoVerifySignatures'] = (bool)$oConfig->Get('security', 'auto_verify_signatures', false);
			$aResult['allowLanguagesOnSettings'] = (bool) $oConfig->Get('webmail', 'allow_languages_on_settings', true);
			$aResult['minRefreshInterval'] = (int) $oConfig->Get('webmail', 'min_refresh_interval', 5);
			$aResult['Capa'] = $this->Capa($bAdmin, $oAccount);
			$value = \ini_get('upload_max_filesize');
			$upload_max_filesize = \intval($value);
			switch (\strtoupper(\substr($value, -1))) {
				case 'G': $upload_max_filesize *= 1024;
				case 'M': $upload_max_filesize *= 1024;
				case 'K': $upload_max_filesize *= 1024;
			}
			$aResult['attachmentLimit'] = \min($upload_max_filesize, ((int) $oConfig->Get('webmail', 'attachment_size_limit', 10)) * 1024 * 1024);
			$aResult['phpUploadSizes'] = array(
				'upload_max_filesize' => $value,
				'post_max_size' => \ini_get('post_max_size')
			);
		}

		$aResult['language'] = $this->GetLanguage();
		$aResult['clientLanguage'] = $this->ValidateLanguage($this->detectClientLanguage($bAdmin), '', false, true);

		$bAppJsDebug = $this->oConfig->Get('debug', 'javascript', false)
			|| $this->oConfig->Get('debug', 'enable', false);

		$aResult['StaticLibsJs'] = Utils::WebStaticPath('js/' . ($bAppJsDebug ? '' : 'min/') .
			'libs' . ($bAppJsDebug ? '' : '.min') . '.js');

		$aResult = $this->ApplyTwoFactorAppData($bAdmin, $aResult);

		return $aResult;
	}

	public static function IsAppearancePreference($mValue): bool
	{
		return \is_string($mValue) && \in_array($mValue, self::APPEARANCE_PREFERENCES, true);
	}

	public function GetBootstrapAppearancePreference(bool $bAdmin): string
	{
		if ($bAdmin) {
			return '';
		}

		$oAccount = $this->getAccountFromToken(false);
		if (!$oAccount) {
			return '';
		}

		$aAuth = $this->ApplyTwoFactorAppData(false, ['Auth' => true]);
		if (empty($aAuth['Auth']) || !empty($aAuth['SetupTwoFactor'])) {
			return '';
		}

		$oSettings = $this->SettingsProvider()->Load($oAccount);
		return $oSettings instanceof Settings ? $this->ResolveAppearancePreference($oSettings, $oAccount) : '';
	}

	private function ResolveAppearancePreference(Settings $oSettings, $oAccount): string
	{
		$mAppearance = $oSettings->GetConf('Appearance');
		if (self::IsAppearancePreference($mAppearance)) {
			return $mAppearance;
		}

		$oSettingsLocal = $oAccount ? $this->SettingsProvider(true)->Load($oAccount) : null;
		$aSettingsLocal = $oSettingsLocal instanceof Settings ? $oSettingsLocal->toArray() : [];
		if (\array_key_exists('Theme', $aSettingsLocal) && '' !== $aSettingsLocal['Theme']) {
			$sTheme = $aSettingsLocal['Theme'];
			return \is_string($sTheme) ? (self::LEGACY_THEME_APPEARANCE[$sTheme] ?? 'light') : 'light';
		}

		// Before native Appearance, accounts without a local Theme inherited this site default.
		$sTheme = $this->Config()->Get('webmail', 'theme', 'Default');
		return \is_string($sTheme) ? (self::LEGACY_THEME_APPEARANCE[$sTheme] ?? 'light') : 'light';
	}

	protected function loginErrorDelay(): void
	{
		$iDelay = (int) $this->oConfig->Get('login', 'fault_delay', 0);
		if (0 < $iDelay) {
			$seconds = $iDelay - (\microtime(true) - $_SERVER['REQUEST_TIME_FLOAT']);
			if (0 < $seconds) {
				\usleep(\intval($seconds * 1000000));
			}
		}
	}

	public function DoPing(): array
	{
		return $this->DefaultResponse('Pong');
	}

	public function DoVersion(): array
	{
		return $this->DefaultResponse(APP_VERSION === (string)$this->GetActionParam('version', ''));
	}

	public function Upload(?array $aFile, int $iError): array
	{
		$oAccount = $this->getAccountFromToken();

		$aResponse = array();

		if ($oAccount && UPLOAD_ERR_OK === $iError && \is_array($aFile)) {
			$sSavedName = 'upload-post-' . \md5($aFile['name'] . $aFile['tmp_name']);

			// Detect content-type
			$type = \SnappyMail\File\MimeType::fromFile($aFile['tmp_name'], $aFile['name'])
				?: \SnappyMail\File\MimeType::fromFilename($aFile['name']);
			if ($type) {
				$aFile['type'] = $type;
				$sSavedName .= \SnappyMail\File\MimeType::toExtension($type);
			}

			if (!$this->FilesProvider()->MoveUploadedFile($oAccount, $sSavedName, $aFile['tmp_name'])) {
				$iError = Enumerations\UploadError::ON_SAVING;
			} else {
				$aResponse['Attachment'] = array(
					'name' => $aFile['name'],
					'tempName' => $sSavedName,
					'mimeType' => $aFile['type'],
					'size' => (int) $aFile['size']
				);
			}
		}

		if (UPLOAD_ERR_OK !== $iError) {
			$iClientError = 0;
			$sError = Enumerations\UploadError::getUserMessage($iError, $iClientError);

			if (!empty($sError)) {
				$aResponse['code'] = $iClientError;
				$aResponse['Error'] = $sError;
			}
		}

		return $this->DefaultResponse($aResponse);
	}

	public function Capa(bool $bAdmin, ?Model\Account $oAccount = null): array
	{
		static $aResult;
		if (!$aResult) {
			$oConfig = $this->oConfig;
			$aResult = array(
				Capa::ADDITIONAL_ACCOUNTS   => (bool) $oConfig->Get('webmail', 'allow_additional_accounts', false),
				Capa::ATTACHMENT_THUMBNAILS => (bool) $oConfig->Get('interface', 'show_attachment_thumbnail', true)
					&& ($bAdmin
						|| \extension_loaded('gd')
					),
				Capa::ATTACHMENTS_ACTIONS => (bool) $oConfig->Get('capa', 'attachments_actions', false),
				Capa::CONTACTS            => (bool) $oConfig->Get('contacts', 'enable', false),
				Capa::DANGEROUS_ACTIONS   => (bool) $oConfig->Get('capa', 'dangerous_actions', true),
				Capa::GNUPG               => (bool) $oConfig->Get('security', 'gnupg', true) && \SnappyMail\PGP\GnuPG::isSupported(),
				Capa::IDENTITIES          => (bool) $oConfig->Get('webmail', 'allow_additional_identities', false),
				Capa::OPENPGP             => (bool) $oConfig->Get('security', 'openpgp', true),
				Capa::SIEVE               => false,
				'Kolab'                   => false,
			);
		}
		$aResult[Capa::SIEVE] = $bAdmin || ($oAccount && $oAccount->Domain()->SieveSettings()->enabled);
		return $aResult;
	}

	public function GetCapa(string $sName, ?Model\Account $oAccount = null): bool
	{
		return !empty($this->Capa(false, $oAccount)[$sName]);
	}

	public function etag(string $sKey): string
	{
//		if ($sKey && $this->oConfig->Get('cache', 'enable', true) && $this->oConfig->Get('cache', 'http', true)) {
		return \md5($sKey . $this->oConfig->Get('cache', 'index', '') . APP_VERSION);
	}

	public function cacheByKey(string $sKey): bool
	{
		if ($sKey && $this->oConfig->Get('cache', 'enable', true) && $this->oConfig->Get('cache', 'http', true)) {
			\MailSo\Base\Http::ServerUseCache(
				$this->etag($sKey),
				0, // issue with messages
				$this->oConfig->Get('cache', 'http_expires', 3600)
			);
			return true;
		}
		$this->Http()->ServerNoCache();
		return false;
	}

	public function verifyCacheByKey(string $sKey): void
	{
		if ($sKey && $this->oConfig->Get('cache', 'enable', true) && $this->oConfig->Get('cache', 'http', true)) {
			\MailSo\Base\Http::checkETag($this->etag($sKey));
//			\MailSo\Base\Http::checkLastModified(0);
		}
	}

	/**
	 * @throws \RainLoop\Exceptions\ClientException
	 */
	protected function initMailClientConnection(): ?Model\Account
	{
		$oAccount = $this->getAccountFromToken();

		if ($oAccount && !$this->ImapClient()->IsLoggined()) {
			try {
				$oAccount->ImapConnectAndLogin($this->ImapClient(), $this->oConfig);
			} catch (\MailSo\Net\Exceptions\ConnectionException $oException) {
				throw new Exceptions\ClientException(Notifications::ConnectionError, $oException);
			} catch (\Throwable $oException) {
				throw new Exceptions\ClientException(Notifications::AuthError, $oException);
			}
		}

		return $oAccount;
	}

	public function encodeRawKey(array $aValues): string
	{
		$aValues['accountHash'] = $this->getAccountFromToken()->Hash();
		return \MailSo\Base\Utils::UrlSafeBase64Encode(\json_encode($aValues));
	}

	public function decodeRawKey(string $sRawKey): array
	{
		return empty($sRawKey) ? []
			: (\json_decode(\MailSo\Base\Utils::UrlSafeBase64Decode($sRawKey), true) ?: []);
/*
		if (empty($aValues['accountHash']) || $aValues['accountHash'] !== $oAccount->Hash()) {
			return [];
		}
*/
	}

	public function SetActionParams(array $aCurrentActionParams, string $sMethodName = ''): self
	{
		$this->aCurrentActionParams = $aCurrentActionParams;

		return $this;
	}

	/**
	 * @param mixed $mDefault = null
	 *
	 * @return mixed
	 */
	public function GetActionParam(string $sKey, $mDefault = null)
	{
		return isset($this->aCurrentActionParams[$sKey]) ?
			$this->aCurrentActionParams[$sKey] : $mDefault;
	}

	public function GetActionParams(): array
	{
		return $this->aCurrentActionParams;
	}

	public function HasActionParam(string $sKey): bool
	{
		return isset($this->aCurrentActionParams[$sKey]);
	}

	public function Location(string $sUrl, int $iStatus = 302): void
	{
		$this->logWrite("{$iStatus} Location: {$sUrl}");
		\MailSo\Base\Http::Location($sUrl, $iStatus);
	}

}
