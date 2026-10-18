/**
 * The document's own history over a raw engine document, for the lanes that
 * stay raw (the replica harness, the engine probes): production's
 * `UndoManager` with production's rules (`src/lib/crdt/doc/history.ts`,
 * `historyRules`: the text hold records, `hist.undo.withdraw`, the attr
 * repair). The engine has no undo manager (fork patch YP18) and the tests
 * keep no copy of one: every undo a test runs is the one the editor runs.
 * A test over a facade or an `EdytorDocument` takes the same class from
 * `createUndoManager` / `document.history`.
 *
 * `scope` narrows what the history captures to nodes of `doc` (default or
 * `null`: the document's own scope — the block registry, the text hold
 * records, the document's data); the text hold records stay in it, since a text delete is
 * one of them (fork patch YP20). `doc` itself stands for every root the
 * document holds when the history is made. `Y`: the engine the document runs
 * on (a copy of the fork's tree in the patch-stripping rows).
 */
// @ts-nocheck -- built over untyped engine documents and copies of the fork's tree.
import * as Fork from '../../../lib/crdt/vendor/yjs/src/index.js';
import { UndoManager, historyRules, type HistoryOptions } from '../../../lib/crdt/doc/history.js';

export type { UndoManager };

export const historyOf = (
	doc: unknown,
	{ scope, Y = Fork, ...options }: HistoryOptions & { scope?: unknown; Y?: unknown } = {}
): UndoManager => {
	const rules = historyRules(Y, doc);
	if (scope == null) return new UndoManager(rules, options);
	const nodes = scope === doc ? [...doc.share.values()] : Array.isArray(scope) ? scope : [scope];
	return new UndoManager(
		{ ...rules, scope: [...nodes.filter((n) => n !== rules.records), rules.records] },
		options
	);
};
