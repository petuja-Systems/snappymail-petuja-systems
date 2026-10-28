import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	windowsPowerShellEnvironment,
	windowsPowerShellExecutable
} from './windows-acl.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isWindows = 'win32' === process.platform;
const windowsAclScript = path.join(repositoryRoot,
	'snappymail/v/0.0.0/app/libraries/snappymail/storage/accountpath-acl.ps1');

function assertProfileChild(testRoot, prefix) {
	const profileRoot = path.resolve(homedir());
	const resolvedRoot = path.resolve(testRoot);
	if (path.dirname(resolvedRoot).toLowerCase() !== profileRoot.toLowerCase()
		|| !path.basename(resolvedRoot).startsWith(prefix)) {
		throw new Error('Refusing to remove a test directory outside the unique private profile child.');
	}
}
/** Allocate Windows fixtures beneath a directory with the same ACL policy as private demo storage. */
export async function createPrivateTestTempRoot(testApi, label) {
	if (!isWindows) {
		return tmpdir();
	}
	if (!testApi || 'function' !== typeof testApi.after || !/^[a-z0-9-]+$/i.test(label)) {
		throw new TypeError('A test API and a simple fixture label are required.');
	}

	const prefix = '.petuja-test-' + label + '-' + process.pid + '-';
	const testRoot = path.join(homedir(), prefix + randomUUID());
	const windowsPowerShell = windowsPowerShellExecutable(process.env.SystemRoot || process.env.SYSTEMROOT);
	const result = spawnSync(windowsPowerShell, [
		'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
		'-File', windowsAclScript, '-Operation', 'PrepareDemoRoot', '-Path', testRoot
	], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		env: windowsPowerShellEnvironment(process.env),
		timeout: 15000,
		windowsHide: true
	});
	if (result.error || 0 !== result.status || 'CREATED' !== (result.stdout || '').trim()) {
		try {
			assertProfileChild(testRoot, prefix);
			await rm(testRoot, { recursive: true, force: true });
		} catch {
			// Preserve the original preparation error; cleanup is best effort for this unique path.
		}
		throw new Error('Could not prepare a private Windows test directory: '
			+ (result.error?.message || result.stderr?.trim() || result.stdout?.trim() || 'unknown ACL error'));
	}

	testApi.after(async () => {
		assertProfileChild(testRoot, prefix);
		await rm(testRoot, { recursive: true, force: true });
	});
	return testRoot;
}
