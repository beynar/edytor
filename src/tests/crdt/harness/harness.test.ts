/**
 * Self-tests for the U02 replica harness and the RawNodeOps adapter.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { createPeerPair, createPeerSet, createPeerTriple, isRemoteOrigin } from './peer-set.js';
import { createRawNodeOps } from './ops/raw-node-ops.js';
import {
	assertConverged,
	checkStructurallyValid,
	diffIdentities,
	snapshotIdentities
} from './assert/convergence.js';
import { BASE_SEED, EMPTY_SEED, specSeed } from '../scenarios/seeds.js';

const ops = createRawNodeOps();

describe('createPeerSet', () => {
	it('creates replicas by applying one seed update — not independent init', () => {
		const set = createPeerTriple(BASE_SEED);
		expect(set.peers).toHaveLength(3);
		// distinct Doc instances, identical content
		expect(set.A.doc).not.toBe(set.B.doc);
		expect(ops.project(set.A)).toEqual(ops.project(set.B));
		// identical *CRDT* identity — only possible when replicas share the seed
		// update, not when each peer built the same JSON itself.
		expect(ops.crdtId(set.A, 'b1')).toBe(ops.crdtId(set.B, 'b1'));
		expect(ops.crdtId(set.A, 'b1')).toMatch(/^\d+:\d+$/);
	});

	it('accepts a pre-encoded seed update', () => {
		const seedDoc = new Y.Doc();
		seedDoc.get('content').insert(0, 'seeded');
		const set = createPeerPair(Y.encodeStateAsUpdate(seedDoc));
		expect(set.A.doc.get('content').toString()).toBe('seeded');
		expect(set.B.doc.get('content').toString()).toBe('seeded');
	});

	it('assigns deterministic, distinct clientIDs', () => {
		const a = createPeerTriple(BASE_SEED);
		const b = createPeerTriple(BASE_SEED);
		expect(a.peers.map((p) => p.doc.clientID)).toEqual([1, 2, 3]);
		expect(b.peers.map((p) => p.doc.clientID)).toEqual([1, 2, 3]);
	});

	it('supports custom names and firstClientId', () => {
		const set = createPeerSet(2, EMPTY_SEED, { names: ['x', 'y'], firstClientId: 100 });
		expect(set.peer('x').doc.clientID).toBe(100);
		expect(set.peer('y').doc.clientID).toBe(101);
	});
});

describe('network simulation', () => {
	it('queues local edits per edge and flushes with deliver()', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertText(set.A, 'b1', 0, 'q');
		expect(set.pending('A', 'B')).toBe(1);
		expect(ops.blockText(set.B, 'b1')).toBe('hello world'); // not yet delivered
		set.deliver('A', 'B');
		expect(ops.blockText(set.B, 'b1')).toBe('qhello world');
		expect(set.pendingCount).toBe(0);
	});

	it('partition holds messages; heal releases them', () => {
		const set = createPeerPair(BASE_SEED);
		set.partition('A', 'B');
		ops.insertText(set.A, 'b1', 0, 'held');
		expect(set.deliver('A', 'B')).toBe(0); // link down: nothing flows
		expect(ops.blockText(set.B, 'b1')).toBe('hello world');
		set.heal('A', 'B');
		set.deliver('A', 'B');
		expect(ops.blockText(set.B, 'b1')).toBe('heldhello world');
	});

	it('reversed and duplicated delivery converge', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertText(set.A, 'b1', 0, '1');
		ops.insertText(set.A, 'b1', 0, '2');
		ops.insertText(set.A, 'b1', 0, '3');
		set.deliver('A', 'B', { reverse: true, times: 2 });
		assertConverged(set, ops);
		expect(ops.blockText(set.B, 'b1')).toBe('321hello world');
	});

	it('batched delivery applies a merged update', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertText(set.A, 'b1', 0, 'x');
		ops.insertText(set.A, 'b1', 1, 'y');
		set.deliver('A', 'B', { batch: true });
		expect(ops.blockText(set.B, 'b1')).toBe('xyhello world');
	});

	it('state-vector sync ships only missing updates after loss', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertText(set.A, 'b1', 0, 'v');
		set.dropQueued('A', 'B');
		set.syncPeer('A', 'B');
		expect(ops.blockText(set.B, 'b1')).toBe('vhello world');
	});

	it('remote application does not re-broadcast (no update storms)', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertText(set.A, 'b1', 0, 'z');
		set.deliver('A', 'B');
		// B's application was remote-origin → nothing new queued back to A
		expect(set.pending('B', 'A')).toBe(0);
	});
});

describe('transaction origins', () => {
	it('distinguishes local vs remote-applied transactions', () => {
		const set = createPeerPair(BASE_SEED);
		const seen: string[] = [];
		set.B.doc.on('update', (_u: Uint8Array, origin: unknown) => {
			seen.push(isRemoteOrigin(origin) ? 'remote' : 'local');
		});
		ops.insertText(set.B, 'b1', 0, 'L');
		ops.insertText(set.A, 'b1', 0, 'R');
		set.deliver('A', 'B');
		expect(seen).toEqual(['local', 'remote']);
	});
});

describe('reload', () => {
	it('snapshot reload preserves content, assigns fresh clientID', () => {
		const set = createPeerPair(BASE_SEED);
		const oldId = set.A.doc.clientID;
		ops.insertText(set.A, 'b1', 0, 'x');
		set.A.persist();
		set.A.reload('snapshot');
		expect(ops.blockText(set.A, 'b1')).toBe('xhello world');
		expect(set.A.doc.clientID).not.toBe(oldId);
		expect(set.A.doc.clientID).toBeGreaterThanOrEqual(3);
	});

	it('log reload replays the full history incl. remote updates', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertText(set.A, 'b1', 0, 'fromA ');
		ops.insertText(set.B, 'b2', 0, 'fromB ');
		set.deliverAll();
		set.B.reload('log');
		expect(ops.blockText(set.B, 'b1')).toBe('fromA hello world');
		expect(ops.blockText(set.B, 'b2')).toBe('fromB second block');
		assertConverged(set, ops);
	});
});

describe('RawNodeOps adapter', () => {
	it('projects the seed document canonically', () => {
		const set = createPeerPair(BASE_SEED);
		const doc = ops.project(set.A);
		expect(doc.children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
		expect(doc.children[2].children.map((b) => b.id)).toEqual(['b3a', 'b3b']);
		expect(doc.children[0].content).toEqual([{ kind: 'text', text: 'hello world' }]);
		expect(doc.children[1].content[0].marks).toEqual({ bold: true });
	});

	it('insert/delete block under a parent', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertBlock(set.A, { parent: 'b3', index: 1 }, { id: 'b3c', type: 'paragraph' });
		expect(ops.listBlockIds(set.A)).toEqual(['b1', 'b2', 'b3', 'b3a', 'b3c', 'b3b']);
		ops.deleteBlock(set.A, 'b3c');
		expect(ops.listBlockIds(set.A)).toEqual(['b1', 'b2', 'b3', 'b3a', 'b3b']);
		expect(ops.deleteBlock(set.A, 'nope')).toBe(false);
	});

	it('moveBlock relocates same-parent and cross-parent (copy semantics)', () => {
		const set = createPeerPair(BASE_SEED);
		const before = snapshotIdentities(set.A, ops);
		// same-parent reorder
		expect(ops.moveBlock(set.A, 'b1', { parent: null, index: 2 })).toBe(true);
		expect(ops.project(set.A).children.map((b) => b.id)).toEqual(['b2', 'b3', 'b1']);
		// cross-parent move
		expect(ops.moveBlock(set.A, 'b1', { parent: 'b3', index: 0 })).toBe(true);
		const proj = ops.project(set.A);
		expect(proj.children.map((b) => b.id)).toEqual(['b2', 'b3']);
		expect(proj.children[1].children.map((b) => b.id)).toEqual(['b1', 'b3a', 'b3b']);
		// logical id retained; engine identity NOT (copy-move evidence)
		const diff = diffIdentities(before, snapshotIdentities(set.A, ops));
		expect(diff.lost).toContain('b1');
		expect(ops.preservesIdentityOnMove).toBe(false);
	});

	it('rejects a move into the block’s own subtree', () => {
		const set = createPeerPair(BASE_SEED);
		expect(ops.moveBlock(set.A, 'b3', { parent: 'b3a', index: 0 })).toBe(false);
		// unchanged
		expect(ops.project(set.A).children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
	});

	it('nest/unnest delegate to move', () => {
		const set = createPeerPair(BASE_SEED);
		expect(ops.nestBlock(set.A, 'b2', 'b1')).toBe(true);
		let proj = ops.project(set.A);
		expect(proj.children.map((b) => b.id)).toEqual(['b1', 'b3']);
		expect(proj.children[0].children.map((b) => b.id)).toEqual(['b2']);
		expect(ops.unNestBlock(set.A, 'b2')).toBe(true);
		proj = ops.project(set.A);
		expect(proj.children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
	});

	it('splitBlock creates a sibling with trailing content + children', () => {
		const set = createPeerPair(BASE_SEED);
		expect(ops.splitBlock(set.A, 'b1', 5, 'b1b')).toBe(true);
		const proj = ops.project(set.A);
		expect(proj.children.map((b) => b.id)).toEqual(['b1', 'b1b', 'b2', 'b3']);
		expect(ops.blockText(set.A, 'b1')).toBe('hello');
		expect(ops.blockText(set.A, 'b1b')).toBe(' world');
		// split inside a block with children: children follow the new block
		ops.splitBlock(set.A, 'b3', 3, 'b3c');
		const p2 = ops.project(set.A);
		const b3c = p2.children.find((b) => b.id === 'b3c')!;
		expect(b3c.children.map((b) => b.id)).toEqual(['b3a', 'b3b']);
	});

	it('mergeBlocks appends content + children and removes the source', () => {
		const set = createPeerPair(BASE_SEED);
		expect(ops.mergeBlocks(set.A, 'b2', 'b1')).toBe(true);
		const proj = ops.project(set.A);
		expect(proj.children.map((b) => b.id)).toEqual(['b1', 'b3']);
		expect(ops.blockText(set.A, 'b1')).toBe('hello worldsecond block');
	});

	it('text + marks + inline atoms round-trip through the adapter', () => {
		const set = createPeerPair(BASE_SEED);
		ops.insertText(set.A, 'b1', 5, ' brave', { italic: true });
		ops.setMark(set.A, 'b1', 0, 5, 'bold', true);
		ops.unsetMark(set.A, 'b1', 0, 2, 'bold');
		ops.insertInline(set.A, 'b1', 0, { id: 'i1', type: 'mention', data: { u: 1 } });
		ops.deleteText(set.A, 'b1', 1, 1);
		set.deliverAll();
		assertConverged(set, ops);
		const content = ops.project(set.B).children[0].content;
		const inline = content.find((i) => i.kind === 'inline');
		expect(inline).toMatchObject({ kind: 'inline', id: 'i1', type: 'mention' });
		expect(ops.removeInline(set.A, 'b1', 'i1')).toBe(true);
		set.deliverAll();
		assertConverged(set, ops);
	});

	it('crdtId changes on copy-move but not on in-place text edit', () => {
		const set = createPeerPair(BASE_SEED);
		const before = ops.crdtId(set.A, 'b1');
		ops.insertText(set.A, 'b1', 0, 'x');
		expect(ops.crdtId(set.A, 'b1')).toBe(before); // identity retained
		ops.moveBlock(set.A, 'b1', { parent: null, index: 2 });
		expect(ops.crdtId(set.A, 'b1')).not.toBe(before); // copy-move loses it
	});

	it('positionOf reports parent + index', () => {
		const set = createPeerPair(BASE_SEED);
		expect(ops.positionOf(set.A, 'b3a')).toEqual({ parent: 'b3', index: 0 });
		expect(ops.positionOf(set.A, 'b2')).toEqual({ parent: null, index: 1 });
		expect(ops.positionOf(set.A, 'missing')).toBeNull();
	});
});

describe('structural checks', () => {
	it('concurrent copy-moves surface duplicate-placement evidence', () => {
		const set = createPeerPair(BASE_SEED);
		// Both peers move b1 concurrently — copy-move produces two survivors.
		ops.moveBlock(set.A, 'b1', { parent: null, index: 2 });
		ops.moveBlock(set.B, 'b1', { parent: null, index: 0 });
		set.deliverAll();
		assertConverged(set, ops); // convergent...
		const report = checkStructurallyValid(set.A, ops);
		// ...but structurally broken — the recorded evidence class.
		expect(report.ok).toBe(false);
		expect(report.violations.some((v) => v.includes('duplicate placement'))).toBe(true);
	});
});
