import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const demoRootMarkerName = '.petuja-email-demo-root.json';
export const demoRunLockName = '.petuja-email-demo-running.json';
export const demoWorkspaceType = 'petuja.email-local-demo';
export const demoWorkspaceVersion = 2;

function pathApi(platform) {
	return 'win32' === platform ? path.win32 : path.posix;
}

function normalizePath(value, platform) {
	const api = pathApi(platform);
	const resolved = api.resolve(value);
	return 'win32' === platform ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
}

function workspaceLeaf(repositoryRoot, platform) {
	const api = pathApi(platform);
	const normalized = normalizePath(repositoryRoot, platform);
	const id = createHash('sha256').update(normalized).digest('hex').slice(0, 20);
	return 'petuja-email-demo-' + id;
}

function workspaceData(repositoryRoot, rootPath, platform, rootCanonical) {
	return {
		root: rootCanonical || api.resolve(rootPath),
		repositoryHash: createHash('sha256').update(normalizePath(repositoryRoot, platform)).digest('hex'),
		platform
	};
}

async function lstatOrNull(filePath) {
	try {
		return await lstat(filePath);
	} catch (error) {
		if ('ENOENT' === error.code) return null;
		throw error;
	}
}

function samePath(left, right, platform) {
	return normalizePath(left, platform) === normalizePath(right, platform);
}

function assertPrivatePosixRoot(info, platform) {
	if ('win32' === platform) return;
	if ('function' !== typeof process.getuid || !Number.isInteger(info.uid)) {
		throw new Error('Refusing to use the local demo workspace because its POSIX ownership cannot be verified.');
	}
	if (info.uid !== process.getuid() || (info.mode & 0o700) !== 0o700 || (info.mode & 0o077) !== 0) {
		throw new Error('Refusing to use the local demo workspace because it is not owned by this user with owner-only permissions.');
	}
}

function insidePath(parent, child, platform) {
	const api = pathApi(platform);
	const relative = api.relative(parent, child);
	return !!relative && '..' !== relative && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative);
}

export function demoWorkspacePath(repositoryRoot, {
	temporaryDirectory = tmpdir(),
	platform = process.platform
} = {}) {
	const api = pathApi(platform);
	return api.join(api.resolve(temporaryDirectory), workspaceLeaf(repositoryRoot, platform));
}

export function demoPrivateDataRoot(demoDataRoot, platform = process.platform) {
	return pathApi(platform).join(demoDataRoot, '_data_', '_default_');
}

export async function prepareDemoWorkspace(repositoryRoot, {
	temporaryDirectory = tmpdir(),
	platform = process.platform,
	directoryPrecreated = false
} = {}) {
	const api = pathApi(platform);
	const canonicalTemp = await realpath(temporaryDirectory);
	const root = api.join(canonicalTemp, workspaceLeaf(repositoryRoot, platform));
	if (!samePath(api.dirname(root), canonicalTemp, platform) || !insidePath(canonicalTemp, root, platform)) {
		throw new Error('Refusing a demo workspace path outside the resolved operating-system temporary directory.');
	}

	let rootInfo = await lstatOrNull(root);
	let created = false;
	if (!rootInfo) {
		try {
			await mkdir(root, { mode: 0o700 });
			created = true;
			rootInfo = await lstat(root);
		} catch (error) {
			if ('EEXIST' !== error.code) throw error;
			rootInfo = await lstat(root);
		}
	}
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
		throw new Error('Refusing to use the demo workspace because it is not a real directory.');
	}
	assertPrivatePosixRoot(rootInfo, platform);
	const canonicalRoot = await realpath(root);
	if (!samePath(canonicalRoot, root, platform) || !samePath(api.dirname(canonicalRoot), canonicalTemp, platform)) {
		throw new Error('Refusing to use a demo workspace that resolves outside its dedicated temporary directory.');
	}

	const workspace = workspaceData(repositoryRoot, root, platform, canonicalRoot);
	if (created) {
		await createDemoRootMarker(workspace);
	} else {
		try {
			await verifyDemoRootMarker(workspace);
		} catch (error) {
			if (!directoryPrecreated || (await readdir(root)).length) throw error;
			await createDemoRootMarker(workspace);
		}
	}
	return { ...workspace, marker: await readDemoRootMarker(workspace) };
}

async function createDemoRootMarker(workspace) {
	const api = pathApi(workspace.platform);
	const marker = {
		type: demoWorkspaceType,
		version: demoWorkspaceVersion,
		repositoryHash: workspace.repositoryHash,
		workspaceId: randomBytes(24).toString('hex'),
		root: workspace.root
	};
	await writeFile(api.join(workspace.root, demoRootMarkerName), JSON.stringify(marker) + '\n', {
		encoding: 'utf8', mode: 0o600, flag: 'wx'
	});
}

export async function readDemoRootMarker(workspace) {
	const { root, repositoryHash, platform } = workspace;
	const api = pathApi(platform);
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error('Refusing to use the local demo workspace because it is not a regular directory.');
	}
	assertPrivatePosixRoot(info, platform);
	const markerPath = api.join(root, demoRootMarkerName);
	const markerInfo = await lstat(markerPath);
	if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 2048) {
		throw new Error('Refusing to use the local demo workspace because its marker is not a small regular file.');
	}
	let marker;
	try {
		marker = JSON.parse(await readFile(markerPath, 'utf8'));
	} catch {
		throw new Error('Refusing to use the local demo workspace because its marker is invalid.');
	}
	if (marker?.type !== demoWorkspaceType || marker?.version !== demoWorkspaceVersion
		|| marker?.repositoryHash !== repositoryHash || marker?.root !== root
		|| 'string' !== typeof marker?.workspaceId || !/^[a-f0-9]{48}$/.test(marker.workspaceId)) {
		throw new Error('Refusing to use the local demo workspace because its marker does not match this repository.');
	}
	return marker;
}

export async function verifyDemoRootMarker(workspace) {
	const marker = await readDemoRootMarker(workspace);
	const canonical = await realpath(workspace.root);
	if (!samePath(canonical, workspace.root, workspace.platform) || marker.root !== canonical) {
		throw new Error('Refusing to use a demo workspace that resolves outside its recorded location.');
	}
	return marker;
}

export async function ensureDemoDirectories(workspace, relativePath) {
	const { root, platform } = workspace;
	const api = pathApi(platform);
	await verifyDemoRootMarker(workspace);
	const parts = String(relativePath).split(/[\\/]/).filter(Boolean);
	if (!parts.length || parts.some(part => '.' === part || '..' === part || part.includes(':'))) {
		throw new Error('Refusing an unsafe path below the local demo workspace.');
	}
	let current = root;
	for (const part of parts) {
		current = api.join(current, part);
		let info = await lstatOrNull(current);
		if (!info) {
			try {
				await mkdir(current, { mode: 0o700 });
			} catch (error) {
				if ('EEXIST' !== error.code) throw error;
			}
			info = await lstat(current);
		}
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error('Refusing to write through a non-directory or reparse point in the demo workspace.');
		}
		const canonical = await realpath(current);
		if (!insidePath(root, canonical, platform) || !samePath(canonical, current, platform)) {
			throw new Error('Refusing a demo workspace directory that resolves outside the validated root.');
		}
	}
	return current;
}

function safeRelativeParts(relativePath, platform) {
	const api = pathApi(platform);
	const relative = String(relativePath);
	const parts = relative.split(/[\\/]/);
	if (!relative || api.isAbsolute(relative) || relative.includes('\0')
		|| parts.some(part => !part || '.' === part || '..' === part || part.includes(':'))) {
		throw new Error('Refusing an unsafe relative demo file path.');
	}
	return parts;
}

async function validatedDemoTarget(workspace, relativePath) {
	const { root, platform } = workspace;
	const api = pathApi(platform);
	const parts = safeRelativeParts(relativePath, platform);
	await verifyDemoRootMarker(workspace);
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = api.join(current, part);
		const info = await lstat(current);
		const canonical = await realpath(current);
		if (!info.isDirectory() || info.isSymbolicLink() || !samePath(canonical, current, platform)
			|| !insidePath(root, canonical, platform)) {
			throw new Error('Refusing to access a path through a non-directory or reparse point in the demo workspace.');
		}
	}
	const target = api.join(root, ...parts);
	const parent = await realpath(api.dirname(target));
	if (!samePath(parent, api.dirname(target), platform)
		|| (!samePath(root, parent, platform) && !insidePath(root, parent, platform))) {
		throw new Error('Refusing to access outside a validated demo workspace directory.');
	}
	return target;
}

export async function readDemoFile(workspace, relativePath, { maxBytes = 1024 * 1024 } = {}) {
	const target = await validatedDemoTarget(workspace, relativePath);
	const info = await lstat(target);
	if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
		throw new Error('Refusing to read an unsafe or oversized demo workspace file.');
	}
	return readFile(target);
}

export async function writeDemoFile(workspace, relativePath, content, { append = false } = {}) {
	const target = await validatedDemoTarget(workspace, relativePath);
	const existing = await lstatOrNull(target);
	if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
		throw new Error('Refusing to overwrite a non-regular demo workspace file.');
	}
	await writeFile(target, content, { encoding: typeof content === 'string' ? 'utf8' : undefined, mode: 0o600, flag: append ? 'a' : 'w' });
	return target;
}

export async function acquireDemoRunLock(workspace) {
	await verifyDemoRootMarker(workspace);
	const api = pathApi(workspace.platform);
	const lockPath = api.join(workspace.root, demoRunLockName);
	const token = randomBytes(24).toString('hex');
	const payload = { type: demoWorkspaceType, version: demoWorkspaceVersion, pid: process.pid, token };
	const create = () => writeFile(lockPath, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	try {
		await create();
	} catch (error) {
		if ('EEXIST' !== error.code) throw error;
		const info = await lstat(lockPath);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) {
			throw new Error('Refusing to use an unsafe demo server lock file.');
		}
		let existing;
		try { existing = JSON.parse(await readFile(lockPath, 'utf8')); } catch { existing = null; }
		const alive = Number.isSafeInteger(existing?.pid) && existing.pid > 0 && processAlive(existing.pid);
		if (alive) throw new Error('The local demo already appears to be running (PID ' + existing.pid + ').');
		await unlink(lockPath);
		await create();
	}
	return async () => {
		try {
			const current = JSON.parse(await readFile(lockPath, 'utf8'));
			if (current?.token === token && current?.pid === process.pid) await unlink(lockPath);
		} catch (error) {
			if ('ENOENT' !== error.code) throw error;
		}
	};
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return 'EPERM' === error.code;
	}
}

export async function assertDemoNotRunning(workspace) {
	const lockPath = pathApi(workspace.platform).join(workspace.root, demoRunLockName);
	const info = await lstatOrNull(lockPath);
	if (!info) return;
	if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) {
		throw new Error('Refusing reset because the demo server lock is unsafe.');
	}
	let lock;
	try { lock = JSON.parse(await readFile(lockPath, 'utf8')); } catch { lock = null; }
	if (Number.isSafeInteger(lock?.pid) && lock.pid > 0 && processAlive(lock.pid)) {
		throw new Error('Stop the active local demo before resetting its workspace (PID ' + lock.pid + ').');
	}
	await unlink(lockPath);
}

async function validateTreeNoLinks(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const child = path.join(directory, entry.name);
		const info = await lstat(child);
		if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
			throw new Error('Refusing to clean a demo workspace containing a link or special file.');
		}
		if (info.isDirectory()) await validateTreeNoLinks(child);
	}
}

export async function resetDemoWorkspace(repositoryRoot, options = {}) {
	const api = pathApi(options.platform || process.platform);
	const temporaryDirectory = options.temporaryDirectory || tmpdir();
	let canonicalTemp;
	try { canonicalTemp = await realpath(temporaryDirectory); } catch (error) {
		if ('ENOENT' === error.code) return false;
		throw error;
	}
	const root = api.join(canonicalTemp, workspaceLeaf(repositoryRoot, options.platform || process.platform));
	const info = await lstatOrNull(root);
	if (!info) return false;
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error('Refusing to reset a path that is not the dedicated demo directory.');
	}
	const canonicalRoot = await realpath(root);
	if (!samePath(canonicalRoot, root, options.platform || process.platform)
		|| !samePath(api.dirname(canonicalRoot), canonicalTemp, options.platform || process.platform)) {
		throw new Error('Refusing to reset a demo path that resolves outside the OS temporary directory.');
	}
	const workspace = workspaceData(repositoryRoot, root, options.platform || process.platform, canonicalRoot);
	await verifyDemoRootMarker(workspace);
	await assertDemoNotRunning(workspace);
	await validateTreeNoLinks(root);
	if (options.beforeRemove) await options.beforeRemove(workspace);
	await rm(root, { recursive: true, force: false });
	return true;
}

export async function assertDemoRuntimeSupported(repositoryRoot) {
	try {
		await lstat(path.join(repositoryRoot, 'include.php'));
	} catch (error) {
		if ('ENOENT' === error.code) return;
		throw error;
	}
	throw new Error('Local demo requires the default private-data layout. A repository-root include.php exists and may redirect runtime data or configuration.');
}
