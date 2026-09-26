/**
 * arch-v2 L63 — the test copy of `diffSnaps` (the F-O7 oracle) stays
 * runnable: snapshots built from the public projection + maintained runs,
 * diffed by the oracle, must describe the same change the facade's
 * `onChange` reports for each commit. D9 replaces the production diff with
 * the fold and compares its change report against this oracle.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { diffSnaps, type DocSnap } from '../../oracles/doc-change.js';

const E = bindEdytorDoc(Y);

const snapOf = (ed): DocSnap => {
	const nodes: DocSnap['nodes'] = new Map();
	const order: DocSnap['order'] = new Map();
	const byId = new Map();
	const walk = (parent, bs) => {
		order.set(
			parent,
			bs.map((b) => b.id)
		);
		bs.forEach((b, index) => {
			byId.set(b.id, b);
			nodes.set(b.id, { parent, index, type: b.type, data: b.data, contentRef: ed.runs(b.id) });
			if (b.children.length > 0) walk(b.id, b.children);
		});
	};
	walk(null, ed.project().children);
	return { nodes, order, nodeFor: (id) => byId.get(id) };
};

/** Comparable form — ids and payloads, not identities or versions. */
const norm = (c) =>
	c === null
		? null
		: {
				added: [...c.added.keys()].sort(),
				removed: [...c.removed].sort(),
				moved: [...c.moved].sort(),
				meta: Object.fromEntries([...c.meta].map(([id, m]) => [id, JSON.stringify(m)])),
				content: Object.fromEntries([...c.content].map(([id, r]) => [id, JSON.stringify(r)])),
				order: Object.fromEntries([...c.order].map(([p, ids]) => [String(p), [...ids]]))
			};

describe('diffSnaps oracle agrees with the facade change report', () => {
	test('insert, edit, retype, move, split, delete', () => {
		const doc = new Y.Doc();
		doc.clientID = 7;
		const ed = E.create(doc);
		ed.init({
			content: [
				{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'alpha' }] },
				{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'beta' }] },
				{ id: 'c', type: 'paragraph', content: [{ kind: 'text', text: 'gamma' }] }
			]
		});
		const steps = [
			() => ed.block('a').insertText(5, '!'),
			() => ed.block('b').setType('heading'),
			() => ed.block('c').nestUnder('b'),
			() => ed.block('a').split(2, 'a2'),
			() => ed.block('b').delete(),
			() => ed.block('a').setMark(0, 2, 'bold', true)
		];
		for (const step of steps) {
			const before = snapOf(ed);
			const reported = [];
			const off = ed.onChange((c) => reported.push(c));
			step();
			off();
			const after = snapOf(ed);
			expect(reported).toHaveLength(1);
			expect(norm(diffSnaps(before, after, null, true, 0))).toEqual(norm(reported[0]));
		}
	});
});
