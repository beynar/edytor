/** @jsxImportSource ../../jsx */
/**
 * Comments (WU-34, decision D6; site `plugins/comments`, contract rows
 * `comment.*` of `docs/editor-delete-contract.md`). Notion's behaviour:
 *
 * - a thread starts on selected text (the toolbar's Comment button,
 *   Mod+Shift+M), is written in a card beside the text and, once posted,
 *   anchors on that text as a `comment:<id>` mark (one command, one undo
 *   step);
 * - an open thread's text is highlighted, the caret in it makes it the
 *   active one; a reply, Resolve (its highlight and card go), Re-open from
 *   the resolved list, a delete (its anchor marks go);
 * - a comment mark is not copied; its anchor follows a split;
 * - another user's change arrives live and reaches `onComment`;
 * - a read-only view reads threads and writes none.
 *
 * Expected values come from the site page and Notion, never from a run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONDoc } from '$lib/utils/json.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import {
	commentsController,
	createCommentsPlugin,
	type CommentsPluginOptions
} from '$lib/plugins/comments/commentsPlugin.js';
import { createMemoryCommentsClient } from '$lib/collaboration/comments/client.js';
import { commentAnchors, type CommentChange } from '$lib/crdt/protocols/comments.js';
import { EDYTOR_FRAGMENT_MIME } from '$lib/clipboard/types.js';
import {
	dispatchCopy,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const VALUE = (): JSONDoc => ({
	children: [
		{ id: 'a', type: 'paragraph', content: [{ text: 'the quick brown fox' }] },
		{ id: 'b', type: 'paragraph', content: [{ text: 'jumps over the lazy dog' }] }
	]
});

const mount = async (
	options: Partial<CommentsPluginOptions> & {
		readonly?: boolean;
		value?: JSONDoc;
		plugins?: Plugin[];
	} = {}
) => {
	const client = options.client ?? createMemoryCommentsClient({ user: 'ada' });
	const comments = createCommentsPlugin({ user: { id: 'ada', name: 'Ada' }, ...options, client });
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>x</paragraph>
		</root>,
		{
			plugins: [comments, ...(options.plugins ?? []), richTextPlugin],
			value: options.value ?? VALUE(),
			readonly: options.readonly,
			autoSelectFixture: false
		}
	);
	await flushDomUpdates();
	return { ...rendered, client, comments: commentsController(rendered.edytor)! };
};

const select = async (edytor: Edytor, id: string, from: number, to: number) => {
	const block = edytor.idToBlock.get(id)!;
	const [start, end] = [block.textAtOffset(from)!, block.textAtOffset(to)!];
	edytor.selection.setAtRange(start.text, start.offset, end.text, end.offset);
	await flushDomUpdates();
};

const caretIn = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setAtTextOffset(edytor.idToBlock.get(id)!.firstText!, offset);
	await flushDomUpdates();
};

/** The text of each run of `comment:<thread>` in the document. */
const anchored = (edytor: Edytor, thread: string) =>
	(commentAnchors(edytor.facade).get(thread) ?? []).map(({ block, offset, length }) =>
		(edytor.facade.blockText(block) ?? '').slice(offset, offset + length)
	);

const card = (thread: string) =>
	document.querySelector<HTMLElement>(`[data-edytor-comment-card="${thread}"]`);
const draftCard = () => document.querySelector<HTMLElement>('[data-edytor-comment-new]');
const styleText = () =>
	document.querySelector('style[data-edytor-comments-style]')?.textContent ?? '';
const press = async (button: Element | null | undefined) => {
	(button as HTMLElement).click();
	await flushDomUpdates();
};
const typeAndEnter = async (field: HTMLTextAreaElement, value: string) => {
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	await flushDomUpdates();
	field.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
	);
	await flushDomUpdates();
	await vi.waitFor(() => expect(field.value).toBe(''));
	await flushDomUpdates();
};

/** Post a thread on `from`–`to` of block `id`; answers its id. */
const comment = async (
	setup: Awaited<ReturnType<typeof mount>>,
	id: string,
	from: number,
	to: number,
	body = 'Is this right?'
) => {
	await select(setup.edytor, id, from, to);
	expect(setup.comments.start()).toBe(true);
	await flushDomUpdates();
	const thread = setup.comments.draft!.id;
	await typeAndEnter(draftCard()!.querySelector('textarea')!, body);
	await vi.waitFor(() => expect(anchored(setup.edytor, thread).length).toBeGreaterThan(0));
	await flushDomUpdates();
	return thread;
};

describe('comment.start — a thread on selected text', () => {
	it('Mod+Shift+M opens a card for the selected text; posting anchors it there', async () => {
		const setup = await mount();
		const { edytor, editor, client } = setup;
		await select(edytor, 'a', 4, 9);
		const key = edytor.keymap.isMac ? { metaKey: true } : { ctrlKey: true };
		expect(
			(await dispatchDomKeyDown(editor, { key: 'm', code: 'KeyM', shiftKey: true, ...key }))
				.defaultPrevented
		).toBe(true);
		expect(draftCard()?.querySelector('[data-edytor-comment-quote]')?.textContent).toBe('quick');
		const field = draftCard()!.querySelector<HTMLTextAreaElement>('textarea')!;
		expect(field.placeholder).toBe('Add a comment…');
		const thread = setup.comments.draft!.id;
		await typeAndEnter(field, 'Is this right?');
		await vi.waitFor(() => expect(anchored(edytor, thread)).toEqual(['quick']));
		expect(draftCard()).toBeNull();
		const { threads } = await client.list();
		expect(threads).toMatchObject([
			{
				id: thread,
				quote: 'quick',
				block: 'a',
				createdBy: 'ada',
				comments: [{ body: 'Is this right?' }]
			}
		]);
		// The core renders the anchor; the open thread's text is highlighted.
		const mark = editor.querySelector(`[data-edytor-mark="comment:${thread}"]`);
		expect(mark?.textContent).toBe('quick');
		expect(styleText()).toContain(`[data-edytor-mark="comment:${thread}"]`);
		// Its card shows, active, with the comment.
		await vi.waitFor(() => expect(card(thread)).not.toBeNull());
		expect(card(thread)!.hasAttribute('data-active')).toBe(true);
		expect(card(thread)!.querySelector('[data-edytor-comment-body]')?.textContent).toBe(
			'Is this right?'
		);
		expect(card(thread)!.querySelector('[data-edytor-comment-author]')?.textContent).toBe('Ada');
	});

	it('the anchor is one command and one undo step; Escape gives the draft up', async () => {
		const setup = await mount();
		const { edytor, editor } = setup;
		const thread = await comment(setup, 'a', 4, 9);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'addComment', status: 'applied' });
		await dispatchDomBeforeInput(editor, { inputType: 'historyUndo' });
		expect(anchored(edytor, thread)).toEqual([]);
		expect(edytor.facade.blockText('a')).toBe('the quick brown fox');
		await select(edytor, 'b', 0, 5);
		setup.comments.start();
		await flushDomUpdates();
		const field = draftCard()!.querySelector('textarea')!;
		field.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		await flushDomUpdates();
		expect(draftCard()).toBeNull();
		expect((await setup.client.list()).threads).toHaveLength(1);
	});

	it('the toolbar’s Comment button starts it (a mark record’s `toolbar.run`)', async () => {
		const setup = await mount({ plugins: [toolbarPlugin] });
		await select(setup.edytor, 'a', 4, 9);
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="toolbar-comment"]')).not.toBeNull()
		);
		await press(document.querySelector('[data-testid="toolbar-comment"]'));
		expect(setup.comments.draft?.quote).toBe('quick');
	});

	it('across blocks, each selected run is anchored', async () => {
		const setup = await mount();
		const thread = await comment(setup, 'a', 10, 19);
		expect(anchored(setup.edytor, thread)).toEqual(['brown fox']);
		const end = setup.edytor.idToBlock.get('b')!.textAtOffset(5)!;
		const start = setup.edytor.idToBlock.get('a')!.textAtOffset(16)!;
		setup.edytor.selection.setAtRange(start.text, start.offset, end.text, end.offset);
		await flushDomUpdates();
		expect(setup.comments.start()).toBe(true);
		await flushDomUpdates();
		const across = setup.comments.draft!.id;
		await typeAndEnter(draftCard()!.querySelector('textarea')!, 'Across');
		await vi.waitFor(() => expect(anchored(setup.edytor, across)).toEqual(['fox', 'jumps']));
	});
});

describe('comment.thread — reply, resolve, re-open, delete', () => {
	it('the caret in the text makes its thread active; a reply joins it', async () => {
		const setup = await mount();
		const { edytor } = setup;
		const thread = await comment(setup, 'a', 4, 9);
		await caretIn(edytor, 'b', 2);
		expect(setup.comments.active).toBeNull();
		await caretIn(edytor, 'a', 6);
		expect(setup.comments.active).toBe(thread);
		expect(styleText()).toContain('--edytor-comment-active');
		const reply = card(thread)!.querySelector<HTMLTextAreaElement>('[data-edytor-comment-reply]')!;
		expect(reply.placeholder).toBe('Reply…');
		await typeAndEnter(reply, 'Yes');
		await vi.waitFor(() =>
			expect(
				[...card(thread)!.querySelectorAll('[data-edytor-comment-body]')].map((n) => n.textContent)
			).toEqual(['Is this right?', 'Yes'])
		);
	});

	it('Resolve hides the thread and its highlight; Re-open from the resolved list', async () => {
		const setup = await mount();
		const thread = await comment(setup, 'a', 4, 9);
		await press(card(thread)!.querySelector('[data-edytor-comment-resolve]'));
		await vi.waitFor(() => expect(card(thread)).toBeNull());
		expect(styleText()).not.toContain(`comment:${thread}`);
		// The anchor stays (Re-open shows it again).
		expect(anchored(setup.edytor, thread)).toEqual(['quick']);
		const toggle = document.querySelector('[data-edytor-comments-toggle]')!;
		expect(toggle.textContent).toBe('Resolved (1)');
		await press(toggle);
		await vi.waitFor(() => expect(card(thread)).not.toBeNull());
		expect(card(thread)!.hasAttribute('data-resolved')).toBe(true);
		expect(card(thread)!.querySelector('[data-edytor-comment-resolved]')?.textContent?.trim()).toBe(
			'Resolved by Ada'
		);
		await press(card(thread)!.querySelector('[data-edytor-comment-reopen]'));
		await vi.waitFor(() => expect(card(thread)?.hasAttribute('data-resolved')).toBe(false));
		expect(styleText()).toContain(`comment:${thread}`);
	});

	it('deleting the first comment removes the thread and its anchor (its store’s write)', async () => {
		const setup = await mount();
		const thread = await comment(setup, 'a', 4, 9);
		await press(card(thread)!.querySelector('[data-edytor-comment-delete]'));
		await vi.waitFor(() => expect(card(thread)).toBeNull());
		expect(anchored(setup.edytor, thread)).toEqual([]);
		expect(setup.edytor.facade.blockText('a')).toBe('the quick brown fox');
		expect((await setup.client.list()).threads).toEqual([]);
		// The store's removal is no step of this view's history: undo takes back the anchor's write.
		expect(setup.edytor.undoManager.undoStack.length).toBe(1);
	});

	it('another user’s change arrives live and reaches `onComment` (`own`: the current user’s)', async () => {
		const heard: Array<[CommentChange['type'], boolean]> = [];
		const client = createMemoryCommentsClient({ user: 'ada' });
		const setup = await mount({
			client,
			onComment: (change, { own }) => heard.push([change.type, own])
		});
		const thread = await comment(setup, 'a', 4, 9);
		await client.as('bob').send({ op: 'reply', thread, body: 'From Bob' });
		await vi.waitFor(() =>
			expect(card(thread)!.querySelectorAll('[data-edytor-comment-body]').length).toBe(2)
		);
		expect(
			[...card(thread)!.querySelectorAll('[data-edytor-comment-author]')].map((n) => n.textContent)
		).toEqual(['Ada', 'bob']);
		// Only its author deletes a comment: Bob's has no delete button here.
		expect(card(thread)!.querySelectorAll('[data-edytor-comment-delete]').length).toBe(1);
		expect(heard).toEqual([
			['added', true],
			['replied', false]
		]);
	});
});

describe('comment.copy and comment.anchor', () => {
	it('copy carries the text, not the comment (the other marks stay)', async () => {
		const value: JSONDoc = {
			children: [
				{
					id: 'a',
					type: 'paragraph',
					content: [
						{ text: 'the ' },
						{ text: 'quick', marks: { bold: true, 'comment:t1': { id: 't1' } } },
						{ text: ' fox' }
					]
				}
			]
		};
		const { edytor, editor } = await mount({ value });
		await select(edytor, 'a', 0, 9);
		const { clipboardData } = await dispatchCopy(editor);
		const parsed = JSON.parse(decodeURIComponent(atob(clipboardData[EDYTOR_FRAGMENT_MIME]!)));
		expect(parsed.content).toEqual([{ text: 'the ' }, { text: 'quick', marks: { bold: true } }]);
		expect(JSON.stringify(parsed)).not.toContain('comment:');
		expect(clipboardData['text/html']).not.toContain('comment');
	});

	it('Enter inside the commented text splits it; both halves keep the thread', async () => {
		const setup = await mount();
		const { edytor, editor } = setup;
		const thread = await comment(setup, 'a', 4, 15);
		await caretIn(edytor, 'a', 9);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(anchored(edytor, thread)).toEqual(['quick', ' brown']);
		await vi.waitFor(() => expect(card(thread)).not.toBeNull());
	});
});

describe('comment.readonly', () => {
	it('a read-only view shows threads and writes none', async () => {
		const client = createMemoryCommentsClient({ user: 'bob' });
		await client.send({ op: 'add', thread: 'r1', body: 'Hello' });
		const value: JSONDoc = {
			children: [
				{
					id: 'a',
					type: 'paragraph',
					content: [{ text: 'read ' }, { text: 'only', marks: { 'comment:r1': { id: 'r1' } } }]
				}
			]
		};
		const setup = await mount({ client, value, readonly: true });
		await vi.waitFor(() => expect(card('r1')).not.toBeNull());
		expect(card('r1')!.querySelector('button')).toBeNull();
		await select(setup.edytor, 'a', 0, 4);
		expect(setup.comments.start()).toBe(false);
		expect(draftCard()).toBeNull();
	});
});
