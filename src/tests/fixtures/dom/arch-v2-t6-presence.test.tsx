/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint T6 rows, dom lane: presence is one encoding per view
 * key (R1, R4; plan §2.4 "Presence payload", §4.2 `sync/presence`, L59).
 *
 * - F-T10 — a view destroyed along a path that skips selection teardown:
 *   its presence entry is removed by its own teardown, at once, with no
 *   sibling activity; the sibling's entry is left as it was.
 * - R1 — a presence entry is written only by the view that minted its key:
 *   a sibling's publish never removes or rewrites another view's entry
 *   (no sweep of "dead" entries by whoever publishes next).
 * - Pins: a live view's DOM remount keeps its entry without a broadcast;
 *   a destroyed view never publishes; one wire shape per value kind;
 *   one caret per remote client (its freshest valid entry).
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';

import { createDocument, type EdytorDocument } from '$lib/crdt/index.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { noSelection } from '$lib/session/selection.js';
import type { JSONDoc } from '$lib/utils/json.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

/** Red on the reference (expected-fail in the tests-first commit); green since T6. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

const input = (
	<root>
		<paragraph>Hello world</paragraph>
	</root>
);

type Entries = Record<string, Record<string, unknown>>;

const entries = (document: EdytorDocument): Entries =>
	(document.awareness.getLocalState()?.selections ?? {}) as Entries;

/** A model caret in the first paragraph — `select()` publishes it. */
const caret = (edytor: Edytor, offset: number) =>
	edytor.selection.setCollapsedStateAtTextOffset(edytor.root!.children[0]!.firstText!, offset);

/** Two mounted views of one document, each with a published caret; returns their keys. */
const siblings = async () => {
	const document = createDocument({ value: structuredClone(input.value) as JSONDoc });
	const v1 = await renderDomEdytor(input, { document, autoSelectFixture: false });
	const v2 = await renderDomEdytor(input, { document, autoSelectFixture: false });
	caret(v1.edytor, 2);
	const [k1] = Object.keys(entries(document));
	caret(v2.edytor, 7);
	const k2 = Object.keys(entries(document)).find((key) => key !== k1)!;
	expect(k1).toBeTypeOf('string');
	expect(k2).toBeTypeOf('string');
	return { document, v1, v2, k1, k2 };
};

describe('T6 — one presence entry per view key, written by its view', () => {
	row(
		'F-T10: a view destroyed along a path that skips selection teardown removes its own entry',
		async () => {
			const { document, v1, v2, k2 } = await siblings();
			const siblingEntry = structuredClone(entries(document)[k2]);
			// The path under test: the selection layer's teardown never runs.
			v1.edytor.selection.destroy = () => {};
			const writes = vi.spyOn(document.awareness, 'setLocalState');

			v1.unmount();
			await flushDomUpdates();

			expect(v1.edytor.destroyed).toBe(true);
			// Gone at once — no sibling publish is needed to notice the death.
			expect(Object.keys(entries(document))).toEqual([k2]);
			expect(entries(document)[k2]).toEqual(siblingEntry);
			expect(writes).toHaveBeenCalledTimes(1);

			v2.unmount();
			await flushDomUpdates();
			expect(document.awareness.getLocalState()?.selections).toBeUndefined();
			document.destroy();
		}
	);

	row("R1: a sibling's publish never touches another view's entry", async () => {
		const { document, v1, v2, k1 } = await siblings();
		const firstEntry = structuredClone(entries(document)[k1]);
		// v1 is marked dead but its own teardown has not run: its entry is
		// still its own to clear — nobody else removes it.
		v1.edytor.destroyed = true;

		caret(v2.edytor, 9);

		expect(entries(document)[k1]).toEqual(firstEntry);

		v1.edytor.destroyed = false;
		v1.unmount();
		v2.unmount();
		await flushDomUpdates();
		expect(document.awareness.getLocalState()?.selections).toBeUndefined();
		document.destroy();
	});

	pin('a live view remounting its DOM keeps its entry without a broadcast', async () => {
		const { document, v1, v2 } = await siblings();
		const before = structuredClone(entries(document));
		const writes = vi.spyOn(document.awareness, 'setLocalState');

		v1.edytor.refreshEditorDom();
		await tick();
		await flushDomUpdates();

		expect(entries(document)).toEqual(before);
		expect(writes).not.toHaveBeenCalled();

		v1.unmount();
		v2.unmount();
		document.destroy();
	});

	pin('a destroyed view never publishes', async () => {
		const { document, v1, v2, k1, k2 } = await siblings();
		const value = v1.edytor.selection.value;
		v1.unmount();
		await flushDomUpdates();
		expect(Object.keys(entries(document))).toEqual([k2]);

		v1.edytor.selection.select(noSelection);
		v1.edytor.selection.select(value);

		expect(Object.keys(entries(document))).toEqual([k2]);
		expect(entries(document)[k1]).toBeUndefined();

		v2.unmount();
		document.destroy();
	});

	pin('one wire shape per value kind; a cleared value removes only its key', async () => {
		const { document, v1, v2, k1, k2 } = await siblings();
		expect(Object.keys(entries(document)[k1]).sort()).toEqual([
			'collapsed',
			'end',
			'reversed',
			'start',
			't'
		]);
		const block = v1.edytor.root!.children[0]!;
		v1.edytor.selection.selectBlocks(block);
		expect(entries(document)[k1]).toEqual({ blocks: [block.id], t: expect.any(Number) });

		v1.edytor.selection.select(noSelection);
		expect(Object.keys(entries(document))).toEqual([k2]);
		// No other presence field is written beside `selections`.
		expect(document.awareness.getLocalState()?.selection).toBeUndefined();

		v1.unmount();
		v2.unmount();
		document.destroy();
	});

	pin('a peer renders one caret per client: its freshest valid entry', async () => {
		const { container, edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		caret(edytor, 1);
		const [early] = Object.values(entries(edytor.document));
		caret(edytor, 4);
		const [late] = Object.values(entries(edytor.document));
		const remoteClientId = 4343;
		edytor.awareness.states.set(remoteClientId, {
			user: { name: 'Ada', color: '#dc2626' },
			selections: {
				a: { ...early, t: 1 },
				b: { ...late, t: 2 },
				junk: { t: 99 }
			}
		});
		edytor.awareness.emit('change', [
			{ added: [remoteClientId], updated: [], removed: [] },
			'test'
		]);
		// Remote carets are overlay chrome, positioned in the next frame (R5).
		await new Promise((resolve) => requestAnimationFrame(resolve));
		await flushDomUpdates();

		const cursors = container.querySelectorAll(
			`[data-edytor-remote-cursor][data-client-id="${remoteClientId}"]`
		);
		expect(cursors).toHaveLength(1);
	});
});
