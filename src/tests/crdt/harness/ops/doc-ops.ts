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

/**
 * Block roles for the corpus's roles lane (RW-01): an island kind with its
 * own child kind, and a void kind. Absent: the pure-engine lane.
 */
export type DocOpsRoles = {
	/** Kind → role (`island` / `lines` / `void` / `layout`). */
	roles: Record<string, { island?: boolean; lines?: boolean; void?: boolean; layout?: boolean }>;
	/** Parent kind → its default child kind. */
	defaultChild: Record<string, string>;
	/** Kinds that render no content of their own (containers, islands, voids). */
	rendersContent?: Record<string, boolean>;
};

/**
 * The roles lane's table: `code` is an island of `codeLine`s (`lines`),
 * `divider` a void, `table` an island of rows of cells; `unordered-list`
 * a container of `list-item`s and `columns` a layout of `column`s (a
 * column holds any block) — the container rules are fuzzed (ZW-11), and
 * the layout rules (`layout.*`, columns plan C1).
 */
export const ROLES: DocOpsRoles = {
	roles: {
		code: { island: true, lines: true },
		divider: { void: true },
		table: { island: true },
		'unordered-list': {},
		columns: { layout: true },
		column: {}
	},
	defaultChild: {
		code: 'codeLine',
		table: 'row',
		row: 'cell',
		'unordered-list': 'list-item',
		columns: 'column'
	},
	rendersContent: {
		code: false,
		divider: false,
		table: false,
		row: false,
		'unordered-list': false,
		columns: false,
		column: false
	}
};

export const createDocOps = (roles?: DocOpsRoles): CrdtOps => {
	const config = roles && {
		roleOf: (type: string) => roles.roles[type],
		kinds: () => Object.keys(roles.roles),
		defaultChildOf: (type: string) => roles.defaultChild[type],
		rendersContent: (type: string) => roles.rendersContent?.[type] ?? true
	};
	// One EdytorDoc per underlying doc instance (peer.doc swaps on reload).
	const facades = new WeakMap<InstanceType<typeof Y.Doc>, ReturnType<typeof E.create>>();
	/** Per doc: the kinds a view fed only the facade's change reports holds (`report-kind`). */
	const reported = new WeakMap<InstanceType<typeof Y.Doc>, Map<string, string>>();
	const ed = (peer: Peer) => {
		let f = facades.get(peer.doc);
		if (!f) {
			f = E.create(peer.doc, config);
			facades.set(peer.doc, f);
			const kinds = new Map<string, string>();
			const take = (b) => {
				kinds.set(b.id, b.type);
				for (const c of b.children ?? []) take(c);
			};
			// The projection, not `toJSON`: a reload drops pending structs (the harness's
			// injected loss), which can leave a type overwrite half-delivered — the JSON
			// serializer's DEV guard throws on that typeless transient, the index does not.
			f.project().children.forEach(take);
			f.onChange((c) => {
				for (const b of c.added.values()) take(b);
				for (const [id, { type }] of c.meta) kinds.set(id, type);
			});
			reported.set(peer.doc, kinds);
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

	/** Layout kind → item kind (`layout-shape`), and the kinds the layout rules may hide. */
	const layouts = new Map(
		Object.entries(roles?.defaultChild ?? {}).filter(([parent]) => roles!.roles[parent]?.layout)
	);
	const layoutKinds = new Set([...layouts.keys(), ...layouts.values()]);

	const islandKinds = new Map(
		Object.entries(roles?.defaultChild ?? {})
			.filter(([parent]) => roles!.roles[parent]?.island && roles!.roles[parent]?.lines)
			.map(([parent, child]) => [child, parent])
	);

	return {
		name: roles ? 'edytor-doc+roles' : 'edytor-doc',
		...(roles && {
			isVoid: (peer, id) => ed(peer).isVoid(id),
			islandKinds,
			reportedKind: (peer, id) => (ed(peer), reported.get(peer.doc)!.get(id)),
			containerSlack: (peer, id) => {
				const f = ed(peer);
				const container = (b: string) => {
					const type = f.blockTypeOf(b) ?? '';
					const role = roles.roles[type];
					return roles.rendersContent?.[type] === false && !role?.void && !role?.island;
				};
				const parent = f.parentOf(id);
				// A layout among the ancestors may dissolve (`layout.dissolving`): its
				// columns are deleted, their blocks moved to its slot.
				const items = f
					.ancestorsOf(id)
					.filter((a) => f.isLayout(a))
					.flatMap((l) => f.childrenIds(l));
				return {
					containers: f.ancestorsOf(id).filter(container),
					split: parent !== null && container(parent) ? f.childrenIds(parent) : [],
					layout: { items, moves: items.flatMap((k) => f.childrenIds(k)) }
				};
			},
			layouts,
			dissolved: (peer, id) => ed(peer).runsView.dissolved(id),
			placeBeside: (peer, ids, target, side) =>
				peer.transact(() => ok(ed(peer).placeBeside(ids, target, side)))
		}),
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
		// The layout rules hide only layouts and their columns (`layout.*`): a
		// block of another kind missing from the projection is still a loss.
		expectedProjectedIds: (peer) => {
			const expected = expectedProjectedIds(peer);
			if (layoutKinds.size === 0) return expected;
			const f = ed(peer);
			for (const id of [...expected])
				if (
					layoutKinds.has(f.model.blockNodeOf(peer.doc, id)?.getAttr('type')) &&
					f.runsView.dissolved(id)
				)
					expected.delete(id);
			return expected;
		},
		// The tag oracle reads engine state straight off peer.doc (the facade
		// shares the same doc), so the model-ops implementation applies
		// unchanged — same for the U5 mutation-surface snapshot and the
		// dead-owner explainer.
		locateTagAtoms,
		classifyTagAtoms,
		tagAtomDeps,
		captureOpState,
		// With roles, a block's children are the ones it displays: a split or a
		// merge moves those, a bare column's blocks included (`layout.bare-item`).
		opTarget: (peer, id) => {
			const target = opTarget(peer, id);
			if (target !== null && roles)
				for (const kid of ed(peer).childrenIds(id)) target.children.add(kid);
			return target;
		},
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
