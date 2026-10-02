/** @jsxImportSource ../../jsx */
/**
 * Suggestions (AI) — the view's session-only suggestion layer
 * (`edytor.suggestions`, site `editor/suggestions`). A suggestion has a
 * position and blocks of content; the view previews it in place and nothing
 * reaches the document, its history, presence or a peer until `accept()`,
 * which is one command and one undo step.
 *
 * Expected values come from the site page and the flow rows
 * (`flow.place`, `flow.slot`, `del.blocks.promote`), never from a run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import { createDocument } from '$lib/crdt/index.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { suggestionsPlugin } from '$lib/plugins/suggestions/suggestionsPlugin.js';
import { dispatchDomKeyDown, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const PLUGINS: Plugin[] = [codePlugin, suggestionsPlugin, imagePlugin, richTextPlugin];

const VALUE = (): JSONDoc => ({
	children: [
		{
			id: 'a',
			type: 'paragraph',
			content: [{ text: 'Alpha' }],
			children: [{ id: 'k', type: 'paragraph', content: [{ text: 'Kid' }] }]
		},
		{ id: 'b', type: 'paragraph', content: [{ text: 'Beta' }] },
		{ id: 'l', type: 'bulleted-list-item', content: [{ text: 'Item' }] }
	]
});

const mount = (options: { plugins?: Plugin[]; readonly?: boolean; document?: never } = {}) =>
	renderDomEdytor(
		<root>
			<paragraph>x</paragraph>
		</root>,
		{ plugins: PLUGINS, value: VALUE(), autoSelectFixture: false, ...options }
	);

/** Root blocks as `type:text`, nested children in braces. */
const shape = (edytor: Edytor) => {
	const walk = (block: JSONBlock): string => {
		const text = (block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		const kids = block.children?.length ? `{${block.children.map(walk).join(', ')}}` : '';
		return `${block.type}:${text}${kids}`;
	};
	return (edytor.value.children ?? []).map(walk);
};

const BASE = ['paragraph:Alpha{paragraph:Kid}', 'paragraph:Beta', 'bulleted-list-item:Item'];

const group = (editor: HTMLElement, id: string) =>
	editor.querySelector<HTMLElement>(`[data-edytor-suggestion="${id}"]`);
const blockEl = (editor: HTMLElement, id: string) =>
	editor.querySelector<HTMLElement>(`[data-edytor-block][data-edytor-id="${id}"]`);
const caretIn = (edytor: Edytor, id: string, offset: number) =>
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);

/** A replica of the mounted document; `sync` exchanges both ways. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		sync: () => {
			const local = Y.encodeStateAsUpdate(edytor.doc, Y.encodeStateVector(remoteDoc));
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
			Y.applyUpdate(remoteDoc, local);
		},
		text: () => JSON.stringify(remote.facade.toJSON())
	};
};

describe('positions — each one previews at its place', () => {
	it('after, before, inside and end render where they say; the preview is not the document', async () => {
		const { edytor, editor } = await mount();
		const after = edytor.suggestions.add({ after: 'a' }, 'After A');
		const before = edytor.suggestions.add({ before: 'b' }, 'Before B');
		const inside = edytor.suggestions.add({ inside: 'b' }, 'Inside B');
		const end = edytor.suggestions.add({ end: 'b' }, ' end of B');
		await flushDomUpdates();

		// a, its next sibling's preview, b's previous sibling's preview, b, l.
		const root = [...editor.children].filter((el) => !el.hasAttribute('data-edytor-render-anchor'));
		expect(
			root.map(
				(el) => el.getAttribute('data-edytor-id') ?? el.getAttribute('data-edytor-suggestion')
			)
		).toEqual(['a', after.id, before.id, 'b', 'l']);
		expect(group(editor, after.id)!.textContent).toContain('After A');
		expect(group(editor, before.id)!.textContent).toContain('Before B');
		// Inside: b's last children, in its children container.
		const nested = group(editor, inside.id)!;
		expect(nested.closest('[data-edytor-block][data-edytor-id]')).toBe(blockEl(editor, 'b'));
		expect(nested.parentElement!.hasAttribute('data-edytor-children')).toBe(true);
		// End: today's ghost text after b's text.
		const ghost = blockEl(editor, 'b')!.querySelector('[data-edytor-text-suggestion]');
		expect(ghost?.textContent).toBe(' end of B');
		expect(end.at).toEqual({ end: 'b' });

		for (const s of [after, before, inside]) {
			const node = group(editor, s.id)!;
			expect(node.getAttribute('contenteditable')).toBe('false');
			expect(node.getAttribute('data-status')).toBe('ready');
			// The kinds' own rendering, but no document identity: no text, no id, no caret stop.
			expect(
				node.querySelector('[data-edytor-block][data-edytor-type="paragraph"]')
			).not.toBeNull();
			expect(node.querySelector('[data-edytor-text], [data-edytor-id]')).toBeNull();
		}
		expect(shape(edytor)).toEqual(BASE);
	});

	it('replace marks the blocks it removes and shows the content right after them', async () => {
		const { edytor, editor } = await mount();
		edytor.selection.selectBlocks(edytor.idToBlock.get('a')!, edytor.idToBlock.get('b')!);
		const s = edytor.suggestions.add({ replace: 'selection' }, 'Fresh');
		await flushDomUpdates();
		// A block selection resolves to its members (the unselected child k stays).
		expect(s.at).toEqual({ replace: ['a', 'b'] });
		expect(blockEl(editor, 'a')!.hasAttribute('data-edytor-suggestion-replaced')).toBe(true);
		expect(blockEl(editor, 'b')!.hasAttribute('data-edytor-suggestion-replaced')).toBe(true);
		expect(blockEl(editor, 'l')!.hasAttribute('data-edytor-suggestion-replaced')).toBe(false);
		expect(group(editor, s.id)!.previousElementSibling).toBe(blockEl(editor, 'b'));
	});

	it('a replace of a line that holds nothing previews in its place (Ask AI on an empty line)', async () => {
		const value = VALUE();
		value.children!.splice(2, 0, { id: 'e', type: 'paragraph', content: [] });
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>x</paragraph>
			</root>,
			{ plugins: PLUGINS, value, autoSelectFixture: false }
		);
		const s = edytor.suggestions.add({ replace: ['e'] }, 'Fresh');
		await flushDomUpdates();
		// The empty line stays mounted (it holds the caret) but folds away: the
		// preview stands where it was.
		expect(edytor.suggestions.at('e').inPlace).toBe(true);
		expect(blockEl(editor, 'e')!.getAttribute('data-edytor-suggestion-replaced')).toBe('empty');
		expect(group(editor, s.id)!.previousElementSibling).toBe(blockEl(editor, 'e'));
		// A line with text is shown struck through instead.
		edytor.suggestions.add({ replace: ['b'] }, 'Other');
		await flushDomUpdates();
		expect(edytor.suggestions.at('b').inPlace).toBe(false);
		expect(blockEl(editor, 'b')!.getAttribute('data-edytor-suggestion-replaced')).toBe('');
		// Accepting puts the content where the empty line was.
		s.accept();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([
			'paragraph:Alpha{paragraph:Kid}',
			'paragraph:Beta',
			'paragraph:Fresh',
			'bulleted-list-item:Item'
		]);
	});

	it('a position the document cannot hold is refused at creation', async () => {
		const { edytor } = await mount();
		expect(() => edytor.suggestions.add({ after: 'ghost' }, 'x')).toThrow();
		expect(edytor.suggestions.list).toEqual([]);
	});
});

describe('streaming', () => {
	it('append, update and done stream into the preview', async () => {
		const { edytor, editor } = await mount();
		const s = edytor.suggestions.add({ after: 'a' });
		expect(s.status).toBe('streaming');
		expect(s.content).toEqual([]);
		await flushDomUpdates();
		expect(group(editor, s.id)!.getAttribute('data-status')).toBe('streaming');

		s.append('Hel');
		s.append('lo');
		await flushDomUpdates();
		expect(s.content).toEqual([{ type: 'paragraph', content: [{ text: 'Hello' }] }]);
		expect(group(editor, s.id)!.textContent).toContain('Hello');

		s.append(' there\n\nSecond');
		expect(s.content).toEqual([
			{ type: 'paragraph', content: [{ text: 'Hello there' }] },
			{ type: 'paragraph', content: [{ text: 'Second' }] }
		]);

		s.update([{ type: 'heading', data: { level: 'h2' }, content: [{ text: 'Title' }] }]);
		await flushDomUpdates();
		expect(group(editor, s.id)!.querySelector('h2')?.textContent).toContain('Title');

		s.done();
		await flushDomUpdates();
		expect(s.status).toBe('ready');
		expect(group(editor, s.id)!.getAttribute('data-status')).toBe('ready');
		expect(shape(edytor)).toEqual(BASE);
	});
});

describe('accept and discard', () => {
	it('accept is one command and one undo step; the content gets fresh ids; the caret ends it', async () => {
		const { edytor, editor } = await mount();
		const undo = edytor.undoManager.undoStack.length;
		const s = edytor.suggestions.add({ after: 'a' }, [
			{ id: 'x1', type: 'paragraph', content: [{ text: 'One' }] },
			{ type: 'quote', content: [{ text: 'Two' }] }
		]);
		const result = s.accept();
		expect(result.status).toBe('applied');
		expect(edytor.dispatcher.last).toMatchObject({
			operation: 'acceptSuggestion',
			status: 'applied'
		});
		expect(shape(edytor)).toEqual([BASE[0], 'paragraph:One', 'quote:Two', BASE[1], BASE[2]]);
		expect(JSON.stringify(edytor.value)).not.toContain('"x1"');
		expect(edytor.undoManager.undoStack.length).toBe(undo + 1);
		expect(edytor.suggestions.list).toEqual([]);
		const { startBlock, yStart, isCollapsed } = edytor.selection.state;
		expect(startBlock?.type).toBe('quote');
		expect([yStart, isCollapsed]).toEqual([3, true]);
		await flushDomUpdates();
		expect(editor.querySelector('[data-edytor-suggestion]')).toBeNull();

		edytor.historyUndo();
		expect(shape(edytor)).toEqual(BASE);
	});

	it('typing right after an accept is its own undo step', async () => {
		const { edytor } = await mount();
		edytor.suggestions.add({ after: 'b' }, 'New').accept();
		const { startText, yStart } = edytor.selection.state;
		startText!.insertText({ value: '!', start: yStart, end: yStart });
		expect(shape(edytor)).toEqual([BASE[0], BASE[1], 'paragraph:New!', BASE[2]]);
		edytor.historyUndo();
		expect(shape(edytor)).toEqual([BASE[0], BASE[1], 'paragraph:New', BASE[2]]);
	});

	it('discard writes nothing: same value, same undo stack', async () => {
		const { edytor, editor } = await mount();
		const before = JSON.stringify(edytor.value);
		const undo = edytor.undoManager.undoStack.length;
		const s = edytor.suggestions.add({ after: 'a' }, 'Nope');
		await flushDomUpdates();
		s.discard();
		await flushDomUpdates();
		expect(JSON.stringify(edytor.value)).toBe(before);
		expect(edytor.undoManager.undoStack.length).toBe(undo);
		expect(edytor.suggestions.list).toEqual([]);
		expect(editor.querySelector('[data-edytor-suggestion]')).toBeNull();
		// A discarded suggestion takes no more content and accepts nothing.
		s.append('more');
		expect(s.accept().status).toBe('refused');
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	it('a replace accept deletes the blocks and inserts the content as one step', async () => {
		const { edytor } = await mount();
		const undo = edytor.undoManager.undoStack.length;
		edytor.suggestions.add({ replace: ['a', 'b'] }, 'Fresh').accept();
		// The blocks go, their unselected child stays after the placed lines (flow.slot).
		expect(shape(edytor)).toEqual(['paragraph:Fresh', 'paragraph:Kid', BASE[2]]);
		expect(edytor.undoManager.undoStack.length).toBe(undo + 1);
		edytor.historyUndo();
		expect(shape(edytor)).toEqual(BASE);
	});

	it('a text-range replace deletes the range and places the content at its caret, one step', async () => {
		const { edytor, editor } = await mount();
		const a = edytor.idToBlock.get('a')!.firstText!;
		edytor.selection.setAtRange(a, 1, a, 4);
		const s = edytor.suggestions.add({ replace: 'selection' }, 'LPH');
		expect(
			'replace' in s.at && typeof s.at.replace === 'object' && !Array.isArray(s.at.replace)
		).toBe(true);
		await flushDomUpdates();
		// The proposal shows after the range's block; the range is marked in the overlay.
		expect(group(editor, s.id)!.previousElementSibling).toBe(blockEl(editor, 'a'));
		const undo = edytor.undoManager.undoStack.length;
		expect(s.accept().status).toBe('applied');
		expect(shape(edytor)).toEqual(['paragraph:ALPHa{paragraph:Kid}', BASE[1], BASE[2]]);
		expect(edytor.undoManager.undoStack.length).toBe(undo + 1);
		edytor.historyUndo();
		expect(shape(edytor)).toEqual(BASE);
	});

	it('an image block suggestion renders its image and accepts as an image block', async () => {
		const { edytor, editor } = await mount();
		const src = 'https://example.com/cat.png';
		const s = edytor.suggestions.add({ after: 'b' }, [
			{ type: 'image', data: { src }, content: [{ text: 'A cat' }] }
		]);
		await flushDomUpdates();
		expect(group(editor, s.id)!.querySelector('img')?.getAttribute('src')).toBe(src);
		expect(s.accept().status).toBe('applied');
		const image = edytor.value.children!.find((block) => block.type === 'image');
		expect(image?.data).toEqual({ src });
		expect(image?.content).toEqual([{ text: 'A cat' }]);
	});
});

describe('session only', () => {
	it('survives selection changes and remote edits elsewhere', async () => {
		const { edytor, editor } = await mount();
		const remote = peer(edytor);
		const s = edytor.suggestions.add({ after: 'b' }, 'Stay');
		caretIn(edytor, 'a', 2);
		edytor.selection.selectBlocks(edytor.idToBlock.get('l')!);
		caretIn(edytor, 'l', 1);
		remote.facade.insertText('a', 0, 'Remote ');
		remote.sync();
		await flushDomUpdates();
		expect(edytor.suggestions.list).toEqual([s]);
		expect(group(editor, s.id)).not.toBeNull();
	});

	it('is dropped when its block is deleted here', async () => {
		const { edytor, editor } = await mount();
		edytor.suggestions.add({ after: 'b' }, 'Gone');
		edytor.suggestions.add({ replace: ['a', 'b'] }, 'Gone too');
		const kept = edytor.suggestions.add({ end: 'l' }, '!');
		edytor.deleteBlocks({ blocks: [edytor.idToBlock.get('b')!] });
		await flushDomUpdates();
		expect(edytor.suggestions.list).toEqual([kept]);
		expect(editor.querySelectorAll('[data-edytor-suggestion]').length).toBe(0);
	});

	it('is dropped when a peer deletes its block', async () => {
		const { edytor, editor } = await mount();
		const remote = peer(edytor);
		edytor.suggestions.add({ inside: 'b' }, 'Gone');
		remote.facade.deleteBlocks(['b']);
		remote.sync();
		await flushDomUpdates();
		expect(edytor.suggestions.list).toEqual([]);
		expect(editor.querySelector('[data-edytor-suggestion]')).toBeNull();
	});

	it('is never synced, in presence or in a sibling view; once accepted, it is', async () => {
		const document = createDocument({ value: VALUE() });
		const v1 = await renderDomEdytor(
			<root>
				<paragraph>x</paragraph>
			</root>,
			{
				plugins: PLUGINS,
				document,
				autoSelectFixture: false
			}
		);
		const v2 = await renderDomEdytor(
			<root>
				<paragraph>x</paragraph>
			</root>,
			{
				plugins: PLUGINS,
				document,
				autoSelectFixture: false
			}
		);
		const remote = peer(v1.edytor);
		caretIn(v1.edytor, 'a', 1);
		const s = v1.edytor.suggestions.add({ after: 'a' }, 'Secret plan');
		remote.sync();
		await flushDomUpdates();
		expect(remote.text()).not.toContain('Secret');
		expect(JSON.stringify(document.awareness.getLocalState())).not.toContain('Secret');
		expect(v2.edytor.suggestions.list).toEqual([]);
		expect(v2.editor.querySelector('[data-edytor-suggestion]')).toBeNull();
		expect(v1.editor.querySelector('[data-edytor-suggestion]')).not.toBeNull();

		s.accept();
		remote.sync();
		await flushDomUpdates();
		expect(remote.text()).toContain('Secret plan');
		expect(v2.editor.textContent).toContain('Secret plan');
	});
});

describe('refusals', () => {
	it('a readonly view shows a suggestion but refuses its accept', async () => {
		const { edytor, editor } = await mount({ readonly: true });
		const s = edytor.suggestions.add({ after: 'a' }, 'Read only');
		await flushDomUpdates();
		expect(group(editor, s.id)).not.toBeNull();
		expect(s.accept().status).toBe('refused');
		expect(edytor.dispatcher.last).toMatchObject({
			operation: 'acceptSuggestion',
			status: 'refused'
		});
		expect(shape(edytor)).toEqual(BASE);
		expect(edytor.suggestions.list).toEqual([s]);
	});

	it("an extension's veto refuses the accept; the suggestion stays", async () => {
		const seen: string[] = [];
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				seen.push(operation);
				if (operation === 'acceptSuggestion') prevent();
			}
		});
		const { edytor } = await mount({ plugins: [veto, ...PLUGINS] });
		const s = edytor.suggestions.add({ after: 'a' }, 'Vetoed');
		expect(s.accept().status).toBe('refused');
		expect(seen).toContain('acceptSuggestion');
		expect(shape(edytor)).toEqual(BASE);
		expect(edytor.suggestions.list).toEqual([s]);
	});
});

describe('the default UI (suggestionsPlugin)', () => {
	it('Mod+Enter accepts the latest suggestion; Escape discards it', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'b', 4);
		const older = edytor.suggestions.add({ after: 'a' }, 'Older');
		edytor.suggestions.add({ after: 'b' }, 'Latest');
		await dispatchDomKeyDown(editor, { key: 'Enter', ctrlKey: true });
		expect(shape(edytor)).toEqual([BASE[0], BASE[1], 'paragraph:Latest', BASE[2]]);
		expect(edytor.suggestions.list).toEqual([older]);
		await dispatchDomKeyDown(editor, { key: 'Escape' });
		expect(edytor.suggestions.list).toEqual([]);
		expect(shape(edytor)).toEqual([BASE[0], BASE[1], 'paragraph:Latest', BASE[2]]);
	});

	it('Tab accepts an end suggestion at the caret; in a list item Tab keeps indenting', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'b', 4);
		edytor.suggestions.add({ end: 'b' }, '!');
		await dispatchDomKeyDown(editor, { key: 'Tab' });
		expect(shape(edytor)).toEqual([BASE[0], 'paragraph:Beta!', BASE[2]]);

		caretIn(edytor, 'l', 4);
		const listed = edytor.suggestions.add({ end: 'l' }, '?');
		await dispatchDomKeyDown(editor, { key: 'Tab' });
		expect(shape(edytor)).toEqual([BASE[0], 'paragraph:Beta!{bulleted-list-item:Item}']);
		expect(edytor.suggestions.list).toEqual([listed]);
	});

	it('the bar accepts, discards, and offers Try again only with onRetry', async () => {
		const { edytor } = await mount();
		const onRetry = vi.fn();
		const s = edytor.suggestions.add({ after: 'a' }, 'Draft', { onRetry });
		await flushDomUpdates();
		const bar = () => document.querySelector<HTMLElement>('[data-edytor-suggestion-bar]');
		expect(bar()).not.toBeNull();
		bar()!.querySelector<HTMLButtonElement>('[data-edytor-suggestion-retry]')!.click();
		expect(onRetry).toHaveBeenCalledWith(s);
		expect([s.status, s.content]).toEqual(['streaming', []]);
		s.update('Second draft');
		s.done();
		await flushDomUpdates();
		bar()!.querySelector<HTMLButtonElement>('[data-edytor-suggestion-accept]')!.click();
		await flushDomUpdates();
		expect(shape(edytor)).toEqual([BASE[0], 'paragraph:Second draft', BASE[1], BASE[2]]);
		expect(bar()).toBeNull();

		edytor.suggestions.add({ after: 'b' }, 'No retry');
		await flushDomUpdates();
		expect(bar()!.querySelector('[data-edytor-suggestion-retry]')).toBeNull();
		bar()!.querySelector<HTMLButtonElement>('[data-edytor-suggestion-discard]')!.click();
		await flushDomUpdates();
		expect(edytor.suggestions.list).toEqual([]);
		expect(shape(edytor)).toEqual([BASE[0], 'paragraph:Second draft', BASE[1], BASE[2]]);
	});
});

describe('the preview is inert', () => {
	it('a press in it is cancelled and moves no selection', async () => {
		const { edytor, editor } = await mount();
		caretIn(edytor, 'b', 2);
		const value = edytor.selection.value;
		const s = edytor.suggestions.add({ after: 'a' }, 'Click me');
		await flushDomUpdates();
		const target = group(editor, s.id)!.querySelector('[data-edytor-block]')!;
		const press = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
		target.dispatchEvent(press);
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
		target.dispatchEvent(down);
		await flushDomUpdates();
		expect(down.defaultPrevented).toBe(true);
		expect(edytor.selection.value).toBe(value);
	});

	it("bundled kinds without a handle render: a to-do's box writes nothing, an empty image, a code block", async () => {
		const { edytor, editor } = await mount();
		const before = JSON.stringify(edytor.value);
		const s = edytor.suggestions.add({ after: 'b' }, [
			{ type: 'todo-item', data: { checked: false }, content: [{ text: 'Task' }] },
			{ type: 'image', content: [] },
			{
				type: 'code',
				content: [],
				children: [{ type: 'codeLine', content: [{ text: 'let a = 1' }] }]
			}
		]);
		await flushDomUpdates();
		const node = group(editor, s.id)!;
		expect(node.textContent).toContain('Task');
		expect(node.textContent).toContain('let a = 1');
		node.querySelector<HTMLInputElement>('[data-edytor-todo-checkbox]')!.click();
		await flushDomUpdates();
		expect(JSON.stringify(edytor.value)).toBe(before);
	});
});

describe('the block API (deprecated wrappers over { end })', () => {
	it('suggestText, suggestions and acceptSuggestedText still work', async () => {
		const { edytor, editor } = await mount();
		const b = edytor.idToBlock.get('b')!;
		b.suggestText({ value: ' world' });
		await flushDomUpdates();
		expect(b.suggestions).toEqual([[{ text: ' world' }]]);
		expect(edytor.suggestions.list.map((s) => s.at)).toEqual([{ end: 'b' }]);
		expect(blockEl(editor, 'b')!.querySelector('[data-edytor-text-suggestion]')?.textContent).toBe(
			' world'
		);
		b.acceptSuggestedText();
		expect(shape(edytor)[1]).toBe('paragraph:Beta world');
		expect(b.suggestions).toBeNull();

		b.suggestions = [[{ text: '?' }]];
		b.suggestions = null;
		expect(edytor.suggestions.list).toEqual([]);
	});
});
