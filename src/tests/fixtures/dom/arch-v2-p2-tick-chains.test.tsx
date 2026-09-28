/** @jsxImportSource ../../jsx */
/**
 * arch-v2 phase 2, checkpoint P2.3 — no select-after-tick chains.
 *
 * `select()` is the synchronous commit point (V2) and the projector writes
 * the current value after the flush (V4), so an adapter that edits the model
 * selects the resulting caret in the same turn: it never waits for a render
 * before selecting, never waits for one after, and never re-asserts the caret
 * a tick later. One row per site this jsdom lane can reach; the rest are
 * pinned by the browser specs named in the ledger. A `test.fails` row is a
 * site not removed yet: it must be red, and turns into `test` with its site.
 *
 * Expected values come from the fixture text, never from running the code.
 */
import { describe, expect, test } from 'vitest';
import { renderDomEdytor, flushDomUpdates, canonicalTree } from '../../dom/test.utils.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { handleNativeLineBreakTextValue } from '$lib/events/onInput.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { Edytor } from '$lib/edytor.svelte.js';

const beforeInput = (target: HTMLElement, inputType: string, data: string | null = null) => {
	const event = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
	Object.defineProperties(event, {
		inputType: { value: inputType, configurable: true },
		data: { value: data, configurable: true },
		dataTransfer: { value: null, configurable: true }
	});
	target.dispatchEvent(event);
};

const command = (edytor: Edytor, inputType: string, data: string | null = null) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, { inputType, data, dataTransfer: null, cancelable: true })
	);

const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return { text: startText?.stringContent, offset: yStart, isCollapsed };
};

const one = (text: string) =>
	renderDomEdytor(
		<root>
			<paragraph>{text}</paragraph>
		</root>,
		{ autoSelectFixture: false }
	);

describe('P2.3 — the caret is selected in the turn of the edit', () => {
	test('onBeforeInput: Backspace over a trailing soft break', async () => {
		const { edytor, editor } = await one('ab\n');
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.setAtTextOffset(text, 3);
		await flushDomUpdates();
		beforeInput(editor, 'deleteContentBackward');
		expect(caret(edytor)).toEqual({ text: 'ab', offset: 2, isCollapsed: true });
	});

	test('beforeInputDeleteCommands: a character Backspace', async () => {
		const { edytor } = await one('hello');
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 3);
		const result = command(edytor, 'deleteContentBackward');
		expect(result).not.toBeInstanceOf(Promise);
		expect(caret(edytor)).toEqual({ text: 'helo', offset: 2, isCollapsed: true });
	});

	test('beforeInputDeleteCommands: a character Delete', async () => {
		const { edytor } = await one('hello');
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 3);
		const result = command(edytor, 'deleteContentForward');
		expect(result).not.toBeInstanceOf(Promise);
		expect(caret(edytor)).toEqual({ text: 'helo', offset: 3, isCollapsed: true });
	});

	test('beforeInputCommands: typing finishes in the turn it selects', async () => {
		const { edytor } = await one('hello');
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 5);
		const result = command(edytor, 'insertText', 'x');
		expect(result).not.toBeInstanceOf(Promise);
		expect(caret(edytor)).toEqual({ text: 'hellox', offset: 6, isCollapsed: true });
	});

	test('beforeInputCommands: the auto-dot finishes in the turn it selects', async () => {
		const { edytor } = await one('end ');
		edytor.selection.setAtTextOffset(edytor.root!.children[0]!.firstText!, 4);
		const result = command(edytor, 'insertText', '. ');
		expect(result).not.toBeInstanceOf(Promise);
		expect(caret(edytor).offset).toBe(5);
	});

	test('onBeforeInput: a model-owned command is not re-selected after the render', async () => {
		const { edytor, editor } = await one('hello');
		const text = edytor.root!.children[0]!.firstText!;
		edytor.selection.setAtTextOffset(text, 5);
		await flushDomUpdates();
		const writes: number[] = [];
		const select = edytor.selection.select;
		edytor.selection.select = (...args) => {
			writes.push(edytor.selection.epoch);
			return select(...args);
		};
		try {
			beforeInput(editor, 'insertText', 'x');
			const inTurn = writes.length;
			expect(caret(edytor)).toEqual({ text: 'hellox', offset: 6, isCollapsed: true });
			await flushDomUpdates();
			expect(writes.length).toBe(inTurn);
			expect(caret(edytor)).toEqual({ text: 'hellox', offset: 6, isCollapsed: true });
		} finally {
			edytor.selection.select = select;
		}
	});

	test('onInput: a native line break runs its intent in the turn', async () => {
		const { edytor } = await one('hello');
		const text = edytor.root!.children[0]!.firstText!;
		void handleNativeLineBreakTextValue(edytor, text, 'hel\nlo');
		// A `\n` the browser typed is a soft break (its `insertLineBreak` intent).
		expect(canonicalTree(edytor).map((block) => block.content)).toEqual([[{ text: 'hel\nlo' }]]);
		expect(caret(edytor)).toEqual({ text: 'hel\nlo', offset: 4, isCollapsed: true });
	});

	// Red until its site lands (P2.3 is one site per commit).
	test.fails('edytor.clear focuses the editor in the turn', async () => {
		const { edytor } = await one('hello');
		edytor.clear();
		expect(document.activeElement).toBe(edytor.node);
		expect(caret(edytor)).toEqual({ text: '', offset: 0, isCollapsed: true });
	});
});
