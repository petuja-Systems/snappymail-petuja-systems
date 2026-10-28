import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
	read = relative => readFile(path.join(root, relative), 'utf8').then(source => source.replace(/\r\n/g, '\n')),
	[
		settingsBuilder,
		userScreen,
		adminScreen,
		userMenu,
		adminMenu,
		iconStyles,
		userLabels,
		adminLabels
	] = await Promise.all([
		read('dev/Screen/AbstractSettings.js'),
		read('dev/Screen/User/Settings.js'),
		read('dev/Screen/Admin/Settings.js'),
		read('snappymail/v/0.0.0/app/templates/Views/User/SettingsMenu.html'),
		read('snappymail/v/0.0.0/app/templates/Views/Admin/AdminMenu.html'),
		read('dev/Styles/UiIcons.less'),
		read('snappymail/v/0.0.0/app/localization/en/user.json').then(JSON.parse),
		read('snappymail/v/0.0.0/app/localization/en/admin.json').then(JSON.parse)
	]);

const expectedIcons = {
	About: 'info',
	Accounts: 'user-round',
	Branding: 'palette',
	Contacts: 'contact-round',
	Config: 'wrench',
	Domains: 'globe',
	Filters: 'filter',
	Folders: 'folder',
	General: 'settings',
	Login: 'key-round',
	Security: 'shield-check'
};

const navigationEntries = (source, start, end) => {
	const region = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
	return [...region.matchAll(/\b(?:User|Admin)Settings(General|Contacts|Accounts|Filters|Security|Folders|Domains|Login|Branding|Config|About)\b/g)]
		.map(([, name]) => name);
};

test('shared settings navigation maps every User and Admin section to an existing semantic icon', async () => {
	const iconMap = settingsBuilder.match(/const SETTINGS_MENU_ICONS = \{([\s\S]*?)\};/);
	assert.ok(iconMap, 'shared settings icon map exists');
	const actualIcons = Object.fromEntries(
		[...iconMap[1].matchAll(/^\s*([A-Za-z]+):\s*'([a-z0-9-]+)',?\s*$/gm)]
			.map(([, section, icon]) => [section, icon])
	);
	assert.deepEqual(actualIcons, expectedIcons);
	assert.match(settingsBuilder, /icon:\s*SETTINGS_MENU_ICONS\[name\]/);

	for (const icon of new Set(Object.values(expectedIcons))) {
		assert.match(iconStyles, new RegExp(`\\[data-ui-icon="${icon}"\\]::before`), `${icon} is registered`);
		const asset = await read(`snappymail/v/0.0.0/static/images/ui-icons/${icon}.svg`);
		assert.match(asset, /^<svg\b/);
		assert.doesNotMatch(asset, /<script\b|foreignObject|\b(?:href|src)\s*=|url\s*\(/i);
	}
});

test('User and Admin navigation labels, order, selected state, and native links remain intact', () => {
	assert.deepEqual(
		navigationEntries(userScreen, 'const views = [', 'views.forEach'),
		['General', 'Contacts', 'Accounts', 'Filters', 'Security', 'Folders']
	);
	assert.deepEqual(
		navigationEntries(adminScreen, '[\n\t\t\tAdminSettingsGeneral', '].forEach'),
		['General', 'Domains', 'Login', 'Branding', 'Contacts', 'Security', 'Config', 'About']
	);
	assert.deepEqual(userLabels.SETTINGS_LABELS, {
		GENERAL: 'General', CONTACTS: 'Contacts', FOLDERS: 'Folders',
		ACCOUNTS: 'Accounts', FILTERS: 'Filters', SECURITY: 'Security'
	});
	assert.deepEqual(adminLabels.SETTINGS_LABELS, {
		GENERAL: 'General', LOGIN: 'Login', BRANDING: 'Branding', CONTACTS: 'Contacts',
		DOMAINS: 'Domains', SECURITY: 'Security', CONFIG: 'Config', ABOUT: 'About'
	});

	for (const template of [userMenu, adminMenu]) {
		const nav = template.match(/<nav\b[\s\S]*?<\/nav>/)?.[0];
		assert.ok(nav, 'menu contains a nav');
		assert.match(nav, /<a\s+data-bind="css: \{'selected': selected \}, attr: \{ 'href': \$root\.link\(route\), 'data-i18n': label, 'data-ui-icon': icon \}"><\/a>/);
		assert.doesNotMatch(nav, /(?:tabindex|aria-label|<i\b|<svg\b)/i);
	}
});

test('settings navigation icons use only the existing local SVG mask system', () => {
	assert.match(iconStyles, /mask-image: url\("\.\.\/\.\.\/images\/ui-icons\/@\{name\}\.svg"\)/);
	assert.match(iconStyles, /width: var\(--ui-icon-size, 1em\)/);
	assert.match(iconStyles, /margin-inline-end: @spacing/);
	assert.match(iconStyles, /background-color: currentColor/);
	assert.doesNotMatch(settingsBuilder + userMenu + adminMenu + iconStyles, /fontastic|https?:\/\//i);
});
