/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint V2 rows, dom lane: the selection is a value with one
 * commit point (R9, L4, L10, L12, §4.3 `session/selection`, D-16).
 *
 * - F-S2 — a peer deletes the caret's block while focus is on an outside
 *   button: the model lands at the seam, `onSelectionChange` fires exactly
 *   once, presence and the focused set follow, outside focus is kept.
 * - F-S3 — `selectBlocks(b)` after a caret emits once and presence publishes
 *   the block set.
 * - F-S7 — a peer deletes the only selected block: the selection repairs to
 *   the seam caret, and Delete then acts on live content.
 * - F-S8 — a blurred caret at the end of `hello world`; a peer inserts an
 *   atom at 3: the model caret sits at display offset 12 immediately.
 * - F-P18 (session half) — inline suggestions are session state: an `end`
 *   suggestion of the view's suggestion layer (`edytor.suggestions`), kept
 *   by selection writes that leave their block (the 2026-10-02 suggestion
 *   contract: a suggestion lives until accepted, discarded or its block
 *   dies), accepted on Tab and cleared on Escape in a code line, kept
 *   through a composition at their boundary, never resurrected once
 *   dismissed.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, it } from 'vitest';

import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONDoc } from '$lib/utils/json.js';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since V2. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

/** A remote peer on a replica of the mounted document; `push` delivers its writes as a remote apply. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	const deliver = () =>
		Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
	return {
		facade: remote.facade,
		deliver,
		push: async () => {
			deliver();
			await flushDomUpdates();
		}
	};
};

/** This view's published presence entries (D-16: only `selections`, no legacy mirror). */
const presence = (edytor: Edytor) =>
	Object.values(
		(edytor.awareness.getLocalState()?.selections ?? {}) as Record<string, Record<string, unknown>>
	);

const outsideButton = () => {
	const button = document.createElement('button');
	button.textContent = 'outside';
	document.body.append(button);
	return button;
};

const counter = () => {
	const calls: unknown[] = [];
	return { calls, onSelectionChange: (selection: unknown) => calls.push(selection) };
};

describe('V2 — one commit point', () => {
	row(
		'F-S2: a peer deletes the caret block under outside focus: one emit, presence, focus kept',
		async () => {
			const { calls, onSelectionChange } = counter();
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>First</paragraph>
					<paragraph>Second</paragraph>
				</root>,
				{ autoSelectFixture: false, onSelectionChange, presence: { throttle: 0 } }
			);
			const [first, second] = edytor.root!.children;
			await setNativeSelection(edytor, second!.firstText!, 3);
			const button = outsideButton();
			button.focus();
			await flushDomUpdates();
			const before = calls.length;

			const remote = peer(edytor);
			remote.facade.deleteBlock(second!.id);
			await remote.push();

			const state = edytor.selection.state;
			expect(state.startText?.parent).toBe(first);
			expect(state.yStart).toBe('First'.length);
			expect(state.isCollapsed).toBe(true);
			expect(calls.length - before).toBe(1);
			expect([...edytor.selection.focusedBlocks]).toEqual([first]);
			const [entry] = presence(edytor);
			const published = edytor.selection.resolveTextAnchor(entry!.start as never);
			expect(published?.text.parent).toBe(first);
			expect(published?.offset).toBe('First'.length);
			expect(document.activeElement).toBe(button);
			button.remove();
		}
	);

	row('F-S3: selectBlocks after a caret emits once and publishes the block set', async () => {
		const { calls, onSelectionChange } = counter();
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>aa</paragraph>
				<paragraph>bb</paragraph>
			</root>,
			{ autoSelectFixture: false, onSelectionChange, presence: { throttle: 0 } }
		);
		const [aa, bb] = edytor.root!.children;
		await setNativeSelection(edytor, aa!.firstText!, 1);
		const before = calls.length;

		edytor.selection.selectBlocks(bb!);

		expect(calls.length - before).toBe(1);
		const [entry] = presence(edytor);
		expect(entry?.blocks).toEqual([bb!.id]);
	});

	row(
		'F-S7: a peer deletes the selected block: the selection repairs, Delete acts on live content',
		async () => {
			const { calls, onSelectionChange } = counter();
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>aa</paragraph>
					<paragraph>bb</paragraph>
					<paragraph>cc</paragraph>
				</root>,
				{ autoSelectFixture: false, onSelectionChange, presence: { throttle: 0 } }
			);
			const [, bb, cc] = edytor.root!.children;
			await setNativeSelection(edytor, bb!.firstText!, 1);
			edytor.selection.selectBlocks(bb!);
			await flushDomUpdates();
			const before = calls.length;

			const remote = peer(edytor);
			remote.facade.deleteBlock(bb!.id);
			await remote.push();

			expect(edytor.selection.selectedBlocks.size).toBe(0);
			const state = edytor.selection.state;
			expect(state.startText?.parent).toBe(cc);
			expect(state.yStart).toBe(0);
			expect(state.isCollapsed).toBe(true);
			expect(calls.length - before).toBe(1);

			await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
			expect(edytor.value.children?.map((block) => block.content?.[0])).toEqual([
				{ text: 'aa' },
				{ text: 'c' }
			]);
		}
	);

	row('F-S8: a blurred caret follows a remote atom insert immediately', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const block = edytor.root!.children[0]!;
		await setNativeSelection(edytor, block.firstText!, 11);
		const button = outsideButton();
		button.focus();
		await flushDomUpdates();

		const remote = peer(edytor);
		remote.facade.insertInline(block.id, 3, { id: 'm1', type: 'mention', data: {} });
		remote.deliver();

		const { startText, yStart } = edytor.selection.state;
		expect(startText!.segStart + yStart).toBe(12);
		await flushDomUpdates();
		expect(edytor.value.children?.[0]?.content).toEqual([
			{ text: 'hel' },
			{ type: 'mention', id: 'm1', data: {} },
			{ text: 'lo world' }
		]);
		button.remove();
	});
});

/** The DST seed-7 shape: one text of three marked runs, `l words`. */
const markedRuns = {
	children: [
		{
			type: 'paragraph',
			content: [
				{ text: 'l', marks: { code: true } },
				{ text: ' ' },
				{ text: 'words', marks: { highlight: 'yellow' } }
			]
		}
	]
};

describe('V2 fix — typing over a reversed range leaves the caret after the insertion', () => {
	// DST seed 7 (multiline-rich-blocks) step 3: Firefox commits `insertText`
	// through a composition. With the range collapsed by its replacement,
	// the compatibility `relativePosition` must stay the start endpoint's
	// anchor (it was the end's), or the composition region starts after the
	// inserted text and the caret lands one character late.
	for (const via of ['composition', 'beforeinput'] as const) {
		it(`${via}: reversed range over marked runs → caret after \`é\``, async () => {
			const { edytor, editor } = await renderDomEdytor(<root></root>, {
				value: structuredClone(markedRuns) as JSONDoc,
				autoSelectFixture: false
			});
			const text = edytor.root!.children[0]!.firstText!;
			await setNativeSelection(edytor, text, 0, text, 3, { reversed: true });
			expect(edytor.selection.state).toMatchObject({ yStart: 0, yEnd: 3, isReversed: true });
			if (via === 'composition')
				await dispatchComposition(editor, [
					{ type: 'compositionstart' },
					{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
					{ type: 'compositionend', data: 'é' }
				]);
			else await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'é' });
			await flushDomUpdates();
			expect(edytor.value.children?.[0]?.content).toEqual([
				{ text: 'é' },
				{ text: 'ords', marks: { highlight: 'yellow' } }
			]);
			const state = edytor.selection.state;
			expect([state.startText!.segStart + state.yStart, state.isCollapsed]).toEqual([1, true]);
		});
	}
});

const codeValue = {
	children: [
		{ type: 'code', children: [{ type: 'codeLine', content: [{ text: 'const a = 1;' }] }] },
		{ type: 'paragraph', content: [{ text: 'tail' }] }
	]
};
const codePlugins = [richTextPlugin, mentionPlugin, codePlugin];

describe('V2 — suggestions are session state (F-P18, session half)', () => {
	row('a suggestion is session state: an `end` suggestion of the view', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		block.suggestions = [[{ text: 'maybe' }]];
		expect(edytor.suggestions.list.map((s) => [s.at, s.content])).toEqual([
			[{ end: block.id }, [{ type: 'paragraph', content: [{ text: 'maybe' }] }]]
		]);
	});

	row('a model selection write that leaves the block keeps its suggestion', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		);
		const [hello, world] = edytor.root!.children;
		hello!.suggestions = [[{ text: ' there' }]];
		edytor.selection.setAtTextOffset(world!.firstText!, 2);
		expect(hello!.suggestions).toEqual([[{ text: ' there' }]]);
	});

	pin('a native caret move that leaves the block keeps its suggestion', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		);
		const [hello, world] = edytor.root!.children;
		hello!.suggestions = [[{ text: ' there' }]];
		await flushDomUpdates();
		await setNativeSelection(edytor, world!.firstText!, 2);
		expect(hello!.suggestions).toEqual([[{ text: ' there' }]]);
	});

	pin('a suggestion on a block the caret never entered survives unrelated moves', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		);
		const [hello, world] = edytor.root!.children;
		world!.suggestions = [[{ text: '!' }]];
		await setNativeSelection(edytor, hello!.firstText!, 2);
		expect(world!.suggestions).not.toBeNull();
	});

	pin('Tab accepts and Escape clears in a code line', async () => {
		const { edytor } = await renderDomEdytor(<root></root>, {
			value: structuredClone(codeValue),
			plugins: codePlugins,
			autoSelectFixture: false
		});
		const line = edytor.root!.children[0]!.children[0]!;
		await setNativeSelection(edytor, line.firstText!, 'const a = 1;'.length);
		line.suggestions = [[{ text: ' // one' }]];
		await dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' });
		expect(line.suggestions).toBeNull();
		expect(line.firstText!.stringContent).toBe('const a = 1; // one');

		line.suggestions = [[{ text: ' // two' }]];
		await dispatchDomKeyDown(document, { key: 'Escape', code: 'Escape' });
		expect(line.suggestions).toBeNull();
		expect(line.firstText!.stringContent).toBe('const a = 1; // one');
	});

	pin('a composition at the suggestion boundary keeps the suggestion', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		block.suggestions = [[{ text: ' world' }]];
		await flushDomUpdates();
		await dispatchComposition(editor, [
			{ type: 'compositionstart' },
			{ type: 'compositionupdate', data: 'x' },
			{ type: 'compositionend', data: 'x' }
		]);
		expect(block.suggestions).not.toBeNull();
	});

	pin('a dismissed suggestion is not resurrected by a later selection write', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		block.suggestions = [[{ text: 'maybe' }]];
		await flushDomUpdates();
		block.suggestions = null;
		await setNativeSelection(edytor, block.firstText!, 1);
		await flushDomUpdates();
		expect(block.suggestions).toBeNull();
		expect(editor.querySelector('[data-edytor-text-suggestion]')).toBeNull();
	});
});
