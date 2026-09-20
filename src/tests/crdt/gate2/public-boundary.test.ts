/**
 * GATE-2 attack probes — the public package boundary (attack item 5).
 *
 * The providers doc (`docs/crdt-v14-providers.md`) tells consumers:
 *
 *   import * as Y from 'edytor/crdt';
 *   import { bindCrdt } from 'edytor';
 *
 * These probes assert that contract against the actual package surface:
 * the exports map, the root module, and the dependency set. Verified
 * externally too: tests/packed-consumer installs the packed tarball —
 * `import 'edytor'` resolves the root (a `default` condition exists) but
 * rejects at the `.svelte` component under plain node, and deep imports
 * fail with ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
// @ts-nocheck -- tests read package files directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const indexSrc = readFileSync(join(ROOT, 'src/lib/index.ts'), 'utf8');
const crdtIndexSrc = readFileSync(join(ROOT, 'src/lib/crdt/index.ts'), 'utf8');

const exportTargets = () =>
	Object.values(pkg.exports ?? {}).flatMap((e) => (typeof e === 'object' ? Object.values(e) : [e]));

describe('attack 5: consumers can construct every promised v14 component', () => {
	test('the package root export resolves for non-svelte consumers', () => {
		const dot = pkg.exports?.['.'];
		// CONTRACT: `import { bindCrdt } from 'edytor'` must resolve outside
		// a svelte-conditioned resolver — a `default`/`import`/`node`
		// condition must exist. (Resolution ≠ loadability: plain node still
		// rejects at the `.svelte` component — that's the documented
		// boundary; the node-safe surface is `edytor/crdt/edytor`.)
		expect(dot?.default ?? dot?.import ?? dot?.node).toBeDefined();
	});

	test('bindCrdt (the documented provider entry) is reachable from SOME export', () => {
		// CONTRACT: bindCrdt — the only way to construct providers, the
		// facade, and migration helpers — must be exported through a public
		// path: the root module, or a subpath that targets crdt/index.js.
		// Today it lives in src/lib/crdt/index.ts but nothing reaches it:
		// root index.ts has no crdt re-export and ./crdt maps to the raw
		// vendored engine entry (vendor/yjs/src/index.js).
		const viaRoot = /bindCrdt|['"]\.\/crdt|['"]\.\/lib\/crdt/.test(indexSrc);
		const viaSubpath = exportTargets().some((t) => /crdt\/index\.js$/.test(String(t)));
		console.log(
			`[gate2] bindCrdt reachability: viaRoot=${viaRoot} viaSubpath=${viaSubpath} ` +
				`crdtExport=${JSON.stringify(pkg.exports?.['./crdt'])}`
		);
		expect(viaRoot || viaSubpath).toBe(true); // ← fails: unreachable
	});

	test('Awareness is constructible from a public export', () => {
		// CONTRACT: consumers need Awareness (provider options take it). It
		// is reachable iff bindCrdt is reachable (bindCrdt returns it) or a
		// subpath targets protocols/awareness directly.
		const bindCrdtReachable =
			/bindCrdt|['"]\.\/crdt|['"]\.\/lib\/crdt/.test(indexSrc) ||
			exportTargets().some((t) => /crdt\/index\.js$/.test(String(t)));
		const awarenessExported = /Awareness/.test(crdtIndexSrc);
		const viaSubpath = exportTargets().some((t) => /awareness\.js$/.test(String(t)));
		console.log(
			`[gate2] Awareness reachability: bindCrdtReachable=${bindCrdtReachable} ` +
				`awarenessExported=${awarenessExported} viaSubpath=${viaSubpath}`
		);
		expect((bindCrdtReachable && awarenessExported) || viaSubpath).toBe(true); // ← fails
	});
});

describe('attack 5: no accidental second engine in the shipped tree', () => {
	test('dependencies do not install the v13 engine stack alongside v14', () => {
		const deps = pkg.dependencies ?? {};
		// CONTRACT: consumers must not silently receive a second, wire-
		// incompatible engine. Today the package depends on the full v13
		// stack — yjs@13, y-protocols, y-websocket, y-indexeddb, lib0@0.2 —
		// and dist/collaboration/providers.js + dist/localProvider.js import
		// it, reachable from the root export (packed consumer node_modules
		// contains yjs@13.6.30 + y-protocols + y-websocket + lib0@0.2.117).
		for (const bad of ['yjs', 'y-protocols', 'y-websocket', 'y-indexeddb']) {
			expect(deps[bad], `${bad} still in dependencies`).toBeUndefined();
		}
		// Old lib0 (0.2.x) is the v13 engine's runtime — same problem.
		expect(deps['lib0']).toBeUndefined();
	});

	test('the shipped root does not re-export v13 collaboration providers', () => {
		// CONTRACT: nothing reachable from the root export may pull the
		// v13 engine stack (yjs@13 / y-websocket / y-protocols /
		// y-indexeddb / the deleted localProvider). The collaboration
		// surface bound to the vendored v14 engine is fine and expected —
		// `collaboration/providers.ts` must import the engine through the
		// `$lib/crdt/engine.js` boundary, never a v13 package specifier.
		const provSrc = readFileSync(join(ROOT, 'src/lib/collaboration/providers.ts'), 'utf8');
		for (const [label, src] of [
			['src/lib/index.ts', indexSrc],
			['src/lib/collaboration/providers.ts', provSrc]
		] as const) {
			for (const bad of ['yjs', 'y-protocols', 'y-websocket', 'y-indexeddb', 'localProvider']) {
				expect(src, `${label} references v13 specifier '${bad}'`).not.toMatch(
					new RegExp(`from ['"][^'"]*${bad}(/|['"]|$)`)
				);
			}
		}
		// The one permitted engine path for the bound collaboration surface.
		expect(provSrc).toMatch(/\$lib\/crdt\/engine\.js/);
	});
});
