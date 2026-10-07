/** @jsxImportSource ../../jsx */
/**
 * UW-36: a third-party trigger (`:smile:` → 😄) as one refusable command.
 * The trigger's removal leads the replacement's operation (`dispatcher.lead`):
 * one plan, so a veto of the command or of the removal step writes nothing
 * and records no undo step — the trigger text stays.
 */
import { describe, expect, it } from 'vitest';
import type { Plugin, Prepared } from '$lib/index.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { dispatchDomBeforeInput, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const EMOJI: Record<string, string> = { smile: '😄' };

/** Typing the closing `:` of `:name:` replaces the whole trigger with its emoji. */
const emojiPlugin: Plugin = (edytor) => ({
	onBeforeOperation: ({ operation, payload, block, prevent }) => {
		if (operation !== 'insertText' || payload.value !== ':') return;
		const { startText: text, yStart } = edytor.selection.state;
		if (!text) return;
		const match = /:(\w+)$/.exec(text.stringContent.slice(0, yStart));
		const emoji = match && EMOJI[match[1]!];
		if (!emoji) return;
		const start = yStart - match[0].length;
		prevent(() => {
			// The documented example (`plugins/operations`): the public facade.
			const { dispatcher, document } = edytor;
			const trigger: Prepared = document.facade.prepare.deleteText(
				block.id,
				text.segStart + start,
				match[0].length
			);
			dispatcher.lead(trigger, () => text.insertText({ value: emoji, start, end: start }));
			if (dispatcher.last?.status === 'applied') dispatcher.caret(text, start + emoji.length);
		});
	}
});

const render = (plugins: Plugin[]) =>
	renderDomEdytor(
		<root>
			<paragraph>hi :smile|</paragraph>
		</root>,
		{ plugins: [emojiPlugin, ...plugins, richTextPlugin] }
	);

const textOf = (edytor: Awaited<ReturnType<typeof render>>['edytor']) =>
	edytor.root!.children[0]!.firstText!.stringContent;

describe('a trigger as one plan', () => {
	it('the closing colon replaces the trigger in one undo step', async () => {
		const { edytor, editor } = await render([]);
		const steps = edytor.undoManager.undoStack.length;
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: ':' });
		expect(textOf(edytor)).toBe('hi 😄');
		expect(edytor.selection.state.yStart).toBe(5);
		expect(edytor.undoManager.undoStack.length).toBe(steps + 1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(textOf(edytor)).toBe('hi :smile');
	});

	const vetoes: [string, Plugin][] = [
		[
			'the replacement',
			() => ({
				onBeforeOperation: ({ operation, payload, prevent }) => {
					if (operation === 'insertText' && payload.value === '😄') prevent();
				}
			})
		],
		[
			"the trigger's removal (a step)",
			() => ({
				onBeforeOperation: ({ operation, prevent }) => {
					if (operation === 'deleteContentAtRange') prevent();
				}
			})
		]
	];

	it.each(vetoes)('a plugin vetoing %s: zero writes, no undo step', async (_, veto) => {
		const { edytor, editor } = await render([veto]);
		const version = edytor.facade.version;
		const steps = edytor.undoManager.undoStack.length;
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: ':' });
		expect(textOf(edytor)).toBe('hi :smile');
		expect(edytor.facade.version).toBe(version);
		expect(edytor.undoManager.undoStack.length).toBe(steps);
		expect(edytor.dispatcher.last?.status).toBe('refused');
	});
});
