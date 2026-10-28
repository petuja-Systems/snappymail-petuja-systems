<?php

$sPluginLoadSentinel = (string) \getenv('PETUJA_TEST_PLUGIN_SENTINEL');
if ('' !== $sPluginLoadSentinel) {
	\file_put_contents($sPluginLoadSentinel, 'included');
}

class M3aProtocolProviderDisentanglementPlugin extends \RainLoop\Plugins\AbstractPlugin
{
	const
		NAME = 'M3A Protocol Provider Boundary Fixture',
		CATEGORY = 'Tests',
		DESCRIPTION = 'Verifies that retained core paths ignore generic protocol and provider hooks';

	public function Init() : void
	{
		$this->addHook('filter.application-config', 'filterApplicationConfig');
		$this->addHook('filter.account', 'filterAccount');
		$this->addHook('filter.domain', 'filterDomain');
		$this->addHook('main.fabrica', 'mainFabrica');
		$this->addHook('filter.fabrica', 'filterFabrica');
		$this->addHook('imap.before-connect', 'imapBeforeConnect');
		$this->addHook('imap.after-connect', 'imapAfterConnect');
		$this->addHook('imap.before-login', 'imapBeforeLogin');
		$this->addHook('imap.after-login', 'imapAfterLogin');
		$this->addHook('smtp.before-connect', 'smtpBeforeConnect');
		$this->addHook('smtp.after-connect', 'smtpAfterConnect');
		$this->addHook('smtp.before-login', 'smtpBeforeLogin');
		$this->addHook('smtp.after-login', 'smtpAfterLogin');
		$this->addHook('sieve.before-connect', 'sieveBeforeConnect');
		$this->addHook('sieve.after-connect', 'sieveAfterConnect');
		$this->addHook('sieve.before-login', 'sieveBeforeLogin');
		$this->addHook('sieve.after-login', 'sieveAfterLogin');
	}

	private function mark(string $sHook) : void
	{
		\file_put_contents(APP_PRIVATE_DATA . 'm3a-hook-calls.log', $sHook . "\n", FILE_APPEND | LOCK_EX);
	}

	private function poisonSettings(string $sHook, \MailSo\Net\ConnectSettings $oSettings) : void
	{
		$this->mark($sHook);
		$oSettings->host = '127.0.0.1';
		$oSettings->port = 1;
	}

	private function poisonLogin(string $sHook, \MailSo\Net\ConnectSettings $oSettings) : void
	{
		$this->mark($sHook);
		$oSettings->username = 'plugin-user';
		$oSettings->passphrase = new \SnappyMail\SensitiveString('plugin-password');
	}

	public function filterApplicationConfig(\RainLoop\Config\Application $oConfig) : void
	{
		$this->mark('filter.application-config');
		$oConfig->Set('imap', 'message_all_headers', false);
	}

	public function filterAccount(\RainLoop\Model\Account $oAccount) : void
	{
		$this->mark('filter.account');
		$oAccount->setImapUser('plugin-user');
		$oAccount->setImapPass(new \SnappyMail\SensitiveString('plugin-password'));
		$oAccount->setSmtpUser('plugin-user');
		$oAccount->setSmtpPass(new \SnappyMail\SensitiveString('plugin-password'));
	}

	public function filterDomain(\RainLoop\Model\Domain $oDomain) : void
	{
		$this->mark('filter.domain');
		foreach ([$oDomain->ImapSettings(), $oDomain->SmtpSettings(), $oDomain->SieveSettings()] as $oSettings) {
			$oSettings->host = '127.0.0.1';
			$oSettings->port = 1;
		}
	}

	public function mainFabrica(string $sName, &$mResult) : void
	{
		if (\in_array($sName, ['domain', 'filters', 'identities', 'storage'], true)) {
			$this->mark('main.fabrica:' . $sName);
			$mResult = new \stdClass;
		}
	}

	public function filterFabrica(string $sName, &$mResult, ?\RainLoop\Model\Account $oAccount = null) : void
	{
		unset($oAccount);
		if (\in_array($sName, ['domain', 'filters', 'identities', 'storage'], true)) {
			$this->mark('filter.fabrica:' . $sName);
			$mResult = new \stdClass;
		}
	}

	public function imapBeforeConnect(\RainLoop\Model\Account $oAccount, \MailSo\Imap\ImapClient $oClient, \MailSo\Imap\Settings $oSettings) : void
	{
		$this->poisonSettings('imap.before-connect', $oSettings);
	}

	public function imapAfterConnect(\RainLoop\Model\Account $oAccount, \MailSo\Imap\ImapClient $oClient, \MailSo\Imap\Settings $oSettings) : void
	{
		$this->mark('imap.after-connect');
	}

	public function imapBeforeLogin(\RainLoop\Model\Account $oAccount, \MailSo\Imap\ImapClient $oClient, \MailSo\Imap\Settings $oSettings) : void
	{
		$this->poisonLogin('imap.before-login', $oSettings);
	}

	public function imapAfterLogin(\RainLoop\Model\Account $oAccount, \MailSo\Imap\ImapClient $oClient, bool $bResult, \MailSo\Imap\Settings $oSettings) : void
	{
		$this->mark('imap.after-login');
	}

	public function smtpBeforeConnect(\RainLoop\Model\Account $oAccount, \MailSo\Smtp\SmtpClient $oClient, \MailSo\Smtp\Settings $oSettings) : void
	{
		$this->poisonSettings('smtp.before-connect', $oSettings);
	}

	public function smtpAfterConnect(\RainLoop\Model\Account $oAccount, \MailSo\Smtp\SmtpClient $oClient, \MailSo\Smtp\Settings $oSettings) : void
	{
		$this->mark('smtp.after-connect');
	}

	public function smtpBeforeLogin(\RainLoop\Model\Account $oAccount, \MailSo\Smtp\SmtpClient $oClient, \MailSo\Smtp\Settings $oSettings) : void
	{
		$this->poisonLogin('smtp.before-login', $oSettings);
	}

	public function smtpAfterLogin(\RainLoop\Model\Account $oAccount, \MailSo\Smtp\SmtpClient $oClient, bool $bResult, \MailSo\Smtp\Settings $oSettings) : void
	{
		$this->mark('smtp.after-login');
	}

	public function sieveBeforeConnect(\RainLoop\Model\Account $oAccount, \MailSo\Sieve\SieveClient $oClient, \MailSo\Sieve\Settings $oSettings) : void
	{
		$this->poisonSettings('sieve.before-connect', $oSettings);
	}

	public function sieveAfterConnect(\RainLoop\Model\Account $oAccount, \MailSo\Sieve\SieveClient $oClient, \MailSo\Sieve\Settings $oSettings) : void
	{
		$this->mark('sieve.after-connect');
	}

	public function sieveBeforeLogin(\RainLoop\Model\Account $oAccount, \MailSo\Sieve\SieveClient $oClient, \MailSo\Sieve\Settings $oSettings) : void
	{
		$this->poisonLogin('sieve.before-login', $oSettings);
	}

	public function sieveAfterLogin(\RainLoop\Model\Account $oAccount, \MailSo\Sieve\SieveClient $oClient, bool $bResult, \MailSo\Sieve\Settings $oSettings) : void
	{
		$this->mark('sieve.after-login');
	}
}
