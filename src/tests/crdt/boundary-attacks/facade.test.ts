/**
 * GATE-2 attack probes — the assembled facade (attack items 2, 7, 9).
 *
 * 2. Undo scope: the facade ships NO UndoManager — U08 will attach one.
 *    These probes pin what each scope choice does to `meta`/`blocks`:
 *    - doc-scoped UM: init's version stamp is undoable; a schema-version
 *      upgrade is undoable (resurrects the stale version).
 *    - registry-scoped UM (baseline parity): meta writes are invisible, but
 *      the bootstrap insert IS inside the registry — attaching the UM before
 *      init lets a user undo the bootstrap into a "versioned but empty" doc.
 *    - provider/remote writes must never enter the undo stack.
 *
 * 7. DocChange mirror: apply every DocChange to a plain-JSON mirror and
 *    require equality with toJSON() — including remote updates, undo, and
 *    a doc constructed update-only.
 *
 * 9. Ownership purity: project()/toJSON()/runs() never write replicated
 *    state (update-bytes identical across reads); inputs/outputs are not
 *    aliased into replicated state (frozen inputs, mutated outputs).
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc, SCHEMA_VERSION } from '../../../lib/crdt/edytor-doc.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';
import { readData } from '../../../lib/crdt/data.js';

const E = bindEdytorDoc(Y);

const nextTick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const freshDoc = (withContent = true) => {
	const doc = new Y.Doc();
	const ed = E.create(doc);
	ed.init();
	if (withContent) {
		ed.insertBlock(
			{ parent: null, index: Number.MAX_SAFE_INTEGER },
			{ id: 'b1', type: 'paragraph', content: [{ kind: 'text', text: 'hello' }] }
		);
	}
	return { doc, ed };
};

describe('attack 2: undo scope vs meta/schema', () => {
	test('doc-scoped UM: the seed (version stamp + default block) is not an undo step', () => {
		// R13 §2.1 / D-3: init's seed is one update applied with a non-local
		// origin — it used to be a tracked local write that undo removed.
		const doc = new Y.Doc();
		const um = new Y.UndoManager(doc, { captureTimeout: 0 });
		const ed = E.create(doc);
		ed.init();
		expect(E.schemaVersion(doc)).toBe(SCHEMA_VERSION);
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);

		expect(um.undoStack).toHaveLength(0);
		um.undo();
		expect(E.schemaVersion(doc)).toBe(SCHEMA_VERSION);
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);
		ed.dispose();
	});

	test('doc-scoped UM: undo resurrects a stale schema version', () => {
		const { doc, ed } = freshDoc();
		const um = new Y.UndoManager(doc, { captureTimeout: 0 });
		doc.transact(() => doc.get('meta').setAttr('v', 99)); // a "future" schema bump
		expect(E.schemaVersion(doc)).toBe(99);
		um.undo();
		// v14 UndoManager happily rolls the version record back to 1 — the
		// doc now claims an older schema than it was written under. Nothing
		// protects meta.v from undo resurrection.
		expect(E.schemaVersion(doc)).toBe(SCHEMA_VERSION);
		ed.dispose();
	});

	test('registry-scoped UM attached BEFORE init cannot reach the seed', () => {
		const doc = new Y.Doc();
		const registry = doc.get('blocks');
		const um = new Y.UndoManager(registry, { captureTimeout: 0 });
		const ed = E.create(doc);
		ed.init();
		ed.insertBlock(
			{ parent: null, index: Number.MAX_SAFE_INTEGER },
			{ id: 'b1', type: 'paragraph' }
		);

		um.undo(); // removes b1
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);
		// R13 §2.1 / D-3: the seed was never captured, so the trap this row
		// pinned (undo leaving a "versioned but empty" doc) is gone.
		expect(um.canUndo()).toBe(false);
		um.undo();
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);
		ed.dispose();
	});

	test('registry-scoped UM attached AFTER init can never reach the bootstrap', () => {
		const { doc, ed } = freshDoc(false);
		const registry = doc.get('blocks');
		const um = new Y.UndoManager(registry, { captureTimeout: 0 });
		ed.insertBlock({ parent: null, index: 0 }, { id: 'b1', type: 'paragraph' });
		um.undo();
		// Undo consumed the only captured op — the bootstrap is unreachable.
		expect(ed.childrenIds(null)).toEqual([DEFAULT_SEED_ID]);
		expect(um.canUndo()).toBe(false);
		ed.dispose();
	});

	test('provider-applied (remote/untracked-origin) updates never enter the stack', () => {
		const { doc, ed } = freshDoc();
		const um = new Y.UndoManager(doc, { captureTimeout: 0 });
		const remote = new Y.Doc();
		const remoteEd = E.create(remote);
		remoteEd.init();
		remoteEd.insertBlock({ parent: null, index: 0 }, { id: 'r1', type: 'paragraph' });
		// Remote application carries an origin object that is NOT in
		// trackedOrigins — and the update lands outside the registry scope
		// check anyway (changedParentTypes covers it — origin is the filter).
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), { remote: true });
		expect(ed.childrenIds(null)).toContain('r1');
		expect(um.canUndo()).toBe(false); // remote writes are never undoable
		ed.dispose();
	});
});

describe('attack 9: shared RunView lifecycle', () => {
	test('disposing one facade kills the doc-shared run view for the other', () => {
		const { doc, ed } = freshDoc();
		const ed2 = E.create(doc); // second facade on the SAME doc — shares the WeakMap view

		let notified = 0;
		ed2.onChange(() => notified++);

		ed.dispose(); // ← tears down the shared RunView (unobserveDeep + cache clear)

		// Symptom 1 — blocks created post-dispose are invisible: the stale
		// view's index never got them, runs() returns [], and toJSON() OMITS
		// their content entirely (contentJSON → [] → `content` key dropped).
		ed2.insertBlock(
			{ parent: null, index: Number.MAX_SAFE_INTEGER },
			{ id: 'b_new', type: 'paragraph', content: [{ kind: 'text', text: 'new!' }] }
		);
		const json = ed2.toJSON();
		const bNew = json.children.find((b) => b.id === 'b_new');
		expect(bNew).toBeDefined();
		console.log(`[gate2] post-dispose block json=${JSON.stringify(bNew)}`);
		expect(bNew.content?.[0]?.text).toBe('new!'); // ← fails: content silently dropped

		// Symptom 2 — dead change subscribers (registry observer unbound).
		ed2.insertText('b1', 5, ' W');
		expect(notified).toBeGreaterThan(0); // ← fails: subscriber never fires

		// Symptom 3 — stale reads on primed blocks (slice-record index frozen
		// at dispose; observed: 'hello' served after a ' WORLD' insert when a
		// block-subscriber prime had cached deps).
		ed2.dispose();
	});
});

describe('attack 9: aliasing — caller objects leak into replicated state', () => {
	test('mutating an inline atom spec post-insert mutates the doc AND replicates', () => {
		const { doc, ed } = freshDoc();
		const spec = {
			id: 'b-inl',
			type: 'paragraph',
			content: [{ kind: 'inline', id: 'i1', type: 'mention', data: { label: 'Ada' } }]
		};
		ed.insertBlock({ parent: null, index: Number.MAX_SAFE_INTEGER }, spec);
		console.log(`[gate2] inline-shape: ${JSON.stringify(ed.toJSON().children[1])}`);

		// The caller still holds the object — and it's the SAME object stored
		// in the replicated node (no defensive clone on the inline data path,
		// unlike insertBlock's spec.data which IS structuredClone'd — the
		// facade's cloning policy is inconsistent).
		spec.content[0].data.label = 'PWNED';

		// Local reads now serve the mutation.
		const inlNode = doc.get('blocks').getAttr('b-inl').getAttr('content').get(0);
		console.log(`[gate2] inline stored data=${JSON.stringify(readData(inlNode))}`);
		// CONTRACT: the facade owns its inputs — mutating a caller-held spec
		// post-insert must not corrupt replicated state.
		expect(readData(inlNode).label).toBe('Ada'); // ← fails: live alias
		const replica = new Y.Doc();
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
		expect(readData(replica.get('blocks').getAttr('b-inl').getAttr('content').get(0)).label).toBe(
			'Ada'
		); // ← fails: the mutation REPLICATES
		ed.dispose();
	});

	test('mutating a nested mark value post-insert leaks through', () => {
		const { doc, ed } = freshDoc();
		const marks = { link: { href: 'https://a.example' } };
		ed.insertText('b1', 5, ' LINK', marks);
		marks.link.href = 'https://evil.example';
		const json = JSON.stringify(ed.toJSON());
		console.log(`[gate2] mark-alias: ${json.includes('evil.example') ? 'REPLICATED' : 'isolated'}`);
		// CONTRACT: same as above — insertText must own the marks payload.
		expect(json).not.toContain('evil.example'); // ← fails: live alias leaks
		ed.dispose();
	});

	test('reads hand out frozen objects: run marks cannot be mutated', () => {
		const { doc, ed } = freshDoc();
		ed.insertText('b1', 5, ' M', { bold: true });
		const runs1 = ed.runs('b1');
		const marked = runs1.find((r) => r.marks?.bold);
		expect(marked).toBeDefined();
		// Pinned contract: runs are interned + frozen — consumers cannot
		// corrupt the maintained view through a leaked reference.
		expect(Object.isFrozen(marked.marks)).toBe(true);
		expect(() => {
			marked.marks.bold = 'tampered';
		}).toThrow();
		const runs2 = ed.runs('b1');
		expect(JSON.stringify(runs2)).not.toContain('tampered');
		ed.dispose();
	});
});

describe('attack 9: projector purity', () => {
	test('project/toJSON/runs write nothing — update bytes identical across reads', () => {
		const { doc, ed } = freshDoc();
		ed.nestBlock('b1', DEFAULT_SEED_ID);
		const before = Y.encodeStateAsUpdate(doc);
		// Exercise every read surface twice.
		for (let i = 0; i < 2; i++) {
			ed.project();
			ed.toJSON();
			ed.runs('b1');
			ed.contentJSON('b1');
			ed.childrenIds(null);
			ed.positionOf('b1');
		}
		const after = Y.encodeStateAsUpdate(doc);
		expect([...after]).toEqual([...before]);
		ed.dispose();
	});

	test('deep-frozen input specs are accepted (no in-place normalization)', () => {
		const { doc, ed } = freshDoc();
		const spec = Object.freeze({
			id: 'fz1',
			type: 'paragraph',
			data: Object.freeze({ nested: Object.freeze({ a: 1 }) }),
			content: Object.freeze([
				Object.freeze({ kind: 'text', text: 'frozen', marks: Object.freeze({ bold: true }) })
			]),
			children: Object.freeze([])
		});
		expect(() =>
			ed.insertBlock({ parent: null, index: Number.MAX_SAFE_INTEGER }, spec)
		).not.toThrow();
		expect(JSON.stringify(ed.toJSON())).toContain('frozen');
		ed.dispose();
	});
});

describe('attack 7: DocChange mirror', () => {
	/** A minimal JSON mirror driven purely by DocChange events. */
	const makeMirror = () => {
		const nodes = new Map(); // id → {id,type,data,content,children}
		const childrenOf = new Map(); // parent(null|id) → [ids]
		childrenOf.set(null, []);
		// contentJSON-equivalent shape for a run/content item (kind dropped).
		const asContentJSON = (r) =>
			r.kind === 'text'
				? r.marks
					? { text: r.text, marks: JSON.parse(JSON.stringify(r.marks)) }
					: { text: r.text }
				: {
						id: r.id,
						type: r.type,
						...(r.data ? { data: JSON.parse(JSON.stringify(r.data)) } : {})
					};
		const indexSubtree = (b, parent) => {
			const clone = JSON.parse(JSON.stringify(b));
			const kids = clone.children ?? [];
			clone.children = undefined; // children tracked via childrenOf
			clone.content = (clone.content ?? []).map(asContentJSON);
			nodes.set(b.id, clone);
			const list = childrenOf.get(parent) ?? [];
			if (!list.includes(b.id)) list.push(b.id);
			childrenOf.set(parent, list);
			for (const k of kids) indexSubtree(k, b.id);
		};
		const apply = (c) => {
			// Added subtrees carry their descendants inline; the parent's new
			// `order` list is what places the root — derive it from `order`.
			for (const [parent, order] of c.order) childrenOf.set(parent, [...order]);
			for (const [id, block] of c.added) {
				let parent = null;
				for (const [p, order] of childrenOf) {
					if (order.includes(id)) {
						parent = p;
						break;
					}
				}
				indexSubtree(block, parent);
			}
			for (const id of c.removed) {
				nodes.delete(id);
				for (const [p, list] of childrenOf)
					childrenOf.set(
						p,
						list.filter((x) => x !== id)
					);
			}
			for (const [id, m] of c.meta) {
				const n = nodes.get(id);
				if (n) {
					n.type = m.type;
					if (m.data !== undefined) n.data = m.data;
				}
			}
			for (const [id, runs] of c.content) {
				const n = nodes.get(id);
				if (n) n.content = runs.map(asContentJSON);
			}
		};
		const render = () => {
			const emit = (id) => {
				const n = nodes.get(id);
				const out = { type: n.type, id: n.id, data: n.data ?? {} };
				if (n.content?.length) out.content = n.content;
				const kids = (childrenOf.get(id) ?? []).filter((k) => nodes.has(k));
				if (kids.length) out.children = kids.map(emit);
				return out;
			};
			return { children: (childrenOf.get(null) ?? []).map(emit) };
		};
		return { apply, render };
	};

	test('mirror stays equal to toJSON across local, remote, undo, and update-only docs', async () => {
		const { doc, ed } = freshDoc();
		const mirror = makeMirror();
		// Prime the mirror from the initial projection.
		const initial = ed.project();
		for (const b of initial.children) {
			mirror.apply({
				added: new Map([[b.id, JSON.parse(JSON.stringify(b))]]),
				order: new Map([[null, [b.id]]]),
				removed: new Set(),
				moved: new Set(),
				meta: new Map(),
				content: new Map(initial.children.map((b) => [b.id, ed.runs(b.id)]))
			});
		}
		const unsub = ed.onChange(mirror.apply);

		// local ops
		ed.insertText('b1', 5, ' world');
		ed.setBlockData('b1', { flag: 1 });
		ed.insertBlock(
			{ parent: null, index: Number.MAX_SAFE_INTEGER },
			{ id: 'b2', type: 'heading', content: [{ kind: 'text', text: 'T' }] }
		);
		ed.moveBlock('b2', { parent: null, index: 0 });
		expect(mirror.render()).toEqual(ed.toJSON());

		// remote-applied update
		const remote = new Y.Doc();
		const remoteEd = E.create(remote);
		remoteEd.init();
		remoteEd.insertBlock({ parent: null, index: 0 }, { id: 'r1', type: 'paragraph' });
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), { remote: true });
		expect(mirror.render()).toEqual(ed.toJSON());

		// undo (doc-scoped UM for coverage)
		const um = new Y.UndoManager(doc, { captureTimeout: 0 });
		ed.insertText('b1', 0, 'X');
		um.stopCapturing();
		um.undo();
		expect(mirror.render()).toEqual(ed.toJSON());

		// update-only construction: a doc built purely from applyUpdate
		// (no init call) must produce a coherent facade + mirror.
		const docOnly = new Y.Doc();
		Y.applyUpdate(docOnly, Y.encodeStateAsUpdate(doc));
		const edOnly = E.create(docOnly);
		expect(edOnly.toJSON()).toEqual(ed.toJSON());
		expect(E.schemaVersion(docOnly)).toBe(SCHEMA_VERSION);
		unsub();
		ed.dispose();
		edOnly.dispose();
	});
});
