/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint S1 rows, dom lane (the headless halves live in
 * `src/tests/crdt/arch-v2/s1-dispatcher.test.ts`): one dispatcher per view
 * (R7, §4.3 `session/commands.ts`, D-10, FP-2, FP-6).
 *
 * - F-O3 — range delete, paste, split, convert and move with a counting
 *   extension: every hook call happens before the transaction, once for the
 *   prepared command and once per planned step (by its documented name); none
 *   happens inside it. Two more rows restore the hook visibility D6/D7 lost:
 *   the block-selection replacement and drop.
 * - F-M1 / F-M2 through the real Backspace (`beforeinput`).
 * - Gap list (D6/D7): a veto on a planned step of the block-selection
 *   replacement, of a paste and of a drop refuses the whole command before
 *   any write.
 * - F-M5 (a) — undo grouping (FP-2): a code-marked `.`, selected, Delete,
 *   `!`, Mod+Z restores `.` with its mark.
 * - F-P19 (hook half) — the documented hook surfaces keep their README
 *   behavior: `onBeforeInput` claiming an occurrence (with and without a
 *   replacement), `onDeleteSelectedBlocks`, `onCut`/`onPaste`, plugin
 *   `commands` (`isEnabled`, async `run`), `moveBlocks` returning the moved
 *   blocks.
 * - L37 — the hotkey catch-all is gone: an error a hotkey throws surfaces.
 * - Readonly refuses every mutating command through the event paths.
 *
 * Expected values come from the plan rows and the README, never from running
 * the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { createBeforeInputSnapshot } from '$lib/events/beforeInputSnapshot.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	dispatchClipboardPaste,
	dispatchCut,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since S1. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

type Call = { phase: 'before' | 'after' | 'tx'; op?: string; on?: string; inTx?: boolean };

/** The label a hook call is recorded under: the operation and its block's text. */
const labelOf = (block: unknown) =>
	(block as { firstText?: { stringContent: string } } | undefined)?.firstText?.stringContent ?? '';

/** An extension that records every hook call, and whether a transaction is open. */
const counting =
	(calls: Call[]): Plugin =>
	(editor) => ({
		onBeforeOperation: (change) => {
			calls.push({
				phase: 'before',
				op: change.operation,
				on: labelOf(change.block),
				inTx: editor.doc._transaction !== null
			});
		},
		onAfterOperation: (change) => {
			calls.push({ phase: 'after', op: change.operation, inTx: editor.doc._transaction !== null });
		}
	});

/** A vetoing extension: refuses `operation` on the block showing `text`. */
const vetoing =
	(operation: string, text: string): Plugin =>
	() => ({
		onBeforeOperation: (change) => {
			if (change.operation === operation && labelOf(change.block) === text) change.prevent();
		}
	});

const plugins = (...extra: Plugin[]) => [richTextPlugin, mentionPlugin, ...extra];

const track = (edytor: Edytor, calls: Call[] = []) => {
	let bytes = 0;
	edytor.doc.on('beforeTransaction', () => calls.push({ phase: 'tx' }));
	edytor.doc.on('update', (update: Uint8Array) => (bytes += update.byteLength));
	return { calls, bytes: () => bytes };
};

/**
 * F-O3's invariant: before-calls are exactly `expected` (command + planned
 * steps, as `op:text`), all of them before the first transaction; no hook call
 * inside a transaction.
 */
const expectHooksBeforeWrites = (calls: Call[], expected: string[]) => {
	const before = calls.filter((call) => call.phase === 'before');
	expect(before.map((call) => `${call.op}:${call.on}`).sort()).toEqual([...expected].sort());
	expect(calls.filter((call) => call.phase !== 'tx' && call.inTx)).toEqual([]);
	const firstTx = calls.findIndex((call) => call.phase === 'tx');
	const lastBefore = calls.findLastIndex((call) => call.phase === 'before');
	expect(firstTx, 'a transaction ran').toBeGreaterThan(-1);
	expect(lastBefore).toBeLessThan(firstTx);
};

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	);

const textOf = (edytor: Edytor, index: number) => edytor.root!.children[index]!.firstText!;

const drop = (edytor: Edytor, data: Record<string, string>) =>
	runBeforeInputCommand(
		edytor,
		createBeforeInputSnapshot(
			edytor,
			{
				inputType: 'insertFromDrop',
				data: null,
				dataTransfer: {
					types: Object.keys(data),
					files: [],
					getData: (type: string) => data[type] ?? ''
				},
				cancelable: true,
				getTargetRanges: () => [],
				preventDefault() {}
			} as unknown as InputEvent,
			null
		)
	);

const abc = () => (
	<root>
		<paragraph>aa</paragraph>
		<paragraph>bb</paragraph>
		<paragraph>cc</paragraph>
	</root>
);

const abcd = () => (
	<root>
		<paragraph>aa</paragraph>
		<paragraph>bb</paragraph>
		<paragraph>cc</paragraph>
		<paragraph>dd</paragraph>
	</root>
);

const helloWorld = () => (
	<root>
		<paragraph>HelloWorld</paragraph>
	</root>
);

/**
 * Collect errors that surface: thrown out of a listener (the window `error`
 * event) or reported by an async handler (`reportError` where the platform has
 * it, `console.error` where it does not, as in jsdom).
 */
const surfaced = () => {
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => {
		errors.push(event.error);
		event.preventDefault();
	};
	window.addEventListener('error', onError);
	const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(...args.filter((arg) => arg instanceof Error));
	});
	return {
		errors,
		stop: () => {
			window.removeEventListener('error', onError);
			consoleError.mockRestore();
		}
	};
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('F-O3 — hooks see the prepared command and each planned step before any write', () => {
	row('range delete (Backspace over a@1 → c@1)', async () => {
		const calls: Call[] = [];
		const { edytor, editor } = await renderDomEdytor(abc(), {
			plugins: plugins(counting(calls)),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 1, textOf(edytor, 2), 1);
		calls.length = 0;
		track(edytor, calls);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(texts(edytor)).toEqual(['ac']);
		// The plan (D6) deletes the tail's prefix after the merge, where it then
		// shows: in the head. A step is shown on the block it names.
		expectHooksBeforeWrites(calls, [
			'deleteContentWithinSelection:',
			'deleteContentAtRange:aa',
			'deleteContentAtRange:aa',
			'removeBlock:bb',
			'mergeBlockBackward:cc'
		]);
	});

	row('paste (plain "X\\nY" at Hello|World)', async () => {
		const calls: Call[] = [];
		const { edytor, editor } = await renderDomEdytor(helloWorld(), {
			plugins: plugins(counting(calls)),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 5);
		calls.length = 0;
		track(edytor, calls);
		await dispatchClipboardPaste(editor, { 'text/plain': 'X\nY' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['HelloX', 'YWorld']);
		// Text written into the block the split creates is part of its creation.
		expectHooksBeforeWrites(calls, [
			'insertFlow:',
			'splitBlock:HelloWorld',
			'insertText:HelloWorld'
		]);
	});

	row('split (Enter at ab|cd)', async () => {
		const calls: Call[] = [];
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
			</root>,
			{ plugins: plugins(counting(calls)) }
		);
		calls.length = 0;
		track(edytor, calls);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(texts(edytor)).toEqual(['ab', 'cd']);
		expectHooksBeforeWrites(calls, ['splitBlock:abcd']);
	});

	row('convert (setBlock to a heading)', async () => {
		const calls: Call[] = [];
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>abcd</paragraph>
			</root>,
			{ plugins: plugins(counting(calls)), autoSelectFixture: false }
		);
		calls.length = 0;
		track(edytor, calls);
		edytor.root!.children[0]!.setBlock({ value: { type: 'heading', data: { level: 'h1' } } });
		await flushDomUpdates();
		expect(edytor.value.children?.[0]?.type).toBe('heading');
		expectHooksBeforeWrites(calls, ['setBlock:abcd']);
	});

	row('move (a after c)', async () => {
		const calls: Call[] = [];
		const { edytor } = await renderDomEdytor(abc(), {
			plugins: plugins(counting(calls)),
			autoSelectFixture: false
		});
		calls.length = 0;
		track(edytor, calls);
		const [a, , c] = edytor.root!.children;
		expect(edytor.moveBlocks({ blocks: [a!], target: c!, position: 'after' })).toEqual([a]);
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['bb', 'cc', 'aa']);
		expectHooksBeforeWrites(calls, ['moveBlock:aa']);
	});

	row('block-selection replacement (Backspace over selected b, c) — D6 gap', async () => {
		const calls: Call[] = [];
		const { edytor, editor } = await renderDomEdytor(abc(), {
			plugins: plugins(counting(calls)),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 0);
		edytor.selection.selectBlocks(edytor.root!.children[1]!, edytor.root!.children[2]!);
		await flushDomUpdates();
		calls.length = 0;
		track(edytor, calls);
		await dispatchDomKeyDown(editor, { key: 'Backspace' });
		expect(texts(edytor)).toEqual(['aa']);
		expectHooksBeforeWrites(calls, ['deleteBlocks:', 'removeBlock:bb', 'removeBlock:cc']);
	});

	row('drop (a plain "X" at Hello|World) — D7 gap', async () => {
		const calls: Call[] = [];
		const { edytor } = await renderDomEdytor(helloWorld(), {
			plugins: plugins(counting(calls)),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 5);
		calls.length = 0;
		track(edytor, calls);
		await drop(edytor, { 'text/plain': 'X' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['HelloXWorld']);
		expectHooksBeforeWrites(calls, ['insertFlow:', 'insertText:HelloWorld']);
	});
});

describe('F-M1 / F-M2 through Backspace', () => {
	row('F-M1: an after-hook throws → [a "ad"], one undo step, the error surfaces', async () => {
		const throwing: Plugin = () => ({
			onAfterOperation: () => {
				throw new Error('after-hook failed');
			}
		});
		const { edytor, editor } = await renderDomEdytor(abcd(), {
			plugins: plugins(throwing),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 1, textOf(edytor, 3), 1);
		const watch = surfaced();
		try {
			await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
			await flushDomUpdates();
		} finally {
			watch.stop();
		}
		expect(texts(edytor)).toEqual(['ad']);
		expect(edytor.undoManager.undoStack.length).toBe(1);
		expect(watch.errors.map(String)).toContain('Error: after-hook failed');
	});

	row('F-M2: refusing the removeBlock step for c refuses the range delete', async () => {
		const { edytor, editor } = await renderDomEdytor(abcd(), {
			plugins: plugins(vetoing('removeBlock', 'cc')),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 1, textOf(edytor, 3), 1);
		const { bytes } = track(edytor);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['aa', 'bb', 'cc', 'dd']);
		expect(bytes()).toBe(0);
		expect(edytor.undoManager.undoStack.length).toBe(0);
	});
});

describe('gap list — a veto on a planned step refuses the whole command', () => {
	row('block-selection replacement: refusing removeBlock for c keeps b and c', async () => {
		const { edytor, editor } = await renderDomEdytor(abc(), {
			plugins: plugins(vetoing('removeBlock', 'cc')),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 0);
		edytor.selection.selectBlocks(edytor.root!.children[1]!, edytor.root!.children[2]!);
		await flushDomUpdates();
		const { bytes } = track(edytor);
		await dispatchDomKeyDown(editor, { key: 'Backspace' });
		expect(texts(edytor)).toEqual(['aa', 'bb', 'cc']);
		expect(bytes()).toBe(0);
	});

	row('paste: refusing its insertText step refuses the paste (no split either)', async () => {
		const { edytor, editor } = await renderDomEdytor(helloWorld(), {
			plugins: plugins(vetoing('insertText', 'HelloWorld')),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 5);
		const { bytes } = track(edytor);
		await dispatchClipboardPaste(editor, { 'text/plain': 'X\nY' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['HelloWorld']);
		expect(bytes()).toBe(0);
	});

	row('drop: refusing its insertText step refuses the drop', async () => {
		const { edytor } = await renderDomEdytor(helloWorld(), {
			plugins: plugins(vetoing('insertText', 'HelloWorld')),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 5);
		const { bytes } = track(edytor);
		await drop(edytor, { 'text/plain': 'X' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['HelloWorld']);
		expect(bytes()).toBe(0);
	});
});

describe('F-M5 (a) — undo grouping (FP-2)', () => {
	pin('code-marked ".", selected, Delete, "!", Mod+Z → "." with its mark', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>
		);
		await dispatchDomKeyDown(editor, { key: 'e', ctrlKey: true });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '.' });
		await setNativeSelection(edytor, textOf(edytor, 0), 0, textOf(edytor, 0), 1);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		expect(texts(edytor)).toEqual(['!']);
		await dispatchDomKeyDown(editor, { key: 'z', ctrlKey: true });
		await flushDomUpdates();
		const content = edytor.value.children?.[0]?.content ?? [];
		expect(
			content.map((part) => ({
				text: 'text' in part ? part.text : '',
				marks: 'marks' in part ? part.marks : undefined
			}))
		).toEqual([{ text: '.', marks: { code: true } }]);
	});
});

describe('F-P19 (hook half) — documented hook surfaces', () => {
	pin('onBeforeInput prevent() claims the occurrence: no write', async () => {
		const claiming: Plugin = () => ({
			onBeforeInput: ({ e, prevent }) => {
				if (e.inputType === 'insertText' && e.data === 'x') prevent();
			}
		});
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|</paragraph>
			</root>,
			{ plugins: plugins(claiming) }
		);
		const { bytes } = track(edytor);
		const { defaultPrevented } = await dispatchDomBeforeInput(editor, {
			inputType: 'insertText',
			data: 'x'
		});
		expect(defaultPrevented).toBe(true);
		expect(texts(edytor)).toEqual(['ab']);
		expect(bytes()).toBe(0);
	});

	pin('onBeforeInput prevent(cb) replaces the input: the callback runs once', async () => {
		const replacement = vi.fn();
		const claiming: Plugin = () => ({
			onBeforeInput: ({ e, prevent }) => {
				if (e.inputType === 'insertText' && e.data === 'x') prevent(replacement);
			}
		});
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|</paragraph>
			</root>,
			{ plugins: plugins(claiming) }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(replacement).toHaveBeenCalledTimes(1);
		expect(texts(edytor)).toEqual(['ab']);
	});

	pin('onDeleteSelectedBlocks prevent() keeps the selected blocks', async () => {
		const keeping: Plugin = () => ({
			onDeleteSelectedBlocks: ({ prevent }) => prevent()
		});
		const { edytor, editor } = await renderDomEdytor(abc(), {
			plugins: plugins(keeping),
			autoSelectFixture: false
		});
		await setNativeSelection(edytor, textOf(edytor, 0), 0);
		edytor.selection.selectBlocks(edytor.root!.children[1]!);
		await flushDomUpdates();
		await dispatchDomKeyDown(editor, { key: 'Backspace' });
		expect(texts(edytor)).toEqual(['aa', 'bb', 'cc']);
	});

	pin(
		'onCut prevent() writes and deletes nothing; onPaste prevent(cb) runs the callback',
		async () => {
			const onPasteCb = vi.fn();
			const guarding: Plugin = () => ({
				onCut: ({ prevent }) => prevent(),
				onPaste: ({ prevent }) => prevent(onPasteCb)
			});
			const { edytor, editor } = await renderDomEdytor(abc(), {
				plugins: plugins(guarding),
				autoSelectFixture: false
			});
			await setNativeSelection(edytor, textOf(edytor, 0), 0, textOf(edytor, 0), 2);
			const cut = await dispatchCut(editor);
			expect(cut.defaultPrevented).toBe(true);
			expect(cut.clipboardData).toEqual({});
			expect(texts(edytor)).toEqual(['aa', 'bb', 'cc']);
			await dispatchClipboardPaste(editor, { 'text/plain': 'zz' });
			expect(onPasteCb).toHaveBeenCalledTimes(1);
			expect(texts(edytor)).toEqual(['aa', 'bb', 'cc']);
		}
	);

	pin('plugin commands: isEnabled gates, async run is awaited', async () => {
		let resolved = false;
		const commanding: Plugin = () => ({
			commands: [
				{ id: 'off', label: 'Off', isEnabled: () => false, run: () => (resolved = true) },
				{
					id: 'on',
					label: 'On',
					run: async () => {
						await Promise.resolve();
						resolved = true;
					}
				}
			]
		});
		const { edytor } = await renderDomEdytor(abc(), {
			plugins: plugins(commanding),
			autoSelectFixture: false
		});
		expect(await edytor.runCommand('off')).toBe(false);
		expect(resolved).toBe(false);
		expect(await edytor.runCommand('on')).toBe(true);
		expect(resolved).toBe(true);
	});

	pin('moveBlocks returns the moved blocks', async () => {
		const { edytor } = await renderDomEdytor(abc(), { autoSelectFixture: false });
		const [a, b, c] = edytor.root!.children;
		expect(edytor.moveBlocks({ blocks: [a!, b!], target: c!, position: 'after' })).toEqual([a, b]);
	});
});

describe('L37 — prevent() is caught once; other errors surface', () => {
	row('an error a hotkey throws surfaces (no catch-all reports it handled)', async () => {
		const throwing: Plugin = () => ({
			hotkeys: {
				'mod+k': () => {
					throw new Error('hotkey failed');
				}
			}
		});
		const { editor } = await renderDomEdytor(abc(), {
			plugins: plugins(throwing),
			autoSelectFixture: false
		});
		const watch = surfaced();
		try {
			await dispatchDomKeyDown(editor, { key: 'k', ctrlKey: true });
		} finally {
			watch.stop();
		}
		expect(watch.errors.map(String)).toContain('Error: hotkey failed');
	});
});

describe('readonly refuses every mutating command (event paths)', () => {
	pin('typing, Enter, Backspace, Tab, paste and cut: zero writes, zero undo steps', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|cd</paragraph>
				<paragraph>ef</paragraph>
			</root>,
			{ readonly: true }
		);
		const { bytes } = track(edytor);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await dispatchDomKeyDown(editor, { key: 'Tab' });
		await dispatchClipboardPaste(editor, { 'text/plain': 'zz' });
		await dispatchCut(editor);
		expect(texts(edytor)).toEqual(['abcd', 'ef']);
		expect(bytes()).toBe(0);
		expect(edytor.undoManager.undoStack.length).toBe(0);
	});
});
