/**
 * HARDENING U0 / R4 — public snapshots are mutable aliases of live state
 * (review `docs/crdt-v14-follow-up-review-2026-09-21.md` §R4, P1).
 *
 * `project()`, `contentItems()`, `block.items` hand out the SAME objects the
 * model/engine holds: `T.contentItemsOf`/`itemsOfRange` emit the live
 * `{marks,data}` object references, and `project()` clones only block-level
 * `data` — not inline `data`/`marks`. Writing into a returned snapshot mutates
 * the live document: no update event fires, but `encodeStateAsUpdate`
 * re-serializes the corrupted objects, so the mutation silently propagates to
 * peers on the next sync (and to the maintained `runs` cache on the next
 * recompute — the checkpoint index seeds the live formats objects).
 *
 * EXPECTED: mutating a returned snapshot is either rejected (frozen payloads)
 * or lands on a detached copy — every subsequent public read and every replica
 * keeps the original values, and `encodeStateAsUpdate` bytes are unchanged.
 *
 * OBSERVED today (vitest run, this file):
 *   after `proj.content[1].data.label = 'MUTATED'` and
 *   `proj.content[0].marks.link.href = 'https://evil.example'`:
 *     project()/contentItems()/items      → mutated values visible
 *     encodeStateAsUpdate bytes           → CHANGED (no 'update' event fired)
 *     peer synced after the mutation      → inherits mutated state
 *     runs() after an unrelated recompute → checkpoint index poisoned, mutated
 *
 * These tests assert the CORRECT semantics — they were RED until U4.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';

const E = bindEdytorDoc(Y);
let cid = 500_000;

const ORIGIN = 'https://orig.example';
const EVIL = 'https://evil.example';
const ORIG_LABEL = 'orig';

const seed = () => {
	const doc = new Y.Doc();
	doc.clientID = cid++;
	const ed = E.create(doc);
	ed.init({
		content: [
			{
				id: 'b',
				type: 'paragraph',
				content: [
					{ kind: 'text', text: 'hello', marks: { link: { href: ORIGIN } } },
					{ kind: 'inline', id: 'm1', type: 'mention', data: { label: ORIG_LABEL } },
					{ kind: 'text', text: ' tail' }
				]
			}
		]
	});
	return { doc, ed };
};

const contentOf = (proj: { children: { id: string; content: any[] }[] }, id: string) =>
	proj.children.find((b) => b.id === id)?.content ?? [];

// Both item shapes are covered: ContentRun/ContentItem use `kind`, while the
// contentJSON() export emits `{text, marks?}` / `{id, type, data?}`.
const isText = (i: any) =>
	i.kind === 'text' || (i.kind === undefined && typeof i.text === 'string');
const isInline = (i: any) => i.kind === 'inline' || (i.kind === undefined && i.type !== undefined);
const inlineDataLabel = (items: any[]) => items.find(isInline)?.data?.label;
const linkHref = (items: any[]) => items.find((i) => isText(i) && i.marks?.link)?.marks?.link?.href;

/** Mutate a snapshot value; returns 'rejected' if frozen, 'landed' otherwise. */
const tryMutate = (fn: () => void): string => {
	try {
		fn();
		return 'landed';
	} catch {
		return 'rejected';
	}
};

describe('R4 — mutating a public snapshot must not touch live state', () => {
	test('project() payload mutation does not alter any subsequent public read', () => {
		const { doc, ed } = seed();
		ed.runs('b'); // prime the maintained-runs cache

		let updates = 0;
		doc.on('update', () => updates++);
		const bytesBefore = Buffer.from(Y.encodeStateAsUpdate(doc));

		const proj = ed.project();
		const items = contentOf(proj, 'b');
		const m1 = tryMutate(() => {
			items.find((i: any) => i.kind === 'inline').data.label = 'MUTATED';
		});
		const m2 = tryMutate(() => {
			items.find((i: any) => i.kind === 'text' && i.marks?.link).marks.link.href = EVIL;
		});
		// Whether the eventual fix freezes payloads ('rejected') or detaches
		// them ('landed'), live state must stay identical. Today: 'landed'/
		// 'landed' — both writes reach live objects. Keep the statuses out of
		// the assertions so the pin holds under either fix strategy.
		void m1;
		void m2;

		expect(inlineDataLabel(contentOf(ed.project(), 'b')), 'project() after mutation').toBe(
			ORIG_LABEL
		);
		expect(linkHref(contentOf(ed.project(), 'b')), 'project() marks').toBe(ORIGIN);
		expect(inlineDataLabel(ed.contentItems('b')), 'contentItems()').toBe(ORIG_LABEL);
		expect(linkHref(ed.contentItems('b')), 'contentItems() marks').toBe(ORIGIN);
		expect(inlineDataLabel(ed.block('b').items), 'block.items').toBe(ORIG_LABEL);
		expect(linkHref(ed.block('b').items), 'block.items marks').toBe(ORIGIN);
		expect(inlineDataLabel(ed.runs('b')), 'runs()').toBe(ORIG_LABEL);
		expect(linkHref(ed.runs('b')), 'runs() marks').toBe(ORIGIN);
		expect(inlineDataLabel(ed.contentJSON('b')), 'contentJSON()').toBe(ORIG_LABEL);

		// The mutation emits no update (silent) but must not alter the encoded
		// state either — today the wire bytes CHANGE underneath the peer set.
		expect(updates, 'mutation must not emit an update').toBe(0);
		expect(
			Buffer.from(Y.encodeStateAsUpdate(doc)).equals(bytesBefore),
			'encodeStateAsUpdate bytes changed after mutating a snapshot'
		).toBe(true);
	});

	test('mutated snapshot does not leak into replicas or later recomputed runs', () => {
		const { doc, ed } = seed();
		const peer = new Y.Doc();
		peer.clientID = cid++;
		const ped = E.create(peer);
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc)); // synced BEFORE mutation

		ed.runs('b'); // prime cache
		const proj = ed.project();
		tryMutate(() => {
			contentOf(proj, 'b').find((i) => i.kind === 'inline').data.label = 'MUTATED';
		});
		tryMutate(() => {
			contentOf(proj, 'b').find((i) => i.kind === 'text' && i.marks?.link).marks.link.href = EVIL;
		});

		// Peer A (synced before the mutation): must still read the original —
		// passes today (no update carried the mutation) but the companion
		// assertions on the LOCAL side fail.
		expect(inlineDataLabel(contentOf(ped.project(), 'b'))).toBe(ORIG_LABEL);

		// Peer B (synced after, full state): the corrupted bytes must not leave
		// this doc — today they do.
		const peer2 = new Y.Doc();
		peer2.clientID = cid++;
		Y.applyUpdate(peer2, Y.encodeStateAsUpdate(doc));
		const ped2 = E.create(peer2);
		expect(
			inlineDataLabel(contentOf(ped2.project(), 'b')),
			'peer synced AFTER mutation inherited corrupted data'
		).toBe(ORIG_LABEL);
		expect(
			linkHref(contentOf(ped2.project(), 'b')),
			'peer synced AFTER mutation inherited corrupted marks'
		).toBe(ORIGIN);

		// An unrelated edit forces a runs() recompute — the checkpoint index
		// seeds the (now-mutated) live formats objects.
		ed.insertText('b', 0, 'x');
		expect(inlineDataLabel(ed.runs('b')), 'runs() after recompute').toBe(ORIG_LABEL);
		expect(linkHref(ed.runs('b')), 'runs() marks after recompute').toBe(ORIGIN);
	});

	test('contentItems() / block.items payloads are equally isolated', () => {
		const { ed } = seed();
		// Mutate through each surface in turn on separate seeds — every one is
		// a live alias today.
		for (const grab of [
			(e: typeof ed) => e.contentItems('b'),
			(e: typeof ed) => e.block('b').items
		]) {
			const s = seed();
			const items = grab(s.ed);
			tryMutate(() => {
				items.find((i: any) => i.kind === 'inline').data.label = 'MUTATED';
			});
			expect(
				inlineDataLabel(contentOf(s.ed.project(), 'b')),
				'snapshot mutation via a content surface reached live state'
			).toBe(ORIG_LABEL);
		}
	});

	test('repeated reads stay stable and share canonical payloads', () => {
		const { ed } = seed();
		const first = ed.contentItems('b');
		// Mutating the FIRST snapshot (when unfrozen) must not poison the second.
		tryMutate(() => {
			(first.find((i: any) => i.kind === 'inline') as any).data.label = 'MUTATED';
		});
		const second = ed.contentItems('b');
		expect(inlineDataLabel(second)).toBe(ORIG_LABEL);
		expect(linkHref(second)).toBe(ORIGIN);
		// Canonical interning: equal payloads are the SAME frozen instance
		// across surfaces and across reads (structural sharing, not copies).
		expect(second.find((i: any) => i.kind === 'inline').data).toBe(
			ed.runs('b').find((i: any) => i.kind === 'inline')?.data
		);
		expect(linkHrefObj(second)).toBe(linkHrefObj(ed.runs('b')));
		// Item wrappers/arrays are fresh per read — splice/sort stays legal.
		expect(() => second.splice(0, 1)).not.toThrow();
	});

	test('proxy-backed caller payloads are sanitized on write, frozen on read', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		// A caller may hand a reactive proxy as marks/data — the write
		// boundary clones it, so later reads neither alias the proxy nor
		// publish a mutable view of the stored value.
		const marksProxy = new Proxy({ link: { href: ORIGIN } }, {});
		const dataProxy = new Proxy({ label: ORIG_LABEL, nested: { x: 1 } }, {});
		ed.init({ content: [{ id: 'b', type: 'paragraph', content: [] }] });
		ed.insertText('b', 0, 'hi', marksProxy);
		ed.insertInline('b', 2, { id: 'm1', type: 'mention', data: dataProxy });
		const items = ed.contentItems('b');
		expect(linkHref(items)).toBe(ORIGIN);
		expect(items.find((i: any) => i.kind === 'inline').data.nested.x).toBe(1);
		// The stored value is NOT the caller's proxy — mutating the proxy's
		// target post-write must not reach the document.
		(marksProxy as any).link.href = EVIL;
		(dataProxy as any).label = 'MUTATED';
		expect(linkHref(ed.contentItems('b'))).toBe(ORIGIN);
		expect(inlineDataLabel(ed.contentItems('b'))).toBe(ORIG_LABEL);
	});
});

const linkHrefObj = (items: any[]) =>
	items.find((i: any) => isText(i) && i.marks?.link)?.marks?.link;
