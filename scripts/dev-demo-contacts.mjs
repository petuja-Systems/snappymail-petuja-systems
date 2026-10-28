import { spawnSync } from 'node:child_process';

const pdoCapabilityProbe = [
	"echo json_encode([",
	"'pdo' => extension_loaded('PDO'),",
	"'pdo_sqlite' => extension_loaded('pdo_sqlite'),",
	"'drivers' => class_exists('PDO', false) ? PDO::getAvailableDrivers() : [],",
	"]);"
].join(' ');

export function detectPdoSqlite(phpBinary, spawnSyncImpl = spawnSync) {
	const result = spawnSyncImpl(phpBinary, ['-r', pdoCapabilityProbe], {
		encoding: 'utf8',
		windowsHide: true
	});

	if (result.error) {
		return { available: false, reason: 'Could not run PHP CLI: ' + result.error.message };
	}
	if (0 !== result.status) {
		return {
			available: false,
			reason: 'PHP PDO capability probe failed with exit status ' + (result.status ?? 'unknown') + '.'
		};
	}

	let capability;
	try {
		capability = JSON.parse(result.stdout || '');
	} catch {
		return { available: false, reason: 'PHP PDO capability probe returned invalid output.' };
	}
	if (!capability || 'object' !== typeof capability || Array.isArray(capability)) {
		return { available: false, reason: 'PHP PDO capability probe returned invalid output.' };
	}

	if (!capability.pdo) {
		return { available: false, reason: 'PHP PDO extension is unavailable.' };
	}
	if (!capability.pdo_sqlite) {
		return { available: false, reason: 'PHP pdo_sqlite extension is unavailable.' };
	}
	if (!Array.isArray(capability.drivers) || !capability.drivers.includes('sqlite')) {
		return { available: false, reason: 'PHP PDO SQLite driver is unavailable.' };
	}

	return { available: true, reason: '' };
}

export function demoContactsConfiguration(existingConfig, availability) {
	const lines = existingConfig ? existingConfig.split(/\r?\n/) : [];
	const sections = [];
	for (let index = 0; index < lines.length; index++) {
		if (/^\s*\[contacts\]\s*$/i.test(lines[index])) {
			sections.push(index);
		}
	}
	if (1 < sections.length) {
		throw new Error('The local demo application config has duplicate [contacts] sections.');
	}

	const settings = [
		'enable = ' + (availability.available ? 'On' : 'Off'),
		'type = sqlite',
		'sqlite_global = Off',
		'allow_sync = Off'
	];
	if (!sections.length) {
		while (lines.length && '' === lines[lines.length - 1]) {
			lines.pop();
		}
		if (lines.length) {
			lines.push('');
		}
		lines.push('[contacts]', ...settings);
	} else {
		const start = sections[0];
		let end = start + 1;
		while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) {
			end++;
		}
		const retained = lines.slice(start + 1, end).filter(line =>
			!/^\s*(enable|type|sqlite_global|allow_sync)\s*=/i.test(line)
		);
		lines.splice(start + 1, end - start - 1, ...retained, ...settings);
	}

	return lines.join('\n').replace(/\n*$/, '\n');
}

export function demoContactsStatus(availability) {
	return availability.available
		? 'Contacts: enabled with isolated per-account SQLite.'
		: 'Contacts: unavailable (' + availability.reason + ')';
}
