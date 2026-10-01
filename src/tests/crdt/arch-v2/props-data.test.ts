/**
 * Block, atom and document properties (0.1.0-next.6): data is stored as one
 * attr per JSON leaf (`d/<pointer>`), so concurrent edits of different keys
 * merge and one key is last-writer-wins. Every multi-replica row runs under
 * the §8 rule (`converge`: client-id assignments, both delivery orders,
 * duplicates, binary reload) with `wellFormed` held after every step.
 * Expected values are hand-authored from the documented merge rules
 * (`site/content/docs/concepts/properties.mdx`).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { converge, replica, seedUpdate } from './p1-harness.js';

const dataOf = (o, id = 'A') => o.ed.blockDataOf(id);
const settled = (outcomes, check: (o) => void) => {
	for (const o of outcomes) {
		expect(o.problems, 'no refusal, nothing pending, well-formed').toEqual([]);
		expect(o.results.size, 'every replica, observer order and reload agrees').toBe(1);
		check(o);
	}
};
const leavesOf = (node) =>
	Object.fromEntries(
		[...node.attrKeys()].filter((k) => k.startsWith('d/')).map((k) => [k, node.getAttr(k)])
	);

describe('block data: per-leaf last writer wins', () => {
	const seed = [{ id: 'A', text: 'a', data: { x: 0, meta: { a: 1 } } }];

	it('different keys edited concurrently are both kept', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				expect(a.ed.patchData('A', [{ path: ['title'], value: 'T' }]).status).toBe('applied');
				expect(b.ed.patchData('A', [{ path: ['done'], value: true }]).status).toBe('applied');
			}),
			(o) => expect(dataOf(o)).toEqual({ x: 0, meta: { a: 1 }, title: 'T', done: true })
		);
	});

	it('one key edited concurrently converges on one writer’s value', () => {
		const seen = new Set();
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.patchData('A', [{ path: ['x'], value: 'ada' }]);
				b.ed.patchData('A', [{ path: ['x'], value: 'bob' }]);
			}),
			(o) => {
				expect(['ada', 'bob']).toContain(dataOf(o).x);
				expect(dataOf(o).meta).toEqual({ a: 1 });
				seen.add(dataOf(o).x);
			}
		);
		expect(seen.size, 'the winner follows the writers, not the delivery order').toBeGreaterThan(0);
	});

	it('sibling nested keys are both kept', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.patchData('A', [{ path: ['meta', 'b'], value: 2 }]);
				b.ed.patchData('A', [{ path: ['meta', 'c'], value: [3, 4] }]);
			}),
			(o) => expect(dataOf(o)).toEqual({ x: 0, meta: { a: 1, b: 2, c: [3, 4] } })
		);
	});

	it('a primitive written concurrently with a key under it: the object wins', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.patchData('A', [{ path: ['meta'], value: 5 }]);
				b.ed.patchData('A', [{ path: ['meta', 'b'], value: 2 }]);
			}),
			// Ada's primitive removed `meta.a`; Bob's leaf under `meta` keeps it an object.
			(o) => expect(dataOf(o)).toEqual({ x: 0, meta: { b: 2 } })
		);
	});

	it('a delete and a set of another key both apply', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.patchData('A', [{ path: ['x'] }]);
				b.ed.patchData('A', [{ path: ['meta', 'a'], value: 9 }]);
			}),
			(o) => expect(dataOf(o)).toEqual({ meta: { a: 9 } })
		);
	});

	it('a set concurrent with a delete of the same key wins', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.patchData('A', [{ path: ['x'] }]);
				b.ed.patchData('A', [{ path: ['x'], value: 7 }]);
			}),
			(o) => expect(dataOf(o)).toEqual({ x: 7, meta: { a: 1 } })
		);
	});

	it('deleting the last key under an object keeps the object', () => {
		const document = createDocument({
			value: { children: [{ id: 'A', type: 'p', data: { m: { a: 1 } } }] }
		});
		document.facade.patchData('A', [{ path: ['m', 'a'] }]);
		expect(document.facade.blockDataOf('A')).toEqual({ m: {} });
		expect(loadDocument(document.encode()).facade.blockDataOf('A')).toEqual({ m: {} });
	});

	it('a whole replace removes the keys it saw; a concurrent key under them is kept', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.setBlockData('A', { z: 1 });
				b.ed.patchData('A', [{ path: ['meta', 'b'], value: 2 }]);
			}),
			(o) => expect(dataOf(o)).toEqual({ z: 1, meta: { b: 2 } })
		);
	});

	it('keys holding `/` and `~` round-trip', () => {
		const document = createDocument({ value: { children: [{ id: 'A', type: 'p' }] } });
		document.facade.patchData('A', [
			{ path: ['a/b', '~c'], value: 1 },
			{ path: [''], value: 'empty' }
		]);
		const expected = { 'a/b': { '~c': 1 }, '': 'empty' };
		expect(document.facade.blockDataOf('A')).toEqual(expected);
		expect(loadDocument(document.encode()).facade.blockDataOf('A')).toEqual(expected);
	});

	it('a `__proto__` key, written locally or by a hostile peer, never reaches Object.prototype', () => {
		const document = createDocument({ value: { children: [{ id: 'A', type: 'p' }] } });
		const ed = document.facade;
		ed.patchData('A', [{ path: ['__proto__', 'polluted'], value: 'local' }]);
		const node = ed.model.blockNodeOf(document.doc, 'A');
		document.doc.transact(() => {
			node.setAttr('d/__proto__/hostile', true);
			node.setAttr('d/constructor/prototype/hostile', true);
		}, 'peer');
		ed.blockDataOf('A');
		ed.toJSON();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).hostile).toBeUndefined();
	});

	it('an unchanged patch writes nothing; a malformed one is refused', () => {
		const document = createDocument({
			value: { children: [{ id: 'A', type: 'p', data: { a: 1 } }] }
		});
		const ed = document.facade;
		const before = document.encode();
		expect(ed.patchData('A', [{ path: ['a'], value: 1 }]).status).toBe('noop');
		expect(ed.setBlockData('A', { a: 1 }).status).toBe('noop');
		expect(document.encode()).toEqual(before);
		expect(ed.patchData('A', [{ path: 'a', value: 1 }]).status).toBe('refused');
		expect(ed.patchData('A', [{ path: [], value: 3 }]).status).toBe('refused');
		expect(ed.patchData('missing', [{ path: ['a'], value: 2 }]).status).toBe('refused');
	});
});

describe('legacy whole-data blocks', () => {
	const legacy = () => {
		const document = createDocument({ value: { children: [{ id: 'A', type: 'p' }] } });
		const node = document.facade.model.blockNodeOf(document.doc, 'A');
		// Written as a pre-next.6 replica did, outside this view's history.
		document.doc.transact(() => node.setAttr('data', { a: 1, m: { x: 1 } }), 'legacy');
		return { document, ed: document.facade, node };
	};

	it('read unchanged', () => {
		const { ed } = legacy();
		expect(ed.blockDataOf('A')).toEqual({ a: 1, m: { x: 1 } });
		expect(ed.toJSON().children[0].data).toEqual({ a: 1, m: { x: 1 } });
	});

	it('a set writes its leaf over the attr, which stays', () => {
		const { ed, node } = legacy();
		ed.patchData('A', [{ path: ['m', 'y'], value: 2 }]);
		ed.patchData('A', [{ path: ['a'], value: 5 }]);
		expect(ed.blockDataOf('A')).toEqual({ a: 5, m: { x: 1, y: 2 } });
		expect(node.getAttr('data')).toEqual({ a: 1, m: { x: 1 } });
		expect(leavesOf(node)).toEqual({ 'd/a': 5, 'd/m/y': 2 });
	});

	it('a key under a value that shadows the attr’s object never shows the object again', () => {
		const { ed } = legacy();
		ed.patchData('A', [{ path: ['m'], value: 5 }]);
		expect(ed.blockDataOf('A')).toEqual({ a: 1, m: 5 });
		ed.patchData('A', [{ path: ['m', 'q'], value: 1 }]);
		expect(ed.blockDataOf('A')).toEqual({ a: 1, m: { q: 1 } });
	});

	it('a delete, or an object over an object, explodes it into leaves; undo restores it exactly', () => {
		for (const patch of [
			{ path: ['a'] },
			{ path: ['m'], value: { y: 2 } },
			{ path: [], value: { z: 1 } }
		]) {
			const { document, ed, node } = legacy();
			const before = ed.blockDataOf('A');
			const after = { ...before };
			if (patch.path.length === 0) Object.keys(after).forEach((k) => delete after[k]);
			if (patch.value === undefined) delete after.a;
			Object.assign(
				after,
				patch.path.length ? (patch.value ? { m: patch.value } : {}) : patch.value
			);
			ed.patchData('A', [patch]);
			expect(ed.blockDataOf('A')).toEqual(after);
			expect(node.getAttr('data')).toBeUndefined();
			document.history.undo();
			expect(node.getAttr('data')).toEqual({ a: 1, m: { x: 1 } });
			expect(leavesOf(node)).toEqual({});
			document.history.redo();
			expect(ed.blockDataOf('A')).toEqual(after);
		}
	});

	it('two peers’ first writes of different keys are both kept', () => {
		const seed = seedUpdate([{ id: 'A', text: 'a' }]);
		const base = replica('base', seed, 2 ** 30);
		const node = base.ed.model.blockNodeOf(base.doc, 'A');
		base.doc.transact(() => node.setAttr('data', { a: 1, b: 1 }), 'legacy');
		const legacySeed = Y.encodeStateAsUpdate(base.doc);
		for (const [ada, bob] of [
			[2 ** 29, 2 ** 29 + 1],
			[2 ** 29 + 1, 2 ** 29]
		]) {
			const [a, b] = [replica('A', legacySeed, ada), replica('B', legacySeed, bob)];
			a.ed.patchData('A', [{ path: ['a'], value: 2 }]);
			b.ed.patchData('A', [{ path: ['b'], value: 2 }]);
			a.receiveAll(b.log);
			b.receiveAll(a.log);
			for (const r of [a, b]) expect(r.ed.blockDataOf('A')).toEqual({ a: 2, b: 2 });
			expect([...a.problems, ...b.problems]).toEqual([]);
		}
	});
});

describe('undo and redo of a patch', () => {
	it('restore the data exactly', () => {
		const document = createDocument({
			value: { children: [{ id: 'A', type: 'p', data: { a: 1, m: { x: 1 }, t: [1] } }] }
		});
		const ed = document.facade;
		ed.patchData('A', [
			{ path: ['m'], value: { y: 2 } },
			{ path: ['a'] },
			{ path: ['t'], value: [1, 2] }
		]);
		expect(ed.blockDataOf('A')).toEqual({ m: { y: 2 }, t: [1, 2] });
		document.history.undo();
		expect(ed.blockDataOf('A')).toEqual({ a: 1, m: { x: 1 }, t: [1] });
		document.history.redo();
		expect(ed.blockDataOf('A')).toEqual({ m: { y: 2 }, t: [1, 2] });
	});

	it('an undo keeps a peer’s concurrent key', () => {
		settled(
			converge([{ id: 'A', text: 'a', data: { a: 1 } }], 2, ([a, b]) => {
				a.ed.patchData('A', [{ path: ['a'], value: 2 }]);
				b.ed.patchData('A', [{ path: ['b'], value: 3 }]);
				a.receiveAll(b.log);
				a.undo();
			}),
			(o) => expect(dataOf(o)).toEqual({ a: 1, b: 3 })
		);
	});
});

describe('inline atom data', () => {
	const seed = [
		{
			id: 'A',
			content: [{ text: 'hi ' }, { id: 'm1', type: 'mention', data: { name: 'Ada', meta: {} } }]
		}
	];
	const atom = (o) => o.ed.contentItems('A').find((i) => i.kind === 'inline').data;

	it('different keys of one atom edited concurrently are both kept', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.patchData({ block: 'A', atom: 'm1' }, [{ path: ['name'], value: 'Bob' }]);
				b.ed.patchData({ block: 'A', atom: 'm1' }, [{ path: ['meta', 'at'], value: 3 }]);
			}),
			(o) => expect(atom(o)).toEqual({ name: 'Bob', meta: { at: 3 } })
		);
	});

	it('setInlineData replaces the whole value; an absent atom is refused', () => {
		const document = loadDocument(seedUpdate(seed));
		expect(document.facade.setInlineData('A', 'm1', { z: 1 }).status).toBe('applied');
		expect(document.facade.contentItems('A')[1].data).toEqual({ z: 1 });
		expect(
			document.facade.patchData({ block: 'A', atom: 'nope' }, [{ path: ['a'], value: 1 }]).status
		).toBe('refused');
	});
});

describe('document data', () => {
	it('different keys edited concurrently are both kept, in toJSON and after reload', () => {
		settled(
			converge([{ id: 'A', text: 'a' }], 2, ([a, b]) => {
				a.ed.patchData(null, [{ path: ['title'], value: 'Notes' }]);
				b.ed.patchData(null, [{ path: ['tags'], value: ['x'] }]);
			}),
			(o) => {
				expect(o.ed.docData()).toEqual({ title: 'Notes', tags: ['x'] });
				expect(o.ed.toJSON().data).toEqual({ title: 'Notes', tags: ['x'] });
			}
		);
	});

	it('is seeded from JSONDoc.data, deterministically', () => {
		const value = { data: { title: 'T', n: { a: 1 } }, children: [{ id: 'A', type: 'p' }] };
		const one = createDocument({ value });
		expect(one.facade.docData()).toEqual({ title: 'T', n: { a: 1 } });
		expect(one.facade.toJSON()).toEqual({ ...value, children: [{ id: 'A', type: 'p', data: {} }] });
		// Two replicas seeding the same value write the same items; another value, other ones.
		const E = bindEdytorDoc(Y);
		const [first, late, other] = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
		E.seed(first, value.children, 'p', value.data);
		E.seed(late, value.children, 'p', value.data);
		E.seed(other, value.children, 'p', { title: 'U' });
		expect(Y.encodeStateAsUpdate(late)).toEqual(Y.encodeStateAsUpdate(first));
		expect(Y.encodeStateVector(other)).not.toEqual(Y.encodeStateVector(first));
		// A seed without data keeps the writer it had before document data existed.
		const [plain, empty] = [new Y.Doc(), new Y.Doc()];
		E.seed(plain, value.children, 'p');
		E.seed(empty, value.children, 'p', {});
		expect(Y.encodeStateAsUpdate(empty)).toEqual(Y.encodeStateAsUpdate(plain));
		// An empty document's JSON has no `data`.
		expect('data' in createDocument({ value: { children: [] } }).facade.toJSON()).toBe(false);
	});

	it('seeds equal data in any key order the same way, at every depth (DR-props-1)', () => {
		// A room's store (jsonb) and a client's source may order keys differently:
		// one writer, so the same items, or an edit on one corrupts the other.
		const E = bindEdytorDoc(Y);
		const children = [{ id: 'A', type: 'p', data: { z: 1, m: { y: 2, b: 3 } } }];
		const reordered = [{ data: { m: { b: 3, y: 2 }, z: 1 }, type: 'p', id: 'A' }];
		const [a, b] = [new Y.Doc(), new Y.Doc()];
		E.seed(a, children, 'p', { title: 'Notes', tags: ['x'], meta: { v: 1, k: [{ q: 1, p: 2 }] } });
		E.seed(b, reordered, 'p', { meta: { k: [{ p: 2, q: 1 }], v: 1 }, tags: ['x'], title: 'Notes' });
		expect(Y.encodeStateAsUpdate(b)).toEqual(Y.encodeStateAsUpdate(a));
		const [fa, fb] = [E.create(a), E.create(b)];
		const before = Y.encodeStateVector(b);
		fa.patchData(null, [{ path: ['title'], value: 'Renamed' }]);
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a, before));
		const want = { title: 'Renamed', tags: ['x'], meta: { v: 1, k: [{ q: 1, p: 2 }] } };
		expect(fa.docData()).toEqual(want);
		expect(fb.docData()).toEqual(want);
	});

	it('is undone and redone by the history', () => {
		const document = createDocument({ value: { children: [{ id: 'A', type: 'p' }] } });
		document.facade.patchData(null, [{ path: ['title'], value: 'One' }]);
		document.history.undo();
		expect(document.facade.docData()).toEqual({});
		document.history.redo();
		expect(document.facade.docData()).toEqual({ title: 'One' });
	});
});

describe('the change report', () => {
	const setup = () => {
		const document = loadDocument(
			seedUpdate([
				{ id: 'A', text: 'x', data: { a: 1 } },
				{ id: 'B', content: [{ id: 'm1', type: 'mention', data: { n: 1 } }] }
			])
		);
		const changes = [];
		document.facade.onChange((c) => changes.push(c));
		return { document, ed: document.facade, changes };
	};

	it('carries a block’s assembled data in meta', () => {
		const { ed, changes } = setup();
		ed.patchData('A', [{ path: ['b'], value: 2 }]);
		expect(changes).toHaveLength(1);
		expect(changes[0].meta.get('A')).toEqual({ type: 'paragraph', data: { a: 1, b: 2 } });
		expect(changes[0].data).toBeUndefined();
	});

	it('carries an atom’s data in the block’s content', () => {
		const { ed, changes } = setup();
		ed.patchData({ block: 'B', atom: 'm1' }, [{ path: ['n'], value: 2 }]);
		expect(changes).toHaveLength(1);
		expect(changes[0].content.get('B')).toEqual([
			{ kind: 'inline', id: 'm1', type: 'mention', data: { n: 2 } }
		]);
	});

	it('carries the document’s data when it changed, local and remote; nothing when it nets out', () => {
		const { document, ed, changes } = setup();
		ed.patchData(null, [{ path: ['title'], value: 'T' }]);
		expect(changes).toHaveLength(1);
		expect(changes[0].data).toEqual({ title: 'T' });
		expect(changes[0].meta.size + changes[0].content.size + changes[0].added.size).toBe(0);
		ed.transact(() => {
			ed.patchData(null, [{ path: ['title'], value: 'U' }]);
			ed.patchData(null, [{ path: ['title'], value: 'T' }]);
		});
		expect(changes).toHaveLength(1);
		const peer = replica('peer', document.encode(), 2 ** 30);
		const seen = [];
		peer.ed.onChange((c) => seen.push(c));
		const other = replica('other', document.encode(), 2 ** 30 + 1);
		other.ed.patchData(null, [{ path: ['title'], value: 'V' }]);
		peer.receiveAll(other.log);
		expect(seen.map((c) => c.data)).toEqual([{ title: 'V' }]);
	});
});
