<?php

namespace RainLoop\Config;

class Application extends \RainLoop\Config\AbstractConfig
{
	private ?array $aReplaceEnv = null;

	private const TWO_FACTOR_POLICY_MIGRATION_VERSION = 1;

	public function __construct()
	{
		parent::__construct('application.ini',
			'; SnappyMail configuration file
; Please don\'t add custom parameters here, those will be overwritten',
			APP_CONFIGURATION_NAME);
	}

	public function Load() : bool
	{
		$aPersistedConfig = $this->readPersistedConfig();
		$bResult = parent::Load();
		$aLegacyPlugins = \is_array($aPersistedConfig['plugins'] ?? null) ? $aPersistedConfig['plugins'] : [];
		foreach (array('enable', 'enabled_list') as $sKey) {
			if (\array_key_exists($sKey, $aLegacyPlugins)) {
				$this->PreserveForSave('plugins', $sKey, $aLegacyPlugins[$sKey]);
			}
		}
		$this->migrateTwoFactorPolicy($aPersistedConfig);

		$max = \floatval($this->Get('security', 'max_sys_getloadavg', 0));
		if ($max && \is_callable('sys_getloadavg')) {
			$load = \sys_getloadavg();
			if ($load && $load[0] > $max) {
				\header('HTTP/1.1 503 Service Unavailable', true, 503);
				\header('Retry-After: 120');
				exit("Mailserver too busy ({$load[0]}). Please try again later.");
			}
		}

		$this->aReplaceEnv = null;
		if ((isset($_ENV) && \is_array($_ENV) && \count($_ENV)) ||
			(isset($_SERVER) && \is_array($_SERVER) && \count($_SERVER)))
		{
			$sEnvNames = $this->Get('labs', 'replace_env_in_configuration', '');
			if (\strlen($sEnvNames)) {
				$this->aReplaceEnv = \explode(',', $sEnvNames);
				if (\is_array($this->aReplaceEnv)) {
					$this->aReplaceEnv = \array_map('trim', $this->aReplaceEnv);
					$this->aReplaceEnv = \array_map('strtolower', $this->aReplaceEnv);
				}
			}
		}

		if (!\is_array($this->aReplaceEnv) || !\count($this->aReplaceEnv)) {
			$this->aReplaceEnv = null;
		}

		$sCipher = $this->Get('security', 'encrypt_cipher', '');
		if (!$sCipher || !\SnappyMail\Crypt::cipherSupported($sCipher)) {
			$sCipher && \SnappyMail\Log::warning('Crypt', "OpenSSL no support for cipher '{$sCipher}'");
			$aCiphers = \SnappyMail\Crypt::listCiphers();
			$sCipher2 = $aCiphers ? $aCiphers[\array_rand($aCiphers)] : '';
			if ($sCipher !== $sCipher2) {
				$this->Set('security', 'encrypt_cipher', $sCipher2);
				$this->Save();
			}
		}

		if (!\in_array($this->Get('logs', 'time_zone', ''), \DateTimeZone::listIdentifiers())) {
			$this->Set('logs', 'time_zone', 'UTC');
		}

		return $bResult;
	}

	/**
	 * Return the pre-load application values so a first-run Save() cannot make
	 * default values look like an operator's explicit configuration.
	 */
	private function readPersistedConfig() : ?array
	{
		$aResult = [];
		$aFiles = [APP_PRIVATE_DATA.'configs/application.ini'];
		if (defined('APP_CONFIGURATION_NAME') && APP_CONFIGURATION_NAME) {
			$aFiles[] = APP_PRIVATE_DATA.'configs/'.APP_CONFIGURATION_NAME;
		}

		foreach (\array_unique($aFiles) as $sFile) {
			if (!\file_exists($sFile)) {
				continue;
			}
			if (!\is_readable($sFile)) {
				return null;
			}

			$sContents = @\file_get_contents($sFile);
			if (!\is_string($sContents)) {
				return null;
			}
			$aData = \str_ends_with($sFile, '.json')
				? \json_decode($sContents, true)
				: @\parse_ini_file($sFile, true, INI_SCANNER_TYPED);
			if (!\is_array($aData)) {
				return null;
			}
			$aResult = \array_replace_recursive($aResult, $aData);
		}

		return $aResult;
	}

	private function migrateTwoFactorPolicy(?array $aPersistedConfig) : void
	{
		$aVersion = \is_array($aPersistedConfig['version'] ?? null) ? $aPersistedConfig['version'] : [];
		$aSecurity = \is_array($aPersistedConfig['security'] ?? null) ? $aPersistedConfig['security'] : [];
		$bMalformedConfigSection = \is_array($aPersistedConfig)
			&& ((\array_key_exists('version', $aPersistedConfig) && !\is_array($aPersistedConfig['version']))
				|| (\array_key_exists('security', $aPersistedConfig) && !\is_array($aPersistedConfig['security'])));
		$bHasMarker = \is_array($aPersistedConfig)
			&& \array_key_exists('two_factor_policy_migration', $aVersion);
		$mMarker = $bHasMarker ? $aVersion['two_factor_policy_migration'] : null;
		$iMarker = $bHasMarker
			? \filter_var($mMarker, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]])
			: null;
		$iMarkerToWrite = self::TWO_FACTOR_POLICY_MIGRATION_VERSION;
		$bMalformedMarkedNativeValue = false;

		// Once a valid migration marker and native value exist, normal requests
		// must not rewrite application.ini. Preserve a newer marker if this code
		// is ever run against a configuration written by a later release.
		if (false !== $iMarker && null !== $iMarker && self::TWO_FACTOR_POLICY_MIGRATION_VERSION <= $iMarker) {
			$mNativeValue = $aSecurity['require_two_factor_auth'] ?? null;
			$bRequired = self::parseBoolean($mNativeValue);
			if (null !== $bRequired) {
				$this->Set('security', 'require_two_factor_auth', $bRequired);
				return;
			}
			$iMarkerToWrite = $iMarker;
			$bMalformedMarkedNativeValue = true;
		}

		if (null === $aPersistedConfig) {
			$bRequired = true;
		} else if ($bMalformedConfigSection) {
			$bRequired = true;
		} else if ($bMalformedMarkedNativeValue) {
			$bRequired = true;
		} else if ($bHasMarker && (false === $iMarker || null === $iMarker)) {
			$bRequired = true;
		} else if ($bHasMarker) {
			$bRequired = $this->legacyTwoFactorPolicy();
		} else if (\array_key_exists('require_two_factor_auth', $aSecurity)) {
			$bRequired = self::parseBoolean($aSecurity['require_two_factor_auth']) ?? true;
		} else {
			$bRequired = $this->legacyTwoFactorPolicy();
		}

		$this->Set('security', 'require_two_factor_auth', $bRequired);
		$this->Set('version', 'two_factor_policy_migration', $iMarkerToWrite);
		if (!$this->Save()) {
			\SnappyMail\Log::warning('CONFIG', 'Unable to persist native two-factor policy migration');
		}
	}

	private function legacyTwoFactorPolicy() : bool
	{
		$sJsonFile = APP_PRIVATE_DATA.'configs/plugin-two-factor-auth.json';
		$sFile = \file_exists($sJsonFile)
			? $sJsonFile
			: APP_PRIVATE_DATA.'configs/plugin-two-factor-auth.ini';
		if (!\file_exists($sFile)) {
			return false;
		}
		if (!\is_readable($sFile)) {
			\SnappyMail\Log::warning('CONFIG', 'Unreadable legacy two-factor policy; forcing policy on');
			return true;
		}

		$sContents = @\file_get_contents($sFile);
		$aData = \is_string($sContents)
			? (\str_ends_with($sFile, '.json')
				? \json_decode($sContents, true)
				: @\parse_ini_file($sFile, true, INI_SCANNER_TYPED))
			: null;
		if (!\is_array($aData)) {
			\SnappyMail\Log::warning('CONFIG', 'Malformed legacy two-factor policy; forcing policy on');
			return true;
		}
		if (!\array_key_exists('plugin', $aData)) {
			return false;
		}
		if (!\is_array($aData['plugin'])) {
			\SnappyMail\Log::warning('CONFIG', 'Malformed legacy two-factor policy; forcing policy on');
			return true;
		}
		if (!\array_key_exists('force_two_factor_auth', $aData['plugin'])) {
			return false;
		}

		$bRequired = self::parseBoolean($aData['plugin']['force_two_factor_auth']);
		if (null === $bRequired) {
			\SnappyMail\Log::warning('CONFIG', 'Malformed legacy two-factor policy; forcing policy on');
			return true;
		}

		return $bRequired;
	}

	public static function parseBoolean($mValue) : ?bool
	{
		if (\is_bool($mValue)) {
			return $mValue;
		}
		if (\is_int($mValue) && (0 === $mValue || 1 === $mValue)) {
			return 1 === $mValue;
		}
		if (\is_string($mValue)) {
			switch (\strtolower(\trim($mValue))) {
				case '1':
				case 'true':
				case 'on':
					return true;
				case '0':
				case 'false':
				case 'off':
					return false;
			}
		}
		return null;
	}

	public function SetTwoFactorRequired(bool $bRequired) : void
	{
		$this->Set('security', 'require_two_factor_auth', $bRequired);
		$this->Set('version', 'two_factor_policy_migration', self::TWO_FACTOR_POLICY_MIGRATION_VERSION);
	}

	/**
	 * @param mixed $mDefault = null
	 *
	 * @return mixed
	 */
	public function Get(string $sSection, string $sName, $mDefault = null)
	{
		$mResult = parent::Get($sSection, $sName, $mDefault);
		if ($this->aReplaceEnv && \is_string($mResult)) {
			$sKey = \strtolower($sSection.'.'.$sName);
			if (\in_array($sKey, $this->aReplaceEnv) && false !== strpos($mResult, '$')) {
				$mResult = \preg_replace_callback('/\$([^\s]+)/', function($aMatch) {
					if (!empty($aMatch[0]) && !empty($aMatch[1])) {
						if (!empty($_ENV[$aMatch[1]])) {
							return $_ENV[$aMatch[1]];
						}
						if (!empty($_SERVER[$aMatch[1]])) {
							return $_SERVER[$aMatch[1]];
						}
						return $aMatch[0];
					}
					return '';
				}, $mResult);
			}
		}
		return $mResult;
	}

	public function Set(string $sSectionKey, string $sParamKey, $mParamValue) : void
	{
		// Workarounds for the changed application structure
		if ('webmail' === $sSectionKey) {
			if ('language_admin' === $sParamKey) {
				$sSectionKey = 'admin_panel';
				$sParamKey = 'language';
			}
		}
		if ('security' === $sSectionKey) {
			if (\str_starts_with($sParamKey, 'admin_panel_')) {
				$sSectionKey = 'admin_panel';
				$sParamKey = \str_replace('admin_panel_', '', $sParamKey);
			}
		}
		if ('labs' === $sSectionKey) {
			if (\str_starts_with($sParamKey, 'imap_')) {
				$sSectionKey = 'imap';
				$sParamKey = \str_replace('imap_', '', $sParamKey);
			}
			if (\str_starts_with($sParamKey, 'use_app_debug_')) {
				$sSectionKey = 'debug';
				$sParamKey = \str_replace('use_app_debug_js', 'javascript', $sParamKey);
				$sParamKey = \str_replace('use_app_debug_css', 'css', $sParamKey);
			}
			if ('cache_system_data' === $sParamKey) {
				$sSectionKey = 'cache';
				$sParamKey = 'system_data';
			}
			if ('force_https' === $sParamKey) {
				$sSectionKey = 'security';
			}
			if ('check_new_messages' === $sParamKey) {
				$sSectionKey = 'imap';
				$sParamKey = 'fetch_new_messages';
			}
			if ('login_fault_delay' === $sParamKey) {
				$sSectionKey = 'login';
				$sParamKey = 'fault_delay';
			}
			if ('log_ajax_response_write_limit' === $sParamKey) {
				$sSectionKey = 'logs';
				$sParamKey = 'json_response_write_limit';
			}
		}
		if ('language' === $sParamKey) {
			$mParamValue = \SnappyMail\L10n::validLanguage($mParamValue, 'admin_panel' === $sSectionKey) ?: 'en';
		}
		parent::Set($sSectionKey, $sParamKey, $mParamValue);
	}

	public function SetPassword(\SnappyMail\SensitiveString $oPassword) : void
	{
		$this->Set('security', 'admin_password', \password_hash($oPassword, PASSWORD_DEFAULT));
	}

	public function ValidatePassword(\SnappyMail\SensitiveString $oPassword) : bool
	{
		return \strlen($oPassword) && \password_verify($oPassword, $this->Get('security', 'admin_password', ''));
	}

	public function Save() : bool
	{
		$this->Set('version', 'current', APP_VERSION);
		$this->Set('version', 'saved', \gmdate('r'));

		return parent::Save();
	}

	protected function defaultValues() : array
	{
		$value = \ini_get('upload_max_filesize');
		$upload_max_filesize = \intval($value);
		switch (\strtoupper(\substr($value, -1))) {
			case 'G': $upload_max_filesize *= 1024;
			case 'M': $upload_max_filesize *= 1024;
			case 'K': $upload_max_filesize *= 1024;
		}
		$upload_max_filesize = $upload_max_filesize / 1024 / 1024;

		return array(

			'webmail' => array(

				'title'                       => array('petuja.email', 'Text displayed as page title'),
				'loading_description'         => array('petuja.email', 'Text displayed on startup'),
				'favicon_url'                 => array(''),
				'app_path'                    => array(''),
				'theme'                       => array('Default', 'Legacy default used only to seed native Appearance'),

				'language'                    => array('en', 'Language used by default'),
				'allow_languages_on_settings' => array(true, 'Allow language selection on settings screen'),

				'allow_additional_accounts'   => array(true),
				'allow_additional_identities' => array(true),
				'popup_identity' => array(true, 'When identity is not set yet, open identity popup after login'),

				'messages_per_page'           => array(20, 'Number of messages displayed on page by default'),
				'message_read_delay'          => array(2, 'Mark message read after N seconds'),

				'min_refresh_interval'        => array(5, 'Minimal check for new messages interval in minutes'),

				'attachment_size_limit'       => array(\min($upload_max_filesize, 25), 'File size limit (MB) for file upload on compose screen
0 for unlimited.'),

				'compress_output' => array(false, 'brotli or gzip compress the output.
Warning: only enable when server does not do this, else double compression errors occur')
			),

			'interface' => array(
				'show_attachment_thumbnail' => array(true)
			),

			'contacts' => array(
				'enable'            => array(false, 'Enable contacts'),
				'allow_sync'        => array(false),
				'dav_allowed_origins' => array('', 'Comma-separated exact HTTP(S) CardDAV origins approved by the operator; empty disables sync destinations'),
				'sync_interval'     => array(20),
				'type'              => array('sqlite'),
				'pdo_dsn'           => array('host=127.0.0.1;port=3306;dbname=snappymail'),
				'pdo_user'          => array('root'),
				'pdo_password'      => array(''),
				'mysql_ssl_ca'      => array('', 'PEM format certificate'),
				'mysql_ssl_verify'  => array(true),
				'mysql_ssl_ciphers' => array('', 'HIGH'),
				'sqlite_global'     => array(\is_file(APP_PRIVATE_DATA . '/AddressBook.sqlite')),
				'suggestions_limit' => array(20)
			),

			'security' => array(
				'custom_server_signature' => array('SnappyMail'),
				'x_xss_protection_header' => array('1; mode=block'),
				'require_two_factor_auth' => array(false, 'Require users to enroll in and verify two-step authentication'),

				'gnupg'                   => array(true),
				'openpgp'                 => array(true),
				'auto_verify_signatures'  => array(false),

				'allow_admin_panel'       => array(true, 'Access settings'),
				'admin_login'             => array('admin', 'Login and password for web admin panel'),
				'admin_password'          => array(''),
				'admin_totp'              => array(''),
				'insecure_cryptkey'       => array(false, 'Use email address instead of login password for encrypting sensitive data (like account passwords)'),

				'force_https'             => array(false),
				'hide_x_mailer_header'    => array(true),
				'max_sys_getloadavg'      => array(0.0, 'https://en.m.wikipedia.org/wiki/Load_(computing)'),
				'content_security_policy' => array('', 'For example to allow all images use "img-src https:". More info at https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy#directives'),
				'csp_report'              => array(false, 'Report CSP errors to PHP and/or SnappyMail Log'),
				'encrypt_cipher'          => array('aes-256-cbc-hmac-sha1', 'A valid cipher method from https://php.net/openssl_get_cipher_methods'),
				'cookie_samesite'         => array('Strict', 'Strict, Lax or None'),
				'secfetch_allow'          => array('', 'Additional allowed Sec-Fetch combinations separated by ";".
For example:
* Allow iframe on same domain in any mode: dest=iframe,site=same-origin
* Allow navigate to iframe on same domain: mode=navigate,dest=iframe,site=same-origin
* Allow navigate to iframe on (sub)domain: mode=navigate,dest=iframe,site=same-site
* Allow navigate to iframe from any domain: mode=navigate,dest=iframe,site=cross-site

Default is "site=same-origin;site=none"')
			),

			'admin_panel' => array(
/*
				'enabled'  => array(true, 'Access settings'),
				'login'    => array('admin', 'Login and password for web admin panel'),
				'password' => array(''),
				'totp'     => array(''),
*/
				'host'     => array(''),
				'key'      => array('admin'),
				'allow_update' => array(false),
				'language'     => array('en', 'Admin Panel interface language'),
			),

			'ssl' => array(
				'security_level'      => array(1, 'https://www.openssl.org/docs/man1.1.1/man3/SSL_CTX_set_security_level.html'),
				'cafile'              => array('', 'Location of Certificate Authority file on local filesystem (/etc/ssl/certs/ca-certificates.crt)'),
				'capath'              => array('', 'capath must be a correctly hashed certificate directory. (/etc/ssl/certs/)'),
				'local_cert'          => array('', 'Location of client certificate file (pem format with private key) on local filesystem'),
				'disable_compression' => array(true, 'This can help mitigate the CRIME attack vector.')
			),

			'capa' => array(
				'dangerous_actions' => array(true, 'Allow clear folder and delete messages without moving to trash'),
				'attachments_actions' => array(true, 'Allow download attachments as Zip (and optionally others)')
			),

			'login' => array(

				'default_domain' => array('',
					'If someone logs in without "@domain.tld", this value will be used
When this value is HTTP_HOST, the $_SERVER["HTTP_HOST"] value is used.
When this value is SERVER_NAME, the $_SERVER["SERVER_NAME"] value is used.
When this value is gethostname, the gethostname() value is used.
'),

				'allow_languages_on_login' => array(true,
					'Allow language selection on webmail login screen'),

				'determine_user_language' => array(true, 'Detect language from browser header `Accept-Language`'),
				'determine_user_domain' => array(false, 'Like default_domain but then HTTP_HOST/SERVER_NAME without www.'),

				'sign_me_auto' => array(\RainLoop\Enumerations\SignMeType::DefaultOff,
					'This option allows webmail to remember the logged in user
once they closed the browser window.

Values:
  "DefaultOff" - can be used, disabled by default;
  "DefaultOn"  - can be used, enabled by default;
  "Unused"     - cannot be used'),

				'fault_delay' => array(5, 'When login fails, wait N seconds before responding'),
			),

			'defaults' => array(
				'view_editor_type'       => array('Html', 'Editor mode used by default (Plain, Html)'),
				'view_layout'            => array(1, 'layout: 0 - no preview, 1 - side preview, 2 - bottom preview'),
				'view_use_checkboxes'    => array(true),
				'view_show_next_message' => array(true, 'Show next message when (re)move current message'),
				'autologout'             => array(30),
				'view_html'              => array(true),
				'show_images'            => array(false),
				'view_images'            => array('ask', 'View external images:
  "ask" - always ask
  "match" - whitelist or ask
  "always" - show always'),
				'contacts_autosave'      => array(true),
                'mail_list_grouped'      => array(false),
                'mail_use_threads'       => array(false),
				'allow_draft_autosave'   => array(true),
				'mail_reply_same_folder' => array(false),
				'msg_default_action'     => array(1, '1 - reply, 2 - reply all'),
                'collapse_blockquotes'   => array(true),
                'allow_spellcheck'       => array(false)
			),

			'logs' => array(

				'enable' => array(false, 'Enable logging'),

				'path' => array('', 'Path where log files will be stored'),

				'level' => array(4, 'Log messages of set RFC 5424 section 6.2.1 Severity level and higher (0 = highest, 7 = lowest).
0 = Emergency
1 = Alert
2 = Critical
3 = Error
4 = Warning
5 = Notice
6 = Informational
7 = Debug'),

				'hide_passwords' => array(true, 'Required for development purposes only.
Disabling this option is not recommended.'),

				'time_zone' => array('UTC'),

				'filename' => array('log-{date:Y-m-d}.txt',
					'Log filename.
For security reasons, some characters are removed from filename.
Allows for pattern-based folder creation (see examples below).

Patterns:
  {date:Y-m-d}  - Replaced by pattern-based date
                  Detailed info: http://www.php.net/manual/en/function.date.php
  {user:email}  - Replaced by user\'s email address
                  If user is not logged in, value is set to "unknown"
  {user:login}  - Replaced by user\'s login (the user part of an email)
                  If user is not logged in, value is set to "unknown"
  {user:domain} - Replaced by user\'s domain name (the domain part of an email)
                  If user is not logged in, value is set to "unknown"
  {user:uid}    - Replaced by user\'s UID regardless of account currently used

  {user:ip}
  {request:ip}  - Replaced by user\'s IP address

Others:
  {imap:login} {imap:host} {imap:port}
  {smtp:login} {smtp:host} {smtp:port}

Examples:
  filename = "log-{date:Y-m-d}.txt"
  filename = "{date:Y-m-d}/{user:domain}/{user:email}_{user:uid}.log"
  filename = "{user:email}-{date:Y-m-d}.txt"
  filename = "syslog"
  filename = "stderr"'),

				'auth_logging' => array(false, 'Enable auth logging in a separate file (for fail2ban)'),
				'auth_logging_filename' => array('fail2ban/auth-{date:Y-m-d}.txt'),
				'auth_logging_format' => array('[{date:Y-m-d H:i:s}] Auth failed: ip={request:ip} user={imap:login} host={imap:host} port={imap:port}'),
				'auth_syslog' => array(false, 'Enable auth logging to syslog for fail2ban'),

				'json_response_write_limit' => array(300),
			),

			'debug' => array(
				'enable' => array(false, 'Special option required for development purposes'),
				// use_app_debug_js
				'javascript' => array(false),
				// use_app_debug_css
				'css' => array(false)
			),

			'cache' => array(
				'enable' => array(true,
					'The section controls caching of the entire application.

Enables caching in the system'),

				'path' => array('', 'Path where cache files will be stored'),

				'index' => array('v1', 'Additional caching key. If changed, cache is purged'),

				'fast_cache_index' => array('v1', 'Additional caching key. If changed, fast cache is purged'),

				'http' => array(true, 'Browser-level cache. If enabled, caching is maintainted without using files'),
				'http_expires' => array(3600, 'Browser-level cache time (seconds, Expires header)'),

				'server_uids' => array(true, 'Caching message UIDs when searching and sorting (threading)'),

				'system_data' => array(true)
			),

			'imap' => array(
				'use_force_selection' => array(false),
				'use_expunge_all_on_delete' => array(false),
				'message_list_fast_simple_search' => array(true),
				'message_list_permanent_filter' => array(''),
				'message_all_headers' => array(false),
				'show_login_alert' => array(true),
				'fetch_new_messages' => array(true),
			),

			'labs' => array(
				'allow_message_append' => array(false, 'Allow drag & drop .eml files from system into messages list'),
				'smtp_show_server_errors' => array(false),
				'mail_func_clear_headers' => array(true, 'PHP mail() remove To and Subject headers'),
				'mail_func_additional_parameters' => array(false, 'PHP mail() set -f emailaddress'),
				'folders_spec_limit' => array(50),
				'curl_proxy' => array(''),
				'curl_proxy_auth' => array(''),
				'custom_login_link' => array(''),
				'custom_logout_link' => array(''),
				'use_local_proxy_for_external_images' => array(true),
				'image_exif_auto_rotate' => array(false),
				'cookie_default_path' => array(''),
				'cookie_default_secure' => array(false),
				'replace_env_in_configuration' => array(''),
				'boundary_prefix' => array(''),
				'dev_email' => array(''),
				'dev_password' => array('')
			),

			'version' => array(
				'current' => array(''),
				'saved' => array(''),
				'two_factor_policy_migration' => array(0)
			)
		);
	}
}
