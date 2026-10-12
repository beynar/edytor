/**
 * U01 smoke probes for the vendored Yjs v14 engine (upstream commit
 * 96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64, @y/y@14.0.0-rc.26).
 *
 * These tests double as the executable record of the v14 API contract used by
 * later units — every assertion uses only the public exports of
 * `src/lib/crdt/vendor/yjs/src/index.js`. See
 * `src/lib/crdt/vendor/yjs/API-NOTES.md` for the API surface notes.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import { describe, expect, test } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { toDelta } from './harness/delta.js';
import { UndoManager } from './harness/undo.js';

describe('v14 smoke: document & unified node', () => {
	test('create Y.Doc and obtain a root Y.Node via doc.get', () => {
		const doc = new Y.Doc();
		const root = doc.get('content');
		expect(root).toBeInstanceOf(Y.Node);
		// doc.get is memoized per key
		expect(doc.get('content')).toBe(root);
	});

	test('map-like usage: set/read/remove attributes on a Y.Node', () => {
		const doc = new Y.Doc();
		const root = doc.get('content');
		root.setAttr('type', 'root');
		root.setAttr('data', { mode: 'test' });
		expect(root.getAttr('type')).toBe('root');
		expect(root.getAttr('data')).toEqual({ mode: 'test' });
		expect(root.hasAttr('type')).toBe(true);
		expect([...root.attrKeys()]).toEqual(expect.arrayContaining(['type', 'data']));
		root.deleteAttr('data');
		expect(root.hasAttr('data')).toBe(false);
	});

	test('sequence-like usage: nested Y.Node children + text', () => {
		const doc = new Y.Doc();
		const root = doc.get('content');
		const child = new Y.Node('paragraph');
		child.setAttr('id', 'b1');
		root.insert(0, [child]);
		expect(root.length).toBe(1);
		expect(root.get(0)).toBe(child);
		expect(child.parent).toBe(root);
		child.insert(0, 'hello');
		child.insert(5, ' world');
		// v14: toString renders the node as an element `<name attrs>…</name>`
		expect(child.toString()).toBe('<paragraph id="b1">hello world</paragraph>');
		expect(child.length).toBe(11);
		expect(child.toArray()).toEqual(['hello world']);
		// v14: slice returns an Array of child items (chars for text), not a string
		expect(child.slice(0, 5)).toEqual(['h', 'e', 'l', 'l', 'o']);
		expect(child.slice(0, 5).join('')).toBe('hello');
	});

	test('marks: a paired mark over a range is visible in the delta read', () => {
		const doc = new Y.Doc();
		const node = new Y.Node('paragraph');
		doc.get('content').insert(0, [node]);
		node.insert(0, 'hello world');
		// YP19: the engine's only marks are paired operations (YP13)
		node.mark(6, 5, 'bold', true, 0, 0);
		const d = toDelta(node).toJSON();
		expect(d.children).toEqual([
			{ type: 'insert', insert: 'hello ' },
			{ type: 'insert', insert: 'world', format: { bold: true } }
		]);
	});
});

describe('v14 smoke: commits', () => {
	test('`commit` fires once per transaction, before `afterTransaction`, with what changed', () => {
		const doc = new Y.Doc();
		const root = doc.get('content');
		const child = new Y.Node('paragraph');
		root.insert(0, [child]);
		/** @type {string[]} */
		const order = [];
		/** @type {any[]} */
		const commits = [];
		doc.on('commit', (/** @type {any} */ tr) => {
			order.push('commit');
			commits.push(tr);
		});
		doc.on('afterTransaction', () => order.push('after'));
		doc.transact(() => {
			child.insert(0, 'nested');
			child.setAttr('id', 'c1');
		});
		expect(order).toEqual(['commit', 'after']);
		expect([...commits[0].changed.get(child)]).toEqual(expect.arrayContaining([null, 'id']));
	});
});

describe('v14 smoke: positions as ids', () => {
	test('idAtIndex + indexOfId resolve a position', () => {
		const doc = new Y.Doc();
		const node = new Y.Node('paragraph');
		doc.get('content').insert(0, [node]);
		node.insert(0, 'hello world');
		const id = Y.idAtIndex(node, 6);
		const abs = Y.indexOfId(doc, id);
		expect(abs.type).toBe(node);
		expect(abs.index).toBe(6);
		// the text's ends bind no unit
		expect(Y.idAtIndex(node, 11)).toBe(null);
		expect(Y.idAtIndex(node, 0, -1)).toBe(null);
	});

	test('a position bound to a unit follows a later insert before it', () => {
		const doc = new Y.Doc();
		const node = new Y.Node('paragraph');
		doc.get('content').insert(0, [node]);
		node.insert(0, 'abc');
		const id = Y.idAtIndex(node, 2);
		// insert before the anchored position → resolved index shifts
		node.insert(0, 'ZZ');
		const abs = Y.indexOfId(doc, Y.createID(id.client, id.clock));
		expect(abs.index).toBe(4);
		expect(abs.type).toBe(node);
		// bound after the unit before it (`assoc < 0`)
		const left = Y.idAtIndex(node, 4, -1);
		expect(Y.indexOfId(doc, left, -1).index).toBe(4);
	});
});

describe('v14 smoke: update encoding roundtrip', () => {
	test('encodeStateAsUpdate / applyUpdate replicates doc state', () => {
		const doc = new Y.Doc();
		const root = doc.get('content');
		root.setAttr('type', 'root');
		const child = new Y.Node('paragraph');
		child.setAttr('id', 'b1');
		root.insert(0, [child]);
		child.insert(0, 'synced');
		child.mark(0, 6, 'bold', true, 0, 0);

		const doc2 = new Y.Doc();
		Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
		const root2 = doc2.get('content');
		expect(root2.getAttr('type')).toBe('root');
		const child2 = root2.get(0);
		// v14 toString renders `<name attrs>children</name>`; text content is in toArray/delta
		expect(child2.toString()).toBe('<paragraph id="b1">synced</paragraph>');
		expect(child2.toArray()).toEqual(['synced']);
		expect(child2.getAttr('id')).toBe('b1');
		expect(toDelta(child2).toJSON().children).toEqual([
			{ type: 'insert', insert: 'synced', format: { bold: true } }
		]);
		// state vectors agree
		expect(Y.decodeStateVector(Y.encodeStateVector(doc))).toEqual(
			Y.decodeStateVector(Y.encodeStateVector(doc2))
		);
	});

	test('incremental updates converge both directions', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		docA.get('content').insert(0, 'from A');
		docB.get('content').insert(0, 'from B');
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
		expect(docA.get('content').toString()).toBe(docB.get('content').toString());
	});
});

describe('v14 smoke: UndoManager', () => {
	test('undo/redo scoped to a Doc', () => {
		const doc = new Y.Doc();
		const node = doc.get('content');
		const um = new UndoManager(doc);
		doc.transact(() => node.insert(0, 'first'));
		um.stopCapturing();
		doc.transact(() => node.insert(5, ' second'));
		expect(node.toString()).toBe('first second');
		um.undo();
		expect(node.toString()).toBe('first');
		um.undo();
		expect(node.toString()).toBe('');
		um.redo();
		um.redo();
		expect(node.toString()).toBe('first second');
	});

	test('undo preserves remote contributions', () => {
		const local = new Y.Doc();
		const remote = new Y.Doc();
		local.get('content').insert(0, 'shared ');
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
		const um = new UndoManager(local, { trackedOrigins: new Set(['local-origin']) });
		local.transact(() => local.get('content').insert(7, 'LOCAL'), 'local-origin');
		remote.get('content').insert(0, 'REMOTE ');
		Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local)));
		expect(local.get('content').toString()).toBe('REMOTE shared LOCAL');
		um.undo();
		expect(local.get('content').toString()).toBe('REMOTE shared ');
	});
});
