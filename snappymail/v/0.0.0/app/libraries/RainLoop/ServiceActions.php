<?php

namespace RainLoop;

class ServiceActions
{
	protected \MailSo\Base\Http $oHttp;

	protected Actions $oActions;

	protected array $aPaths = array();

	protected string $sQuery = '';

	public function __construct(\MailSo\Base\Http $oHttp, Actions $oActions)
	{
		$this->oHttp = $oHttp;
		$this->oActions = $oActions;
	}

	private function Logger() : \MailSo\Log\Logger
	{
		return $this->oActions->Logger();
	}

	private function Config() : Config\Application
	{
		return $this->oActions->Config();
	}

	private function Cacher() : \MailSo\Cache\CacheClient
	{
		return $this->oActions->Cacher();
	}

	private function StorageProvider() : Providers\Storage
	{
		return $this->oActions->StorageProvider();
	}

	private function SettingsProvider() : Providers\Settings
	{
		return $this->oActions->SettingsProvider();
	}

	public function SetPaths(array $aPaths) : self
	{
		$this->aPaths = $aPaths;
		return $this;
	}

	public function SetQuery(string $sQuery) : self
	{
		$this->sQuery = $sQuery;
		return $this;
	}

/*
	public function ServiceBackup() : void
	{
		if (\method_exists($this->oActions, 'DoAdminBackup')) {
			$this->oActions->DoAdminBackup();
		}
		exit;
	}
*/

	public function ServiceJson() : string
	{
		\ob_start();

		$aResponse = null;
		$oException = null;

		if (empty($_POST) || (!empty($_SERVER['CONTENT_TYPE']) && \str_contains($_SERVER['CONTENT_TYPE'], 'application/json'))) {
			$_POST = \json_decode(\file_get_contents('php://input'), true);
		}

		$sAction = $_POST['Action'] ?? '';
		if (empty($sAction) && $this->oHttp->IsGet() && !empty($this->aPaths[2])) {
			$sAction = $this->aPaths[2];
		}
		$bSensitiveTwoFactorAction = \is_string($sAction) && 0 === \strncasecmp($sAction, 'TwoFactor', 9);

		$this->oActions->SetIsJson(true);

		try
		{
			if (empty($sAction)) {
				throw new Exceptions\ClientException(Notifications::InvalidInputArgument, null, 'Action unknown');
			}
			// Preserve cached mailbox reads; every other JSON action requires POST.
			if (!$this->oHttp->IsPost() && (!$this->oHttp->IsGet() || !\is_string($sAction)
				|| !\in_array(\strtolower($sAction), ['message', 'messagelist'], true))) {
				throw new Exceptions\ClientException(Notifications::AuthError);
			}
			if (!$this->oActions->isTwoFactorJsonActionAllowed(
				$sAction,
				$this->oActions instanceof ActionsAdmin
			)) {
				throw new Exceptions\ClientException(Notifications::AuthError, null, 'Two-factor enrollment is required');
			}

			if ('Logout' !== $sAction) {
				$token = Utils::GetCsrfToken();
				if (isset($_SERVER['HTTP_X_SM_TOKEN'])) {
					if ($_SERVER['HTTP_X_SM_TOKEN'] !== $token) {
						if ($bSensitiveTwoFactorAction) {
							$this->oActions->logWrite('Sensitive two-factor action rejected: CSRF token mismatch', \LOG_ERR, 'Token');
						} else {
							$this->oActions->logWrite('JSON action rejected: CSRF token mismatch', \LOG_ERR, 'Token');
						}
						throw new Exceptions\ClientException(Notifications::InvalidToken, null, 'HTTP Token mismatch');
					}
				} else if ($this->oHttp->IsPost()) {
					if (empty($_POST['XToken']) || $_POST['XToken'] !== $token) {
						if ($bSensitiveTwoFactorAction) {
							$this->oActions->logWrite('Sensitive two-factor action rejected: CSRF token mismatch', \LOG_ERR, 'XToken');
						} else {
							$this->oActions->logWrite('JSON action rejected: CSRF token mismatch', \LOG_ERR, 'XToken');
						}
						throw new Exceptions\ClientException(Notifications::InvalidToken, null, 'XToken mismatch');
					}
				}
			}

			if ($this->oActions instanceof ActionsAdmin && 0 === \stripos($sAction, 'Admin') && !\in_array($sAction, ['AdminLogin', 'AdminLogout'])) {
				$this->oActions->IsAdminLoggined();
			}

			$sMethodName = 'Do'.$sAction;

			$this->oActions->logWrite('Action: '.$sMethodName, \LOG_INFO, 'JSON');

			if ($_POST) {
				$this->oActions->SetActionParams($_POST, $sMethodName);
				if ($bSensitiveTwoFactorAction) {
					$this->oActions->logWrite('[two-factor request body omitted]', \LOG_INFO, 'POST');
				} else {
					$this->oActions->logWrite('[request body omitted]', \LOG_INFO, 'POST');
				}
			} else if (3 < \count($this->aPaths) && $this->oHttp->IsGet()) {
				$this->oActions->SetActionParams(array(
					'RawKey' => empty($this->aPaths[3]) ? '' : $this->aPaths[3]
				), $sMethodName);
			}

			if (\method_exists($this->oActions, $sMethodName) && \is_callable(array($this->oActions, $sMethodName))) {
				$aResponse = $this->oActions->{$sMethodName}();
			}

			if (\is_array($aResponse)) {
				// Everything must converted to array
				$aResponse = \json_decode(Utils::jsonEncode($aResponse), true);
			}

			if (!\is_array($aResponse)) {
				throw new Exceptions\ClientException(Notifications::UnknownError);
			}
		}
		catch (\Throwable $oException)
		{
			if ($bSensitiveTwoFactorAction) {
				\SnappyMail\Log::warning('SERVICE', 'Sensitive two-factor action failed');
			} else {
				\SnappyMail\Log::warning('SERVICE', "{$oException}");
				if ($e = $oException->getPrevious()) {
					\SnappyMail\Log::warning('SERVICE', "- {$e}");
				}
			}

			$aResponse = $this->oActions->ExceptionResponse($oException);
		}

		$aResponse['Action'] = $sAction ?: 'Unknown';

		if (!\headers_sent()) {
			\header('Content-Type: application/json; charset=utf-8');
		}

		if (\is_array($aResponse)) {
			$aResponse['epoch'] = \time();
//			if ($this->Config()->Get('debug', 'enable', false)) {
//				$aResponse['rtime'] = \round(\microtime(true) - $_SERVER['REQUEST_TIME_FLOAT'], 3);
//			}
		}

		$sResult = Utils::jsonEncode($aResponse);

		$sObResult = \ob_get_clean();

		if ($this->Logger()->IsEnabled()) {
			if (\strlen($sObResult)) {
				$this->oActions->logWrite('[unexpected output omitted]', \LOG_ERR, 'OB-DATA');
			}

			if ($oException && $bSensitiveTwoFactorAction) {
				$this->oActions->logWrite('Sensitive two-factor action failed', \LOG_ERR, 'JSON');
			} else if ($oException) {
				$this->oActions->logException($oException, \LOG_ERR);
			}

			if ($bSensitiveTwoFactorAction) {
				$this->oActions->logWrite('[two-factor response body omitted]', \LOG_INFO, 'JSON');
			} else {
				$this->oActions->logWrite('[response body omitted]', \LOG_INFO, 'JSON');
			}
		}

		return $sResult;
	}

	private function privateUpload(string $sAction, int $iSizeLimit = 0) : string
	{
		$oConfig = $this->Config();

		\ob_start();
		$aResponse = null;
		try
		{
			if (!$this->oHttp->IsPost()) {
				throw new Exceptions\ClientException(Notifications::AuthError);
			}
			// Match JSON's header precedence and current account token semantics.
			if (($_SERVER['HTTP_X_SM_TOKEN'] ?? ($_POST['XToken'] ?? null)) !== Utils::GetCsrfToken()) {
				throw new Exceptions\ClientException(Notifications::InvalidToken);
			}

			$aFile = null;
			$sInputName = 'uploader';
			$iSizeLimit = (0 < $iSizeLimit ? $iSizeLimit : ((int) $oConfig->Get('webmail', 'attachment_size_limit', 0))) * 1024 * 1024;

			$_FILES = isset($_FILES) ? $_FILES : null;
			if (isset($_FILES[$sInputName], $_FILES[$sInputName]['name'], $_FILES[$sInputName]['tmp_name'], $_FILES[$sInputName]['size'])) {
				$iError = (isset($_FILES[$sInputName]['error'])) ? (int) $_FILES[$sInputName]['error'] : UPLOAD_ERR_OK;
//				\is_uploaded_file($_FILES[$sInputName]['tmp_name'])

				if (UPLOAD_ERR_OK === $iError && 0 < $iSizeLimit && $iSizeLimit < (int) $_FILES[$sInputName]['size']) {
					$iError = Enumerations\UploadError::CONFIG_SIZE;
				}

				if (UPLOAD_ERR_OK === $iError) {
					$aFile = $_FILES[$sInputName];
				}
			} else if (empty($_FILES)) {
				$iError = UPLOAD_ERR_INI_SIZE;
			} else {
				$iError = Enumerations\UploadError::EMPTY_FILE;
			}

			if (\method_exists($this->oActions, $sAction) && \is_callable(array($this->oActions, $sAction))) {
				$aResponse = $this->oActions->{$sAction}($aFile, $iError);
			}

			if (!is_array($aResponse)) {
				throw new Exceptions\ClientException(Notifications::UnknownError);
			}

		}
		catch (\Throwable $oException)
		{
			$aResponse = $this->oActions->ExceptionResponse($oException);
		}

		$aResponse['Action'] = $sAction ?: 'Unknown';

		\header('Content-Type: application/json; charset=utf-8');

		$sResult = Utils::jsonEncode($aResponse);

		$sObResult = \ob_get_clean();
		if (\strlen($sObResult)) {
			$this->oActions->logWrite('[unexpected output omitted]', \LOG_ERR, 'OB-DATA');
		}

		$this->oActions->logWrite('[upload response body omitted]', \LOG_INFO, 'UPLOAD');

		return $sResult;
	}

	public function ServiceUpload() : string
	{
		return $this->privateUpload('Upload');
	}

	public function ServiceUploadContacts() : string
	{
		return $this->privateUpload('UploadContacts', 5);
	}

	public function ServiceProxyExternal() : string
	{
		// New URLs cannot reuse cache provenance from the former unrestricted proxy.
		$sData = 'public-v1' === ($this->aPaths[1] ?? '') ? ($this->aPaths[2] ?? '') : '';
		if ($sData
			&& $this->Config()->Get('labs', 'use_local_proxy_for_external_images', false)
			&& $this->oActions->getAccountFromToken()
		) {
			$tmp = null;
			try {
				$sUrl = \MailSo\Base\Utils::UrlSafeBase64Decode($sData);
				if (!empty($sUrl)) {
					$tmp = \tmpfile();
					$HTTP = \SnappyMail\HTTP\Request::factory();
					$HTTP->requirePublicDestination();
					$HTTP->max_redirects = 2;
					$HTTP->streamBodyTo($tmp);
					$oResponse = $HTTP->doRequest('GET', $sUrl);
					if ($oResponse) {
						$sContentType = \SnappyMail\File\MimeType::fromStream($tmp) ?: $oResponse->getHeader('content-type');
						if (200 === $oResponse->status && \str_starts_with($sContentType, 'image/')) {
							// Conditional 304 checks happen only after the entire fetch passed policy.
							$cacheKey = 'external-image-public-v1:' . $sData;
							$this->oActions->verifyCacheByKey($cacheKey);
							$this->oActions->cacheByKey($cacheKey);
							\header('Content-Type: ' . $sContentType);
							\header('Cache-Control: public');
							\header('Expires: '.\gmdate('D, j M Y H:i:s', 2592000 + \time()).' UTC');
							\header('X-Content-Location: '.$oResponse->request_uri);
							\header('X-Content-Redirect-Location: '.$oResponse->final_uri);
							\rewind($tmp);
							\fpassthru($tmp);
							exit;
						}
					}
				}
			} catch (\Throwable $e) {
				// Sender URLs and remote errors are not reflected in response headers or logs.
			} finally {
				if (\is_resource($tmp)) {
					\fclose($tmp);
				}
			}
		}

		\MailSo\Base\Http::StatusHeader(404);
		return '';
	}

	public function ServiceCspReport() : void
	{
		\SnappyMail\HTTP\CSP::logReport();
	}

	public function ServiceRaw() : string
	{
		$sResult = '';
		$sRawError = '';
		$sAction = empty($this->aPaths[2]) ? '' : $this->aPaths[2];
		$oException = null;

		try
		{
			$sRawError = 'Invalid action';
			if (\strlen($sAction)) {
				try {
					$sMethodName = 'Raw'.$sAction;
					if (\method_exists($this->oActions, $sMethodName)) {
						$this->oActions->logWrite('Action: '.$sMethodName, \LOG_INFO, 'RAW');
						\header('X-Raw-Action: '.$sMethodName);
						// Keep the site policy, including operator-configured frame-ancestors.
						\header('Content-Security-Policy: default-src \'none\'; script-src \'none\'; child-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'', false);

						$sRawError = '';
						$this->oActions->SetActionParams(array(
							'RawKey' => empty($this->aPaths[3]) ? '' : $this->aPaths[3],
							'Params' => $this->aPaths
						), $sMethodName);

						if (!$this->oActions->{$sMethodName}()) {
							$sRawError = 'False result';
						}
					} else {
						$sRawError = 'Unknown action';
					}
				} catch (\Throwable $e) {
//					error_log(print_r($e,1));
					$sRawError = 'Exception as result';
				}
			} else {
				$sRawError = 'Empty action';
			}
		}
		catch (Exceptions\ClientException $oException)
		{
			$sRawError = Notifications::AuthError == $oException->getCode()
				? 'Authentication failed'
				: 'Exception as result';
		}
		catch (\Throwable $oException)
		{
			$sRawError = 'Exception as result';
		}

		if (\strlen($sRawError)) {
			$this->oActions->logWrite($sRawError, \LOG_ERR);
		}

		if ($oException) {
			$this->oActions->logException($oException, \LOG_ERR, 'RAW');
		}

		return $sResult;
	}

	public function ServiceLang() : string
	{
		$sResult = '';
		\header('Content-Type: application/javascript; charset=utf-8');

		if (!empty($this->aPaths[3])) {
			$bAdmin = 'Admin' === (isset($this->aPaths[2]) ? (string) $this->aPaths[2] : 'App');
			$sLanguage = $this->oActions->ValidateLanguage($this->aPaths[3], '', $bAdmin);

			$bCacheEnabled = $this->Config()->Get('cache', 'system_data', true);
			$sCacheFileName = '';
			if ($bCacheEnabled) {
				$sCacheFileName = KeyPathHelper::LangCache($sLanguage, $bAdmin);
				$this->oActions->verifyCacheByKey(\md5($sCacheFileName));
				$sResult = $this->Cacher()->Get($sCacheFileName);
			}

			if (!$sResult) {
				$sResult = $this->oActions->compileLanguage($sLanguage, $bAdmin);
				if ($sCacheFileName) {
					$this->Cacher()->Set($sCacheFileName, $sResult);
				}
			}

			if ($sCacheFileName) {
				$this->oActions->cacheByKey(\md5($sCacheFileName));
			}
		}

		return $sResult;
	}

	public function ServiceAppData() : string
	{
		return $this->localAppData(false);
	}

	public function ServiceAdminAppData() : string
	{
		return $this->localAppData(true);
	}

	public function ServiceMailto() : string
	{
		$this->oHttp->ServerNoCache();
		$sTo = \trim($_GET['to'] ?? '');
		if (\preg_match('/^mailto:/i', $sTo)) {
			\SnappyMail\Cookies::set(
				Actions::AUTH_MAILTO_TOKEN_KEY,
				Utils::EncodeKeyValuesQ(array(
					'Time' => \microtime(true),
					'MailTo' => 'MailTo',
					'To' => $sTo
				))
			);
		}
		\MailSo\Base\Http::Location('./');
		return '';
	}

	public function ServicePing() : string
	{
		$this->oHttp->ServerNoCache();

		\header('Content-Type: text/plain; charset=utf-8');
		$this->oActions->logWrite('Pong', \LOG_INFO, 'PING');
		return 'Pong';
	}

	public function ServiceTest() : string
	{
		$this->oHttp->ServerNoCache();
		\SnappyMail\Integrity::test();
		return '';
	}

	/**
	 * Login with the \RainLoop\API::CreateUserSsoHash() generated hash
	 */
	public function ServiceSso() : string
	{
		$this->oHttp->ServerNoCache();

		$oException = null;
		$oAccount = null;

		$sSsoHash = $_REQUEST['hash'] ?? '';
		if (!empty($sSsoHash)) {
			$mData = null;

			$sSsoSubData = $this->Cacher()->Get(KeyPathHelper::SsoCacherKey($sSsoHash));
			if (!empty($sSsoSubData)) {
				$aData = \SnappyMail\Crypt::DecryptFromJSON($sSsoSubData, $sSsoHash);

				$this->Cacher()->Delete(KeyPathHelper::SsoCacherKey($sSsoHash));

				if (\is_array($aData) && !empty($aData['Email']) && isset($aData['Password'], $aData['Time']) &&
					(0 === $aData['Time'] || \time() - 10 < $aData['Time']))
				{
					$aAdditionalOptions = (isset($aData['AdditionalOptions']) && \is_array($aData['AdditionalOptions']))
						? $aData['AdditionalOptions'] : [];
					try
					{
						$oAccount = $this->oActions->LoginProcess(
							\trim($aData['Email']),
							new \SnappyMail\SensitiveString($aData['Password'])
						);
						if ($aAdditionalOptions) {
							$bSaveSettings = false;

							$oSettings = $this->SettingsProvider()->Load($oAccount);
							if ($oSettings) {
								$sLanguage = isset($aAdditionalOptions['language']) ?
									$aAdditionalOptions['language'] : '';

								if ($sLanguage) {
									$sLanguage = $this->oActions->ValidateLanguage($sLanguage);
									if ($sLanguage !== $oSettings->GetConf('language', '')) {
										$bSaveSettings = true;
										$oSettings->SetConf('language', $sLanguage);
									}
								}
							}

							if ($bSaveSettings) {
								$oSettings->save();
							}
						}
					}
					catch (\Throwable $oException)
					{
						$this->oActions->logException($oException);
					}
				}
			}
		}

		\MailSo\Base\Http::Location('./');
		return '';
	}

	public function ErrorTemplates(string $sTitle, string $sDesc, bool $bShowBackLink = true) : string
	{
		return \strtr(\file_get_contents(APP_VERSION_ROOT_PATH.'app/templates/Error.html'), array(
			'{{ErrorTitle}}' => $sTitle,
			'{{ErrorHeader}}' => $sTitle,
			'{{ErrorDesc}}' => $sDesc,
			'{{BackLinkVisibilityStyle}}' => $bShowBackLink ? 'display:inline-block' : 'display:none',
			'{{BackLink}}' => $this->oActions->StaticI18N('BACK_LINK'),
			'{{BackHref}}' => './'
		));
	}

	private function localError(string $sTitle, string $sDesc) : string
	{
		\header('Content-Type: text/html; charset=utf-8');
		return $this->ErrorTemplates($sTitle, \nl2br($sDesc));
	}

	private function localAppData(bool $bAdmin = false) : string
	{
		\header('Content-Type: application/json; charset=utf-8');
		$this->oHttp->ServerNoCache();
		try {
			return Utils::jsonEncode($this->oActions->AppData($bAdmin));
		} catch (\Throwable $oException) {
			$this->Logger()->WriteExceptionShort($oException);
			\MailSo\Base\Http::StatusHeader(500);
			return $oException->getMessage();
		}
	}

	public function compileTemplates(bool $bAdmin = false) : string
	{
		$aTemplates = array();

		foreach (['Components', ($bAdmin ? 'Admin' : 'User'), 'Common'] as $dir) {
			$sNameSuffix = ('Components' === $dir) ? 'Component' : '';
			foreach (\glob(APP_VERSION_ROOT_PATH."app/templates/Views/{$dir}/*.html") as $file) {
				$sTemplateName = \basename($file, '.html') . $sNameSuffix;
				$aTemplates[$sTemplateName] = $file;
			}
		}

		$sHtml = '';
		foreach ($aTemplates as $sName => $sFile) {
			$sName = \preg_replace('/[^a-zA-Z0-9]/', '', $sName);
			$sHtml .= '<template id="'.$sName.'">'
				. \preg_replace('/<(\/?)script/i', '<$1x-script', \file_get_contents($sFile))
				. '</template>';
		}

		return \str_replace('&nbsp;', "\xC2\xA0", $sHtml);
	}
}
