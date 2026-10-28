/* Build the public product-versioned static tree from the normal Gulp output. */
const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

async function copyAsset(source, destination) {
	const info = await fs.lstat(source);
	if (info.isSymbolicLink()) throw new Error('Static assets must not contain symbolic links: ' + source);
	if (info.isDirectory()) {
		await fs.mkdir(destination);
		for (const name of (await fs.readdir(source)).sort()) {
			await copyAsset(path.join(source, name), path.join(destination, name));
		}
		await fs.chmod(destination, info.mode & 0o777);
		await fs.utimes(destination, info.atime, info.mtime);
	} else if (info.isFile()) {
		if (/\.(?:gz|br)$/.test(source)) {
			const compressed = await fs.readFile(source);
			const original = await fs.readFile(source.replace(/\.(?:gz|br)$/, ''));
			const decoded = source.endsWith('.gz') ? zlib.gunzipSync(compressed) : zlib.brotliDecompressSync(compressed);
			if (!decoded.equals(original)) throw new Error('Stale compressed static asset: ' + source);
		}
		await fs.copyFile(source, destination);
		await fs.chmod(destination, info.mode & 0o777);
		await fs.utimes(destination, info.atime, info.mtime);
	} else {
		throw new Error('Unsupported static asset type: ' + source);
	}
}

async function prepareProductStatic(repositoryRoot = path.resolve(__dirname, '..')) {
	const versionRoot = path.join(repositoryRoot, 'snappymail', 'v', '0.0.0');
	const metadata = JSON.parse(await fs.readFile(path.join(versionRoot, 'app', 'petuja-product.json'), 'utf8'));
	if (metadata.product !== 'petuja.email' || typeof metadata.version !== 'string'
		|| metadata.version !== metadata.version.trim()
		|| !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
		throw new Error('Invalid petuja.email product metadata');
	}
	const root = path.join(versionRoot, 'static');
	const rootInfo = await fs.lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Invalid static asset directory');
	const destination = path.join(root, 'petuja-email-' + metadata.version);
	const stage = await fs.mkdtemp(path.join(root, '.petuja-static-'));
	await fs.chmod(stage, rootInfo.mode & 0o777);
	const previous = stage + '-previous';
	let movedPrevious = false;
	try {
		for (const name of (await fs.readdir(root)).sort()) {
			if (name.startsWith('petuja-email-') || name.startsWith('.petuja-static-')) continue;
			await copyAsset(path.join(root, name), path.join(stage, name));
		}
		try {
			const existing = await fs.lstat(destination);
			if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Invalid generated static destination');
			await fs.rename(destination, previous);
			movedPrevious = true;
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		try {
			await fs.rename(stage, destination);
		} catch (error) {
			if (movedPrevious) await fs.rename(previous, destination);
			movedPrevious = false;
			throw error;
		}
		if (movedPrevious) await fs.rm(previous, { recursive: true });
	} finally {
		await fs.rm(stage, { recursive: true, force: true });
	}
}

module.exports = { prepareProductStatic };
