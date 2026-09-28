/**
 * `DocOps` — the `CrdtOps` adapter for the assembled U06 document model
 * (`src/lib/crdt/edytor-doc.ts` via `bindEdytorDoc`).
 *
 * This is the corpus sweep through the UNIFIED public surface: every
 * `CrdtOps` op resolves the per-doc `EdytorDoc` facade and calls its
 * semantic operation, so the random corpus proves the facade preserves the
 * U03/U04/U05 engine semantics (no role resolver is configured — the corpus
 * exercises pure engine behavior, which is the point: the facade must not
 * alter model semantics when no policy is injected).
 *
 * Facades are memoized per `peer.doc` (a reload swaps the doc instance, so
 * the map keys on the doc itself — a reloaded peer transparently gets a new
 * facade). Ops run inside `peer.transact` for the peer's local origin, like
 * `model-ops`; the facade's own `doc.transact` calls join the outer
 * transaction.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../../lib/crdt/edytor-doc.js';
import type { Peer } from '../peer-set.js';
import type { CrdtOps } from './crdt-ops.js';
import {
	expectedProjectedIds,
	locateTagAtoms,
	classifyTagAtoms,
	tagAtomDeps,
	captureOpState,
	opTarget,
	deadCause
} from './model-ops.js';

const E = bindEdytorDoc(Y);

/** The harness contract is boolean across backends: a facade op that was not refused (D4, R6). */
const ok = (r: { status: string }): boolean => r.status !== 'refused';

export const createDocOps = (): CrdtOps => {
	// One EdytorDoc per underlying doc instance (peer.doc swaps on reload).
	const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
	const ed = (peer: Peer) => {
		let f = facades.get(peer.doc);
		if (!f) {
			f = E.create(peer.doc);
			facades.set(peer.doc, f);
		}
		return f;
	};
	// One UndoManager per doc, built through the facade's public surface
	// (registry scope, captureTimeout 0 = one stack item per op transaction,
	// local origin only — remote applies must not be undoable here).
	const undoManagers = new WeakMap<
		InstanceType<typeof Y.Doc>,
		ReturnType<ReturnType<typeof E.create>['createUndoManager']>
	>();
	const history = (peer: Peer) => {
		let m = undoManagers.get(peer.doc);
		if (!m) {
			m = ed(peer).createUndoManager({
				captureTimeout: 0,
				trackedOrigins: new Set([peer.localOrigin])
			});
			undoManagers.set(peer.doc, m);
		}
		return m;
	};

	return {
		name: 'edytor-doc',
		preservesIdentityOnMove: true,
		preservesIdentityOnSplitMerge: true,

		insertBlock: (peer, dest, spec) => peer.transact(() => ok(ed(peer).insertBlock(dest, spec))),
		// The adapters' `deleteBlock` is the whole-subtree delete (the model's op): explicit since promotion became the default.
		deleteBlock: (peer, id) =>
			peer.transact(() => ok(ed(peer).deleteBlock(id, { keepChildren: false }))),
		moveBlock: (peer, id, dest) => peer.transact(() => ok(ed(peer).moveBlock(id, dest))),
		moveBlocks: (peer, ids, dest) => peer.transact(() => ok(ed(peer).moveBlocks(ids, dest))),
		nestBlock: (peer, id, newParentId) =>
			peer.transact(() => ok(ed(peer).nestBlock(id, newParentId))),
		unNestBlock: (peer, id) => peer.transact(() => ok(ed(peer).unNestBlock(id))),
		splitBlock: (peer, id, offset, newId) =>
			peer.transact(() => ok(ed(peer).splitBlock(id, offset, newId))),
		mergeBlocks: (peer, fromId, intoId) =>
			peer.transact(() => ok(ed(peer).mergeBlocks(fromId, intoId))),

		insertText: (peer, id, offset, text, marks) =>
			peer.transact(() => ok(ed(peer).insertText(id, offset, text, marks))),
		deleteText: (peer, id, offset, length) =>
			peer.transact(() => ok(ed(peer).deleteText(id, offset, length))),
		setMark: (peer, id, offset, length, name, value) =>
			peer.transact(() => ok(ed(peer).setMark(id, offset, length, name, value))),
		unsetMark: (peer, id, offset, length, name) =>
			peer.transact(() => ok(ed(peer).unsetMark(id, offset, length, name))),
		insertInline: (peer, id, offset, atom) =>
			peer.transact(() => ok(ed(peer).insertInline(id, offset, atom))),
		removeInline: (peer, id, inlineId) =>
			peer.transact(() => ok(ed(peer).removeInline(id, inlineId))),

		project: (peer) => ed(peer).project(),
		resolveBlock: (peer, id) => ed(peer).resolveBlock(id),
		crdtId: (peer, id) => ed(peer).crdtId(id),
		blockText: (peer, id) => ed(peer).blockText(id),
		listBlockIds: (peer) => ed(peer).listBlockIds(),
		positionOf: (peer, id) => ed(peer).positionOf(id),
		expectedProjectedIds,
		// The tag oracle reads engine state straight off peer.doc (the facade
		// shares the same doc), so the model-ops implementation applies
		// unchanged — same for the U5 mutation-surface snapshot and the
		// dead-owner explainer.
		locateTagAtoms,
		classifyTagAtoms,
		tagAtomDeps,
		captureOpState,
		opTarget,
		deadCause,
		trackHistory: (peer) => {
			history(peer);
		},
		undo: (peer) => {
			history(peer).undo();
		},
		redo: (peer) => {
			history(peer).redo();
		}
	};
};
