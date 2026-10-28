<?php

require_once __DIR__ . '/backup-restore-prepend.php';

$sRepositoryRoot = dirname(__DIR__, 2);
$sRequestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$sFixtureSecret = getenv('PETUJA_TEST_FIXTURE_SECRET') ?: '';
$sRequestSecret = $_SERVER['HTTP_X_TEST_FIXTURE_SECRET'] ?? '';
$bFixtureRequest = '' !== $sFixtureSecret && is_string($sRequestSecret)
	&& hash_equals($sFixtureSecret, $sRequestSecret);

if ('/__test/protocol-provider' === $sRequestPath && $bFixtureRequest) {
	$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
	require $sRepositoryRoot . '/index.php';

	$sStage = 'actions';
	try {
		$oActions = \RainLoop\Api::Actions();

		$sStage = 'domain';
		$oDomain = $oActions->DomainProvider()->getByEmailAddress('main@example.test');
		$oWildcardDomain = $oActions->DomainProvider()->Load('alice.wild.test', true);
		$sStage = 'main-login';
		$oMainAccount = $oActions->LoginProcess(
			'main@example.test',
			new \SnappyMail\SensitiveString(getenv('PETUJA_TEST_IMAP_PASSWORD') ?: '')
		);
		$iImapTimeout = $oActions->ImapClient()->Settings->timeout;

		// Force the ordinary encrypted-cookie and server-side session reconstruction path.
		$oMainAccountCache = new \ReflectionProperty(\RainLoop\Actions::class, 'oMainAuthAccount');
		$oMainAccountCache->setValue($oActions, false);
		$sStage = 'main-reconstruction';
		$oReconstructedMain = $oActions->getMainAccountFromToken(true);
		$sStage = 'identity-provider';
		$oIdentityProvider = $oActions->IdentitiesProvider();
		$aIdentities = $oIdentityProvider->GetIdentities($oReconstructedMain, true);
		$oPrimaryIdentity = null;
		foreach ($aIdentities as $oIdentity) {
			if ($oIdentity->IsAccountIdentities()) {
				$oPrimaryIdentity = $oIdentity;
				break;
			}
		}

		$sStage = 'smtp-send';
		$oActions->SetActionParams([
			'from' => 'main@example.test',
			'to' => 'recipient@example.test',
			'subject' => 'M3A.1 synthetic send',
			'plain' => 'synthetic message body'
		]);
		$oSendResult = $oActions->DoSendMessage();
		$oActions->ImapClient()->Disconnect();

		$sStage = 'additional-login';
		$oAdditionalAccount = $oActions->LoginProcess(
			'additional@example.test',
			new \SnappyMail\SensitiveString(getenv('PETUJA_TEST_IMAP_PASSWORD') ?: ''),
			false
		);
		$sStage = 'additional-reconstruction';
		$aAdditionalToken = $oAdditionalAccount->asTokenArray($oReconstructedMain);
		$oReconstructedAdditional = \RainLoop\Model\AdditionalAccount::NewInstanceFromTokenArray(
			$oActions,
			$aAdditionalToken,
			true
		);
		$sStage = 'additional-imap';
		$oAdditionalImapClient = new \MailSo\Imap\ImapClient;
		$oAdditionalImapClient->SetLogger($oActions->Logger());
		$bAdditionalImapLogin = $oReconstructedAdditional->ImapConnectAndLogin(
			$oAdditionalImapClient,
			$oActions->Config()
		);
		$oAdditionalImapClient->Disconnect();

		$sStage = 'explicit-smtp';
		$oExplicitSmtpAccount = new \RainLoop\Model\MainAccount;
		$oExplicitSmtpAccount->setCredentials(
			$oDomain,
			'explicit@example.test',
			'explicit-imap-user',
			new \SnappyMail\SensitiveString('unused-imap-password'),
			'explicit-smtp-user',
			new \SnappyMail\SensitiveString(getenv('PETUJA_TEST_SMTP_PASSWORD') ?: '')
		);
		$oExplicitSmtpClient = new \MailSo\Smtp\SmtpClient;
		$oExplicitSmtpClient->SetLogger($oActions->Logger());
		$bExplicitSmtpLogin = $oExplicitSmtpAccount->SmtpConnectAndLogin($oExplicitSmtpClient);
		$oExplicitSmtpClient->Disconnect();

		$sStage = 'sieve-storage';
		$oActions->SetActionParams([]);
		$oSieveLoad = $oActions->DoFilters();
		$oActions->SetActionParams(['name' => 'm3a-test', 'body' => 'keep;']);
		$oSieveSave = $oActions->DoFiltersScriptSave();
		$oActions->SetActionParams(['name' => 'm3a-test']);
		$oSieveActivate = $oActions->DoFiltersScriptActivate();
		$oSieveDelete = $oActions->DoFiltersScriptDelete();

		$oConnectSettings = new \ReflectionProperty(\MailSo\Net\ConnectSettings::class, 'passphrase');
		$oAccountPassword = new \ReflectionProperty(\RainLoop\Model\Account::class, 'oImapPass');
		$oDomainImapSettings = $oReconstructedMain->Domain()->ImapSettings();
		$oDomainSmtpSettings = $oReconstructedMain->Domain()->SmtpSettings();
		$oDomainSieveSettings = $oReconstructedMain->Domain()->SieveSettings();
		$oExplicitSmtpSettings = $oExplicitSmtpClient->Settings;

		header('Content-Type: application/json; charset=utf-8');
		echo json_encode([
			'domain_provider' => get_class($oActions->DomainProvider()),
			'domain' => $oDomain->Name(),
			'wildcard_domain' => $oWildcardDomain ? $oWildcardDomain->Name() : null,
			'domain_hosts' => [
				'imap' => $oDomain->ImapSettings()->host,
				'smtp' => $oDomain->SmtpSettings()->host,
				'sieve' => $oDomain->SieveSettings()->host
			],
			'main_account' => [
				'class' => get_class($oReconstructedMain),
				'email' => $oReconstructedMain->Email(),
				'imap_user' => $oReconstructedMain->ImapUser(),
				'smtp_user' => $oReconstructedMain->SmtpUser(),
				'password_sensitive' => $oAccountPassword->getValue($oReconstructedMain) instanceof \SnappyMail\SensitiveString,
				'password_matches' => hash_equals(getenv('PETUJA_TEST_IMAP_PASSWORD') ?: '', $oReconstructedMain->ImapPass())
			],
			'identities' => [
				'provider' => get_class($oIdentityProvider),
				'primary_email' => $oPrimaryIdentity ? $oPrimaryIdentity->Email() : null
			],
			'additional_account' => [
				'class' => get_class($oReconstructedAdditional),
				'email' => $oReconstructedAdditional->Email(),
				'imap_user' => $oReconstructedAdditional->ImapUser(),
				'imap_login' => $bAdditionalImapLogin,
				'password_sensitive' => $oAccountPassword->getValue($oReconstructedAdditional) instanceof \SnappyMail\SensitiveString,
				'password_matches' => hash_equals(getenv('PETUJA_TEST_IMAP_PASSWORD') ?: '', $oReconstructedAdditional->ImapPass())
			],
			'imap_timeout' => $iImapTimeout,
			'imap_message_all_headers' => $oActions->ImapClient()->Settings->message_all_headers,
			'smtp' => [
				'send_result' => $oSendResult['Result'] ?? false,
				'explicit_login' => $bExplicitSmtpLogin,
				'password_sensitive' => $oConnectSettings->getValue($oExplicitSmtpSettings) instanceof \SnappyMail\SensitiveString
			],
			'sieve' => [
				'load_result' => $oSieveLoad['Result'] ?? [],
				'save_result' => $oSieveSave['Result'] ?? false,
				'activate_result' => $oSieveActivate['Result'] ?? false,
				'delete_result' => $oSieveDelete['Result'] ?? false,
				'password_sensitive' => $oConnectSettings->getValue($oDomainSieveSettings) instanceof \SnappyMail\SensitiveString
			]
		]);
	} catch (\Throwable $oException) {
		http_response_code(500);
		header('Content-Type: application/json; charset=utf-8');
		echo json_encode([
			'error_class' => get_class($oException),
			'error_code' => $oException->getCode(),
			'previous_class' => $oException->getPrevious() ? get_class($oException->getPrevious()) : null,
			'stage' => $sStage
		]);
	}
	return true;
}

http_response_code(404);
return true;
