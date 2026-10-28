import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pythonRunner from '../tasks/python-runner.js';
import { prepareDemoBuild, runDemoStartup } from '../scripts/dev-demo-build.mjs';
import { prepareDemoWorkspace } from '../scripts/dev-demo-runtime.mjs';

const { pythonCandidates, runPythonScript } = pythonRunner;
const requiredAssets = [
	'snappymail/v/0.0.0/static/css/app.min.css',
	'snappymail/v/0.0.0/static/js/min/libs.min.js',
	'snappymail/v/0.0.0/static/js/min/app.min.js',
	'snappymail/v/0.0.0/static/images/background.jpg',
	'snappymail/v/0.0.0/static/images/petuja-systems-logo.svg',
	'snappymail/v/0.0.0/static/fonts/Rubik/Rubik-VariableFont_wght.ttf'
];
const fingerprintDirectories = [
	'dev', 'tasks', 'vendors/bootstrap/less', 'vendors/routes', 'vendors/jua',
	'vendors/knockout/build/output', 'vendors/squire2/dist', 'vendors/mathiasbynens',
	'vendors/turndown', 'snappymail/v/0.0.0/app/localization'
];
const fingerprintFiles = ['gulpfile.js', 'package.json', 'yarn.lock', 'vendors/normalize.css/normalize.css'];

function captureOutput() {
	let value = '';
	return {
		write(chunk) { value += chunk; },
		value: () => value
	};
}

test('Python candidates honor PYTHON and preserve platform defaults', () => {
	assert.deepEqual(pythonCandidates({ platform: 'win32', env: { PYTHON: 'C:\\Tools\\Python 3\\python.exe' } }), [
		{ command: 'C:\\Tools\\Python 3\\python.exe', args: [], fromOverride: true }
	]);
	assert.deepEqual(pythonCandidates({ platform: 'win32', env: {} }), [
		{ command: 'py', args: ['-3'] },
		{ command: 'python3', args: [] },
		{ command: 'python', args: [] }
	]);
	assert.deepEqual(pythonCandidates({ platform: 'linux', env: {} }), [
		{ command: 'python3', args: [] },
		{ command: 'python', args: [] }
	]);
});

test('Windows localization lint falls through unavailable commands with exact arguments', async () => {
	const calls = [];
	const stdout = captureOutput();
	const stderr = captureOutput();
	await runPythonScript('scripts/validate_localization.py', {
		cwd: 'repo',
		platform: 'win32',
		env: {},
		stdout,
		stderr,
		execFileImpl(command, args, options, callback) {
			calls.push({ command, args, options });
			if ('py' !== command && 'python3' !== command) {
				callback(null, 'validated\n', '');
				return;
			}
			const error = new Error('not installed');
			error.code = 'python3' === command ? 'EACCES' : 'ENOENT';
			if ('python3' === command) {
				error.code = 9009;
				error.message = 'Command failed: python3';
			}
			callback(error, '', 'Python was not found; run without arguments to install from the Microsoft Store.');
		}
	});

	assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
		['py', ['-3', 'scripts/validate_localization.py']],
		['python3', ['scripts/validate_localization.py']],
		['python', ['scripts/validate_localization.py']]
	]);
	assert.ok(calls.every(({ options }) => 'repo' === options.cwd));
	assert.equal(stdout.value(), 'validated\n');
	assert.equal(stderr.value(), '');
});

test('PYTHON override is used alone and Unix falls back from python3 to python', async () => {
	const overrideCalls = [];
	await assert.rejects(runPythonScript('scripts/validate_localization.py', {
		platform: 'win32',
		env: { PYTHON: 'custom-python' },
		stdout: captureOutput(),
		stderr: captureOutput(),
		execFileImpl(command, args, options, callback) {
			overrideCalls.push({ command, args });
			const error = new Error('not installed');
			error.code = 'ENOENT';
			callback(error, '', '');
		}
	}), /PYTHON \(custom-python\).*Set PYTHON/);
	assert.deepEqual(overrideCalls, [{ command: 'custom-python', args: ['scripts/validate_localization.py'] }]);

	const linuxCalls = [];
	await runPythonScript('scripts/validate_localization.py', {
		platform: 'linux',
		env: {},
		stdout: captureOutput(),
		stderr: captureOutput(),
		execFileImpl(command, args, options, callback) {
			linuxCalls.push({ command, args });
			if ('python3' === command) {
				const error = new Error('not installed');
				error.code = 'ENOENT';
				callback(error, '', '');
			} else {
				callback(null, 'validated\n', '');
			}
		}
	});
	assert.deepEqual(linuxCalls, [
		{ command: 'python3', args: ['scripts/validate_localization.py'] },
		{ command: 'python', args: ['scripts/validate_localization.py'] }
	]);
});

test('Windows does not switch interpreters after a Python command runs and validation fails', async () => {
	const calls = [];
	await assert.rejects(runPythonScript('scripts/validate_localization.py', {
		platform: 'win32',
		env: {},
		stdout: captureOutput(),
		stderr: captureOutput(),
		execFileImpl(command, args, options, callback) {
			calls.push({ command, args });
			const error = new Error('validation failed');
			error.code = 2;
			callback(error, '', 'validation failed\n');
		}
	}), /failed using py -3 \(exited with code 2\)/);
	assert.deepEqual(calls, [{ command: 'py', args: ['-3', 'scripts/validate_localization.py'] }]);
});

test('Unix does not switch interpreters after a Python command exits with a validation error', async () => {
	const calls = [];
	await assert.rejects(runPythonScript('scripts/validate_localization.py', {
		platform: 'linux',
		env: {},
		stdout: captureOutput(),
		stderr: captureOutput(),
		execFileImpl(command, args, options, callback) {
			calls.push({ command, args });
			const error = new Error('validation failed');
			error.code = 9009;
			callback(error, '', 'validation failed\n');
		}
	}), /failed using python3 \(exited with code 9009\)/);
	assert.deepEqual(calls, [{ command: 'python3', args: ['scripts/validate_localization.py'] }]);
});

test('Windows does not treat an unrelated exit code 9009 as a missing Python alias', async () => {
	const calls = [];
	await assert.rejects(runPythonScript('scripts/validate_localization.py', {
		platform: 'win32',
		env: {},
		stdout: captureOutput(),
		stderr: captureOutput(),
		execFileImpl(command, args, options, callback) {
			calls.push({ command, args });
			const error = new Error('validator returned 9009');
			error.code = 9009;
			callback(error, '', 'validation failed\n');
		}
	}), /failed using py -3 \(exited with code 9009\)/);
	assert.deepEqual(calls, [{ command: 'py', args: ['-3', 'scripts/validate_localization.py'] }]);
});

async function makeRepositoryRoot(t) {
	const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'petuja-demo-build-'));
	t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
	const cliPath = path.join(repositoryRoot, 'node_modules', 'gulp', 'bin', 'gulp.js');
	await mkdir(path.dirname(cliPath), { recursive: true });
	await writeFile(cliPath, '/* fake local Gulp CLI */\n');
	for (const directory of fingerprintDirectories) await mkdir(path.join(repositoryRoot, directory), { recursive: true });
	for (const file of fingerprintFiles) {
		const filePath = path.join(repositoryRoot, file);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, file + '\n');
	}
	return repositoryRoot;
}

function fakeBuildRunner({ exitCode = 0, signal = null, assets = true, emptyAsset = null } = {}) {
	const calls = [];
	const spawnImpl = (executable, args, options) => {
		calls.push({ executable, args, options });
		const child = new EventEmitter();
		child.kill = () => true;
		queueMicrotask(async () => {
			if (assets) {
				for (const asset of requiredAssets) {
					const assetPath = path.join(options.cwd, asset);
					await mkdir(path.dirname(assetPath), { recursive: true });
					await writeFile(assetPath, asset === emptyAsset ? '' : 'built asset');
				}
			}
			child.emit('exit', exitCode, signal);
		});
		return child;
	};
	return { calls, spawnImpl };
}

test('demo build invokes the local Gulp CLI and verifies every required asset', async (t) => {
	const repositoryRoot = await makeRepositoryRoot(t);
	const { calls, spawnImpl } = fakeBuildRunner();
	const stdout = captureOutput();
	const processEvents = [];
	await prepareDemoBuild({
		repositoryRoot,
		spawnImpl,
		stdout,
		onProcess: child => processEvents.push(child)
	});

	assert.deepEqual(calls, [{
		executable: process.execPath,
		args: [path.join(repositoryRoot, 'node_modules', 'gulp', 'bin', 'gulp.js'), 'devDemoAssets'],
		options: { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true }
	}]);
	assert.match(stdout.value(), /installed Gulp CLI/);
	assert.equal(processEvents.length, 2);
	assert.ok(processEvents[0] instanceof EventEmitter);
	assert.equal(processEvents[1], null);
});

test('demo build replaces stale generated assets from an older checkout', async (t) => {
	const repositoryRoot = await makeRepositoryRoot(t);
	for (const asset of requiredAssets) {
		const assetPath = path.join(repositoryRoot, asset);
		await mkdir(path.dirname(assetPath), { recursive: true });
		await writeFile(assetPath, 'stale output from an older checkout');
	}
	const { spawnImpl } = fakeBuildRunner();
	await prepareDemoBuild({ repositoryRoot, spawnImpl, stdout: captureOutput() });
	for (const asset of requiredAssets) {
		assert.equal(await readFile(path.join(repositoryRoot, asset), 'utf8'), 'built asset');
	}
});

test('demo startup stops before PHP checks or services when the build fails', async (t) => {
	const repositoryRoot = await makeRepositoryRoot(t);
	const { spawnImpl } = fakeBuildRunner({ exitCode: 1, assets: false });
	let runtimeChecks = 0;
	let servicesStarted = 0;
	await assert.rejects(runDemoStartup({
		prepareBuild: () => prepareDemoBuild({ repositoryRoot, spawnImpl, stdout: captureOutput() }),
		assertRuntime: () => { runtimeChecks += 1; },
		startServices: async () => { servicesStarted += 1; }
	}), /asset generation failed with exit code 1/);
	assert.equal(runtimeChecks, 0);
	assert.equal(servicesStarted, 0);
});

test('demo startup does not check PHP or start services after an interrupt', async () => {
	let runtimeChecks = 0;
	let servicesStarted = 0;
	const started = await runDemoStartup({
		prepareBuild: async () => {},
		isStopping: () => true,
		assertRuntime: () => { runtimeChecks += 1; },
		startServices: async () => { servicesStarted += 1; }
	});
	assert.equal(started, false);
	assert.equal(runtimeChecks, 0);
	assert.equal(servicesStarted, 0);

	let stopping = false;
	const completed = await runDemoStartup({
		prepareBuild: async () => {},
		isStopping: () => stopping,
		assertRuntime: () => { stopping = true; },
		startServices: async () => { servicesStarted += 1; }
	});
	assert.equal(completed, false);
	assert.equal(servicesStarted, 0);
});

test('demo startup stops before PHP checks or services when assets are incomplete', async (t) => {
	const repositoryRoot = await makeRepositoryRoot(t);
	const { spawnImpl } = fakeBuildRunner({ assets: false });
	let runtimeChecks = 0;
	let servicesStarted = 0;
	await assert.rejects(runDemoStartup({
		prepareBuild: () => prepareDemoBuild({ repositoryRoot, spawnImpl, stdout: captureOutput() }),
		assertRuntime: () => { runtimeChecks += 1; },
		startServices: async () => { servicesStarted += 1; }
	}), /did not produce required demo files/);
	assert.equal(runtimeChecks, 0);
	assert.equal(servicesStarted, 0);
});

test('demo startup rejects interrupted builds and incomplete assets', async (t) => {
	const repositoryRoot = await makeRepositoryRoot(t);
	const interrupted = fakeBuildRunner({ signal: 'SIGINT', assets: false });
	await assert.rejects(prepareDemoBuild({
		repositoryRoot,
		spawnImpl: interrupted.spawnImpl,
		stdout: captureOutput()
	}), /asset generation was interrupted/);

	const emptyAsset = fakeBuildRunner({ emptyAsset: requiredAssets[0] });
	await assert.rejects(prepareDemoBuild({
		repositoryRoot,
		spawnImpl: emptyAsset.spawnImpl,
		stdout: captureOutput()
	}), /did not produce required demo files/);
});

test('demo build reuses only a source-matched asset set from a verified workspace', async t => {
	const repositoryRoot = await makeRepositoryRoot(t);
	const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'petuja-demo-build-state-'));
	t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
	const workspace = await prepareDemoWorkspace(repositoryRoot, { temporaryDirectory: workspaceRoot });
	const initial = fakeBuildRunner();
	await prepareDemoBuild({ repositoryRoot, workspace, spawnImpl: initial.spawnImpl, stdout: captureOutput() });
	const reused = fakeBuildRunner();
	const result = await prepareDemoBuild({ repositoryRoot, workspace, spawnImpl: reused.spawnImpl, stdout: captureOutput() });
	assert.equal(result.rebuilt, false);
	assert.equal(reused.calls.length, 0, 'a matching source fingerprint and asset hashes skip Gulp');
	await writeFile(path.join(repositoryRoot, 'gulpfile.js'), 'changed input\n');
	const changed = fakeBuildRunner();
	const rebuilt = await prepareDemoBuild({ repositoryRoot, workspace, spawnImpl: changed.spawnImpl, stdout: captureOutput() });
	assert.equal(rebuilt.rebuilt, true);
	assert.equal(changed.calls.length, 1, 'a changed build input invalidates the cache');
});

test('missing local Gulp CLI aborts without invoking a runner', async (t) => {
	const repositoryRoot = await makeRepositoryRoot(t);
	await rm(path.join(repositoryRoot, 'node_modules', 'gulp', 'bin', 'gulp.js'));
	let calls = 0;
	await assert.rejects(prepareDemoBuild({
		repositoryRoot,
		spawnImpl: () => { calls += 1; },
		stdout: captureOutput()
	}), /Installed local Gulp CLI not found/);
	assert.equal(calls, 0);
});
