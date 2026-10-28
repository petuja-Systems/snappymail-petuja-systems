import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
	base = 'snappymail/v/0.0.0/app/templates/Views',
	paths = {
		accounts: `${base}/User/SettingsAccounts.html`,
		folders: `${base}/User/SettingsFolderItem.html`,
		domains: `${base}/Admin/AdminSettingsDomains.html`,
		userGeneral: `${base}/User/SettingsGeneral.html`,
		userFilters: `${base}/User/SettingsFilters.html`,
		userFolders: `${base}/User/SettingsFolders.html`,
		userSecurity: `${base}/User/SettingsSecurity.html`,
		userMenu: `${base}/User/SettingsMenu.html`,
		adminPane: `${base}/Admin/AdminPane.html`,
		adminAbout: `${base}/Admin/AdminSettingsAbout.html`,
		adminContacts: `${base}/Admin/AdminSettingsContacts.html`,
		adminGeneral: `${base}/Admin/AdminSettingsGeneral.html`,
		adminSecurity: `${base}/Admin/AdminSettingsSecurity.html`,
		accountPopup: `${base}/User/PopupsAccount.html`,
		identityPopup: `${base}/User/PopupsIdentity.html`,
		folderPopup: `${base}/User/PopupsFolder.html`,
		folderCreatePopup: `${base}/User/PopupsFolderCreate.html`,
		folderSystemPopup: `${base}/User/PopupsFolderSystem.html`,
		folderAclPopup: `${base}/User/PopupsFolderACL.html`,
		openPgpPopup: `${base}/User/PopupsOpenPgpKey.html`,
		sievePopup: `${base}/User/PopupsSieveScript.html`,
		filterPopup: `${base}/User/PopupsFilter.html`,
		domainPopup: `${base}/Admin/PopupsDomain.html`,
		domainAliasPopup: `${base}/Admin/PopupsDomainAlias.html`
	},
	closureFiles = Object.values(paths),
	read = relative => readFile(join(root, relative), 'utf8'),
	stripComments = source => source.replace(/<!--[\s\S]*?-->/g, ''),
	elements = source => [...stripComments(source).matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)]
		.map(([, tag, attributes]) => ({ tag: tag.toLowerCase(), attributes })),
	withClass = (source, className) => elements(source)
		.filter(({ attributes }) => (attributes.match(/\bclass="([^"]*)"/)?.[1] || '')
			.split(/\s+/).includes(className)),
	buttonWithClass = (source, className, action) => {
		const controls = withClass(source, className)
			.filter(({ attributes }) => new RegExp(`data-bind="[^"]*\\b${action}\\s*:`).test(attributes));
		assert.ok(controls.length, `expected .${className} with ${action} binding`);
		for (const { tag, attributes } of controls) {
			assert.equal(tag, 'button', `.${className} must be a native button`);
			assert.match(attributes, /\btype="button"/, `.${className} must not submit an enclosing form`);
		}
		return controls;
	};

const sources = Object.fromEntries(await Promise.all(Object.entries(paths)
	.map(async ([name, path]) => [name, await read(path)]))),
	[userCatalog, adminCatalog, iconRegistry] = await Promise.all([
		read('snappymail/v/0.0.0/app/localization/en/user.json').then(JSON.parse),
		read('snappymail/v/0.0.0/app/localization/en/admin.json').then(JSON.parse),
		read('dev/Styles/UiIcons.less')
	]);

const hasTranslation = (key, catalog) => {
	const [section, name] = key.split('/');
	return Boolean(catalog[section]?.[name]);
};

test('account and identity deletion use named native buttons and retain the confirmation action', () => {
	assert.equal(withClass(sources.accounts, 'delete').length, 2);
	for (const { tag, attributes } of withClass(sources.accounts, 'delete')) {
		assert.equal(tag, 'button');
		assert.match(attributes, /\btype="button"/);
		assert.match(attributes, /data-ui-icon="trash-2"/);
		assert.match(attributes, /data-i18n="\[aria-label\]GLOBAL\/DELETE"/);
	}
	for (const className of ['account-name', 'identity-name']) {
		const [control] = withClass(sources.accounts, className);
		assert.equal(control?.tag, 'button', `.${className} remains keyboard operable`);
		if (className === 'account-name') {
			assert.match(control.attributes, /data-bind="text:\s*displayName/);
		} else {
			assert.match(sources.accounts, /<button[^>]*class="identity-name[\s\S]*?formattedName\(\)[\s\S]*?identity-default[\s\S]*?<\/button>/,
				'the identity label and default marker remain in the same action target');
		}
	}
	const confirmations = withClass(sources.accounts, 'button-confirm-delete');
	assert.equal(confirmations.length, 2);
	for (const { tag, attributes } of confirmations) {
		assert.equal(tag, 'button');
		assert.match(attributes, /\btype="button"/);
		assert.match(attributes, /hasfocus:\s*askDelete/);
		assert.match(attributes, /data-i18n="GLOBAL\/ARE_YOU_SURE"/);
	}
});

test('folder delete and state toggles expose localized names and synchronized pressed state', () => {
	const deleteButton = buttonWithClass(sources.folders, 'ui-icon-only', 'click')
		.find(({ attributes }) => /folderForDeletion/.test(attributes));
	assert.match(deleteButton.attributes, /data-i18n="\[aria-label\]SETTINGS_FOLDERS\/HELP_DELETE_FOLDER"/);
	assert.match(deleteButton.attributes, /visible:\s*canBeDeleted\(\)\s*&&\s*!askDelete\(\)/);

	const subscription = withClass(sources.folders, 'ui-icon-only')
		.find(({ attributes }) => /toggleFolderSubscription/.test(attributes));
	assert.equal(subscription.tag, 'button');
	assert.match(subscription.attributes, /aria-pressed':\s*isSubscribed\(\)/);
	assert.match(subscription.attributes, /data-i18n="\[aria-label\]SETTINGS_FOLDERS\/HELP_SHOW_HIDE_FOLDER"/);

	const checkable = withClass(sources.folders, 'ui-icon-only')
		.find(({ attributes }) => /toggleFolderCheckable/.test(attributes));
	assert.equal(checkable.tag, 'button');
	assert.match(checkable.attributes, /aria-pressed':\s*checkable\(\)/);
	assert.match(checkable.attributes, /data-i18n="\[aria-label\]SETTINGS_FOLDERS\/HELP_CHECK_FOR_NEW_MESSAGES"/);
});

test('Admin domain delete and enable state use named, keyboard-operable buttons', async () => {
	const deleteButton = withClass(sources.domains, 'delete-domain')[0];
	assert.equal(deleteButton.tag, 'button');
	assert.match(deleteButton.attributes, /\btype="button"/);
	assert.match(deleteButton.attributes, /data-i18n="\[aria-label\]GLOBAL\/DELETE"/);
	const confirmButton = withClass(sources.domains, 'button-confirm-delete')[0];
	assert.equal(confirmButton.tag, 'button');
	assert.match(confirmButton.attributes, /hasfocus:\s*askDelete/);
	assert.match(confirmButton.attributes, /data-i18n="TAB_DOMAINS\/DELETE_ARE_YOU_SURE"/);
	const enabledButton = withClass(sources.domains, 'disabled-domain')[0];
	assert.equal(enabledButton.tag, 'button');
	assert.match(enabledButton.attributes, /\btype="button"/);
	assert.doesNotMatch(enabledButton.attributes, /aria-label':\s*name\b/,
		'the domain name alone does not describe the enabled-state control');
	assert.match(enabledButton.attributes,
		/aria-label':\s*rl\.i18n\('TAB_DOMAINS\/LABEL_TOGGLE_DOMAIN_ENABLED',\s*\{\s*NAME:\s*name\s*\}\)/);
	assert.match(adminCatalog.TAB_DOMAINS.LABEL_TOGGLE_DOMAIN_ENABLED, /enable or disable domain %NAME%/i,
		'the localized name communicates the control purpose and includes the domain context');
	assert.match(enabledButton.attributes, /aria-pressed':\s*!disabled\(\)/);
	assert.match(enabledButton.attributes, /data-ui-icon':\s*disabled\(\)\s*\?\s*'square'\s*:\s*'square-check'/);
	assert.match(enabledButton.attributes, /click:\s*function \(oDomain\) \{\s*\$root\.disableDomain\(oDomain\);\s*\}/);
	assert.match(sources.domains, /<button[^>]*class="domain-name[\s\S]*?text:\s*name[\s\S]*?domain-alias[\s\S]*?<\/button>/,
		'the domain name and alias remain in the same action target');
	const domainStyles = await read('dev/Styles/Admin/Domains.less');
	assert.match(domainStyles, /\.domain-name\s*\{[^}]*display:\s*block;[^}]*width:\s*100%/s);
});

test('the audited settings and dialog surfaces have no click-bound non-interactive elements', async () => {
	for (const path of closureFiles) {
		for (const { tag, attributes } of elements(await read(path))) {
			const binding = attributes.match(/\bdata-bind="([^"]*)"/)?.[1] || '';
			if (!/\b(?:click|command)\s*:/.test(binding)) continue;
			const native = ['button', 'input', 'select', 'textarea', 'summary'].includes(tag);
			const link = tag === 'a' && /\bhref="(?!#)[^"]+"/.test(attributes);
			assert.ok(native || link, `${path}: <${tag}> with click/command binding is not semantic`);
			if (tag === 'button') assert.match(attributes, /\btype="(?:button|submit)"/,
				`${path}: bound button must state its form behavior`);
		}
	}
});

test('delegated account, domain, and Sieve row actions retain native full-width button targets', async () => {
	for (const className of ['account-name', 'identity-name']) {
		const [control] = withClass(sources.accounts, className);
		assert.equal(control.tag, 'button');
		assert.match(control.attributes, /\btype="button"/);
	}
	assert.match(sources.domains, /<td class="e-action">\s*<button[^>]*class="domain-name/);
	assert.match(sources.sievePopup, /<td class="e-action">\s*<button[^>]*class="filter-edit ui-text-action"/);
	assert.match(sources.userFilters, /<button[^>]*class="e-action script-name ui-text-action"/);
	const [accounts, domains, filters, sieve] = await Promise.all([
		read('dev/Settings/User/Accounts.js'), read('dev/Settings/Admin/Domains.js'),
		read('dev/Settings/User/Filters.js'), read('dev/Sieve/View/Script.js')
	]);
	assert.match(accounts, /closestWithin\('\.accounts-list \.e-action'/);
	assert.match(accounts, /closestWithin\('\.identities-list \.e-action'/);
	assert.match(domains, /closestWithin\('\.b-admin-domains-list-table \.e-action'/);
	assert.match(filters, /closestWithin\('\.script-item \.script-name'/);
	assert.match(sieve, /closestWithin\('td\.e-action'/);
	const [accountStyles, domainStyles, filterStyles] = await Promise.all([
		read('dev/Styles/User/SettingsAccounts.less'), read('dev/Styles/Admin/Domains.less'),
		read('dev/Styles/User/SettingsFilters.less')
	]);
	assert.match(accountStyles, /\.account-name\s*\{[^}]*display:\s*block;[^}]*width:\s*100%/s);
	assert.match(accountStyles, /\.identity-name\s*\{[^}]*display:\s*block;[^}]*width:\s*100%/s);
	assert.match(domainStyles, /\.domain-name\s*\{[^}]*display:\s*block;[^}]*width:\s*100%/s);
	assert.match(filterStyles, /#V-PopupsSieveScript \.filter-edit,[\s\S]*?width:\s*100%/);
});

test('new localized accessible names resolve and the translator applies aria-label attributes', async () => {
	for (const path of closureFiles) {
		const source = await read(path);
		for (const [, key] of source.matchAll(/data-i18n="\[aria-label\]([^\"]+)"/g)) {
			assert.ok(hasTranslation(key, userCatalog) || hasTranslation(key, adminCatalog),
				`${path} references missing English translation ${key}`);
		}
	}
	const translator = await read('dev/Common/Translator.js');
	assert.match(translator, /case 'aria-':\s*\{\s*const label = i18n\(key\.slice\(12\)\);\s*element\.setAttribute\('aria-label', label\);\s*element\.title = label;/);
	assert.match(sources.userGeneral, /aria-labelledby="settings-identity-label settings-identity-value"/);
	assert.match(sources.userGeneral, /aria-labelledby="settings-language-label settings-language-value"/);
	assert.match(sources.adminGeneral, /aria-labelledby="admin-language-label admin-language-value"/);
	assert.match(sources.adminGeneral, /aria-labelledby="admin-language-admin-label admin-language-admin-value"/);
});

test('keyboard focus remains visible for User, Admin, and Login without a global outline reset', async () => {
	const [main, userAppearance, adminLayout, login] = await Promise.all([
		read('dev/Styles/Main.less'),
		read('dev/Styles/Appearance.less'),
		read('dev/Styles/Admin/Layout.less'),
		read('dev/Styles/Login.less')
	]);
	assert.doesNotMatch(main, /(?:\*|select:focus)[^{]*\{[^}]*outline:\s*none/s);
	assert.match(userAppearance, /#V-SettingsPane :focus-visible[\s\S]*?outline:\s*2px solid/);
	assert.match(adminLayout, /#rl-app\[data-admin="1"\] :focus-visible\s*\{[^}]*outline:\s*2px solid #005fcc/s);
	assert.match(adminLayout, /#rl-app\[data-admin="1"\] :focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 4px #fff/s);
	assert.doesNotMatch(userAppearance, /#V-MailMessageView\s+:focus-visible|#V-PopupsCompose\s+:focus-visible/);
	assert.match(login, /&:focus,\s*&:focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 3px[^}]*outline:\s*none/s,
		'Login keeps its explicit visible focus shadow where its outline is reset');
});

test('all icons in the closure templates resolve through the local native SVG registry', async () => {
	const iconDir = join(root, 'snappymail/v/0.0.0/static/images/ui-icons'),
		icons = new Set((await readdir(iconDir)).filter(file => file.endsWith('.svg')).map(file => file.slice(0, -4))),
		registry = new Set([...iconRegistry.matchAll(/\[data-ui-icon="([a-z0-9-]+)"\]::before/g)].map(([, key]) => key)),
		settingsBuilder = await read('dev/Screen/AbstractSettings.js'),
		settingsIconMap = settingsBuilder.match(/const SETTINGS_MENU_ICONS = \{([\s\S]*?)\};/);
	for (const path of closureFiles) {
		for (const { attributes } of elements(await read(path))) {
			const staticIcon = attributes.match(/\bdata-ui-icon="([a-z0-9-]+)"/)?.[1];
			if (staticIcon) {
				if (staticIcon !== 'spacer') {
					assert.ok(icons.has(staticIcon), `${path}: missing local SVG ${staticIcon}`);
					assert.ok(registry.has(staticIcon), `${path}: missing registry mapping ${staticIcon}`);
				}
			}
			const binding = attributes.match(/\bdata-bind="([^"]*)"/)?.[1] || '';
			for (const [, expression] of binding.matchAll(/["']data-ui-icon["']\s*:\s*([^,}]+)/g)) {
				let keys = [...expression.matchAll(/["']([a-z][a-z0-9-]*)["']/g)].map(([, key]) => key);
				if (!keys.length) {
					assert.equal(expression.trim(), 'icon', `${path}: dynamic icon values must be explicit`);
					assert.ok(settingsIconMap, 'shared settings icons must use a fixed mapping');
					keys = [...settingsIconMap[1].matchAll(/^\s*[A-Za-z]+:\s*'([a-z0-9-]+)'/gm)].map(([, key]) => key);
					assert.ok(keys.length, 'shared settings icon mapping must not be empty');
				}
				for (const key of keys) {
					assert.ok(icons.has(key), `${path}: missing local SVG ${key}`);
					assert.ok(registry.has(key), `${path}: missing registry mapping ${key}`);
				}
			}
		}
	}
});

test('the active M4 icon and build architecture contains no Fontastic dependency', async () => {
	const activeFiles = [
		'dev/Styles/@Main.less', 'dev/Styles/@Admin.less', 'dev/Styles/UiIcons.less',
		'gulpfile.js', 'tasks/config.js', 'package.json',
		paths.accounts, paths.folders, paths.domains
	];
	const activeSource = await Promise.all(activeFiles.map(read)).then(parts => parts.join('\n'));
	assert.doesNotMatch(activeSource, /fontastic/i);
	await assert.rejects(read('tasks/vendors.js'), { code: 'ENOENT' });
	assert.match(iconRegistry, /mask-image:\s*url\("\.\.\/\.\.\/images\/ui-icons\/@\{name\}\.svg"\)/);
});
