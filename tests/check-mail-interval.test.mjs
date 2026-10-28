import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [accountsSource, userActionsSource, foldersSource] = await Promise.all([
	readFile(path.join(repository, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/Accounts.php'), 'utf8'),
	readFile(path.join(repository, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php'), 'utf8'),
	readFile(path.join(repository, 'dev/Common/Folders.js'), 'utf8')
]);

test('check mail interval remains an account-local integer setting with the AppData minimum', () => {
	assert.match(userActionsSource,
		/\$this->setSettingsFromParams\(\$oSettingsLocal, 'CheckMailInterval', 'int'\);/);
	assert.match(accountsSource, /'CheckMailInterval'\s*=>\s*\\max\(15,\s*\$minRefreshInterval\)/);
	assert.match(accountsSource,
		/\$aResult\['CheckMailInterval'\]\s*=\s*\\max\(\(int\)\s*\$oSettingsLocal->GetConf\('CheckMailInterval',\s*\$aResult\['CheckMailInterval'\]\),\s*\$minRefreshInterval\)/);
});

test('mail polling still clamps the effective interval to the configured minimum', () => {
	assert.match(foldersSource,
		/Math\.max\(1,\s*pInt\(SettingsGet\('minRefreshInterval'\)\),\s*pInt\(minutes\)\)\s*\*\s*60000/);
});
