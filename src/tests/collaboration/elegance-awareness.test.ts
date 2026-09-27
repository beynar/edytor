/**
 * Elegance-review regression pins for awareness presence — see
 * docs/elegance-review-2026-09-23.md:
 *
 *  - D17: publish and consume used two different "freshest selection by
 *    `t`" contests; a malformed entry with a high `t` was mirrored but
 *    never rendered. The legacy mirror is gone (D-16); the one
 *    validated-winner helper is what a peer renders.
 *  - S12: presence dedupe compared `JSON.stringify` snapshots per
 *    publish; the structural `jsonValuesEqual` compare must agree
 *    with stringify semantics on the cases that matter (key order is
 *    not a difference, `undefined`-valued keys are invisible).
 */
import { describe, expect, it, vi } from 'vitest';
import { createDocument, type EdytorDocument } from '../../lib/crdt/index.js';
import {
	freshestPublishedSelection,
	jsonValuesEqual,
	normalizeAwarenessSelection,
	publishPresence
} from '../../lib/collaboration/awarenessSelection.js';
import { Edytor } from '../../lib/edytor.svelte.js';
import { serialize } from '../../lib/session/selection.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '../../lib/utils/json.js';

const docValue = (text = 'shared'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

const makeView = (document: EdytorDocument) => new Edytor({ document, plugins: [richTextPlugin] });

/** Write the view's caret (which publishes) and run the one write once more with the same payload. */
const publishSelection = (view: Edytor, offset = 0) => {
	view.selection.setCollapsedStateAtTextOffset(view.root!.children[0]!.firstText!, offset);
	publishPresence(
		view.awareness,
		view.presenceKey,
		serialize(view.selection.value, view.selection.projection)
	);
};

/** The caret offset a peer renders for this document's freshest published entry. */
const renderedOffset = (view: Edytor, document: EdytorDocument) => {
	const winner = freshestPublishedSelection(
		(document.awareness.getLocalState()?.selections ?? {}) as Record<string, unknown>
	);
	return winner ? view.selection.resolveTextAnchor(winner.start as never)?.offset : undefined;
};

const selectionPayload = (marker: number, t: number) => ({
	start: marker,
	end: marker,
	collapsed: true,
	reversed: false,
	t
});

describe('D17 — one validated freshest-selection winner', () => {
	it('a malformed entry cannot win the mirror by carrying the highest `t`', () => {
		// The pre-D17 publish contest compared raw `t` — this malformed
		// entry (no endpoints) would have been mirrored into `selection`
		// while the remote consume side skipped it entirely.
		const selections = {
			good: selectionPayload(2, 1),
			malformed: { t: 9999 },
			alsoBad: { start: null, t: 8888 } // `end` missing → invalid
		};
		const winner = freshestPublishedSelection(selections);
		expect(winner?.start).toBe(2);
		expect(winner).not.toHaveProperty('t');
	});

	it('picks the freshest among valid entries — first valid seeds, strictly-greater `t` wins', () => {
		expect(
			freshestPublishedSelection({
				a: selectionPayload(1, 5),
				b: selectionPayload(2, 9),
				c: selectionPayload(3, 4)
			})?.start
		).toBe(2);
		// Missing `t` counts as 0 — a valid entry still wins over nothing.
		expect(
			freshestPublishedSelection({ only: { ...selectionPayload(7, 0), t: undefined } })?.start
		).toBe(7);
		expect(freshestPublishedSelection({ bad: { t: 3 } })).toBeNull();
		expect(freshestPublishedSelection({})).toBeNull();
	});

	it('a malformed foreign entry never wins the rendered caret', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		publishSelection(v1, 3);

		// A foreign/malformed entry lands in the shared map with a huge
		// sequence — e.g. written by a peer implementation that does not
		// stamp our payload shape.
		const localState = document.awareness.getLocalState()!;
		document.awareness.setLocalState({
			...localState,
			selections: {
				...(localState.selections as Record<string, unknown>),
				foreign: { t: 99999, note: 'not a selection' }
			}
		});

		// The rendered winner stays the valid entry, not the malformed one.
		publishSelection(v1, 4);
		expect(document.awareness.getLocalState()?.selection).toBeUndefined(); // D-16
		expect(renderedOffset(v1, document)).toBe(4);

		v1.destroy();
		document.destroy();
	});

	it("a view's teardown rebroadcasts once and the surviving entry wins", () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);
		publishSelection(v1, 1);
		publishSelection(v2, 5); // v2 is freshest

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		v2.destroy(); // clears its own key
		expect(spy).toHaveBeenCalledTimes(1);
		// The surviving valid entry is the rendered winner.
		expect(renderedOffset(v1, document)).toBe(1);

		v1.destroy();
		document.destroy();
	});
});

describe('normalizeAwarenessSelection — the shared validity gate', () => {
	it('rejects payloads without endpoints and coerces the rest', () => {
		expect(normalizeAwarenessSelection(null)).toBeNull();
		expect(normalizeAwarenessSelection({})).toBeNull();
		expect(normalizeAwarenessSelection({ start: null })).toBeNull(); // end missing
		expect(normalizeAwarenessSelection({ end: null })).toBeNull(); // start missing

		const normalized = normalizeAwarenessSelection({
			start: null,
			end: null,
			yStart: 'nope',
			collapsed: true,
			reversed: 1
		});
		expect(normalized).toEqual({ start: null, end: null, collapsed: true, reversed: false });
	});
});

describe('S12 — jsonValuesEqual matches stringify semantics where they matter', () => {
	it('treats key order and undefined-valued keys as no difference', () => {
		expect(jsonValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(jsonValuesEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
		expect(jsonValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(jsonValuesEqual({ a: null }, {})).toBe(false); // null is a real JSON value
	});

	it('compares nested structures and arrays deeply', () => {
		expect(
			jsonValuesEqual(
				{ b: 'blk', a: { i: { c: 3, k: 7 }, a: -1 } },
				{ a: { a: -1, i: { k: 7, c: 3 } }, b: 'blk' }
			)
		).toBe(true);
		expect(jsonValuesEqual([1, [2, { x: 'y' }]], [1, [2, { x: 'y' }]])).toBe(true);
		expect(jsonValuesEqual([1, 2], [2, 1])).toBe(false);
		expect(jsonValuesEqual({ a: { i: null } }, { a: {} })).toBe(false);
	});

	it('publish dedupe still holds — identical republish does not broadcast', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		publishSelection(v1, 3);

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		publishSelection(v1, 3); // identical caret
		expect(spy).not.toHaveBeenCalled();

		publishSelection(v1, 4); // real change still broadcasts
		expect(spy).toHaveBeenCalledTimes(1);

		v1.destroy();
		document.destroy();
	});
});
