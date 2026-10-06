/**
 * P8 (UPSTREAM.md) — the pruned fork stays pruned, and its public surface is
 * pinned.
 *
 * 1. `edytor/crdt` (the vendored `src/index.js`) exports exactly `KEPT`: a
 *    removed export cannot come back unnoticed, a kept one cannot vanish.
 * 2. Closure: bundling the engine object (`crdt/engine.js`) plus the codec
 *    keep list with rolldown (as `scripts/check-worker-bundle.mjs` does)
 *    keeps every top-level declaration of every vendored module, except the
 *    documented allowlist. After an upstream re-sync, this test's failure
 *    message IS the P8 deletion list.
 */
// @ts-nocheck -- drives the vendored engine JS and rolldown directly.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as V from '../../lib/crdt/vendor/yjs/src/index.js';
import { Y } from '../../lib/crdt/engine.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(ROOT, 'src/lib/crdt/vendor/yjs/src');

// prettier-ignore
const KEPT = ['$contentIds', '$contentMap', '$doc', '$idMapAny', '$idSet', '$nodeAny', '$renderer', 'AbsolutePosition', 'AbstractRenderer', 'AbstractStruct', 'ContentAny', 'ContentAttribute', 'ContentBinary', 'ContentDeleted', 'ContentDoc', 'ContentEmbed', 'ContentFormat', 'ContentJSON', 'ContentString', 'ContentType', 'Doc', 'GC', 'ID', 'IdMap', 'IdSet', 'Item', 'Node', 'RangeCursor', 'RelativePosition', 'Skip', 'Transaction', 'UndoManager', 'UpdateDecoderV1', 'UpdateDecoderV2', 'UpdateEncoderV1', 'UpdateEncoderV2', 'YEvent', 'applyUpdate', 'applyUpdateV2', 'cleanupYTextFormatting', 'compareIDs', 'convertUpdateFormatV2ToV1', 'createAbsolutePositionFromRelativePosition', 'createContentAttribute', 'createContentMap', 'createDeleteSetFromStructStore', 'createID', 'createIdMap', 'createIdSet', 'createRelativePositionFromJSON', 'createRelativePositionFromTypeIndex', 'decodeContentMap', 'decodeIdMap', 'decodeStateVector', 'decodeUpdate', 'decodeUpdateV2', 'diffIdSet', 'diffUpdateV2', 'encodeContentMap', 'encodeIdMap', 'encodeStateAsUpdate', 'encodeStateAsUpdateV2', 'encodeStateVector', 'equalIdSets', 'findIndexSS', 'findRootTypeKey', 'getItemCleanEnd', 'getItemCleanStart', 'insertIntoIdMap', 'insertIntoIdSet', 'intersectSets', 'isKeptReplaced', 'isParentOf', 'iterateStructsByIdSet', 'mergeIdSets', 'mergeUpdates', 'mergeUpdatesV2', 'readContentMap', 'readIdMap', 'readIdSet', 'readUpdateV2', 'redoItem', 'relativePositionToJSON', 'transact', 'writeContentMap', 'writeIdMap', 'writeIdSet'];

/**
 * Reached beyond the engine object: `mergeUpdates` (server coordinators
 * compact with it), the IdMap/ContentMap codec pair (the inverse of the
 * `readIdMap` that decodes legacy attribution records) and the attribute
 * constructor those maps hold.
 */
const EXTRA = [
	'mergeUpdates',
	'encodeContentMap',
	'encodeIdMap',
	'decodeIdMap',
	'createContentAttribute'
];

/** Unreachable by design: the duplicate-import guard (side effect), the content interface, wire type refs. */
const ALLOW = new Set([
	'index.js:glo',
	'index.js:importIdentifier',
	'structs/Item.js:AbstractContent',
	'structs/Item.js:YArrayRefID',
	'structs/Item.js:YMapRefID',
	'structs/Item.js:YTextRefID',
	'structs/Item.js:YXmlElementRefID',
	'structs/Item.js:YXmlFragmentRefID',
	'structs/Item.js:YXmlHookRefID',
	'structs/Item.js:YXmlTextRefID',
	// P13: constants the bundle inlines.
	'utils/marks.js:MARK_START',
	'utils/marks.js:MARK_END'
]);

const require = createRequire(join(ROOT, 'package.json'));
const ts = require('typescript');

const files = (dir: string): string[] =>
	readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? files(p) : f.endsWith('.js') ? [p] : [];
	});

const topLevelNames = (file: string): string[] => {
	const sf = ts.createSourceFile(
		file,
		readFileSync(file, 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS
	);
	return sf.statements.flatMap((st) =>
		ts.isVariableStatement(st)
			? st.declarationList.declarations.map((d) => d.name.getText(sf))
			: (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name
				? [st.name.text]
				: []
	);
};

describe('P8 — pruned engine surface', () => {
	it('edytor/crdt exports exactly the kept surface', () => {
		expect(Object.keys(V).sort()).toEqual([...KEPT].sort());
	});

	it('every vendored declaration is reachable from the engine object + codec keep list', async () => {
		const vite = createRequire(require.resolve('vite/package.json'));
		const { rolldown } = await import(pathToFileURL(vite.resolve('rolldown')).href);
		const keep = [...Object.keys(Y), ...EXTRA];
		const entry = `import * as V from ${JSON.stringify(join(SRC, 'index.js'))};\nexport const keep = [${keep.map((k) => `V.${k}`).join(', ')}];\n`;
		const bundle = await rolldown({
			input: 'p8-entry',
			cwd: ROOT,
			platform: 'neutral',
			external: [/^lib0-v14/],
			logLevel: 'silent',
			treeshake: { moduleSideEffects: false },
			plugins: [
				{
					name: 'p8-entry',
					resolveId: (id) => (id === 'p8-entry' ? id : null),
					load: (id) => (id === 'p8-entry' ? entry : null)
				}
			]
		});
		const { output } = await bundle.generate({ format: 'esm', minify: false });
		await bundle.close();
		const regions = new Map<string, string>();
		for (const m of output[0].code.matchAll(/\/\/#region (.*)\n([\s\S]*?)\/\/#endregion/g))
			regions.set(m[1].trim(), (regions.get(m[1].trim()) ?? '') + m[2]);
		const dead: string[] = [];
		for (const file of files(SRC)) {
			const rel = relative(SRC, file).split('\\').join('/');
			const code = [...regions].find(([k]) => k.endsWith(`vendor/yjs/src/${rel}`))?.[1] ?? '';
			for (const n of topLevelNames(file)) {
				const alive = new RegExp(
					`(const|let|var|function\\*?|class)\\s+${n.replace(/\$/g, '\\$')}(\\$\\d+)?\\b`
				).test(code);
				if (!alive && !ALLOW.has(`${rel}:${n}`)) dead.push(`${rel}:${n}`);
			}
		}
		expect(dead, 'unreachable vendored declarations — prune them (UPSTREAM.md P8)').toEqual([]);
	});
});
