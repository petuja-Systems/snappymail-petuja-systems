import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
	iconDir = join(root, 'snappymail/v/0.0.0/static/images/ui-icons'),
	registryPath = join(root, 'dev/Styles/UiIcons.less'),
	registry = await readFile(registryPath, 'utf8');

async function filesUnder(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	return (await Promise.all(entries.map(entry => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	}))).flat();
}

const iconFiles = await filesUnder(iconDir).then(paths => paths.filter(path => path.endsWith('.svg'))),
	iconNames = new Set(iconFiles.map(path => path.slice(iconDir.length + 1, -4))),
	registryNames = new Set([...registry.matchAll(/\[data-ui-icon="([a-z0-9-]+)"\]::before/g)].map(match => match[1])),
	registryPseudoNames = new Set([...registry.matchAll(/\.ui-icon-pseudo\(([a-z0-9-]+)/g)].map(match => match[1]));

const dynamicIconValueAllowlist = {
	icon: ['inbox', 'send', 'file-text', 'flame', 'trash-2', 'archive'],
	'collapsedIcon()': ['chevron-right', 'chevron-down'],
	sortFieldIcon: ['at-sign', 'file-text', 'mail', 'calendar-days'],
	sortDirectionIcon: ['arrow-down', 'arrow-up'],
	attachmentIconClass: [
		'lock-keyhole', 'paperclip', 'file', 'file-text', 'mail', 'file-code-2', 'image',
		'audio-lines', 'clapperboard', 'archive', 'file-badge', 'table-2', 'presentation', 'calendar-days'
	],
	dkimIcon: ['check', 'x'],
	'iconClass()': [
		'file', 'file-text', 'mail', 'file-code-2', 'image', 'audio-lines', 'clapperboard',
		'archive', 'file-badge', 'table-2', 'presentation', 'calendar-days'
	]
};

test('the fixed UI icon registry and local SVG assets stay in sync', () => {
	assert.deepEqual([...registryNames].filter(name => name !== 'spacer').sort(), [...iconNames].sort());
	for (const name of registryPseudoNames) {
		assert.ok(iconNames.has(name), `Missing SVG for CSS icon ${name}`);
	}
	assert.match(registry, /background-color:\s*currentColor/);
	assert.match(registry, /mask-image:\s*url\("\.\.\/\.\.\/images\/ui-icons\/@\{name\}\.svg"\)/);
	assert.doesNotMatch(registry, /https?:|data:/i);
});

test('shared icon geometry keeps toolbar, status, label, and RTL spacing predictable', async () => {
	const helpers = await readFile(join(root, 'dev/Styles/UiHelpers.less'), 'utf8'),
		rtl = await readFile(join(root, 'dev/Styles/rtl.less'), 'utf8'),
		messageListStyles = await readFile(join(root, 'dev/Styles/User/MessageList.less'), 'utf8'),
		folderStyles = await readFile(join(root, 'dev/Styles/User/FolderList.less'), 'utf8');
	assert.match(registry, /width:\s*var\(--ui-icon-size,\s*1em\)/);
	assert.match(registry, /height:\s*var\(--ui-icon-size,\s*1em\)/);
	assert.match(registry, /margin-inline-end:\s*@spacing/);
	assert.match(registry, /data-ui-icon-after="chevron-down"\]::after\s*\{[\s\S]*?margin-inline-start:\s*0\.25em/);
	assert.doesNotMatch(registry, /margin-(?:left|right)\s*:/);

	assert.match(helpers, /--ui-icon-size-toolbar:\s*1rem/);
	assert.match(helpers, /--ui-icon-size-sidebar:\s*1rem/);
	assert.match(helpers, /--ui-icon-size-status:\s*0\.875rem/);
	assert.match(helpers, /--ui-icon-size-large:\s*1\.5rem/);
	assert.match(helpers, /\.btn\.ui-icon,[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;[\s\S]*?line-height:\s*2em;[\s\S]*?min-height:\s*30px/);
	assert.match(helpers, /\.btn\.ui-icon::before,[\s\S]*?margin-inline-end:\s*0/);
	assert.match(helpers, /\[data-ui-icon\]\.ui-icon-only::before,[\s\S]*?\.btn:empty\[data-ui-icon\]::before\s*\{[^}]*margin-inline-end:\s*0/s);
	assert.doesNotMatch(helpers, /\.ui-icon\s*\+\s*span/);
	assert.match(helpers, /\.ui-spinner\s*\+\s*span\s*\{\s*margin-inline-start:\s*0\.5em/);
	assert.doesNotMatch(rtl, /\.ui-icon\s*\+\s*span|\[data-ui-icon\]::before|\[data-ui-icon-after\]::after/);
	assert.match(messageListStyles, /\.checkboxCheckAll\s*\{[^}]*--ui-icon-size:\s*var\(--ui-icon-size-status\)/s);
	assert.match(messageListStyles, /\.checkboxMessage\s*\{[^}]*--ui-icon-size:\s*var\(--ui-icon-size-status\)/s);
	assert.match(folderStyles, /\.flag-icon\s*\{[^}]*margin-inline-start:\s*7px/s);
});

test('icon-only message controls use the shared geometry helper', async () => {
	const list = await readFile(join(root, 'snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html'), 'utf8'),
		view = await readFile(join(root, 'snappymail/v/0.0.0/app/templates/Views/User/MailMessageView.html'), 'utf8');
	assert.match(list, /class="[^"]*buttonCompose[^"]*ui-icon-only[^"]*"/);
	assert.match(list, /class="[^"]*ui-icon-only[^"]*" data-bind="click: reload"/);
	assert.match(list, /class="[^"]*ui-icon-only[^"]*" data-bind="command: moveCommand"/);
	assert.match(list, /class="[^"]*ui-icon-only[^"]*" data-bind="visible: isSpamFolder, command: notSpamCommand"/);
	assert.match(list, /class="[^"]*buttonMoreSearch[^"]*ui-icon-only[^"]*"/);
	assert.match(list, /class="[^"]*closeSearch[^"]*ui-icon-only[^"]*"/);
	assert.match(view, /class="[^"]*ui-icon-only[^"]*" data-bind="visible: isSpamFolder, command: notSpamCommand"/);
});

test('read-state menu actions use local semantic icons and retain their menu contract', async () => {
	const list = await readFile(join(root, 'snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html'), 'utf8'),
		view = await readFile(join(root, 'snappymail/v/0.0.0/app/templates/Views/User/MailMessageView.html'), 'utf8'),
		actions = [...list.matchAll(/<li role="presentation" data-bind="click: (listUnsetSeen|listSetSeen), css: \{'disabled': !messageList\.hasCheckedOrSelected\(\)\}">([\s\S]*?)<\/li>/g)];

	assert.deepEqual(actions.map(([, action]) => action), ['listUnsetSeen', 'listSetSeen']);
	for (const [index, [fullRow, action, row]] of actions.entries()) {
		const [icon, key] = index === 0
			? ['mail', 'MENU_UNSET_SEEN']
			: ['mail-open', 'MENU_SET_SEEN'];
		const anchor = row.match(/<a\b[^>]*><\/a>/)?.[0];
		assert.ok(anchor, `${action} must remain a plain anchor without child markup`);
		assert.match(anchor, /^<a href="#" tabindex="-1" data-ui-icon="[a-z-]+" data-i18n="MESSAGE_LIST\/MENU_[A-Z_]+"><\/a>$/);
		assert.match(anchor, new RegExp(`data-ui-icon="${icon}"`));
		assert.match(anchor, new RegExp(`data-i18n="MESSAGE_LIST/${key}"`));
		assert.match(fullRow, /css: \{'disabled': !messageList\.hasCheckedOrSelected\(\)\}/);
		assert.match(registry, new RegExp(`\\[data-ui-icon="${icon}"\\]::before\\s*\\{\\s*\\.ui-icon-pseudo\\(${icon}\\);\\s*\\}`));
	}

	assert.match(list, /<li role="presentation" data-bind="click: listSetAllSeen, css: \{'disabled': !messageList\(\)\.length\}">\s*<a href="#" tabindex="-1" data-ui-icon="check-check" data-i18n="MESSAGE_LIST\/MENU_SET_ALL_SEEN"><\/a>/);
	assert.match(registry, /\[data-ui-icon="check-check"\]::before\s*\{\s*\.ui-icon-pseudo\(check-check\);\s*\}/);
	assert.match(view, /<a href="#" tabindex="-1" data-bind="click: setUnseen" data-ui-icon="mail" data-i18n="MESSAGE_LIST\/MENU_UNSET_SEEN"><\/a>/);
});

test('all static and allowlisted dynamic icon keys resolve to a trusted local asset', async () => {
	const sources = [
		...(await filesUnder(join(root, 'dev'))),
		...(await filesUnder(join(root, 'snappymail/v/0.0.0/app/templates')))
	].filter(path => /\.(?:js|html|less|css)$/.test(path));
	const iconKeys = new Set();
	for (const path of sources) {
		const source = await readFile(path, 'utf8');
		for (const [, key] of source.matchAll(/data-ui-icon(?:-after)?=["']([a-z0-9-]+)["']/g)) {
			iconKeys.add(key);
		}
		for (const [, binding] of source.matchAll(/\bdata-bind=(["'])([\s\S]*?)\1/g)) {
			for (const [, expression] of binding.matchAll(/["']data-ui-icon["']\s*:\s*([^,}]+)/g)) {
				const value = expression.trim(),
					literal = value.match(/^["']([a-z][a-z0-9-]*)["']$/),
					branches = [...value.matchAll(/(?:\?|:)\s*["']([a-z][a-z0-9-]*)["']/g)].map(([, key]) => key);
				if (literal) {
					iconKeys.add(literal[1]);
				} else if (branches.length) {
					branches.forEach(key => iconKeys.add(key));
				} else {
					const allowedValues = dynamicIconValueAllowlist[value.replace(/\s+/g, '')];
					assert.ok(allowedValues, `Unreviewed dynamic icon binding in ${path}: ${value}`);
					allowedValues.forEach(key => iconKeys.add(key));
				}
			}
		}
	}
	iconKeys.add('spacer');

	const codeMaps = [
		['dev/Common/File.js', /getTypeIconClass:\s*([\s\S]*?)(?=\n\tgetIconClass:)/],
		['dev/Model/FolderCollection.js', /icon:\s*\(\)\s*=>\s*\{([\s\S]*?)(?=\n\t\t\t\},\n\n\t\t\thasUnreadInSub)/],
		['dev/Model/FolderCollection.js', /collapsedIcon\(\)\s*\{([\s\S]*?)\n\t\}/],
		['dev/View/User/MailBox/MessageList.js', /sortFieldIcon:\s*\(\)\s*=>\s*\{([\s\S]*?)(?=\n\t\t\tsortDirectionIcon:)/],
		['dev/View/User/MailBox/MessageList.js', /sortDirectionIcon:\s*\(\)\s*=>\s*\{([\s\S]*?)(?=\n\t\t\tdownloadAsZipAllowed:)/],
		['dev/View/User/MailBox/MessageView.js', /dkimIcon:\s*\(\)\s*=>\s*\{([\s\S]*?)(?=\n\t\t\tdkimIconClass:)/]
	];
	for (const [relativePath, pattern] of codeMaps) {
		const source = await readFile(join(root, relativePath), 'utf8'),
			block = source.match(pattern)?.[1] || '';
		for (const [, key] of block.matchAll(/(?:return|field\s*=|result\s*=)\s*['"]([a-z][a-z0-9-]*)['"]/g)) {
			iconKeys.add(key);
		}
	}
	for (const relativePath of ['dev/External/SquireUI.js']) {
		const source = await readFile(join(root, relativePath), 'utf8');
		for (const [, key] of source.matchAll(/\bicon:\s*['"]([a-z][a-z0-9-]*)['"]/g)) {
			iconKeys.add(key);
		}
	}
	for (const name of iconKeys) {
		if (name !== 'spacer') {
			assert.ok(iconNames.has(name), `No local SVG for semantic icon key ${name}`);
			assert.ok(registryNames.has(name), `No fixed registry entry for semantic icon key ${name}`);
		}
	}
});

test('spam uses a distinct icon from generic warning states', async () => {
	const folders = await readFile(join(root, 'dev/Model/FolderCollection.js'), 'utf8');
	assert.match(folders, /case 4:\s*return 'flame'; \/\/ FolderType\.Junk/);
	for (const relativePath of [
		'snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html',
		'snappymail/v/0.0.0/app/templates/Views/User/MailMessageView.html',
		'snappymail/v/0.0.0/app/templates/Views/User/PopupsFolderSystem.html'
	]) {
		const template = await readFile(join(root, relativePath), 'utf8');
		assert.match(template, /data-i18n="(?:\[title\])?GLOBAL\/(?:TO_SPAM|SPAM)"[^>]*data-ui-icon="flame"|data-ui-icon="flame"[^>]*data-i18n="(?:\[title\])?GLOBAL\/(?:TO_SPAM|SPAM)"/);
	}
	assert.match(await readFile(join(root, 'dev/Styles/User/MessageView.less'), 'utf8'), /triangle-alert/);

	const sort = (await readFile(join(root, 'dev/View/User/MailBox/MessageList.js'), 'utf8'))
		.match(/sortFieldIcon:\s*\(\)\s*=>\s*\{([\s\S]*?)(?=\n\t\t\tsortDirectionIcon:)/)?.[1] || '';
	assert.match(sort, /mode\.includes\('SIZE'\)[\s\S]*?field\s*=\s*'mail'/);
});

test('mail-only visual pictograms use the local icon asset', async () => {
	const message = await readFile(join(root, 'dev/Model/Message.js'), 'utf8'),
		styles = await readFile(join(root, 'dev/Styles/User/MessageView.less'), 'utf8');
	assert.doesNotMatch(message, /📎/);
	assert.doesNotMatch(styles, /🖼/);
	assert.match(styles, /background-image:\s*url\("\.\.\/\.\.\/images\/ui-icons\/image\.svg"\)/);
});

test('contact and folder pictograms use semantic local icons instead of legacy glyphs', async () => {
	const contacts = await readFile(join(root, 'snappymail/v/0.0.0/app/templates/Views/User/PopupsContacts.html'), 'utf8');
	assert.doesNotMatch(contacts, /👤/);
	assert.match(contacts, /data-ui-icon="user-round" aria-hidden="true"/);
	for (const relativePath of [
		'snappymail/v/0.0.0/app/templates/Views/User/MailFolderList.html',
		'snappymail/v/0.0.0/app/templates/Views/User/PopupsFolder.html',
		'snappymail/v/0.0.0/app/templates/Views/User/PopupsFolderCreate.html',
		'snappymail/v/0.0.0/app/templates/Views/User/SettingsFolders.html'
	]) {
		const template = await readFile(join(root, relativePath), 'utf8');
		assert.match(template, /data-ui-icon="folder-plus"/);
		assert.doesNotMatch(template, /icon-folder-add/);
	}
});

test('unordered list commands use a list icon while Sieve retains its filter icon', async () => {
	const squire = await readFile(join(root, 'dev/External/SquireUI.js'), 'utf8'),
		domain = await readFile(join(root, 'snappymail/v/0.0.0/app/templates/Views/Admin/PopupsDomain.html'), 'utf8');
	assert.match(squire, /ol:\s*\{\s*icon:\s*'list-ordered'[\s\S]*?ul:\s*\{\s*icon:\s*'list'/);
	assert.match(domain, /data-ui-icon="list-filter"/);
});

test('SVGs are local, normalized Lucide-style paths with no active content', async () => {
	for (const path of iconFiles) {
		const svg = await readFile(path, 'utf8');
		const name = path.slice(iconDir.length + 1, -4);
		assert.match(svg, /<svg\b[^>]*viewBox="0 0 24 24"/);
		assert.match(svg, /currentColor/);
		assert.match(svg, /stroke-width="2"/);
		if (name === 'star-filled') {
			assert.match(svg, /fill="currentColor"/);
		} else {
			assert.doesNotMatch(svg, /fill="currentColor"/, `${path} contains an unintended filled shape`);
		}
		assert.doesNotMatch(svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, ''), /<script\b|<foreignObject\b|<image\b|\b(?:href|xlink:href)=|https?:|data:/i);
	}
});

test('migrated UI surfaces do not retain data-icon attributes or unsafe SVG rendering', async () => {
	for (const dir of ['dev', 'snappymail/v/0.0.0/app/templates']) {
		for (const path of await filesUnder(join(root, dir))) {
			if (!/\.(?:js|html|less|css)$/.test(path)) continue;
			const source = await readFile(path, 'utf8');
			assert.doesNotMatch(source, /\bdata-icon\s*=/, `${path} still uses legacy data-icon`);
			assert.doesNotMatch(source, /\[\s*data-icon\b/, `${path} still styles legacy data-icon`);
		}
	}
	const squire = await readFile(join(root, 'dev/External/SquireUI.js'), 'utf8');
	assert.doesNotMatch(squire, /innerHTML\s*=\s*cfg\.(?:icon|html)/);
	assert.doesNotMatch(squire, /<svg\b/i);
});

test('Core UI stays independent of Fontastic classes and glyph names', async () => {
	const sources = [
		...(await filesUnder(join(root, 'dev'))),
		...(await filesUnder(join(root, 'snappymail/v/0.0.0/app/templates')))
	].filter(path => /\.(?:js|html|less|css|php)$/.test(path));
	for (const path of sources) {
		const source = await readFile(path, 'utf8');
		const withoutNeutralIconPrefixes = source.replace(/\bui-icon-/gi, 'uiIcon-');
		assert.doesNotMatch(source, /\bfontastic\b/i, `${path} still refers to Fontastic`);
		assert.doesNotMatch(source, /\bdata-icon\s*=/i, `${path} still uses legacy data-icon`);
		assert.doesNotMatch(source, /\[\s*data-icon\b/i, `${path} still styles legacy data-icon`);
		assert.doesNotMatch(source, /font-family\s*:[^;]*["']?snappymail\b/i, `${path} still uses the icon font`);
		assert.doesNotMatch(withoutNeutralIconPrefixes, /class\s*=\s*["'][^"']*\bicon[_-][a-z0-9_-]+\b/i, `${path} still uses a legacy glyph class`);
		assert.doesNotMatch(withoutNeutralIconPrefixes, /\.icon[_-][a-z0-9_-]+\b/i, `${path} still styles a legacy glyph class`);
		assert.doesNotMatch(withoutNeutralIconPrefixes, /["']icon[_-][a-z0-9_-]+["']\s*:/i, `${path} still binds a legacy glyph class`);
	}
});

test('Fontastic compatibility, vendor assets, and build hooks are absent', async () => {
	for (const relativePath of [
		'dev/Styles/FontasticCompatibility.less',
		'vendors/fontastic',
		'tasks/vendors.js'
	]) {
		await assert.rejects(readFile(join(root, relativePath)), { code: 'ENOENT' });
	}
	const config = await readFile(join(root, 'tasks/config.js'), 'utf8'),
		gulpfile = await readFile(join(root, 'gulpfile.js'), 'utf8'),
		main = await readFile(join(root, 'dev/Styles/@Main.less'), 'utf8'),
		admin = await readFile(join(root, 'dev/Styles/@Admin.less'), 'utf8'),
		shortcuts = await readFile(join(root, 'dev/Styles/User/Shortcuts.less'), 'utf8');
	assert.doesNotMatch(config + gulpfile + main + admin, /fontastic/i);
	assert.doesNotMatch(shortcuts, /td\[class\^="icon-"\]/);
	for (const relativePath of [
		'snappymail/v/0.0.0/static/css/app.css',
		'snappymail/v/0.0.0/static/css/admin.css',
		'snappymail/v/0.0.0/static/css/app.min.css',
		'snappymail/v/0.0.0/static/css/admin.min.css'
	]) {
		let css;
		try {
			css = await readFile(join(root, relativePath), 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') continue;
			throw error;
		}
		assert.doesNotMatch(css, /font-family\s*:\s*["']?snappymail\b/i, `${relativePath} contains the removed icon font`);
		assert.doesNotMatch(css, /content\s*:\s*["']\\e[0-9a-f]{3}/i, `${relativePath} contains a legacy private-use glyph mapping`);
	}
});

test('legacy built-in theme assets and the retired Nextcloud integration are absent', async () => {
	const themeRoot = join(root, 'snappymail/v/0.0.0/themes'),
		integrationThemeRoot = join(root, 'integrations/nextcloud');
	await assert.rejects(readdir(themeRoot), { code: 'ENOENT' });
	await assert.rejects(readdir(integrationThemeRoot), { code: 'ENOENT' });
});

test('Lucide and Feather license notices are present', async () => {
	const license = await readFile(join(root, 'vendors/lucide/LICENSE'), 'utf8');
	assert.match(license, /ISC License/);
	assert.match(license, /derived from the Feather project/);
	assert.match(license, /The MIT License \(MIT\)/);
});
