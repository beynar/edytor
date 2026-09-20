/**
 * Assertion helpers for the replica harness (U02) — deliberately more than
 * JSON equality:
 *
 * - {@link assertConverged} compares the canonical adapter projection pairwise
 *   AND the encoded state vectors, and produces a path-addressed readable diff
 *   on mismatch rather than a bare false.
 * - {@link assertStructurallyValid} checks the invariants the plan requires of
 *   the *visible* structure: every logical block id appears at most once, the
 *   tree is acyclic and reachable from the root, and every inline-atom id is
 *   unique. These run against whatever the adapter exposes — RawNodeOps keeps
 *   them trivially true, which is itself evidence that the interesting cases
 *   are the pending MV and TX ones.
 * - Identity-retention hooks: {@link snapshotIdentities} /
 *   {@link diffIdentities} compare `crdtId` per logical id across an operation
 *   or schedule. Retention failures are returned as data so callers can decide
 *   whether they are hard failures (text edit must not churn identity) or
 *   expected evidence (copy-move loses identity).
 * - History helpers assert selective undo: local ops undo while remote
 *   contributions survive.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { expect } from 'vitest';
import * as Y from '../../../../lib/crdt/vendor/yjs/src/index.js';
import type { Peer, PeerSet } from '../peer-set.js';
import type { BlockId, CrdtOps, ProjectedBlock } from '../ops/crdt-ops.js';

/**
 * Walk two JSON-ish trees and return a readable `path: a !== b` description of
 * the first difference, or null. Values are compared by deep equality; Yjs
 * internals never leak into the projection, so plain comparison is sound.
 */
export const findFirstDiff = (a: unknown, b: unknown, path = '$'): string | null => {
	if (a === b) return null;
	const ta = typeof a;
	const tb = typeof b;
	if (ta !== tb || a === null || b === null || ta !== 'object') {
		return `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
	}
	const aArr = Array.isArray(a);
	const bArr = Array.isArray(b);
	if (aArr !== bArr) return `${path}: array-ness differs`;
	const aKeys = Object.keys(a as object);
	const bKeys = Object.keys(b as object);
	for (const key of aKeys) {
		if (!(key in (b as object))) {
			return `${path}.${key}: ${JSON.stringify((a as any)[key])} present only on left`;
		}
		const d = findFirstDiff((a as any)[key], (b as any)[key], `${path}.${key}`);
		if (d) return d;
	}
	for (const key of bKeys) {
		if (!(key in (a as object))) {
			return `${path}.${key}: ${JSON.stringify((b as any)[key])} present only on right`;
		}
	}
	return null;
};

/**
 * Assert every peer's canonical projection and state vector are identical.
 * On divergence the message names the diverging peers and the first differing
 * projection path — not just `false`.
 */
export const assertConverged = (set: PeerSet, ops: CrdtOps, context = ''): void => {
	const projections = set.peers.map((p) => ({ peer: p.name, doc: ops.project(p) }));
	for (let i = 1; i < projections.length; i++) {
		const diff = findFirstDiff(projections[0].doc, projections[i].doc);
		expect(
			diff,
			`projection divergence${context ? ` (${context})` : ''}: ` +
				`${projections[0].peer} vs ${projections[i].peer} — ${diff ?? 'equal'}\n` +
				`left:  ${JSON.stringify(projections[0].doc)}\n` +
				`right: ${JSON.stringify(projections[i].doc)}`
		).toBeNull();
	}
	// Compare DECODED state vectors — encoded byte order can differ between
	// peers that learned the same set of clients in different orders.
	const vectors = set.peers.map((p) => new Map(Y.decodeStateVector(p.stateVector())));
	for (let i = 1; i < vectors.length; i++) {
		expect(
			vectors[i],
			`state-vector divergence${context ? ` (${context})` : ''}: ` +
				`${set.peers[0].name} vs ${set.peers[i].name}`
		).toEqual(vectors[0]);
	}
};

export type StructuralReport = {
	ok: boolean;
	violations: string[];
};

/**
 * Check structural validity of a peer's projected tree:
 * - acyclic + reachable from root (the projection IS the reachable set — a
 *   node not under root is a hidden orphan),
 * - each logical block id placed at most once (single placement),
 * - each inline-atom id unique,
 * - **registry completeness** (gate-1): when the adapter exposes
 *   `expectedProjectedIds`, every live, not-legitimately-hidden registry
 *   block must appear in the projection EXACTLY once, and nothing deleted
 *   or legitimately hidden may appear. A live block absent from the
 *   projection is `unreachable-block` — the silent-loss class the
 *   display-parent-cycle fix exists to eliminate; without this check the
 *   oracle only sees reachable nodes and the defect is invisible to it.
 * Returns a report instead of throwing so corpus code can classify known
 * missing-semantics violations; `assertStructurallyValid` is the hard form.
 */
export const checkStructurallyValid = (peer: Peer, ops: CrdtOps): StructuralReport => {
	const violations: string[] = [];
	const seen = new Set<BlockId>();
	const inlineIds = new Set<string>();
	const visit = (block: ProjectedBlock, trail: Set<BlockId>) => {
		if (block.malformed) {
			violations.push(`malformed-node: block ${block.id} has unresolvable content/children`);
		}
		if (trail.has(block.id)) {
			violations.push(`cycle: block ${block.id} is its own ancestor`);
			return;
		}
		if (seen.has(block.id)) {
			violations.push(`duplicate placement of block ${block.id}`);
		}
		seen.add(block.id);
		const next = new Set(trail);
		next.add(block.id);
		for (const item of block.content) {
			if (item.kind === 'inline') {
				if (inlineIds.has(item.id)) {
					violations.push(`duplicate inline atom ${item.id}`);
				}
				inlineIds.add(item.id);
			}
		}
		for (const child of block.children) visit(child, next);
	};
	const doc = ops.project(peer);
	const trail = new Set<BlockId>();
	for (const child of doc.children) visit(child, trail);
	// Registry-vs-projection completeness (adapter-optional): both directions
	// are violations — a live block missing from the projection is silent
	// content loss; a hidden/deleted block showing up is the symmetric leak.
	const expected = ops.expectedProjectedIds?.(peer);
	if (expected) {
		for (const id of expected) {
			if (!seen.has(id)) {
				violations.push(
					`unreachable-block: ${id} is live and not legitimately hidden, but absent from the projection`
				);
			}
		}
		for (const id of seen) {
			if (!expected.has(id)) {
				violations.push(
					`unreachable-block: ${id} is projected but should be hidden (deleted, merged, or under a deleted ancestor)`
				);
			}
		}
	}
	return { ok: violations.length === 0, violations };
};

/** Hard form of {@link checkStructurallyValid}. */
export const assertStructurallyValid = (peer: Peer, ops: CrdtOps, context = ''): void => {
	const report = checkStructurallyValid(peer, ops);
	expect(
		report.violations,
		`structural violations on ${peer.name}${context ? ` (${context})` : ''}`
	).toEqual([]);
};

/** checkStructurallyValid on every peer. */
export const assertAllStructurallyValid = (set: PeerSet, ops: CrdtOps, context = ''): void => {
	for (const peer of set.peers) assertStructurallyValid(peer, ops, context);
};

/**
 * Snapshot `logical id → crdtId` for every block on a peer. Compare with
 * {@link diffIdentities} after an operation/schedule to observe which blocks
 * kept their engine identity.
 */
export const snapshotIdentities = (peer: Peer, ops: CrdtOps): Map<BlockId, string> => {
	const map = new Map<BlockId, string>();
	for (const id of ops.listBlockIds(peer)) {
		const crdtId = ops.crdtId(peer, id);
		if (crdtId !== null) map.set(id, crdtId);
	}
	return map;
};

export type IdentityDiff = {
	/** ids present before and after whose crdtId changed. */
	lost: BlockId[];
	/** ids that disappeared entirely. */
	removed: BlockId[];
	/** new ids. */
	added: BlockId[];
	/** ids whose crdtId is unchanged. */
	retained: BlockId[];
};

export const diffIdentities = (
	before: Map<BlockId, string>,
	after: Map<BlockId, string>
): IdentityDiff => {
	const diff: IdentityDiff = { lost: [], removed: [], added: [], retained: [] };
	for (const [id, crdtId] of before) {
		const now = after.get(id);
		if (now === undefined) diff.removed.push(id);
		else if (now !== crdtId) diff.lost.push(id);
		else diff.retained.push(id);
	}
	for (const id of after.keys()) {
		if (!before.has(id)) diff.added.push(id);
	}
	return diff;
};

/**
 * Assert that unrelated remote contributions survive a local undo on `peer`:
 * `expected` is the projection that must hold after `peer.undo()`.
 */
export const assertUndoPreservesRemote = (
	peer: Peer,
	ops: CrdtOps,
	expected: unknown,
	context = ''
): void => {
	expect(
		peer.undoManager,
		`peer ${peer.name} has no UndoManager — call enableUndo()`
	).not.toBeNull();
	peer.undoManager!.undo();
	expect(ops.project(peer)).toEqual(expected);
	void context;
};
