/**
 * Elegance-review regression pins for awareness presence — see
 * docs/elegance-review-2026-09-23.md:
 *
 *  - D17: publish and consume used two different "freshest selection by
 *    `t`" contests. `freshestPublishedSelection` picked the raw max-`t`
 *    entry (no validation) and wrote it as the legacy `selection`
 *    mirror, while `remoteSelection.getSelection` picked the freshest
 *    entry among VALIDATED candidates — a malformed entry with a high
 *    `t` was mirrored but never rendered. Both sides now share the one
 *    validated-winner helper.
 *  - S12: presence dedupe compared `JSON.stringify` snapshots per
 *    publish/clear; the structural `jsonValuesEqual` compare must agree
 *    with stringify semantics on the cases that matter (key order is
 *    not a difference, `undefined`-valued keys are invisible).
 */
import { describe, expect, it, vi } from 'vitest';
import { createDocument, type EdytorDocument } from '../../lib/crdt/index.js';
import {
	freshestPublishedSelection,
	jsonValuesEqual,
	normalizeAwarenessSelection,
	publishAwarenessSelection,
	clearAwarenessSelection
} from '../../lib/collaboration/awarenessSelection.js';
import { Edytor } from '../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '../../lib/utils/json.js';

const docValue = (text = 'shared'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

const makeView = (document: EdytorDocument) => new Edytor({ document, plugins: [richTextPlugin] });

const publishSelection = (view: Edytor, offset = 0) => {
	view.selection.setCollapsedStateAtTextOffset(view.root!.children[0]!.firstText!, offset);
	publishAwarenessSelection(view.selection);
};

const selectionPayload = (yStart: number, t: number) => ({
	start: null,
	end: null,
	startTextId: 't1',
	endTextId: 't1',
	yStart,
	yEnd: yStart,
	isCollapsed: true,
	isReversed: false,
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
		expect(winner?.yStart).toBe(2);
		expect(winner).not.toHaveProperty('t');
	});

	it('picks the freshest among valid entries — first valid seeds, strictly-greater `t` wins', () => {
		expect(
			freshestPublishedSelection({
				a: selectionPayload(1, 5),
				b: selectionPayload(2, 9),
				c: selectionPayload(3, 4)
			})?.yStart
		).toBe(2);
		// Missing `t` counts as 0 — a valid entry still wins over nothing.
		expect(
			freshestPublishedSelection({ only: { ...selectionPayload(7, 0), t: undefined } })?.yStart
		).toBe(7);
		expect(freshestPublishedSelection({ bad: { t: 3 } })).toBeNull();
		expect(freshestPublishedSelection({})).toBeNull();
	});

	it('the published legacy mirror is the same winner a remote peer renders', () => {
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

		// The next publish recomputes the mirror through the shared
		// winner — it must stay the valid entry, not the malformed one.
		publishSelection(v1, 4);
		const mirror = document.awareness.getLocalState()?.selection as
			| { yStart?: number; startTextId?: string }
			| undefined;
		expect(mirror?.yStart).toBe(4);
		expect(mirror?.startTextId).toBe(v1.root!.children[0]!.firstText!.id);

		v1.destroy();
		document.destroy();
	});

	it('a swept selections map still rebroadcasts when the mirror winner changes', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);
		publishSelection(v1, 1);
		publishSelection(v2, 5); // v2 is freshest

		v2.destroyed = true; // died without running selection.destroy()

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		clearAwarenessSelection(document.awareness);
		expect(spy).toHaveBeenCalledTimes(1);
		// The mirror falls back to the surviving valid entry.
		expect((document.awareness.getLocalState()?.selection as { yStart?: number })?.yStart).toBe(1);

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
			isCollapsed: true,
			isReversed: 1
		});
		expect(normalized).toEqual({
			start: null,
			end: null,
			startTextId: '',
			endTextId: '',
			yStart: 0,
			yEnd: 0,
			isCollapsed: true,
			isReversed: false
		});
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
