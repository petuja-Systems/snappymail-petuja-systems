import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
	contractSource = await readFile(join(root, 'dev/Common/Appearance.js'), 'utf8'),
	contract = await import('data:text/javascript;base64,' + Buffer.from(contractSource).toString('base64')),
	appearanceStyles = await readFile(join(root, 'dev/Styles/Appearance.less'), 'utf8'),
	bootStyles = await readFile(join(root, 'dev/Styles/@Boot.css'), 'utf8'),
	mainStyles = await readFile(join(root, 'dev/Styles/Main.less'), 'utf8'),
	editorStyles = await readFile(join(root, 'dev/Styles/User/SquireUI.less'), 'utf8'),
	messageListStyles = await readFile(join(root, 'dev/Styles/User/MessageList.less'), 'utf8'),
	messageStyles = await readFile(join(root, 'dev/Styles/User/MessageView.less'), 'utf8'),
	composeStyles = await readFile(join(root, 'dev/Styles/User/Compose.less'), 'utf8'),
	htmlSource = await readFile(join(root, 'dev/Common/Html.js'), 'utf8');

function findRule(source, selector, requiredDeclaration) {
	const cleanSource = source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	let offset = 0;
	while (offset < cleanSource.length) {
		const start = cleanSource.indexOf(selector, offset);
		if (-1 === start) {
			break;
		}
		const open = cleanSource.indexOf('{', start + selector.length);
		if (-1 === open) {
			break;
		}
		const boundary = Math.max(cleanSource.lastIndexOf('}', start), cleanSource.lastIndexOf('{', start)) + 1,
			header = cleanSource.slice(boundary, open).trim(),
			selectors = header.split(',').map(value => value.trim().replace(/\s+/g, ' '));
		if (!selectors.includes(selector)) {
			offset = start + selector.length;
			continue;
		}

		const childRule = cleanSource.indexOf('{', open + 1),
			close = cleanSource.indexOf('}', open + 1),
			end = -1 !== childRule && childRule < close ? childRule : close,
			declarations = Object.fromEntries(cleanSource.slice(open + 1, end)
				.split(';')
				.map(item => item.trim())
				.filter(Boolean)
				.map(item => {
					const colon = item.indexOf(':');
					return [item.slice(0, colon).trim(), item.slice(colon + 1).trim()];
				}));
		if (undefined === requiredDeclaration || Object.hasOwn(declarations, requiredDeclaration)) {
			return { selectors, declarations };
		}
		offset = start + selector.length;
	}
	assert.fail(`CSS rule ${selector} was not found`);
}

test('native appearance preference and effective scheme vocabularies are closed', () => {
	assert.deepEqual(Object.values(contract.AppearancePreference).sort(), ['dark', 'light', 'system']);
	assert.deepEqual(Object.values(contract.EffectiveColorScheme).sort(), ['dark', 'light']);

	for (const value of Object.values(contract.AppearancePreference)) {
		assert.equal(contract.isAppearancePreference(value), true);
	}
	for (const value of ['auto', 'Default', 'dark-mode', '', null, {}]) {
		assert.equal(contract.isAppearancePreference(value), false);
	}
	for (const value of Object.values(contract.EffectiveColorScheme)) {
		assert.equal(contract.isEffectiveColorScheme(value), true);
	}
	for (const value of ['system', 'auto', 'Default', '', null, {}]) {
		assert.equal(contract.isEffectiveColorScheme(value), false);
	}
});

test('Light and Dark define the same populated semantic color token vocabulary', () => {
	const blocks = [...appearanceStyles.matchAll(/(html\[data-appearance-scheme="(light|dark)"\][^{]*)\{([^}]*)\}/g)];
	assert.deepEqual(blocks.map(([, , scheme]) => scheme).sort(), ['dark', 'light']);
	for (const [, selector] of blocks) {
		assert.ok(selector.replace(/\s+/g, '').includes(':not(:has(#V-Login.LoginView))'),
			'native appearance scheme roots exclude the separately branded login view');
	}

	const tokensByScheme = new Map(blocks.map(([, , scheme, body]) => {
		const tokens = [...body.matchAll(/(--appearance-[\w-]+)\s*:\s*([^;]+);/g)];
		assert.ok(tokens.length > 0, `${scheme} scheme has no semantic color tokens`);
		for (const [, name, value] of tokens) {
			assert.ok(value.trim(), `${name} has an empty ${scheme} value`);
		}
		return [scheme, tokens.map(([, name]) => name).sort()];
	}));

	assert.deepEqual(tokensByScheme.get('light'), tokensByScheme.get('dark'));
	assert.match(appearanceStyles, /data-appearance-scheme="light"/);
	assert.match(appearanceStyles, /data-appearance-scheme="dark"/);
	assert.doesNotMatch(appearanceStyles, /data-appearance-scheme="system"/);
});

test('muted text and Dark enabled dropdown text meet normal text contrast', () => {
	const schemeTokens = new Map([...appearanceStyles.matchAll(/html\[data-appearance-scheme="(light|dark)"\][^{]*\{([^}]*)\}/g)]
		.map(([, scheme, body]) => [scheme, new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
			.map(([, name, value]) => [name, value.trim()]))])),
		contrastRatio = (foreground, background) => {
			const luminance = color => {
			const hex = color.slice(1),
				normalizedHex = 3 === hex.length ? [...hex].map(value => value + value).join('') : hex,
				[red, green, blue] = normalizedHex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16) / 255)
					.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
				return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
			},
				foregroundLuminance = luminance(foreground),
				backgroundLuminance = luminance(background);
			return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
				(Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
		};
	for (const scheme of ['light', 'dark']) {
		const tokens = schemeTokens.get(scheme),
			mutedText = tokens.get('--appearance-text-muted'),
			surface = tokens.get('--appearance-surface');
		assert.ok(mutedText?.startsWith('#'), `${scheme} muted text color is explicit`);
		assert.ok(surface?.startsWith('#'), `${scheme} surface color is explicit`);
		assert.ok(contrastRatio(mutedText, surface) >= 4.5,
			`${scheme} muted text has at least 4.5:1 contrast against its surface`);
	}
	assert.equal(schemeTokens.get('dark').get('--dropdown-menu-color'), 'var(--appearance-text-muted)');
});

test('application keyboard focus is visible without restyling mail or editor content', () => {
	const selectors = [
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-SettingsMenu :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-SettingsPane :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-PopupsIdentity :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-PopupsContacts :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-PopupsFolderClear :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailFolderList :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageList :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-SystemDropDown :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-PopupsCompose header :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-PopupsCompose .b-header :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-PopupsCompose .b-header .emailaddresses:has(input:focus-visible)',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView .top-toolbar :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView .message-fixed-button-toolbar :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView .messageItemHeader .subjectParent :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView #messageItem .bodySubHeader > :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView #messageItem .attachmentsPlace > summary:focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView #messageItem .attachmentsPlace .checkboxAttachment:focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView #messageItem .attachmentsPlace .controls-handle:focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView #messageItem .attachmentsPlace .attachmentsControls :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView #messageItem > .btn-toolbar :focus-visible',
		'#rl-app[data-admin="0"]:not(:has(#V-Login.LoginView)) #V-MailMessageView .messageTags :focus-visible'
	],
		focusRule = findRule(appearanceStyles, selectors[1]);
	assert.deepEqual(focusRule.selectors.sort(), [...selectors].sort());
	assert.equal(focusRule.declarations.outline, '2px solid var(--appearance-link, #369)');
	assert.equal(focusRule.declarations['outline-offset'], '2px');
	assert.equal(focusRule.declarations['box-shadow'], '0 0 0 4px var(--appearance-surface-raised, #fff)');
	assert.ok(focusRule.selectors.every(selector => /data-admin="0".*#V-Login/.test(selector)),
		'application focus excludes the separately styled Admin and Login roots');
	assert.ok(focusRule.selectors.every(selector => !/#V-MailMessageView\s+:focus-visible|#V-PopupsCompose\s+:focus-visible/.test(selector)),
		'application focus stays outside arbitrary message and Compose editor content');
});

test('message list and message view empty states use semantic muted text without a fixed toolbar gradient', () => {
	assert.match(messageListStyles,
		/\.listEmptyMessage,\s*\.listLoading,\s*\.listDragOver,\s*\.listError\s*\{\s*color:\s*var\(--appearance-text-muted, #666\);/);
	assert.match(messageStyles,
		/\.b-message-view-desc\s*\{[^}]*color:\s*var\(--appearance-text-muted, #666\);/s);
	assert.doesNotMatch(messageListStyles,
		/\.thm-message-list-top-toolbar,\s*\.thm-message-list-bottom-toolbar\s*\{[^}]*background-image:/s,
		'message list toolbar surfaces are free to follow the active appearance token');
});

test('narrow Compose More menu stays within the viewport in LTR and RTL', () => {
	assert.match(composeStyles,
		/@media screen and \(max-width: 380px\)\s*\{\s*#V-PopupsCompose header \.pull-right > \.btn-group\.dropdown > \.dropdown-menu\s*\{\s*left:\s*auto;\s*position:\s*fixed;\s*right:\s*4px;\s*top:\s*72px;\s*\}\s*html\[dir="rtl"\] #V-PopupsCompose header \.pull-right > \.btn-group\.dropdown > \.dropdown-menu\s*\{\s*left:\s*4px;\s*right:\s*auto;/s);
});

test('native application typography stays independent from legacy content font preferences', async () => {
	const rootTokens = findRule(bootStyles, ':root').declarations,
		shellRule = findRule(bootStyles, '#rl-app'),
		fixedBase = findRule(mainStyles, ':root').declarations,
		systemSansStack = rootTokens['--font-stack-system-sans'];
	assert.match(systemSansStack ?? '', /^ui-sans-serif\b/);
	assert.equal(rootTokens['--appearance-font-ui'], 'var(--font-stack-system-sans)');
	assert.equal(rootTokens['--fontSans'], 'var(--font-stack-system-sans)');
	assert.match(rootTokens['--fontSerif'], /^ui-serif\b/);
	assert.match(rootTokens['--fontMono'], /^ui-monospace\b/);
	assert.equal(shellRule.declarations['font-family'], 'var(--appearance-font-ui)');
	assert.doesNotMatch(bootStyles, /#rl-app\.font[\w-]+\s*\{/,
		'user-selectable font classes and their runtime token overrides are removed');
	const fixedBackground = fixedBase['--main-bg-image'],
		compiledBackground = fixedBackground?.replace(/\.\.\/(img|images|fonts|svg)\//g, '$1/'),
		backgroundPath = compiledBackground?.match(/^url\(["']?(.+?)["']?\)$/)?.[1],
		staticCssDirectory = join(root, 'snappymail/v/0.0.0/static/css'),
		rehomedBackground = resolve(root, 'snappymail/v/0.0.0/static/images/background.jpg');
	assert.equal(fixedBackground, 'url("../../images/background.jpg")',
		'source URL keeps one parent segment after the Gulp asset-prefix rewrite');
	assert.equal(compiledBackground, 'url("../images/background.jpg")',
		'compiled CSS URL resolves from static/css to static/images');
	assert.equal(resolve(staticCssDirectory, backgroundPath), rehomedBackground,
		'fixed Login/Admin background resolves to the migrated asset path');
	await access(rehomedBackground);

	const typographyRule = findRule(appearanceStyles, '#rl-app[data-admin="1"] #V-AdminPane > .b-toolbar');
	assert.deepEqual(typographyRule.selectors.sort(), [
		'#rl-app[data-admin="0"] #V-MailFolderList > .b-folders',
		'#rl-app[data-admin="0"] #V-SettingsMenu > .b-toolbar',
		'#rl-app[data-admin="1"] #V-AdminPane > .b-toolbar'
	].sort());
	assert.equal(typographyRule.declarations['font-family'], 'var(--appearance-font-ui)');
	assert.equal(findRule(editorStyles, '.squire-toolbar button').declarations['font-family'], 'var(--appearance-font-ui)');
	assert.equal(findRule(editorStyles, '.squire-toolbar select').declarations['font-family'], 'var(--appearance-font-ui)');
	assert.equal(findRule(editorStyles, '.squire-wysiwyg', 'font-family').declarations['font-family'], 'var(--fontSans)',
		'WYSIWYG content retains its fixed content typography token');
	assert.equal(findRule(editorStyles, '.squire-plain', 'font-family').declarations['font-family'], 'var(--fontMono)',
		'plain-text content retains its fixed content typography token');
	assert.equal(findRule(messageStyles, '&.html').declarations['font-family'], 'var(--fontSans)');
	assert.equal(findRule(messageStyles, '&.plain').declarations['font-family'], 'var(--fontMono)');
	assert.equal(findRule(messageStyles, 'img[data-x-src]:not([src]):hover::after').declarations['font-family'], 'var(--appearance-font-ui)');
	const htmlSourceAttributes = htmlSource.match(/allowedAttributes\s*=\s*\[([\s\S]*?)\]/)?.[1];
	assert.ok(htmlSourceAttributes, 'message sanitizer attribute allowlist is present');
	assert.doesNotMatch(htmlSourceAttributes.replace(/\/\/[^\n]*/g, ''), /['"]id['"]/);
	assert.doesNotMatch(htmlSourceAttributes.replace(/\/\/[^\n]*/g, ''), /['"]class['"]/,
		'sender classes are removed to keep message typography separate from application-owned wrappers');
	assert.doesNotMatch(htmlSource, /allowedAttributes\.push\(['"]class['"]\)/,
		'the retired stylesheet preference cannot re-enable sender classes');
	assert.doesNotMatch(appearanceStyles, /\.b-text-part|\.squire-wysiwyg|\.squire-plain/);
});
