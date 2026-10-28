import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	demoRootMarkerName,
	prepareDemoWorkspace,
	resetDemoWorkspace,
	writeDemoFile
} from '../scripts/dev-demo-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phpBinary = process.env.PHP_BINARY || 'php';
const isWindows = 'win32' === process.platform;

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address();
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

async function startPhp(workspace, port) {
	const bootstrapPath = path.join(workspace.root, 'demo-bootstrap.php');
	const child = spawn(phpBinary, [
		'-d', 'display_errors=0',
		'-d', 'disable_functions=proc_open',
		'-d', 'auto_prepend_file=' + bootstrapPath,
		'-S', '127.0.0.1:' + port,
		'-t', workspace.root
	], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	let output = '';
	child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
	child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
	const stop = async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await new Promise(resolve => child.once('exit', resolve));
		}
	};
	const baseUrl = 'http://127.0.0.1:' + port;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null || child.signalCode !== null) break;
		try {
			const response = await fetch(baseUrl + '/fastpath-check.php');
			if (response.ok) return { baseUrl, stop };
		} catch {}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	await stop();
	assert.fail('The local fast-path PHP server did not start:\n' + output);
}

test('Windows AccountPath demo bypass requires the validated marker and loopback request', {
	skip: !isWindows,
	timeout: 30000
}, async t => {
	const modules = spawnSync(phpBinary, ['-m'], { encoding: 'utf8', windowsHide: true });
	if (modules.error || 0 !== modules.status) {
		t.skip('PHP CLI is unavailable: ' + (modules.error?.message || modules.stderr));
		return;
	}

	const workspace = await prepareDemoWorkspace(repositoryRoot, { temporaryDirectory: tmpdir() });
	const markerPath = path.join(workspace.root, demoRootMarkerName);
	const markerContents = await readFile(markerPath);
	await mkdir(path.join(workspace.root, '_data_', '_default_', 'storage'), { recursive: true });
	const bootstrap = [
		'<?php',
		"define('APP_DATA_FOLDER_PATH', __DIR__ . DIRECTORY_SEPARATOR);",
		"define('PETUJA_LOCAL_DEMO_ROOT', __DIR__);",
		"define('PETUJA_LOCAL_DEMO_MARKER_CONTENTS', hex2bin('" + markerContents.toString('hex') + "'));",
		''
	].join('\n');
	let server;
	try {
		await writeDemoFile(workspace, 'demo-bootstrap.php', bootstrap);
		await writeDemoFile(workspace, 'fastpath-check.php', [
			'<?php',
			"require " + JSON.stringify(path.join(repositoryRoot, 'snappymail/v/0.0.0/app/libraries/snappymail/storage/accountpath.php')) + ';',
			"if (isset($_GET['remote'])) $_SERVER['REMOTE_ADDR'] = $_GET['remote'];",
			"if (isset($_GET['server'])) $_SERVER['SERVER_ADDR'] = $_GET['server'];",
			"$result = 'OK';",
			'try { new \\SnappyMail\\Storage\\AccountPath(APP_DATA_FOLDER_PATH . \'_data_/_default_/storage\', false); }',
			"catch (\\Throwable $error) { $result = get_class($error) . ': ' . $error->getMessage(); }",
			"header('Content-Type: application/json');",
			'echo json_encode([\'result\' => $result, \'remote\' => $_SERVER[\'REMOTE_ADDR\'] ?? null, \'server\' => $_SERVER[\'SERVER_ADDR\'] ?? null]);',
			''
		].join('\n'));

		server = await startPhp(workspace, await reservePort());
		const check = async suffix => (await fetch(server.baseUrl + '/fastpath-check.php' + suffix)).json();
		assert.equal((await check('')).result, 'OK', 'a marked demo workspace is usable without proc_open on loopback');
		assert.notEqual((await check('?remote=192.0.2.1')).result, 'OK',
			'a non-loopback client cannot use the demo ACL fast path');
		assert.notEqual((await check('?server=192.0.2.1')).result, 'OK',
			'a non-loopback server address cannot use the demo ACL fast path');

		await writeFile(markerPath, 'invalid marker');
		assert.notEqual((await check('')).result, 'OK',
			'a modified workspace marker cannot use the demo ACL fast path');
	} finally {
		await server?.stop();
		await writeFile(markerPath, markerContents);
		await resetDemoWorkspace(repositoryRoot, { temporaryDirectory: tmpdir() });
	}
});
