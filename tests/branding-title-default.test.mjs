import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
	appDataSource = await readFile(path.join(repository, 'snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php'), 'utf8'),
	applicationConfig = await readFile(path.join(repository, 'snappymail/v/0.0.0/app/libraries/RainLoop/Config/Application.php'), 'utf8'),
	adminActions = await readFile(path.join(repository, 'snappymail/v/0.0.0/app/libraries/RainLoop/ActionsAdmin.php'), 'utf8');

test('petuja.email is the page-title fallback and seeded Branding default while Admin override remains wired', () => {
	assert.match(appDataSource, /'title'\s*=>\s*\$oConfig->Get\('webmail',\s*'title',\s*'petuja\.email'\)/);
	assert.match(applicationConfig, /'title'\s*=>\s*array\('petuja\.email',\s*'Text displayed as page title'\)/);
	assert.match(adminActions, /setConfigFromParams\(\$oConfig,\s*'title',\s*'webmail',\s*'title',\s*'string'\)/);
});
