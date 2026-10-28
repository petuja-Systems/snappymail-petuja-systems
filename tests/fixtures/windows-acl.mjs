import path from 'node:path';

export function windowsPowerShellExecutable(systemRoot) {
	if (!path.win32.isAbsolute(systemRoot || '')) {
		throw new Error('SystemRoot must be an absolute Windows path to locate Windows PowerShell.');
	}
	const normalizedRoot = path.win32.resolve(systemRoot);
	const executable = path.win32.resolve(normalizedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const relative = path.win32.relative(normalizedRoot, executable);
	if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) {
		throw new Error('Windows PowerShell must resolve below the validated SystemRoot.');
	}
	return executable;
}

export function windowsPowerShellEnvironment(environment) {
	const systemRoot = environment?.SystemRoot || environment?.SYSTEMROOT;
	windowsPowerShellExecutable(systemRoot);
	const root = path.win32.resolve(systemRoot);
	return {
		...environment,
		SystemRoot: root,
		PSModulePath: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
	};
}
