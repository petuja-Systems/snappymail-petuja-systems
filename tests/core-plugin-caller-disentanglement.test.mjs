import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const applicationRoot = path.join(repositoryRoot, 'snappymail/v/0.0.0');
const librariesRoot = path.join(applicationRoot, 'app/libraries');

async function source(relativePath) {
	return readFile(path.join(librariesRoot, relativePath), 'utf8');
}

async function phpSources(directory) {
	const files = [];
	for (const entry of await readdir(directory, {withFileTypes: true})) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...await phpSources(fullPath));
		} else if (entry.isFile() && entry.name.endsWith('.php')) {
			files.push(fullPath);
		}
	}
	return files;
}

async function filesWithExtension(directory, extension) {
	const files = [];
	for (const entry of await readdir(directory, {withFileTypes: true})) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...await filesWithExtension(fullPath, extension));
		} else if (entry.isFile() && entry.name.endsWith(extension)) {
			files.push(fullPath);
		}
	}
	return files;
}

test('M3C removes the plugin catalogue, package backend, and build paths', async () => {
	for (const removed of [
		'plugins',
		'snappymail/v/0.0.0/app/templates/Views/Admin/AdminSettingsPluginProperty.html',
		'snappymail/v/0.0.0/app/libraries/snappymail/repository.php',
		'snappymail/v/0.0.0/app/libraries/snappymail/tar.php',
		'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/AdminExtensions.php',
		'snappymail/v/0.0.0/app/libraries/RainLoop/Plugins/AbstractPlugin.php',
		'build/plugins.php',
		'build/nextcloud.php',
		'build/owncloud.php',
		'build/cpanel.php',
		'integrations/nextcloud',
		'integrations/owncloud',
		'integrations/cpanel',
		'integrations/cyberpanel',
		'integrations/hestiacp'
	]) {
		await assert.rejects(access(path.join(repositoryRoot, removed)), {code: 'ENOENT'}, removed + ' is removed');
	}

	for (const removed of [
		'RainLoop/Plugins/Manager.php',
		'RainLoop/Plugins/Helper.php',
		'RainLoop/Plugins/Property.php',
		'RainLoop/Plugins/PropertyCollection.php',
		'RainLoop/Config/Plugin.php',
		'RainLoop/Enumerations/PluginPropertyType.php'
	]) {
		await assert.rejects(access(path.join(librariesRoot, removed)), {code: 'ENOENT'}, removed + ' is removed');
	}

	const actions = await source('RainLoop/Actions.php');
	assert.doesNotMatch(actions, /Plugins\\Manager|new\s+Plugins\\Manager|function\s+Plugins\s*\(|\$oPlugins/);
	assert.doesNotMatch(actions, /'Plugins'\s*=>|'PluginsLink'\s*=>|InitAppData|compilePluginCss/);

	const service = await source('RainLoop/Service.php');
	const serviceActions = await source('RainLoop/ServiceActions.php');
	const admin = await source('RainLoop/ActionsAdmin.php');
	const notifications = await source('RainLoop/Notifications.php');
	const clientEnums = await readFile(path.join(repositoryRoot, 'dev/Common/Enums.js'), 'utf8');
	const applicationConfig = await source('RainLoop/Config/Application.php');
	const include = await readFile(path.join(applicationRoot, 'include.php'), 'utf8');
	const setup = await readFile(path.join(applicationRoot, 'setup.php'), 'utf8');
	const imapsync = await readFile(path.join(applicationRoot, 'imapsync.php'), 'utf8');
	const release = await readFile(path.join(repositoryRoot, 'cli/release.php'), 'utf8');
	assert.doesNotMatch(service + serviceActions, /Plugins\\Manager|Plugins\(\)|CompileCss|CompileJs|CompileTemplate|ReadLang|InitAppData|PluginsJsCache|BaseAppPluginCss/);
	assert.doesNotMatch(serviceActions, /ServicePlugins/);
	assert.doesNotMatch(admin, /DoAdminPackagesList|DoAdminPackage(?:Install|Delete)|Actions\\AdminExtensions/);
	assert.doesNotMatch(notifications + clientEnums, /(?:CantInstallPackage|CantDeletePackage|InvalidPluginPackage|UnsupportedPluginPackage|CantSavePluginSettings)/);
	assert.match(admin, /unset\(\$aConfig\['plugins'\]\)/,
		'Admin settings reads keep stale plugin configuration hidden');
	assert.match(admin, /array_key_exists\('plugins', \$aConfig\)/,
		'Admin settings writes keep rejecting stale plugin configuration');
	assert.doesNotMatch(applicationConfig, /['"]plugins['"]\s*=>/,
		'supported Core configuration no longer defines plugin defaults');
	assert.doesNotMatch(include, /APP_PLUGINS_PATH/);
	assert.doesNotMatch(setup, /['"]plugins['"]/,
		'first-run setup does not create a new plugin data directory');
	assert.doesNotMatch(imapsync, /RunHook|\$oPlugins/,
		'IMAP synchronization has no retired plugin hooks');
	assert.doesNotMatch(release, /['"]plugins['"]|build\/plugins\.php|nextcloud|owncloud|cpanel/i);
	assert.match(release, /getopt\('',\s*\['aur','docker','skip-gulp','debian','sign'\]\)/,
		'normal Core, AUR, Debian, and Docker release options remain');

	const runtimeFiles = await phpSources(librariesRoot);
	for (const file of runtimeFiles) {
		const relative = path.relative(librariesRoot, file);
		const contents = await readFile(file, 'utf8');
		assert.doesNotMatch(contents, /SnappyMail\\Repository|(?:getPackagesList|installPackage|deletePackage|getRepositoryData)|DoAdminPackage|AdminPlugin|AdminPackage|APP_PLUGINS_PATH|packages\.json|RainLoop\\Plugins\\|AbstractPlugin|Config\\Plugin|RunHook|CreatePluginByName|loadPlugin|Plugins\\Manager/,
			relative + ' must not retain plugin package/runtime code');
	}

	const updater = await source('snappymail/coreupdater.php');
	const coreArchive = await source('snappymail/corereleasearchive.php');
	const coreExtractor = await source('snappymail/corereleasetarextractor.php');
	const transport = await source('snappymail/repositorytransport.php');
	assert.match(updater, /RepositoryTransport/);
	assert.match(coreArchive, /PharData/);
	assert.match(coreArchive, /CoreReleaseTarExtractor::extract/,
		'Core release extraction has a dedicated Core-only TAR fallback');
	assert.doesNotMatch(coreArchive + coreExtractor, /SnappyMail\\TAR|APP_PLUGINS_PATH|installPackage|deletePackage|packages\.json|SnappyMail\\Repository/,
		'Core fallback does not restore a generic plugin archive path');
	assert.match(updater, /core\.json/);
	assert.doesNotMatch(transport, /packages\.json/);
	assert.match(applicationConfig, /plugin-two-factor-auth\.json/);
	assert.match(applicationConfig, /plugin-two-factor-auth\.ini/,
		'native 2FA policy migration retains its narrow legacy reader');
	assert.doesNotMatch(release, /--plugins|build\/plugins\.php|APP_PLUGINS_PATH/,
		'release tooling has no generic plugin distribution switches');
});

test('M3D removes orphan Admin plugin artifacts and false integration claims', async () => {
	const localizationRoot = path.join(applicationRoot, 'app/localization');
	const adminCatalogs = [];
	for (const locale of await readdir(localizationRoot, {withFileTypes: true})) {
		if (!locale.isDirectory()) {
			continue;
		}
		const file = path.join(localizationRoot, locale.name, 'admin.json');
		try {
			await access(file);
			adminCatalogs.push(file);
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		}
	}
	assert.ok(adminCatalogs.length > 0, 'current Admin locale catalogs are discovered dynamically');
	for (const file of adminCatalogs) {
		const raw = await readFile(file, 'utf8');
		const catalog = JSON.parse(raw);
		const locale = path.basename(path.dirname(file));
		assert.equal(Object.hasOwn(catalog.SETTINGS_LABELS ?? {}, 'PACKAGES'), false,
			locale + ' Admin catalog has no retired Packages navigation label');
		assert.equal(Object.hasOwn(catalog, 'TAB_PACKAGES'), false,
			locale + ' Admin catalog has no retired Packages tab');
		assert.equal(Object.hasOwn(catalog, 'POPUPS_PLUGIN'), false,
			locale + ' Admin catalog has no retired Plugin popup');
		assert.doesNotMatch(raw, /"(?:LABEL_ENABLE_PLUGINS|LEGEND_AVAILABLE_FOR_UPDATE|LEGEND_AVAILABLE_FOR_INSTALLATION|LEGEND_INSTALLED_PACKAGES|ALERT_CANNOT_ACCESS_REPOSITORY|TITLE_PLUGIN|DESC_NOTHING_TO_CONFIGURE)"\s*:/,
			locale + ' Admin catalog has no orphaned plugin/package-only labels');
	}

	const currentDocumentation = [
		path.join(repositoryRoot, 'README.md'),
		...await filesWithExtension(path.join(repositoryRoot, 'integrations'), '.md')
	];
	for (const file of currentDocumentation) {
		const contents = await readFile(file, 'utf8');
		assert.doesNotMatch(contents, /(?:plugins?[^.\n]*(?:install|enable|configure)[^.\n]*admin|admin[^.\n]*(?:install|enable|configure)[^.\n]*plugins?)/i,
			path.relative(repositoryRoot, file) + ' has no false Admin plugin-management claim');
	}
});

test('native Core security boundaries remain after generic hooks are removed', async () => {
	const callers = {
		userAuth: await source('RainLoop/Actions/UserAuth.php'),
		user: await source('RainLoop/Actions/User.php'),
		service: await source('RainLoop/Service.php'),
		serviceActions: await source('RainLoop/ServiceActions.php'),
		messages: await source('RainLoop/Actions/Messages.php'),
		attachments: await source('RainLoop/Actions/Attachments.php'),
		api: await source('RainLoop/Api.php'),
		mailClient: await source('MailSo/Mail/MailClient.php')
	};

	assert.match(callers.serviceActions, /isTwoFactorJsonActionAllowed\(/,
		'native two-factor action gating remains in JSON dispatch');
	assert.match(callers.serviceActions, /Utils::GetCsrfToken\(/,
		'native JSON CSRF validation remains in place');
	assert.match(callers.serviceActions, /IsAdminLoggined\(/,
		'native admin authorization remains in place');
	assert.match(callers.serviceActions, /method_exists\(\$this->oActions, \$sMethodName\)/,
		'JSON dispatch resolves native Core actions only');
	assert.match(callers.service, /isTwoFactorServiceAllowed\(/,
		'native service two-factor gating remains in place');
	assert.match(callers.userAuth, /completePrimaryMainLogin\(/,
		'native factor evaluation remains after primary credential verification');
	assert.match(callers.userAuth, /finalizeMainAuthSession\(/,
		'native assured session issuance remains in place');
	assert.match(callers.messages, /smtpSendMessage\(/,
		'native SMTP send path remains in place');
	assert.match(callers.messages, /MessageAppendStream\(/,
		'native draft and Sent-copy append paths remain in place');
	assert.doesNotMatch(callers.attachments, /RunHook/);
	assert.doesNotMatch(callers.api, /RunHook/);
	assert.doesNotMatch(callers.mailClient, /RunHook/);
});
