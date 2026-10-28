import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
	contractSource = await readFile(path.join(repositoryRoot, 'dev/Common/Appearance.js'), 'utf8'),
	contract = await import('data:text/javascript;base64,' + Buffer.from(contractSource).toString('base64')),
	appearanceStoreSource = await readFile(path.join(repositoryRoot, 'dev/Stores/Appearance.js'), 'utf8'),
	appearanceGeneralSource = await readFile(path.join(repositoryRoot, 'dev/Settings/User/General.js'), 'utf8'),
	appearanceStyles = await readFile(path.join(repositoryRoot, 'dev/Styles/Appearance.less'), 'utf8'),
	indexTemplate = await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/templates/Index.html'), 'utf8'),
	settingsTemplate = await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/templates/Views/User/SettingsGeneral.html'), 'utf8'),
	headerTemplate = await readFile(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/templates/Views/User/SystemDropDown.html'), 'utf8'),
	bootstrapSource = indexTemplate.match(/<script id="appearance-bootstrap"[^>]*>([\s\S]*?)<\/script>/)?.[1];

function createRoot(attributes = {}) {
	const values = new Map(Object.entries(attributes));
	return {
		getAttribute: name => values.get(name) ?? null,
		setAttribute: (name, value) => values.set(name, value),
		removeAttribute: name => values.delete(name),
		attributes: values
	};
}

function runBootstrap(preference, prefersDark) {
	const root = createRoot(preference ? { 'data-appearance-preference': preference } : {});
	vm.runInNewContext(bootstrapSource, {
		document: { documentElement: root },
		window: { matchMedia: () => ({ matches: prefersDark }) }
	});
	return root.getAttribute('data-appearance-scheme');
}

class MediaQueryMock {
	matches = false;
	listeners = new Set();

	addEventListener(name, listener) {
		assert.equal(name, 'change');
		this.listeners.add(listener);
	}

	removeEventListener(name, listener) {
		assert.equal(name, 'change');
		this.listeners.delete(listener);
	}

	change(matches) {
		this.matches = matches;
		for (const listener of this.listeners) {
			listener({ matches });
		}
	}
}

test('the nonce-bearing pre-paint resolver matches the closed runtime mapping', () => {
	assert.ok(bootstrapSource, 'the document contains its early appearance bootstrap');
	assert.match(indexTemplate, /<script id="appearance-bootstrap" nonce=""/,
		'the early resolver uses the existing trusted nonce replacement');
	assert.doesNotMatch(bootstrapSource, /data-appearance-scheme['"]\s*,\s*preference/,
		'user preference is never copied without a closed branch');

	for (const preference of ['light', 'dark', 'system']) {
		for (const prefersDark of [false, true]) {
			const early = runBootstrap(preference, prefersDark),
				runtime = contract.resolveEffectiveColorScheme(preference, prefersDark);
			assert.equal(early, runtime, `${preference} with OS dark=${prefersDark}`);
			assert.ok(contract.isEffectiveColorScheme(early));
		}
	}

	assert.equal(runBootstrap('invalid', true), null, 'malformed pre-paint preferences do not set a scheme');
	assert.equal(runBootstrap('', true), null, 'Login/Admin documents do not receive an effective user scheme');
	assert.equal(contract.resolveEffectiveColorScheme('invalid', true), null);
});

test('System follows live OS changes while fixed preferences detach the listener', () => {
	const root = createRoot(),
		media = new MediaQueryMock(),
		controller = contract.createAppearanceController(root, media);

	assert.equal(controller.setPreference('system'), true);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'light');
	assert.equal(media.listeners.size, 1);
	media.change(true);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'dark');
	media.change(false);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'light');

	assert.equal(controller.setPreference('dark'), true);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'dark');
	assert.equal(media.listeners.size, 0);
	media.change(false);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'dark', 'fixed Dark ignores OS changes');

	assert.equal(controller.setPreference('light'), true);
	media.change(true);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'light', 'fixed Light ignores OS changes');
	assert.equal(media.listeners.size, 0);

	media.change(true);
	assert.equal(controller.setPreference('system'), true);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'dark', 'switching to System resolves current OS state immediately');
	assert.equal(media.listeners.size, 1);
});

test('reinitialization and account clearing do not leak media-query listeners or DOM values', () => {
	const root = createRoot(),
		media = new MediaQueryMock(),
		controller = contract.createAppearanceController(root, media);

	for (let i = 0; i < 5; i++) {
		controller.setPreference('system');
		assert.equal(media.listeners.size, 1);
	}
	controller.setPreference('dark');
	assert.equal(media.listeners.size, 0);
	assert.equal(root.getAttribute('data-appearance-scheme'), 'dark');
	assert.equal(controller.setPreference('dark<script>'), false);
	assert.equal(root.getAttribute('data-appearance-scheme'), null, 'malformed input removes the previous effective scheme');
	assert.equal(media.listeners.size, 0);

	controller.setPreference('system');
	controller.clear();
	assert.equal(media.listeners.size, 0);
	assert.equal(root.getAttribute('data-appearance-scheme'), null);
	assert.equal(controller.getPreference(), null);
});

test('rapid preference writes are serialized so an older result cannot overwrite the latest choice', () => {
	const requests = [],
		results = [],
		write = contract.createAppearanceWriteQueue(
			(preference, callback) => requests.push({ preference, callback }),
			(preference, error, latest) => results.push({ preference, error, latest })
		);

	assert.equal(write('dark'), true);
	assert.equal(write('light'), true);
	assert.equal(write('system'), true);
	assert.deepEqual(requests.map(request => request.preference), ['dark'], 'only one POST is in flight');
	requests[0].callback(0);
	assert.deepEqual(requests.map(request => request.preference), ['dark', 'system'], 'only the latest queued selection is sent next');
	assert.deepEqual(results, [{ preference: 'dark', error: 0, latest: false }]);
	requests[1].callback(0);
	assert.deepEqual(results[1], { preference: 'system', error: 0, latest: true });
	assert.equal(write('dark<script>'), false, 'invalid values never enter the persistence queue');
});

test('User General exposes exactly the three closed native choices', () => {
	const options = [...settingsTemplate.matchAll(/<option value="([^"]+)" data-i18n="SETTINGS_APPEARANCE\/(?:LIGHT|DARK|SYSTEM)"><\/option>/g)]
		.map(([, value]) => value);
	assert.deepEqual(options, ['light', 'dark', 'system']);
	assert.match(settingsTemplate, /data-bind="value: appearance"/);
	assert.match(settingsTemplate, /saveTrigger: appearanceTrigger/);
});

test('the header switch and Settings selector share one localized Appearance observable', () => {
	const choices = [...headerTemplate.matchAll(/<input type="radio" name="header-appearance" value="(light|dark|system)" data-bind="checked: appearancePreference" data-i18n="\[aria-label\]SETTINGS_APPEARANCE\/(LIGHT|DARK|SYSTEM)">/g)];
	assert.deepEqual(choices.map(([, value, label]) => [value, label.toLowerCase()]), [
		['light', 'light'], ['dark', 'dark'], ['system', 'system']
	]);
	assert.match(headerTemplate, /class="appearance-quick-switch" role="radiogroup"[^>]*data-i18n="\[aria-label\]SETTINGS_APPEARANCE\/LABEL"/);
	assert.match(headerTemplate, /appearancePreference\(\) === 'light'/);
	assert.match(headerTemplate, /appearancePreference\(\) === 'dark'/);
	assert.match(headerTemplate, /appearancePreference\(\) === 'system'/);
	assert.match(headerTemplate, /data-ui-icon="sun" aria-hidden="true"/);
	assert.match(headerTemplate, /data-ui-icon="moon" aria-hidden="true"/);
	assert.match(headerTemplate, /data-ui-icon="monitor" aria-hidden="true"/);
	assert.match(headerTemplate, /visible: appearancePreference\(\)/, 'the quick switch is absent while authenticated appearance is cleared');
	assert.match(appearanceStoreSource, /preference: ko\.observable\(null\)/);
	assert.match(appearanceStoreSource, /createAppearanceWriteQueue\([\s\S]*?Remote\.saveSetting\('Appearance'/);
	assert.equal((appearanceStoreSource.match(/preference:\s*ko\.observable\(/g) || []).length, 1);
	assert.doesNotMatch(appearanceStoreSource, /\bcurrentPreference\b/, 'the shared observable has no mirror preference state');
	assert.match(appearanceGeneralSource, /this\.appearance = AppearanceStore\.preference;/);
	assert.match(appearanceGeneralSource, /this\.appearanceTrigger = AppearanceStore\.saveStatus;/);
	assert.doesNotMatch(appearanceGeneralSource, /this\.appearance\s*=\s*ko\.observable/);
	assert.doesNotMatch(headerTemplate, /fontastic|https?:|data:image/i);
});

test('Light and Dark share native tokens and map dialog compatibility tokens', () => {
	const declarations = preference => {
		const rule = appearanceStyles.match(new RegExp(`html\\[data-appearance-scheme="${preference}"\\][^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1];
		assert.ok(rule, `${preference} token rule exists`);
		return new Map([...rule.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
			.map(([, name, value]) => [name, value.trim()]));
	};
	const light = declarations('light'),
		dark = declarations('dark'),
		lightNativeTokens = [...light.keys()].filter(name => name.startsWith('--appearance-')).sort(),
		darkNativeTokens = [...dark.keys()].filter(name => name.startsWith('--appearance-')).sort();

	assert.deepEqual(darkNativeTokens, lightNativeTokens, 'both schemes define the same native semantic vocabulary');
	for (const name of lightNativeTokens) {
		assert.ok(light.get(name), `${name} has a Light value`);
		assert.ok(dark.get(name), `${name} has a Dark value`);
	}
	assert.equal(dark.get('--dialog-clr'), 'var(--appearance-text-primary)');
	assert.equal(dark.get('--dialog-bg-clr'), 'var(--appearance-surface-raised)');
	assert.equal(dark.get('--dialog-border-clr'), 'var(--appearance-border)');
});
