import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	completeLoginRequestData,
	LoginStep,
	nextSignMeValue,
	parseLoginResponse
} from '../dev/View/User/LoginFlow.mjs';
import { startForcedEnrollmentRouting } from '../dev/App/ForcedEnrollmentRouting.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function source(relativePath) {
	return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

test('native login distinguishes ordinary, forced-enrollment, and enabled-factor results', () => {
	const ordinary = {Result: {Auth: true, language: 'de'}};
	assert.deepEqual(parseLoginResponse(ordinary), {
		type: 'authenticated',
		appData: ordinary.Result
	});
	assert.equal(parseLoginResponse({Result: {Auth: false}}).type, 'invalid',
		'a successful HTTP response without authenticated AppData is not a login');

	const pending = {Result: {Auth: true, SetupTwoFactor: true, RequireTwoFactor: true}};
	assert.equal(parseLoginResponse(pending).type, 'authenticated',
		'forced enrollment stays on the restricted AppData path');

	const challenge = {
		Result: {
			RequiresTwoFactor: true,
			Challenge: 'A'.repeat(43),
			Account: 'canonical@example.test',
			ExpiresAt: 1_800_000_000
		}
	};
	assert.deepEqual(parseLoginResponse(challenge), {
		type: 'factor',
		appData: challenge.Result,
		challenge: {
			id: challenge.Result.Challenge,
			account: challenge.Result.Account,
			expiresAt: challenge.Result.ExpiresAt
		}
	});
	assert.equal(parseLoginResponse({Result: {...challenge.Result, Auth: true, RequiresTwoFactor: 1}}).type, 'authenticated',
		'the UI only enters the factor step on the literal boolean true');
	assert.equal(parseLoginResponse({Result: {...challenge.Result, Challenge: 'bad'}}).type, 'invalid');
});

test('Remember Me cannot change while a login request is pending', () => {
	assert.equal(nextSignMeValue(false, false), true);
	assert.equal(nextSignMeValue(true, false), false);
	assert.equal(nextSignMeValue(false, true), false);
	assert.equal(nextSignMeValue(true, true), true);
});

test('forced-enrollment routing starts Security and blocks navigation away without affecting optional users', () => {
	let screenListener = null,
		locationWrites = 0,
		securityScreenStarts = 0;
	const queuedRoutes = [];
	let currentHash = '#/';
	const location = {
		get hash() { return currentHash; },
		set hash(value) { locationWrites++; currentHash = value; }
	};
	const eventListeners = [];

	assert.equal(startForcedEnrollmentRouting(true, {
		location,
		addEventListener: (name, callback) => {
			eventListeners.push(name);
			screenListener = callback;
		},
		startSecurityScreen: () => { securityScreenStarts++; },
		schedule: callback => queuedRoutes.push(callback)
	}), true);
	assert.deepEqual(eventListeners, ['sm-show-screen']);
	assert.equal(securityScreenStarts, 1, 'pending enrollment starts the Security settings screen');
	assert.equal(currentHash, '#/', 'initial route waits until screens are registered');

	let securityPrevented = false;
	screenListener({ detail: 'settings/security', preventDefault: () => { securityPrevented = true; } });
	assert.equal(securityPrevented, false, 'the required enrollment screen remains navigable');

	let mailboxPrevented = false;
	screenListener({ detail: 'mailbox', preventDefault: () => { mailboxPrevented = true; } });
	assert.equal(mailboxPrevented, true, 'mailbox navigation is prevented while enrollment is pending');
	assert.equal(currentHash, '#/settings/security');
	assert.equal(locationWrites, 1);

	let settingsPrevented = false;
	screenListener({ detail: 'settings/general', preventDefault: () => { settingsPrevented = true; } });
	assert.equal(settingsPrevented, true, 'ordinary settings navigation is prevented');
	assert.equal(locationWrites, 1, 'the security route does not redirect repeatedly');
	queuedRoutes[0]();
	assert.equal(locationWrites, 1, 'the initial route does not create a redirect loop');

	let optionalListeners = 0,
		optionalScreenStarts = 0,
		optionalSchedules = 0;
	assert.equal(startForcedEnrollmentRouting(false, {
		location,
		addEventListener: () => { optionalListeners++; },
		startSecurityScreen: () => { optionalScreenStarts++; },
		schedule: () => { optionalSchedules++; }
	}), false);
	assert.deepEqual([optionalListeners, optionalScreenStarts, optionalSchedules], [0, 0, 0],
		'optional 2FA users retain ordinary routing');
});

test('native request construction preserves two-factor challenge and sign-me boundaries', () => {
	const begin = new FormData();
	begin.set('Email', 'person@example.test');
	begin.set('Password', 'primary password');
	completeLoginRequestData(begin, {
		step: LoginStep.Primary,
		language: 'de',
		signMe: true
	});
	assert.equal(begin.get('Email'), 'person@example.test');
	assert.equal(begin.get('Password'), 'primary password');
	assert.equal(begin.get('language'), 'de');
	assert.equal(begin.get('signMe'), '1');
	assert.equal(begin.has('Code'), false);
	assert.equal(begin.has('Challenge'), false);
	assert.equal(begin.has('totp_code'), false);

	const verify = new FormData();
	verify.set('Email', 'person@example.test');
	verify.set('Password', 'primary password');
	verify.set('totp_code', 'legacy-factor-must-not-leak');
	assert.equal(verify.has('signMe'), false);
	completeLoginRequestData(verify, {
		step: LoginStep.Factor,
		language: 'de',
		signMe: true,
		challenge: 'A'.repeat(43),
		code: '987654321'
	});
	assert.equal(verify.get('language'), 'de');
	assert.equal(verify.get('Challenge'), 'A'.repeat(43));
	assert.equal(verify.get('Code'), '987654321');
	assert.equal(verify.has('totp_code'), false);
	assert.equal(verify.has('signMe'), false,
		'the server-held challenge remains authoritative for Remember Me intent');
});

test('login template and view implement conditional native two-step controls', async () => {
	const [template, login, adminLogin, userApp, userActions, twoFactorActions] = await Promise.all([
		source('snappymail/v/0.0.0/app/templates/Views/User/Login.html'),
		source('dev/View/User/Login.js'),
		source('dev/View/Admin/Login.js'),
		source('dev/App/User.js'),
		source('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php'),
		source('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/TwoFactor.php')
	]);

	const factorBlock = template.match(/<!-- ko if: 'factor' === loginStep\(\) -->([\s\S]*?)<!-- \/ko -->/);
	assert.ok(factorBlock, 'factor markup is guarded by actual Knockout conditional rendering');
	assert.match(factorBlock[1], /name="Code"[\s\S]*?autocomplete="one-time-code"/);
	assert.match(factorBlock[1], /inputmode="numeric"/);
	assert.match(factorBlock[1], /<label for="login-factor-code"/);
	assert.match(factorBlock[1], /i18nUpdate: loginStep/,
		'conditionally inserted labels and actions are translated after the factor step is rendered');
	assert.equal((template.match(/i18nUpdate: loginStep/g) || []).length, 5,
		'primary controls regain their labels and button text after Back');
	assert.doesNotMatch(factorBlock[1], /name="(?:Email|Password)"|type="hidden"|pattern=|maxlength=/);
	assert.match(template, /submit: submitCommand/);
	assert.equal((template.match(/click: submitCommand/g) || []).length, 2,
		'both native step buttons use the same command and the form supports Enter');
	assert.doesNotMatch(template, /plugin-Login-BottomControlGroup|sm-user-login|sm-admin-login/,
		'login templates expose no generic plugin event or insertion surface');
	assert.match(template, /role="alert" aria-live="assertive"/);
	assert.match(template, /click: toggleSignMe, onSpace: toggleSignMe/);
	assert.match(template, /'aria-disabled': submitRequest\(\) \? 'true' : 'false'/);
	assert.match(login, /Remote\.request\(isPrimary \? 'TwoFactorLoginBegin' : 'TwoFactorLoginVerify'/);
	assert.match(login, /const data = new FormData\(\);[\s\S]*?data\.set\('Email'/,
		'Core constructs the native authentication request directly');
	assert.doesNotMatch(login + adminLogin, /sm-(?:user|admin)-login(?:-response)?|fireEvent\(/,
		'neither login view dispatches generic plugin events');
	assert.match(login, /submitCommand\(self, event\)/);
	assert.match(template, /submit: submitCommand/);
	assert.doesNotMatch(login, /Remote\.request\('Login'/,
		'the normal native UI does not use the legacy Login action');
	assert.match(login, /Remote\.request\('TwoFactorLoginAbort'/);
	assert.match(login, /challenge\.account/);
	assert.match(login, /challenge\.id/);
	assert.match(login, /requestRevision !== this\.requestRevision/);
	assert.match(login, /this\.submitRequest\(\)\s*\|\|\s*this\.loginComplete/);
	assert.match(login, /this\.password\(''\)/);
	assert.match(login, /Local\.set\(ClientSideKeyNameLastSignMe/);
	assert.doesNotMatch(login, /localStorage|sessionStorage|URLSearchParams|Settings\.set\(/);
	assert.match(userApp, /startForcedEnrollmentRouting\(SettingsGet\('SetupTwoFactor'\)/,
		'the user app delegates forced routing to the tested native router helper');
	assert.doesNotMatch(userApp, /plugins\/two-factor-auth/);
	assert.match(userActions, /private function persistLoginLanguage/);
	assert.match(userActions, /persistLoginLanguage\(\$oAccount\)/);
	assert.equal((twoFactorActions.match(/persistLoginLanguage\(\$oAccount\)/g) || []).length, 2,
		'language is persisted on no-factor/pending Begin and final Verify only');
});

test('forced-enrollment Security template conditionally removes ordinary settings', async () => {
	const template = await source('snappymail/v/0.0.0/app/templates/Views/User/SettingsSecurity.html');
	let depth = 0;
	for (const [, comment] of template.matchAll(/<!--\s*(.*?)\s*-->/gs)) {
		const directive = comment.trim();
		if (/^ko\b/.test(directive)) {
			depth++;
		} else if (/^\/ko\b/.test(directive)) {
			depth--;
			assert.ok(depth >= 0, 'Knockout closing comments must have a matching opener');
		}
	}
	assert.equal(depth, 0, 'Security enrollment template must not contain unmatched Knockout comments');
	assert.match(template, /<div data-bind="ifnot: forcedEnrollment">/,
		'ordinary Security settings remain conditionally rendered during forced enrollment');
	assert.doesNotMatch(template, /<!-- ko ifnot: forcedEnrollment -->/,
		'forced enrollment does not depend on a large virtual-comment block');
});

test('native login translations have four parity keys in every user locale', async () => {
	const root = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/localization');
	const locales = (await readdir(root, {withFileTypes: true}))
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name);
	assert.equal(locales.length, 38);
	for (const locale of locales) {
		const catalog = JSON.parse(await source(`snappymail/v/0.0.0/app/localization/${locale}/user.json`));
		for (const key of ['TWO_FACTOR_TITLE', 'TWO_FACTOR_INSTRUCTION', 'TWO_FACTOR_CODE', 'BUTTON_VERIFY']) {
			assert.equal(typeof catalog.LOGIN?.[key], 'string', `${locale} LOGIN/${key}`);
			assert.ok(catalog.LOGIN[key].trim(), `${locale} LOGIN/${key} is not empty`);
		}
	}
});
