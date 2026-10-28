import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readDemoFile, writeDemoFile } from './dev-demo-runtime.mjs';

const requiredAssets = [
	'snappymail/v/0.0.0/static/css/app.min.css',
	'snappymail/v/0.0.0/static/js/min/libs.min.js',
	'snappymail/v/0.0.0/static/js/min/app.min.js',
	'snappymail/v/0.0.0/static/images/background.jpg',
	'snappymail/v/0.0.0/static/images/petuja-systems-logo.svg',
	'snappymail/v/0.0.0/static/fonts/Rubik/Rubik-VariableFont_wght.ttf'
];
const fingerprintDirectories = [
	'dev',
	'tasks',
	'vendors/bootstrap/less',
	'vendors/routes',
	'vendors/jua',
	'vendors/knockout/build/output',
	'vendors/squire2/dist',
	'vendors/mathiasbynens',
	'vendors/turndown',
	'snappymail/v/0.0.0/app/localization'
];
const fingerprintFiles = [
	'gulpfile.js',
	'package.json',
	'yarn.lock',
	'vendors/normalize.css/normalize.css'
];
const buildStampPath = '.demo-assets.json';

async function inspectFile(filePath) {
	try {
		return await lstat(filePath);
	} catch (error) {
		if ('ENOENT' === error.code) {
			return null;
		}
		throw error;
	}
}

async function collectFiles(root, relativeDirectory) {
	const directory = path.join(root, relativeDirectory);
	const entries = await readdir(directory, { withFileTypes: true });
	const output = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const relative = path.posix.join(relativeDirectory.replace(/\\/g, '/'), entry.name);
		const target = path.join(root, relative);
		if (entry.isSymbolicLink()) {
			throw new Error('Build fingerprint source contains a symbolic link: ' + relative);
		}
		if (entry.isDirectory()) output.push(...await collectFiles(root, relative));
		else if (entry.isFile()) output.push(relative);
	}
	return output;
}

async function sourceFingerprint(repositoryRoot) {
	const files = [...fingerprintFiles];
	for (const directory of fingerprintDirectories) {
		files.push(...await collectFiles(repositoryRoot, directory));
	}
	files.sort();
	const hash = createHash('sha256');
	for (const relative of files) {
		const contents = await readFile(path.join(repositoryRoot, relative));
		hash.update(relative).update('\0').update(contents).update('\0');
	}
	return hash.digest('hex');
}

async function assetDigests(repositoryRoot) {
	const result = {};
	for (const asset of requiredAssets) {
		const filePath = path.join(repositoryRoot, asset);
		const stats = await inspectFile(filePath);
		if (!stats || !stats.isFile() || stats.isSymbolicLink() || 0 === stats.size) {
			return null;
		}
		result[asset] = createHash('sha256').update(await readFile(filePath)).digest('hex');
	}
	return result;
}

export async function assertDemoAssets(repositoryRoot) {
	const incomplete = [];
	for (const asset of requiredAssets) {
		const stats = await inspectFile(path.join(repositoryRoot, asset));
		if (!stats || !stats.isFile() || stats.isSymbolicLink() || 0 === stats.size) {
			incomplete.push(asset);
		}
	}
	if (incomplete.length) {
		throw new Error(
			'Local Gulp asset tasks did not produce required demo files (' + incomplete.join(', ') + ').'
		);
	}
}

function waitForBuild(child) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback, value) => {
			if (!settled) {
				settled = true;
				callback(value);
			}
		};
		child.once('error', error => {
			finish(reject, new Error('Could not start the installed local Gulp asset tasks: ' + error.message));
		});
		child.once('exit', (code, signal) => {
			if (signal) {
				finish(reject, new Error('Local Gulp asset generation was interrupted (' + signal + '); no demo services were started.'));
			} else if (0 !== code) {
				finish(reject, new Error('Local Gulp asset generation failed with exit code ' + (null === code ? 'unknown' : code) + '.'));
			} else {
				finish(resolve);
			}
		});
	});
}

export async function prepareDemoBuild({
	repositoryRoot,
	workspace,
	spawnImpl = spawn,
	onProcess = () => {},
	stdout = process.stdout
}) {
	const inputHash = await sourceFingerprint(repositoryRoot);
	const existingAssets = await assetDigests(repositoryRoot);
	if (workspace && existingAssets) {
		try {
			const saved = JSON.parse((await readDemoFile(workspace, buildStampPath, { maxBytes: 4096 })).toString('utf8'));
			if (saved?.sourceHash === inputHash && JSON.stringify(saved?.assets) === JSON.stringify(existingAssets)) {
				stdout.write('Reusing verified local demo assets.\n');
				return { rebuilt: false, assets: existingAssets };
			}
		} catch (error) {
			if (!['ENOENT'].includes(error.code)) {
				if (!/demo workspace file|marker|workspace/i.test(error.message)) throw error;
			}
		}
	}
	const gulpCli = path.join(repositoryRoot, 'node_modules', 'gulp', 'bin', 'gulp.js');
	const cliStats = await inspectFile(gulpCli);
	if (!cliStats || !cliStats.isFile() || cliStats.isSymbolicLink()) {
		throw new Error(
			'Installed local Gulp CLI not found at node_modules/gulp/bin/gulp.js. '
			+ 'Install project dependencies with `corepack yarn install --frozen-lockfile`, then retry.'
		);
	}

	stdout.write('Building local demo assets with the installed Gulp CLI...\n');
	let child;
	try {
		child = spawnImpl(process.execPath, [gulpCli, 'devDemoAssets'], {
			cwd: repositoryRoot,
			stdio: 'inherit',
			windowsHide: true
		});
		onProcess(child);
		await waitForBuild(child);
	} finally {
		onProcess(null);
	}

	await assertDemoAssets(repositoryRoot);
	const assets = await assetDigests(repositoryRoot);
	if (workspace) {
		await writeDemoFile(workspace, buildStampPath, JSON.stringify({ sourceHash: inputHash, assets }) + '\n');
	}
	return { rebuilt: true, assets };
}

export async function runDemoStartup({
	prepareBuild,
	assertRuntime,
	startServices,
	isStopping = () => false
}) {
	await prepareBuild();
	if (isStopping()) {
		return false;
	}
	await assertRuntime();
	if (isStopping()) {
		return false;
	}
	await startServices();
	return true;
}
