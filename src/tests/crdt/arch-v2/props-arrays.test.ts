/**
 * Fine-grained arrays in properties (0.1.0-next.7): an array's items merge
 * like a `Y.Array`. Each item has an id and a rank, its value lives under
 * its own leaves, so concurrent edits inside different items, concurrent
 * inserts, a move and an edit inside the moved item all merge; a delete
 * beats a concurrent edit inside the deleted item. Patches address items by
 * index, resolved where the command is prepared. Every multi-replica row
 * runs under the §8 rule (`converge`: client-id assignments, both delivery
 * orders, duplicates, binary reload) with `wellFormed` held after every
 * step. Expected values are hand-authored from the properties page.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { setDocRand } from '../../../lib/crdt/rand.js';
import { mulberry32 } from '../harness/rng.js';
import { CLIENT_IDS, converge, LIVE, replica, seedUpdate } from './p1-harness.js';

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
const tasks = [
	{ title: 'a', done: false },
	{ title: 'b', done: false }
];
const seed = [{ id: 'A', text: 'x', data: { tasks, tags: ['p', 'q'] } }];
const applied = (r) => expect(r.status).toBe('applied');

describe('concurrent edits of one array', () => {
	it('properties of different items are both kept', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tasks', '0', 'title'], value: 'A' }]));
				applied(b.ed.patchData('A', [{ path: ['tasks', '1', 'done'], value: true }]));
			}),
			(o) =>
				expect(dataOf(o).tasks).toEqual([
					{ title: 'A', done: false },
					{ title: 'b', done: true }
				])
		);
	});

	it('two pushes keep both items, in one order everywhere, never interleaved', () => {
		const orders = new Set();
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tags'], splice: [2, 0, 'x1', 'x2'] }]));
				applied(b.ed.patchData('A', [{ path: ['tags'], splice: [2, 0, 'y1', 'y2'] }]));
			}),
			(o) => {
				const tags = dataOf(o).tags;
				expect([
					['p', 'q', 'x1', 'x2', 'y1', 'y2'],
					['p', 'q', 'y1', 'y2', 'x1', 'x2']
				]).toContainEqual(tags);
				orders.add(JSON.stringify(tags));
			}
		);
		expect(orders.size).toBeGreaterThan(0);
	});

	it('what one peer inserts after its own item in separate commands stays together (DR-arrays-1)', () => {
		// Two `push` calls, two 'Add task' clicks: a Y.Array keeps the second
		// after the first (its origin); a peer's concurrent insert in that gap
		// never lands between them.
		for (const [ada, bob, after] of [
			[
				[
					[2, 0, 'x'],
					[3, 0, 'y']
				],
				[[2, 0, 'b']],
				[
					['p', 'q', 'x', 'y', 'b'],
					['p', 'q', 'b', 'x', 'y']
				]
			],
			[
				[
					[2, 0, 'x'],
					[3, 0, 'y'],
					[4, 0, 'z']
				],
				[
					[2, 0, 'b'],
					[3, 0, 'c']
				],
				[
					['p', 'q', 'x', 'y', 'z', 'b', 'c'],
					['p', 'q', 'b', 'c', 'x', 'y', 'z']
				]
			],
			[
				[
					[1, 0, 'x'],
					[2, 0, 'y']
				],
				[[1, 0, 'b']],
				[
					['p', 'x', 'y', 'b', 'q'],
					['p', 'b', 'x', 'y', 'q']
				]
			],
			// After a peer's item: the second insert follows the first, not the peer's item.
			[
				[
					[0, 0, 'x'],
					[1, 0, 'y']
				],
				[[0, 0, 'b']],
				[
					['x', 'y', 'b', 'p', 'q'],
					['b', 'x', 'y', 'p', 'q']
				]
			]
		])
			settled(
				converge(seed, 2, ([a, b]) => {
					for (const splice of ada) applied(a.ed.patchData('A', [{ path: ['tags'], splice }]));
					for (const splice of bob) applied(b.ed.patchData('A', [{ path: ['tags'], splice }]));
				}),
				(o) => expect(after).toContainEqual(dataOf(o).tags)
			);
	});

	it('a path names an item by its id: an edit follows it past a peer’s insert or move (DR-arrays-2)', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				const [, second] = a.ed.dataItemIds('A', ['tasks']);
				applied(b.ed.patchData('A', [{ path: ['tasks'], splice: [0, 0, { title: 'new' }] }]));
				applied(b.ed.patchData('A', [{ path: ['tasks'], order: [0, 2, 1] }]));
				b.receiveAll(a.log);
				a.receiveAll(b.log);
				applied(a.ed.patchData('A', [{ path: ['tasks', second, 'title'], value: 'B' }]));
				applied(a.ed.patchData('A', [{ path: ['tasks', second, 'tags'], value: ['t'] }]));
			}),
			(o) =>
				expect(dataOf(o).tasks).toEqual([
					{ title: 'new' },
					{ title: 'B', done: false, tags: ['t'] },
					{ title: 'a', done: false }
				])
		);
	});

	it('an edit by id of an item a peer removed is refused once the removal is in', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				const [first] = a.ed.dataItemIds('A', ['tasks']);
				applied(b.ed.patchData('A', [{ path: ['tasks'], splice: [0, 1] }]));
				a.receiveAll(b.log);
				expect(a.ed.patchData('A', [{ path: ['tasks', first, 'title'], value: 'X' }]).status).toBe(
					'refused'
				);
				expect(a.ed.patchData('A', [{ path: ['tasks', first] }]).status).toBe('refused');
			}),
			(o) => expect(dataOf(o).tasks).toEqual([{ title: 'b', done: false }])
		);
	});

	it('an insert in the middle and a push both land where they were made', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tags'], splice: [1, 0, 'm'] }]));
				applied(b.ed.patchData('A', [{ path: ['tags'], splice: [2, 0, 'z'] }]));
			}),
			(o) => expect(dataOf(o).tags).toEqual(['p', 'm', 'q', 'z'])
		);
	});

	it('a delete beats a concurrent edit inside the deleted item: it never comes back', () => {
		for (const edit of [
			{ path: ['tasks', '0', 'title'], value: 'X' },
			{ path: ['tasks', '0'], value: { title: 'X' } },
			{ path: ['tasks', '0', 'sub'], value: [1] }
		])
			settled(
				converge(seed, 2, ([a, b]) => {
					applied(a.ed.patchData('A', [{ path: ['tasks'], splice: [0, 1] }]));
					applied(b.ed.patchData('A', [edit]));
				}),
				(o) => expect(dataOf(o).tasks).toEqual([{ title: 'b', done: false }])
			);
	});

	it('a delete beats a concurrent move of the deleted item (SW22-props-1)', () => {
		const three = [{ id: 'A', text: 'x', data: { l: ['a', 'b', 'c'] } }];
		for (const [removed, after] of [
			[0, ['C', 'b']],
			[2, ['b', 'a']]
		])
			settled(
				converge(three, 2, ([a, b]) => {
					applied(a.ed.patchData('A', [{ path: ['l'], splice: [removed, 1] }]));
					// A reverse moves every item but one.
					applied(b.ed.patchData('A', [{ path: ['l'], order: [2, 1, 0] }]));
					applied(b.ed.patchData('A', [{ path: ['l', '0'], value: 'C' }]));
				}),
				(o) => expect(dataOf(o).l).toEqual(after)
			);
	});

	it('an array deleted whole leaves nothing of a concurrent edit inside it', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tasks'] }]));
				applied(b.ed.patchData('A', [{ path: ['tasks', '1', 'title'], value: 'B' }]));
			}),
			(o) => expect(dataOf(o)).toEqual({ tags: ['p', 'q'] })
		);
	});

	it('a move (sort, reverse) and an edit inside the moved item both apply', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tasks'], order: [1, 0] }]));
				applied(b.ed.patchData('A', [{ path: ['tasks', '0', 'title'], value: 'A' }]));
			}),
			(o) =>
				expect(dataOf(o).tasks).toEqual([
					{ title: 'b', done: false },
					{ title: 'A', done: false }
				])
		);
	});

	it('a move and a concurrent insert both apply', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tags'], order: [1, 0] }]));
				applied(b.ed.patchData('A', [{ path: ['tags'], splice: [2, 0, 'z'] }]));
			}),
			// `p` moved after `q` and `z` was pushed after it: both land there, in one order.
			(o) =>
				expect([
					['q', 'p', 'z'],
					['q', 'z', 'p']
				]).toContainEqual(dataOf(o).tags)
		);
	});

	it('arrays nested in items merge the same way', () => {
		const rows = [{ id: 'A', text: 'x', data: { rows: [{ cells: [1, 2] }, { cells: [3] }] } }];
		settled(
			converge(rows, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['rows', '0', 'cells'], splice: [2, 0, 9] }]));
				applied(b.ed.patchData('A', [{ path: ['rows', '0', 'cells'], splice: [0, 0, 0] }]));
				applied(b.ed.patchData('A', [{ path: ['rows', '1', 'cells', '0'], value: 30 }]));
			}),
			(o) => expect(dataOf(o).rows).toEqual([{ cells: [0, 1, 2, 9] }, { cells: [30] }])
		);
	});

	it('items of an atom’s and of the document’s data merge too', () => {
		const withAtom = [
			{ id: 'A', content: [{ text: 'hi ' }, { id: 'm', type: 'mention', data: { l: [1] } }] }
		];
		settled(
			converge(withAtom, 2, ([a, b]) => {
				applied(a.ed.patchData({ block: 'A', atom: 'm' }, [{ path: ['l'], splice: [1, 0, 2] }]));
				applied(b.ed.patchData({ block: 'A', atom: 'm' }, [{ path: ['l'], splice: [0, 0, 0] }]));
				applied(a.ed.patchData(null, [{ path: ['list'], value: ['a'] }]));
			}),
			(o) => {
				expect(o.ed.contentItems('A')[1].data).toEqual({ l: [0, 1, 2] });
				expect(o.ed.docData()).toEqual({ list: ['a'] });
			}
		);
	});
});

describe('a whole reassignment', () => {
	it('keeps the items it keeps equal, so concurrent edits inside them stay', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				// The immutable-update pattern: append one, keep the rest.
				applied(
					a.ed.patchData('A', [{ path: ['tasks'], value: [...tasks, { title: 'c', done: false }] }])
				);
				applied(b.ed.patchData('A', [{ path: ['tasks', '1', 'done'], value: true }]));
			}),
			(o) =>
				expect(dataOf(o).tasks).toEqual([
					{ title: 'a', done: false },
					{ title: 'b', done: true },
					{ title: 'c', done: false }
				])
		);
	});

	it('an item changed in place keeps its id: a concurrent edit of another of its properties stays', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(
					a.ed.patchData('A', [{ path: ['tasks'], value: [{ title: 'a', done: true }, tasks[1]] }])
				);
				applied(b.ed.patchData('A', [{ path: ['tasks', '0', 'title'], value: 'A' }]));
			}),
			(o) =>
				expect(dataOf(o).tasks).toEqual([
					{ title: 'A', done: true },
					{ title: 'b', done: false }
				])
		);
	});

	it('a filter removes only the items it drops', () => {
		const three = [{ id: 'A', text: 'x', data: { l: [{ n: 1 }, { n: 2 }, { n: 3 }] } }];
		settled(
			converge(three, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['l'], value: [{ n: 1 }, { n: 3 }] }]));
				applied(b.ed.patchData('A', [{ path: ['l', '2', 'seen'], value: true }]));
			}),
			(o) => expect(dataOf(o).l).toEqual([{ n: 1 }, { n: 3, seen: true }])
		);
	});

	it('two identical assignments of an array that was not there read once (DR-arrays-3)', () => {
		// `options ??= ['A', 'B']` in every open view, a preset's array: one copy, as next.6 gave.
		for (const value of [['x', 'y'], [{ t: 'a', l: [1, 2] }, 'x', 'x'], []])
			settled(
				converge(seed, 2, ([a, b]) => {
					for (const r of [a, b]) {
						applied(r.ed.patchData('A', [{ path: ['fresh'], value }]));
						applied(r.ed.patchData(null, [{ path: ['fresh'], value }]));
						applied(r.ed.patchData('A', [{ path: ['tasks', '0', 'fresh'], value }]));
					}
				}),
				(o) => {
					expect(dataOf(o).fresh).toEqual(value);
					expect(dataOf(o).tasks[0].fresh).toEqual(value);
					expect(o.ed.docData()).toEqual({ fresh: value });
				}
			);
	});

	it('two peers turning a block into a kind whose data holds an array leave one copy', () => {
		const data = { variant: 'x', options: ['A', 'B'] };
		settled(
			converge([{ id: 'A', text: 'x' }], 2, ([a, b]) => {
				for (const r of [a, b]) applied(r.ed.setBlock('A', { type: 'h1', data }));
			}),
			(o) => expect(dataOf(o)).toEqual(data)
		);
	});

	it('two reassignments of an array holding items pair them by position: last writer wins there (DR-arrays-4)', () => {
		const one = [{ id: 'A', text: 'x', data: { tags: ['old'] } }];
		settled(
			converge(one, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tags'], value: ['a'] }]));
				applied(b.ed.patchData('A', [{ path: ['tags'], value: ['b'] }]));
			}),
			(o) => expect([['a'], ['b']]).toContainEqual(dataOf(o).tags)
		);
		// What each inserts past the paired items is kept.
		settled(
			converge(one, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['tags'], value: ['a', 'a2'] }]));
				applied(b.ed.patchData('A', [{ path: ['tags'], value: ['b', 'b2'] }]));
			}),
			(o) =>
				expect([
					['a', 'a2', 'b2'],
					['a', 'b2', 'a2'],
					['b', 'a2', 'b2'],
					['b', 'b2', 'a2']
				]).toContainEqual(dataOf(o).tags)
		);
	});

	it('two concurrent reassignments of a fresh array keep both writers’ items, not interleaved', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				applied(a.ed.patchData('A', [{ path: ['fresh'], value: ['a1', 'a2'] }]));
				applied(b.ed.patchData('A', [{ path: ['fresh'], value: ['b1', 'b2'] }]));
			}),
			(o) =>
				expect([
					['a1', 'a2', 'b1', 'b2'],
					['b1', 'b2', 'a1', 'a2']
				]).toContainEqual(dataOf(o).fresh)
		);
	});
});

describe('one replica', () => {
	const make = (data = { tasks, tags: ['p', 'q'] }) => {
		const document = createDocument({
			value: { children: [{ id: 'A', type: 'p', data }] },
			history: { captureTimeout: 0 }
		});
		return { document, ed: document.facade };
	};

	it('stores an array as its marker, each item’s value and its rank', () => {
		const { document, ed } = make({ tags: ['p'], m: { k: [{ a: 1 }] } });
		const node = ed.model.blockNodeOf(document.doc, 'A');
		const leaves = leavesOf(node);
		expect(leaves['d/tags']).toEqual([]);
		const items = Object.keys(leaves).filter((k) => /^d\/tags\/~[a-z][a-z0-9.]*$/.test(k));
		expect(items).toHaveLength(1);
		expect(leaves[items[0]]).toBe('p');
		expect(typeof leaves[`${items[0]}#`]).toBe('string');
		expect(Object.keys(leaves).some((k) => /^d\/m\/k\/~[a-z][a-z0-9.]*\/a$/.test(k))).toBe(true);
	});

	it('ranks stay short: one peer’s pushes one at a time, and inserts after its own items', () => {
		const { document, ed } = make({ tags: [] });
		for (let i = 0; i < 300; i++) {
			const n = ed.blockDataOf('A').tags.length;
			applied(
				ed.patchData('A', [{ path: ['tags'], splice: [i % 3 ? n : Math.floor(n / 2), 0, i] }])
			);
		}
		const node = ed.model.blockNodeOf(document.doc, 'A');
		const ranks = Object.entries(leavesOf(node)).filter(([k]) => /[#>]$/.test(k));
		expect(ranks).toHaveLength(300);
		expect(Math.max(...ranks.map(([, r]) => r.length))).toBeLessThanOrEqual(16 * 6);
	});

	it('every op is one undo step; undo and redo restore exactly', () => {
		const steps = [
			[{ path: ['tags'], splice: [2, 0, 'r'] }, ['p', 'q', 'r']],
			[{ path: ['tags'], splice: [0, 1] }, ['q']],
			[{ path: ['tags'], splice: [1] }, ['p']],
			[{ path: ['tags'], order: [1, 0] }, ['q', 'p']],
			[{ path: ['tags', '1'], value: 'Q' }, ['p', 'Q']],
			[{ path: ['tags', '3'], value: 's' }, ['p', 'q', null, 's']],
			[{ path: ['tags', '0'] }, ['q']],
			[{ path: ['tags'], value: ['q', 'z'] }, ['q', 'z']]
		];
		for (const [patch, after] of steps) {
			const { document, ed } = make();
			applied(ed.patchData('A', [patch]));
			expect(ed.blockDataOf('A').tags, JSON.stringify(patch)).toEqual(after);
			document.history.undo();
			expect(ed.blockDataOf('A').tags).toEqual(['p', 'q']);
			document.history.redo();
			expect(ed.blockDataOf('A').tags).toEqual(after);
			expect(loadDocument(document.encode()).facade.blockDataOf('A').tags).toEqual(after);
		}
	});

	it('an undo of a push keeps a peer’s concurrent push', () => {
		settled(
			converge(seed, 2, ([a, b]) => {
				a.ed.patchData('A', [{ path: ['tags'], splice: [2, 0, 'x'] }]);
				b.ed.patchData('A', [{ path: ['tags'], splice: [2, 0, 'y'] }]);
				a.receiveAll(b.log);
				a.undo();
			}),
			(o) => expect(dataOf(o).tags).toEqual(['p', 'q', 'y'])
		);
	});

	it('refuses what no array does; an unchanged op writes nothing', () => {
		const { document, ed } = make();
		const before = document.encode();
		for (const patch of [
			{ path: ['tasks', '0', 'title'], value: 'a' },
			{ path: ['tags'], order: [0, 1] },
			{ path: ['tags'], splice: [0, 0] },
			{ path: ['tags'], value: ['p', 'q'] }
		])
			expect(ed.patchData('A', [patch]).status).toBe('noop');
		expect(document.encode()).toEqual(before);
		for (const patch of [
			{ path: ['tasks', 'x', 'title'], value: 1 },
			{ path: ['tasks', '2', 'title'], value: 1 },
			{ path: ['tasks', '-1'], value: 1 },
			{ path: ['tasks', '01'], value: 1 },
			{ path: ['tasks', '0', 'title'], splice: [0, 0, 'x'] },
			{ path: ['nope'], splice: [0, 0, 1] },
			{ path: ['tags'], order: [0, 0] },
			{ path: ['tags'], order: [1] },
			{ path: ['tags'], splice: ['a', 0] },
			{ path: [], splice: [0, 0] }
		])
			expect(ed.patchData('A', [patch]).status, JSON.stringify(patch)).toBe('refused');
	});

	it('a key spelled like an item stays a key', () => {
		const { ed } = make({});
		const data = { '~a': 1, '~a#': 'x', '@k': [{ '~b#': 2 }] };
		applied(ed.patchData('A', [{ path: [], value: data }]));
		expect(ed.blockDataOf('A')).toEqual(data);
	});
});

describe('arrays written by 0.1.0-next.6 (one leaf) and in a legacy whole-data attr', () => {
	const legacy = (write: (node) => void) => {
		const base = replica('base', seedUpdate([{ id: 'A', text: 'a' }]), 2 ** 30);
		const node = base.ed.model.blockNodeOf(base.doc, 'A');
		base.doc.transact(() => write(node), 'legacy');
		return Y.encodeStateAsUpdate(base.doc);
	};
	const shapes = {
		leaf: (node) => node.setAttr('d/tags', ['p', 'q']),
		attr: (node) => node.setAttr('data', { tags: ['p', 'q'], k: 1 })
	};

	for (const [shape, write] of Object.entries(shapes)) {
		it(`${shape}: read unchanged; the first op explodes it into items`, () => {
			const document = loadDocument(legacy(write));
			const ed = document.facade;
			expect(ed.blockDataOf('A').tags).toEqual(['p', 'q']);
			applied(ed.patchData('A', [{ path: ['tags', '1'], value: 'Q' }]));
			expect(ed.blockDataOf('A').tags).toEqual(['p', 'Q']);
			document.history.undo();
			expect(ed.blockDataOf('A').tags).toEqual(['p', 'q']);
			for (const [patch, after] of [
				[{ path: ['tags'], splice: [0, 1] }, ['q']],
				[{ path: ['tags', '1'] }, ['p']],
				[{ path: ['tags'], order: [1, 0] }, ['q', 'p']],
				[{ path: ['tags'], value: ['q'] }, ['q']],
				[{ path: ['tags'], splice: [1, 0, 'm'] }, ['p', 'm', 'q']]
			]) {
				const fresh = loadDocument(legacy(write));
				applied(fresh.facade.patchData('A', [patch]));
				expect(fresh.facade.blockDataOf('A').tags, JSON.stringify(patch)).toEqual(after);
				expect(loadDocument(fresh.encode()).facade.blockDataOf('A').tags).toEqual(after);
				fresh.history.undo();
				expect(fresh.facade.blockDataOf('A').tags).toEqual(['p', 'q']);
			}
		});

		it(`${shape}: two peers’ concurrent first ops are both kept`, () => {
			const update = legacy(write);
			for (const [ada, bob] of [
				[2 ** 29, 2 ** 29 + 1],
				[2 ** 29 + 1, 2 ** 29]
			]) {
				const [a, b] = [replica('A', update, ada), replica('B', update, bob)];
				applied(a.ed.patchData('A', [{ path: ['tags'], splice: [2, 0, 'r'] }]));
				applied(b.ed.patchData('A', [{ path: ['tags', '0'], value: 'P' }]));
				a.receiveAll(b.log);
				b.receiveAll(a.log);
				for (const r of [a, b]) expect(r.ed.blockDataOf('A').tags).toEqual(['P', 'q', 'r']);
				expect(a.canonical()).toBe(b.canonical());
				expect([...a.problems, ...b.problems]).toEqual([]);
			}
		});
	}
});

describe('an insert never runs out of room (RankSpaceExhausted, 2026-10-01 review)', () => {
	// Arrays seeded, exploded from a next.6 leaf or assigned whole have ranks
	// derived from their value (one run under the value's hash): every gap of
	// such an array, and of what is inserted into it, takes any number of
	// inserts, from one peer or two at once, and the ranks stay short.
	const legacyLeaf = (tags: string[]) => {
		const base = replica('base', seedUpdate([{ id: 'A', text: 'a' }]), 2 ** 30);
		const node = base.ed.model.blockNodeOf(base.doc, 'A');
		base.doc.transact(() => node.setAttr('d/tags', tags), 'legacy');
		return Y.encodeStateAsUpdate(base.doc);
	};
	const opened = (document) => {
		document.doc.clientID = LIVE + 5;
		setDocRand(document.doc, mulberry32(5));
		return document;
	};
	const shapes = {
		seeded: () =>
			opened(
				createDocument({
					value: { children: [{ id: 'A', type: 'p', data: { tags: ['p', 'q'] } }] },
					history: { captureTimeout: 0 }
				})
			),
		'seed writer': () =>
			opened(
				loadDocument(seedUpdate([{ id: 'A', text: 'x', data: { tags: ['p', 'q'] } }]), {
					history: { captureTimeout: 0 }
				})
			),
		'next.6 leaf': () =>
			opened(loadDocument(legacyLeaf(['p', 'q']), { history: { captureTimeout: 0 } })),
		'next.6 leaf, exploded': () => {
			const document = opened(
				loadDocument(legacyLeaf(['p', 'x', 'q']), { history: { captureTimeout: 0 } })
			);
			applied(document.facade.patchData('A', [{ path: ['tags'], splice: [1, 1] }]));
			const node = document.facade.model.blockNodeOf(document.doc, 'A');
			expect(leavesOf(node)['d/tags'], 'exploded into items').toEqual([]);
			return document;
		},
		assigned: () => {
			const document = opened(
				createDocument({
					value: { children: [{ id: 'A', type: 'p' }] },
					history: { captureTimeout: 0 }
				})
			);
			applied(document.facade.patchData('A', [{ path: ['tags'], value: ['p', 'q'] }]));
			return document;
		}
	};
	const rnd = mulberry32(17);
	const workloads: Record<string, (n: number, i: number) => number> = {
		unshift: () => 0,
		'at index 1': () => 1,
		'unshift and index 1, alternating': (_, i) => i % 2,
		'before the last': (n) => n - 1,
		push: (n) => n,
		anywhere: (n) => Math.floor(rnd() * (n + 1))
	};
	const rankLengths = (document) =>
		Object.entries(leavesOf(document.facade.model.blockNodeOf(document.doc, 'A')))
			.filter(([k]) => /[#>]$/.test(k))
			.map(([, r]) => r.length);
	// A rank is 16 characters a segment. Inserts that keep landing in one gap
	// (the front, index 1, before the last, the end) stay at a constant
	// depth whatever their number: measured 4 segments at most (64
	// characters). Inserts anywhere halve gaps at random and descend one level
	// when one runs out, as a fresh array's do: measured 7 to 8 segments
	// after 500 (112 to 128 characters; a fresh array, 8).
	const BOUND = 16 * 4;
	const ANYWHERE = 16 * 9;

	for (const [shape, make] of Object.entries(shapes))
		for (const [workload, at] of Object.entries(workloads))
			it(`${shape}: 500 inserts, ${workload}`, () => {
				const document = make();
				const want = ['p', 'q'];
				for (let i = 0; i < 500; i++) {
					const index = at(want.length, i);
					want.splice(index, 0, `v${i}`);
					applied(
						document.facade.patchData('A', [{ path: ['tags'], splice: [index, 0, `v${i}`] }])
					);
				}
				expect(document.facade.blockDataOf('A').tags).toEqual(want);
				expect(loadDocument(document.encode()).facade.blockDataOf('A').tags).toEqual(want);
				expect(Math.max(...rankLengths(document))).toBeLessThanOrEqual(
					workload === 'anywhere' ? ANYWHERE : BOUND
				);
				// Moves into those gaps rank the same way.
				applied(
					document.facade.patchData('A', [
						{ path: ['tags'], order: want.map((_, i) => i).reverse() }
					])
				);
				expect(document.facade.blockDataOf('A').tags).toEqual([...want].reverse());
			});

	it('two peers each inserting 200 times into the same gaps, apart and then synced as they go', () => {
		const seeds = [{ id: 'A', text: 'x', data: { tags: ['p', 'q'] } }];
		for (const ids of CLIENT_IDS[2]) {
			const update = seedUpdate(seeds);
			const [a, b] = ids.map((id, i) => replica(i ? 'B' : 'A', update, id));
			const sent = new Map([
				[a, 0],
				[b, 0]
			]);
			const deliver = () => {
				for (const [from, to] of [
					[a, b],
					[b, a]
				]) {
					to.receiveAll(from.log.slice(sent.get(from)));
					sent.set(from, from.log.length);
				}
			};
			const insert = (r, index: number, v: string) =>
				applied(r.ed.patchData('A', [{ path: ['tags'], splice: [index, 0, v] }]));
			// Apart: each peer's 200 inserts at index 1 and at the front.
			for (let i = 0; i < 200; i++)
				for (const r of [a, b]) insert(r, i % 3 === 2 ? 0 : 1, `${r.name}${i}`);
			deliver();
			expect(a.canonical()).toBe(b.canonical());
			// Then 200 more each, between the same two items, synced every few steps.
			for (let i = 0; i < 200; i++) {
				for (const r of [a, b]) insert(r, i % 2 ? 1 : 2, `${r.name}+${i}`);
				if (i % 5 === 4) deliver();
			}
			deliver();
			expect(a.canonical()).toBe(b.canonical());
			expect([...a.problems, ...b.problems]).toEqual([]);
			const tags = a.ed.blockDataOf('A').tags;
			expect(tags).toHaveLength(802);
			expect(new Set(tags).size).toBe(802);
			// Measured: 4 segments at most (64 characters).
			for (const r of [a, b])
				expect(Math.max(...rankLengths(r.document))).toBeLessThanOrEqual(BOUND);
		}
	});
});

describe('a write to an item that is gone writes nothing (2026-10-01 review)', () => {
	// A held item (a proxy kept across an await, an id from `dataItemIds`)
	// whose array was deleted, replaced or emptied, or which was removed
	// itself: its writes are refused, never written under a dead item, and a
	// `~` id never reads as an object key.
	const noItemKeys = (v: unknown): boolean =>
		v === null || typeof v !== 'object'
			? true
			: Array.isArray(v)
				? v.every(noItemKeys)
				: Object.entries(v).every(([k, x]) => !/^~[a-z]/.test(k) && noItemKeys(x));
	const removals = {
		'array deleted': { path: ['tasks'] },
		'array replaced by a string': { path: ['tasks'], value: 'none' },
		'array replaced by an object': { path: ['tasks'], value: { k: 1 } },
		'array emptied': { path: ['tasks'], value: [] },
		'item removed': { path: ['tasks'], splice: [0, 1] },
		'array deleted, a new one assigned': [
			{ path: ['tasks'] },
			{ path: ['tasks'], value: [{ title: 'n' }] }
		]
	};
	const writes = (id: string) => [
		{ path: ['tasks', id, 'title'], value: 'X' },
		{ path: ['tasks', id], value: { title: 'X' } },
		{ path: ['tasks', id] },
		{ path: ['tasks', id, 'sub'], value: [1] },
		{ path: ['tasks', id, 'sub'], splice: [0, 0, 1] },
		{ path: ['tasks', id, 'deep', 'er'], value: 1 }
	];
	const targets = {
		block: { target: 'A', read: (ed) => ed.blockDataOf('A') },
		document: { target: null, read: (ed) => ed.docData() },
		atom: { target: { block: 'B', atom: 'm' }, read: (ed) => ed.contentItems('B')[1].data }
	};
	const withData = [
		{ id: 'A', text: 'x', data: { tasks } },
		{ id: 'B', content: [{ text: 'hi ' }, { id: 'm', type: 'mention', data: { tasks } }] }
	];

	for (const [name, { target, read }] of Object.entries(targets))
		for (const [removal, ops] of Object.entries(removals))
			it(`${name}: ${removal}, by a peer`, () => {
				settled(
					converge(withData, 2, ([a, b]) => {
						if (target === null) {
							for (const r of [a, b]) r.ed.patchData(null, [{ path: ['tasks'], value: tasks }]);
							a.receiveAll(b.log);
							b.receiveAll(a.log);
						}
						const [first] = a.ed.dataItemIds(target, ['tasks']);
						applied(b.ed.patchData(target, [ops].flat()));
						a.receiveAll(b.log);
						const before = JSON.stringify(read(a.ed));
						for (const write of writes(first)) {
							const r = a.ed.patchData(target, [write]);
							expect(r.status, JSON.stringify(write)).toBe('refused');
						}
						expect(JSON.stringify(read(a.ed))).toBe(before);
						expect(noItemKeys(read(a.ed))).toBe(true);
					}),
					(o) => expect(noItemKeys(read(o.ed))).toBe(true)
				);
			});

	it('an item of an item: refused once the outer item or array is gone', () => {
		const rows = [{ id: 'A', text: 'x', data: { rows: [{ cells: [1, 2] }, { cells: [3] }] } }];
		for (const removal of [
			{ path: ['rows'] },
			{ path: ['rows'], splice: [0, 1] },
			{ path: ['rows', '0', 'cells'] }
		]) {
			const document = loadDocument(seedUpdate(rows));
			const ed = document.facade;
			const [row] = ed.dataItemIds('A', ['rows']);
			const [cell] = ed.dataItemIds('A', ['rows', row, 'cells']);
			applied(ed.patchData('A', [removal]));
			const before = JSON.stringify(ed.blockDataOf('A'));
			for (const write of [
				{ path: ['rows', row, 'cells', cell], value: 9 },
				{ path: ['rows', row, 'cells', cell, 'k'], value: 9 },
				{ path: ['rows', row, 'cells', cell] }
			])
				expect(ed.patchData('A', [write]).status, JSON.stringify([removal, write])).toBe('refused');
			expect(JSON.stringify(ed.blockDataOf('A'))).toBe(before);
			expect(noItemKeys(ed.blockDataOf('A'))).toBe(true);
		}
	});

	it('an id where no array is never makes an object key', () => {
		const document = loadDocument(seedUpdate([{ id: 'A', text: 'x', data: { o: { k: 1 } } }]));
		const ed = document.facade;
		for (const path of [['~abc'], ['o', '~abc'], ['o', '~abc', 'x'], ['n', '~abc']])
			expect(ed.patchData('A', [{ path, value: 1 }]).status, JSON.stringify(path)).toBe('refused');
		expect(ed.blockDataOf('A')).toEqual({ o: { k: 1 } });
	});
});

describe('a key that starts with `~` (2026-10-01 review)', () => {
	// In a path, `~` and a lowercase letter names an array item; a key that
	// starts with `~` is written with that `~` escaped as `~0` (RFC 6901).
	it('round-trips through a whole value, a set, an edit inside it and a delete', () => {
		const document = loadDocument(seedUpdate([{ id: 'A', text: 'x' }]));
		const ed = document.facade;
		const data = { '~abc': 1, '~': 2, '~0': 3, '~x': { '~y': [{ '~z': 1 }] }, 'a~b': 4 };
		applied(ed.patchData('A', [{ path: [], value: data }]));
		expect(ed.blockDataOf('A')).toEqual(data);
		applied(ed.patchData('A', [{ path: ['~0abc'], value: 5 }]));
		applied(ed.patchData('A', [{ path: ['~00'], value: 6 }]));
		applied(ed.patchData('A', [{ path: ['~0x', '~0y', '0', '~0z'], value: 7 }]));
		applied(ed.patchData('A', [{ path: ['~0x', '~0y'], splice: [1, 0, 'n'] }]));
		applied(ed.patchData('A', [{ path: ['~0new'], value: { '~k': [] } }]));
		applied(ed.patchData('A', [{ path: ['~0'] }]));
		const want = {
			'~abc': 5,
			'~0': 6,
			'~x': { '~y': [{ '~z': 7 }, 'n'] },
			'a~b': 4,
			'~new': { '~k': [] }
		};
		expect(ed.blockDataOf('A')).toEqual(want);
		expect(loadDocument(document.encode()).facade.blockDataOf('A')).toEqual(want);
		expect(ed.dataItemIds('A', ['~0x', '~0y'])).toHaveLength(2);
	});
});
