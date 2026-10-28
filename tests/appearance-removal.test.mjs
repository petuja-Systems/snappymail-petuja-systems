import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
	read = relative => readFile(join(root, relative), 'utf8'),
	missing = async relative => assert.rejects(access(join(root, relative)), { code: 'ENOENT' }),
	themeNames = [
		'A', 'BlackWood', 'Blurred', 'BlurredDark', 'Clear', 'DarkShine', 'Default', 'Linen', 'Love',
		'LoveDark', 'Magnetic', 'NextcloudV25+', 'NightShine', 'Snow', 'SnowDarkV1', 'Squares',
		'SquaresDark', 'Stripes', 'StripesDark', 'Wood', 'Xv'
	];

test('the complete 21-directory built-in legacy catalogue is absent', async () => {
	for (const name of themeNames) {
		await missing(`snappymail/v/0.0.0/themes/${name}`);
	}
	await missing('snappymail/v/0.0.0/themes');
	await missing('integrations/nextcloud/snappymail/app/themes/Nextcloud');
});
test('Appearance compatibility maps exact account-local and site-default legacy IDs', async () => {
	const actions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php'),
		block = actions.match(/LEGACY_THEME_APPEARANCE\s*=\s*\[([\s\S]*?)\];/)?.[1];
	assert.ok(block, 'the closed historical mapping remains available');
	const mappings = Object.fromEntries([...block.matchAll(/'([^']+)'\s*=>\s*'(light|dark|system)'/g)]
		.map(([, key, value]) => [key, value]));
	assert.deepEqual(mappings, {
		A: 'light',
		BlackWood: 'dark',
		Blurred: 'light',
		BlurredDark: 'dark',
		DarkShine: 'light',
		Default: 'light',
		Linen: 'light',
		Love: 'light',
		LoveDark: 'dark',
		Magnetic: 'dark',
		'NextcloudV25+': 'system',
		NightShine: 'dark',
		Snow: 'light',
		SnowDarkV1: 'dark',
		Squares: 'light',
		SquaresDark: 'dark',
		Stripes: 'light',
		StripesDark: 'dark',
		Wood: 'light',
		Xv: 'light'
	});
	assert.equal(Object.hasOwn(mappings, 'Clear'), false, 'ambiguous Clear safely uses the Light fallback');
	assert.match(actions, /SettingsProvider\(true\)->Load\(\$oAccount\)/,
		'compatibility loads the account-local settings provider');
	assert.match(actions, /array_key_exists\('Theme', \$aSettingsLocal\)/,
		'malformed account-local legacy values remain distinct from a missing setting');
	assert.match(actions, /self::LEGACY_THEME_APPEARANCE\[\$sTheme\] \?\? 'light'/);
	assert.doesNotMatch(actions, /GetThemes|GetTheme\(|ValidateTheme|APP_VERSION_ROOT_PATH[^\n]*themes/);
	assert.match(actions, /Config\(\)->Get\('webmail', 'theme', 'Default'\)/,
		'the retired site default is read only as a closed-map Appearance migration fallback');
});

test('theme catalogue, selection, previews, and dynamic CSS have no runtime path', async () => {
	const actions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php'),
		service = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Service.php'),
		serviceActions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/ServiceActions.php'),
		links = await read('dev/Common/Links.js'),
		themeStore = await read('dev/Stores/Theme.js'),
		adminSettings = await read('dev/Settings/Admin/General.js'),
		adminConfig = await read('dev/Settings/Admin/Config.js'),
		adminTemplate = await read('snappymail/v/0.0.0/app/templates/Views/Admin/AdminSettingsGeneral.html'),
		index = await read('snappymail/v/0.0.0/app/templates/Index.html');
	await missing('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Themes.php');
	assert.doesNotMatch(actions, /GetThemes|GetTheme\(|ValidateTheme|compileCss\(/);
	assert.doesNotMatch(serviceActions, /ServiceCss|ValidateTheme|compileCss\(/);
	assert.doesNotMatch(service, /BaseAppTheme|app-theme-style|app-native-theme-style|GetTheme\(/);
	assert.doesNotMatch(links, /cssLink|themePreviewLink/);
	assert.doesNotMatch(themeStore, /theme:|themes:|changeTheme|fontSansSerif|fontSerif|fontMono|userBackground/);
	assert.match(themeStore, /isMobile:\s*ko\.observable\(false\)/);
	assert.doesNotMatch(adminSettings + adminConfig + adminTemplate, /themesOptions|themeTrigger|ThemeStore\.theme|ThemeStore\.themes|LABEL_THEME/);
	assert.doesNotMatch(index, /BaseAppTheme|app-theme-style|app-native-theme-style/);
	assert.doesNotMatch(index, /app-plugin-style|BaseAppPluginCss/);
	assert.doesNotMatch(service, /compilePluginCss|BaseAppPluginCss/);
});

test('generic plugin CSS runtime and Fontastic compatibility assets are absent', async () => {
	const actions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php'),
		service = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Service.php'),
		main = await read('dev/Styles/@Main.less'),
		admin = await read('dev/Styles/@Admin.less');
	assert.doesNotMatch(actions + service, /Plugins\(\)|CompileCss|BaseAppPluginCss|app-plugin-style/);
	assert.doesNotMatch(main + admin, /FontasticCompatibility|fontastic/i);
	await missing('dev/Styles/FontasticCompatibility.less');
	await missing('vendors/fontastic/styles.css');
	await missing('vendors/fontastic/fonts/snappymail.woff');
	await missing('vendors/fontastic/fonts/snappymail.woff2');
});

test('font and background preferences are absent while fixed content typography survives', async () => {
	const actions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php'),
		userActions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php'),
		rawActions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Raw.php'),
		serviceActions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/ServiceActions.php'),
		settings = await read('dev/Stores/Theme.js'),
		links = await read('dev/Common/Links.js'),
		userSettingsScreen = await read('dev/Screen/User/Settings.js'),
		boot = await read('dev/Styles/@Boot.css'),
		main = await read('dev/Styles/Main.less'),
		appearance = await read('dev/Styles/Appearance.less'),
		message = await read('dev/Styles/User/MessageView.less'),
		editor = await read('dev/Styles/User/SquireUI.less');
	await missing('dev/Settings/User/Themes.js');
	await missing('dev/Styles/User/SettingsThemes.less');
	await missing('snappymail/v/0.0.0/app/templates/Views/User/SettingsThemes.html');
	assert.doesNotMatch(actions + userActions, /fontSansSerif|fontSerif|fontMono|userBackgroundName|userBackgroundHash|UploadBackground|ClearUserBackground/);
	assert.doesNotMatch(rawActions, /RawUserBackground/);
	assert.doesNotMatch(serviceActions, /ServiceUploadBackground/);
	assert.doesNotMatch(settings + links + userSettingsScreen, /fontSansSerif|fontSerif|fontMono|userBackground|UploadBackground|ClearUserBackground|Settings\/User\/Themes/);
	assert.doesNotMatch(boot, /#rl-app\.font[\w-]+\s*\{/);
	assert.match(boot, /--fontSans:\s*var\(--font-stack-system-sans\)/);
	assert.match(boot, /--fontSerif:\s*ui-serif/);
	assert.match(boot, /--fontMono:\s*ui-monospace/);
	assert.match(appearance, /--appearance-font-ui/);
	assert.match(message, /&\.html\s*\{[^}]*font-family:\s*var\(--fontSans\)/s);
	assert.match(message, /&\.plain\s*\{[^}]*font-family:\s*var\(--fontMono\)/s);
	assert.match(editor, /\.squire-wysiwyg\s*\{[^}]*font-family:\s*var\(--fontSans\)/s);
	assert.match(editor, /\.squire-plain\s*\{[^}]*font-family:\s*var\(--fontMono\)/s);
});

test('background retirement leaves attachment and contact upload routes intact', async () => {
	const serviceActions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/ServiceActions.php'),
		rawActions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Raw.php');
	assert.match(serviceActions, /public function ServiceUpload\(\)/);
	assert.match(serviceActions, /public function ServiceUploadContacts\(\)/);
	assert.match(rawActions, /public function RawDownload\(\)/);
	assert.match(rawActions, /public function RawView\(\)/);
});

test('Admin exposes no retired theme/background capabilities and native bootstrap stays strict', async () => {
	const actionsAdmin = await read('snappymail/v/0.0.0/app/libraries/RainLoop/ActionsAdmin.php'),
		actions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php'),
		capabilities = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Enumerations/Capa.php'),
		adminSettings = await read('dev/Settings/Admin/General.js'),
		general = await read('snappymail/v/0.0.0/app/templates/Views/Admin/AdminSettingsGeneral.html'),
		schema = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Config/Application.php'),
		main = await read('dev/Styles/Main.less'),
		appearance = await read('dev/Styles/Appearance.less'),
		index = await read('snappymail/v/0.0.0/app/templates/Index.html'),
		upgrade = await read('snappymail/v/0.0.0/app/libraries/snappymail/upgrade.php');
	assert.doesNotMatch(actionsAdmin + general, /setConfigFromParams\([^\n]*'Theme'|LABEL_THEME|\s'theme'\s*=>/);
	assert.doesNotMatch(actionsAdmin + adminSettings + general, /CapaThemes|CapaUserBackground|capaThemes|capaUserBackground|LABEL_ALLOW_THEMES_ON_SETTINGS|LABEL_ALLOW_BACKGROUND_ON_SETTINGS/);
	assert.doesNotMatch(actions + capabilities + schema, /Capa::THEMES|Capa::USER_BACKGROUND|THEMES\s*=\s*'Themes'|USER_BACKGROUND\s*=\s*'UserBackground'|allow_themes|allow_user_background/);
	assert.match(schema, /'theme'\s*=>\s*array\('Default', 'Legacy default used only to seed native Appearance'\)/,
		'the persisted site default is retained for migration without restoring the Admin selector');
	assert.equal((actionsAdmin.match(/unset\(\$aConfig\['webmail'\]\['theme'\]\)/g) || []).length, 2,
		'generic Admin config reads and writes cannot expose or change the retired site theme default');
	const localizationRoot = join(root, 'snappymail/v/0.0.0/app/localization');
	for (const locale of await readdir(localizationRoot, { withFileTypes: true })) {
		if (!locale.isDirectory()) {
			continue;
		}
		for (const file of ['admin.json', 'user.json']) {
			try {
				const catalog = JSON.parse(await readFile(join(localizationRoot, locale.name, file), 'utf8'));
				assert.equal(Object.hasOwn(catalog.TAB_GENERAL || {}, 'LABEL_THEME'), false, `${locale.name}/${file} has no retired Theme label`);
				assert.equal(Object.hasOwn(catalog.TAB_GENERAL || {}, 'LABEL_ALLOW_THEMES_ON_SETTINGS'), false, `${locale.name}/${file} has no retired theme capability label`);
				assert.equal(Object.hasOwn(catalog.TAB_GENERAL || {}, 'LABEL_ALLOW_BACKGROUND_ON_SETTINGS'), false, `${locale.name}/${file} has no retired background capability label`);
				assert.equal(Object.hasOwn(catalog, 'SETTINGS_THEMES'), false, `${locale.name}/${file} has no retired Themes group`);
				assert.equal(Object.hasOwn(catalog.SETTINGS_LABELS || {}, 'THEMES'), false, `${locale.name}/${file} has no retired Themes navigation label`);
			} catch (error) {
				if ('ENOENT' !== error.code) {
					throw error;
				}
			}
		}
	}
	assert.match(main, /--main-bg-image:\s*url\("\.\.\/\.\.\/images\/background\.jpg"\)/);
	assert.match(appearance, /data-admin="0"/);
	assert.match(index, /id="appearance-bootstrap" nonce=""/);
	assert.match(index, /data-appearance-preference/);
	assert.match(upgrade, /if \(!\\is_dir\(\$path\)\)/,
		'upgrade permissions tolerate old installations with no shipped theme directory');
});
