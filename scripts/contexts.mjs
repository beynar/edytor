// The contexts of src/lib (AGENTS.md "The top-level model") as data, shared
// by the dependency check (`scripts/deps.mjs`, `src/tests/deps.test.ts`) and
// the import-direction lint rule (`edytor/context-imports` in
// eslint.config.js). Keep it in step with that table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIB = path.join(ROOT, 'src/lib');

/**
 * Module path (relative to src/lib) → context, first match wins.
 *
 * - doc: the replicated document (`crdt/`), DOM-free and Svelte-free.
 * - sync: transport, the room, presence state.
 * - shared: leaves every context reads (utilities, constants, the label tables).
 * - session: DOM-free per-view state and the commands over it, the handles,
 *   the clipboard's flows, the selection rules over the value and the kind
 *   catalogue.
 * - surface: the code that reads or writes the host DOM: render cells,
 *   observer, projector, components, event adapters, the DOM selection's
 *   adopter (`EdytorSelection`) and the remote carets.
 * - plugins: kind, mark and atom records and the chrome built on them.
 * - root: the composition root (`Edytor`), the mount and the public entry.
 * - starter: `edytor/starter`, the full editor and the ready-made chrome: it
 *   reads the public entry only, and nothing of the package imports it.
 */
export const CONTEXTS = [
	['sync', /^crdt\/(providers|protocols)\//],
	['sync', /^cloudflare\//],
	['doc', /^crdt\//],
	['shared', /^(utils|constants|labels)(\/|\.[jt]s$)/],
	['surface', /^collaboration\/(remoteSelection\.ts|RemoteSelections\.svelte)$/],
	['plugins', /^collaboration\/history\//],
	['sync', /^collaboration\//],
	['session', /^session\//],
	['session', /^selection\/(replaceSelection|visibility)\.ts$/],
	['session', /^(block|text|clipboard)\//],
	['session', /^(kinds|edytor\.utils)\.ts$/],
	['root', /^(edytor\.svelte\.ts|index\.ts|components\/Edytor\.svelte)$/],
	['surface', /^(surface|events|components|selection|dnd)\//],
	['plugins', /^plugins(\/|\.ts$)/],
	['starter', /^starter\//]
];

/**
 * The value imports a context must not make (`edytor/context-imports`): the
 * session never reaches the surface, the chrome or the root (it declares a
 * port the root implements, `session/ports.ts`), and the surface never
 * reaches the chrome or the root. Nothing reaches the starter, and the
 * starter reaches the package through its public entry only.
 */
export const FORBIDDEN = {
	doc: ['starter'],
	sync: ['starter'],
	shared: ['starter'],
	session: ['surface', 'plugins', 'root', 'starter'],
	surface: ['plugins', 'root', 'starter'],
	plugins: ['starter'],
	root: ['starter'],
	// The public entry (`index.ts`, root) is the starter's one way in.
	starter: ['doc', 'sync', 'shared', 'session', 'surface', 'plugins']
};

/** The context of a module path relative to src/lib, or `null`. */
export const contextOf = (rel) => {
	for (const [name, re] of CONTEXTS) if (re.test(rel)) return name;
	return null;
};

/** A path under src/lib as the contexts name it (`/` separators). */
export const relOf = (file) => path.relative(LIB, file).split(path.sep).join('/');

const isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * The src/lib module a relative or `$lib` specifier names (its path relative
 * to src/lib), or `null` for a bare package or a file that is not there.
 */
export const resolveModule = (fromFile, spec, exists = isFile) => {
	let base;
	if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
	else if (spec === '$lib' || spec.startsWith('$lib/')) base = path.join(LIB, spec.slice(4));
	else return null;
	const candidates = [];
	if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'));
	candidates.push(base);
	for (const ext of ['.ts', '.js', '.svelte', '/index.ts', '/index.js'])
		candidates.push(base + ext);
	for (const candidate of candidates) {
		const rel = relOf(candidate);
		if (rel.startsWith('..')) return null;
		if (exists(candidate)) return rel;
	}
	return null;
};
