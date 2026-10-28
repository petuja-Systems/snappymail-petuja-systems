import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aclScript = path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/snappymail/storage/accountpath-acl.ps1');

function executablePath(systemRoot) {
	if ('string' !== typeof systemRoot || !path.win32.isAbsolute(systemRoot)) {
		throw new Error('SystemRoot must be an absolute Windows path.');
	}
	return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function environmentForPowerShell(environment) {
	const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
	if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
		throw new Error('Windows SystemRoot is unavailable or is not an absolute path.');
	}
	return {
		...environment,
		SystemRoot: systemRoot,
		PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
	};
}

export async function runDemoAclOperation(operation, targetPath, environment = process.env) {
	if (!path.win32.isAbsolute(targetPath)) {
		throw new Error('The Windows demo ACL path must be absolute.');
	}
	const safeEnvironment = environmentForPowerShell(environment);
	const systemRoot = await realpath(safeEnvironment.SystemRoot);
	const executable = await realpath(executablePath(systemRoot));
	const normalizedSystemRoot = systemRoot.replace(/[\\/]+$/, '').toLowerCase() + '\\';
	if (!executable.toLowerCase().startsWith(normalizedSystemRoot)) {
		throw new Error('Windows PowerShell must resolve below SystemRoot.');
	}
	const [executableInfo, helperInfo] = await Promise.all([lstat(executable), lstat(aclScript)]);
	if (!executableInfo.isFile() || executableInfo.isSymbolicLink()
		|| !helperInfo.isFile() || helperInfo.isSymbolicLink()) {
		throw new Error('The Windows ACL helper or PowerShell executable is not a regular file.');
	}
	const result = spawnSync(executable, [
		'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
		'-File', aclScript,
		'-Operation', operation,
		'-Path', targetPath
	], {
		encoding: 'utf8',
		env: { ...safeEnvironment, SystemRoot: systemRoot },
		windowsHide: true,
		timeout: 15000
	});
	const stdout = (result.stdout || '').trim();
	if (result.error || 0 !== result.status) {
		throw new Error('Could not verify the private local demo ACL: '
			+ (result.error?.message || (result.stderr || '').trim() || stdout || 'unknown PowerShell error'));
	}
	return stdout;
}
