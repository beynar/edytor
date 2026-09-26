/**
 * Source identification for bench artifacts — R7 correction.
 *
 * The old `dirtyHash` hashed `git status --porcelain` OUTPUT — i.e. the list
 * of changed FILENAMES, not what the files contain. Two different trees with
 * the same dirty file set hashed identically, and a clean checkout of
 * different content hashed the same as this one. Source identification must
 * hash file CONTENTS.
 *
 * `hashTree(dir)` — sha256 over the sorted (relpath, content) pairs of every
 *   file under `dir`. Deterministic across runs on identical trees; order-
 *   independent of filesystem enumeration (sorted before hashing).
 *
 * `hashFile(path)` — sha256 of one file's bytes (the packed tarball id).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const walk = (dir, out) => {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '.git') continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (st.isFile()) out.push(p);
	}
};

/**
 * sha256 of every file under `dir`: hash input is
 * `relpath\0<contents>\0` per file, files visited in sorted order.
 * Returns `{sha256, files}` or `{skipped}` when the dir is absent.
 */
export const hashTree = (dir) => {
	if (!existsSync(dir)) return { skipped: `${dir} absent` };
	const files = [];
	walk(dir, files);
	files.sort();
	const h = createHash('sha256');
	for (const f of files) {
		h.update(relative(dir, f));
		h.update('\0');
		h.update(readFileSync(f));
		h.update('\0');
	}
	return { sha256: h.digest('hex'), files: files.length };
};

/** sha256 of a single file's bytes. */
export const hashFile = (path) => {
	if (!existsSync(path)) return { skipped: `${path} absent` };
	return {
		sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
		bytes: statSync(path).size
	};
};
