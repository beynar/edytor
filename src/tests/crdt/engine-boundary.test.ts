/**
 * Gate-2 engine boundary — the CRDT layer must never runtime-import the
 * v13 engine stack.
 *
 * `src/lib/crdt/**` receives the vendored v14 engine by injection
 * (`bind*(Y)`) and depends only on `lib0-v14` at runtime. A stray
 * `import 'yjs'` / `y-protocols` / `y-websocket` / `y-indexeddb` / `lib0`
 * would silently wire a second, wire-incompatible engine into the shipped
 * tree. `import type` is exempt — erased at compile time. The vendored
 * engine itself (`vendor/**`) is excluded: it IS the engine.
 */
// @ts-nocheck -- tests read package files directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRDT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../lib/crdt');

const collectTs = (dir) => {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'vendor') continue; // the engine itself — excluded
			out.push(...collectTs(p));
		} else if (/\.ts$/.test(entry.name)) {
			out.push(p);
		}
	}
	return out;
};

const BANNED = /^(yjs|y-protocols|y-websocket|y-indexeddb|lib0)$|^lib0\//;
/** Every runtime import/export specifier in a file (import type exempt). */
const runtimeSpecifiers = (src) => {
	const specs = [];
	// strip `import type …` / `export type …` statements
	const noType = src.replace(/(import|export)\s+type\s[^'"]*from\s*['"][^'"]*['"]/g, '');
	const re =
		/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
	let m;
	while ((m = re.exec(noType)) !== null) {
		specs.push(m[1] ?? m[2] ?? m[3]);
	}
	return specs;
};

describe('engine boundary: no v13 runtime imports under src/lib/crdt', () => {
	const files = collectTs(CRDT_ROOT);
	test('the scan actually covers the CRDT subtree', () => {
		expect(files.length).toBeGreaterThan(10);
	});
	for (const file of files) {
		test(relative(CRDT_ROOT, file), () => {
			const specs = runtimeSpecifiers(readFileSync(file, 'utf8'));
			const bad = specs.filter((s) => s != null && BANNED.test(s));
			expect(bad, `${file} imports v13 engine package(s): ${bad.join(', ')}`).toEqual([]);
		});
	}
	test('nothing outside vendor/ runtime-imports the vendored engine source', () => {
		for (const file of files) {
			const specs = runtimeSpecifiers(readFileSync(file, 'utf8'));
			const bad = specs.filter((s) => s != null && /vendor\/yjs\/src/.test(s));
			expect(bad, `${file} runtime-imports vendored engine JS: ${bad.join(', ')}`).toEqual([]);
		}
	});
});
