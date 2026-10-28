import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const applicationRoot = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries');
const phpBinary = process.env.PHP_BINARY || 'php';

async function source(relativePath) {
	return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

test('TOTP matching selects the newest counter when adjacent steps share a code', () => {
	const matchedCounter = execFileSync(phpBinary, ['-r', [
		"require getcwd() . '/snappymail/v/0.0.0/app/libraries/snappymail/totp.php';",
		"echo \\SnappyMail\\TOTP::MatchingCounter('JBSWY3DPEHPK3PXP', '874294', 111317070);"
	].join(' ')], { cwd: repositoryRoot, encoding: 'utf8' });
	assert.equal(Number(matchedCounter), 3710569);
});

test('native enrollment and force policy use core configuration and persisted CONFIG state', async () => {
	const [actions, domain, userActions, auth, totp, applicationConfig] = await Promise.all([
		source('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/TwoFactor.php'),
		source('snappymail/v/0.0.0/app/libraries/snappymail/twofactor.php'),
		source('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php'),
		source('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/UserAuth.php'),
		source('snappymail/v/0.0.0/app/libraries/snappymail/totp.php'),
		source('snappymail/v/0.0.0/app/libraries/RainLoop/Config/Application.php')
	]);

	assert.match(actions, /use SnappyMail\\TwoFactor as TwoFactorService/);
	assert.match(actions, /VerifyAndConsumeTotp\(/,
		'enrollment proofs must consume one account-wide TOTP counter');
	assert.match(actions, /TwoFactorService::GenerateRecoveryCodes\(/);
	assert.match(actions, /StorageType::SESSION/);
	const requiredPolicy = actions.match(/private function twoFactorIsRequired\(\).*?\n\t\}/s)?.[0] || '';
	assert.match(requiredPolicy, /Config\(\)->Get\('security', 'require_two_factor_auth', false\)/);
	assert.doesNotMatch(requiredPolicy, /Plugins\(\)|RunHook/);
	assert.match(applicationConfig, /plugin-two-factor-auth\.json/,
		'legacy config is read only for the one-time native migration');
	assert.match(applicationConfig, /plugin-two-factor-auth\.ini/,
		'legacy INI config remains an isolated migration fallback');
	assert.doesNotMatch(applicationConfig, /Config\\Plugin|APP_PLUGINS_PATH/,
		'native migration does not depend on generic plugin runtime or paths');
	assert.match(applicationConfig, /two_factor_policy_migration/);
	assert.match(actions, /'pending' !== \$this->twoFactorSessionState\(\$oAccount\)/);
	assert.match(actions, /return \$this->DoLogout\(\)/,
		'forced enrollment must use the established logout and fresh-authentication boundary');
	assert.match(domain, /'two_factor'/,
		'the M1A domain service must continue to own the authoritative CONFIG key');
	assert.match(domain, /FactorGeneration/);
	assert.match(domain, /TotpGeneration/);
	assert.match(domain, /LastTotpCounter/);
	assert.match(totp, /function MatchingCounter\(/,
		'TOTP verification must return the matched RFC 6238 counter for one-use persistence');
	assert.match(auth, /parseSessionAssurance\(/,
		'session assurance must use one strict parser');
	assert.match(auth, /verified:\x27\.\$aState\[\x27FactorGeneration\x27\]/,
		'verified session state must bind to the current factor generation');
	assert.match(auth, /native SEC-02 gates/);
	assert.match(auth, /\x27v\x27 => 3/,
		'new Remember-Me issuance must use the generation-bound schema');
	assert.match(userActions, /use TwoFactor;/,
		'native JSON action methods must be attached to the existing Actions architecture');
	assert.doesNotMatch(actions, /TOTP::|function\s+(?:verify|consume|generateRecovery)/i,
		'enrollment must not add a second TOTP or recovery implementation');
});

test('only explicit enrollment responses carry secrets; action logs omit second-factor data', async () => {
	const [actions, serviceActions] = await Promise.all([
		source('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/TwoFactor.php'),
		source('snappymail/v/0.0.0/app/libraries/RainLoop/ServiceActions.php')
	]);

	const stateAction = actions.match(/public function DoTwoFactorState\(\).*?\n\t\}/s)?.[0] || '';
	assert.match(stateAction, /'Status'\s*=>/);
	assert.match(stateAction, /'Enabled'\s*=>/);
	assert.doesNotMatch(stateAction, /'Secret'\s*=>|'BackupCodes'\s*=>|'QRCode'\s*=>/);
	assert.match(actions, /'Secret'\s*=> \$mRecord\['Secret'\]/,
		'the setup response is the intentional secret presentation path');
	assert.match(actions, /'BackupCodes'\s*=> \$mRecord\['BackupCodes'\]/,
		'recovery codes are returned with explicit enrollment only');
	assert.match(serviceActions, /strncasecmp\(\$sAction, 'TwoFactor', 9\)/,
		'sensitive action matching must follow PHP case-insensitive method dispatch');
	assert.match(serviceActions, /Sensitive two-factor action rejected: CSRF token mismatch/,
		'CSRF failures for sensitive actions must omit submitted and expected token values');
	assert.match(serviceActions, /\[two-factor request body omitted\]/);
	assert.match(serviceActions, /\[two-factor response body omitted\]/);
	assert.match(serviceActions, /\[request body omitted\]/,
		'ordinary Login proof must use the generic request-body omission policy');
	assert.match(serviceActions, /\[response body omitted\]/,
		'ordinary secret-bearing responses must use the generic omission policy');
});

test('retired package artifacts and generic runtime are absent while native enrollment controls remain', async () => {
	const [nativeSettings, nativeTemplate] = await Promise.all([
		source('dev/Settings/User/Security.js'),
		source('snappymail/v/0.0.0/app/templates/Views/User/SettingsSecurity.html')
	]);

	await assert.rejects(source('plugins/two-factor-auth/index.php'), { code: 'ENOENT' });
	await assert.rejects(source('plugins/two-factor-auth/js/TwoFactorAuthLogin.js'), { code: 'ENOENT' });
	await assert.rejects(access(path.join(repositoryRoot, 'plugins', 'two-factor-auth')),
		'the retired two-factor package directory must be absent');
	await assert.rejects(access(path.join(applicationRoot, 'RainLoop/Plugins/Manager.php')),
		'the generic executable Plugin Manager must be absent');
	await assert.rejects(access(path.join(applicationRoot, 'RainLoop/Plugins/AbstractPlugin.php')),
		'the build-only generic plugin parent must be absent');
	assert.match(nativeSettings, /Remote\.request\('TwoFactorState'/);
	assert.match(nativeSettings, /Remote\.request\('TwoFactorSetup'/);
	assert.match(nativeTemplate, /autocomplete="one-time-code"/);
	assert.match(nativeTemplate, /text: twoFactorRecoveryCodes/);
});

test('ordinary setup clicks cannot become explicit restarts through Knockout arguments', async () => {
	const [nativeSettings, nativeTemplate] = await Promise.all([
		source('dev/Settings/User/Security.js'),
		source('snappymail/v/0.0.0/app/templates/Views/User/SettingsSecurity.html')
	]);

	assert.match(nativeTemplate,
		/data-bind="click: startTwoFactorSetup, disable: twoFactorBusy"[\s\S]*?SETTINGS_SECURITY\/TFA_START/);
	assert.match(nativeTemplate,
		/data-bind="click: startTwoFactorSetup, disable: twoFactorBusy"[\s\S]*?SETTINGS_SECURITY\/TFA_RESUME/);
	assert.match(nativeSettings,
		/startTwoFactorSetup\(\)\s*\{\s*this\.requestTwoFactorSetup\(false\);\s*\}/,
		'the Knockout-bound handler must ignore binding data and event arguments');
	assert.match(nativeSettings,
		/requestTwoFactorSetup\(restart\)\s*\{[\s\S]*?Remote\.request\('TwoFactorSetup'[\s\S]*?restart\s*\?\s*\{\s*Restart:\s*1\s*\}\s*:\s*\{\}/,
		'explicit restart intent is applied only by the internal request helper');
	assert.match(nativeSettings,
		/confirmTwoFactorRestart\(\)\s*\{[\s\S]*?\(\)\s*=>\s*this\.requestTwoFactorSetup\(true\)/,
		'only the post-confirmation restart flow requests factor rotation');
	assert.equal([...nativeSettings.matchAll(/requestTwoFactorSetup\(true\)/g)].length, 1,
		'the confirmed restart flow must be the sole explicit restart caller');
});
