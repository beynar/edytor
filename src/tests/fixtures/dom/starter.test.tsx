/**
 * The starter registry item (`registry/edytor/starter`): the starter editor
 * mounts with every part, each toggle removes its part, the page parts
 * write the document's data (one undo step each), every property type on
 * its shadcn control (Select, the list Combobox, the Date Picker, Checkbox,
 * Input), hidden properties keep their values, dates are shown in the
 * editor's locale, comments, readonly, shadcn's tokens (`.dark` flips them
 * in the menus too) and the snippet overrides.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, test } from 'vitest';
import type { EdytorInstance, JSONDoc } from '$lib/index.js';
import { commentsController, createMemoryCommentsClient } from '$lib/index.js';
import {
	starterPlugins,
	type StarterEditorProps,
	type StarterProperty
} from '$registry/edytor/starter/index.js';
import { formatDate } from '$registry/edytor/starter/page/dates.js';
import StarterHarness from '../../dom/StarterHarness.svelte';

const value = (): JSONDoc => ({
	data: { title: 'Plan' },
	children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'Body' }] }]
});

const SCHEMA: StarterProperty[] = [
	{
		id: 'status',
		name: 'Status',
		type: 'select',
		options: [{ value: 'todo' }, { value: 'done', color: 'green' }]
	},
	{ id: 'tags', name: 'Tags', type: 'multi-select', options: [{ value: 'a' }, { value: 'b' }] },
	{ id: 'due', name: 'Due', type: 'date' },
	{ id: 'owner', name: 'Owner', type: 'person' },
	{ id: 'size', name: 'Size', type: 'number' },
	{ id: 'shipped', name: 'Shipped', type: 'checkbox' },
	{ id: 'link', name: 'Link', type: 'url' },
	{ id: 'notes', name: 'Notes', type: 'text' },
	{ id: 'later', name: 'Later', type: 'text', hidden: true }
];
const PEOPLE = [
	{ id: 'ada', label: 'Ada' },
	{ id: 'alan', label: 'Alan' }
];

const mount = async (props: Partial<StarterEditorProps> = {}) => {
	let edytor: EdytorInstance | undefined;
	const rendered = render(StarterHarness, {
		props: { value: value(), onedytor: (view: EdytorInstance) => (edytor = view), ...props }
	});
	await waitFor(() => {
		expect(edytor?.synced).toBe(true);
		expect(rendered.container.querySelector('[data-edytor]')).toBeTruthy();
	});
	// The page reads the live data once mounted.
	await waitFor(() =>
		expect(rendered.container.querySelector('[data-edytor-starter]')).toBeTruthy()
	);
	return { ...rendered, edytor: edytor!, root: rendered.container };
};
const $ = (root: Element, selector: string) => root.querySelector<HTMLElement>(selector);
const data = (edytor: EdytorInstance) =>
	JSON.parse(JSON.stringify(edytor.data)) as Record<string, unknown>;
/** Writes are sent at the end of their task, then undo is one step. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const undoOnce = async (edytor: EdytorInstance) => {
	await settle();
	edytor.historyUndo();
	await settle();
};

/** Pick `value` in a shadcn Select (bits-ui: a press opens it, a press picks an option). */
const pick = async (trigger: Element, value: string) => {
	await fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0, pointerId: 1 });
	await fireEvent.click(trigger);
	const option = await waitFor(() => {
		const found = trigger.ownerDocument.querySelector<HTMLElement>(
			`[data-slot="select-item"][data-value="${value}"]`
		);
		expect(found).toBeTruthy();
		return found!;
	});
	await fireEvent.pointerUp(option, { pointerType: 'mouse', button: 0, pointerId: 1 });
	await fireEvent.click(option);
};
/** Toggle `label` in a list property's Combobox. */
const choose = async (root: Element, cell: Element, label: string) => {
	await fireEvent.click(cell.querySelector('[data-edytor-starter-pick]')!);
	const item = await waitFor(() => {
		const found = [...root.querySelectorAll<HTMLElement>('[data-slot="command-item"]')].find(
			(element) => element.textContent?.trim() === label
		);
		expect(found).toBeTruthy();
		return found!;
	});
	await fireEvent.click(item);
};

describe('starter editor', () => {
	test('mounts with every part and every bundled kind by default', async () => {
		const { root, edytor } = await mount({ properties: SCHEMA, people: PEOPLE });
		expect($(root, '[data-edytor-starter-title] textarea')).toBeTruthy();
		expect(($(root, '[data-edytor-starter-title] textarea') as HTMLTextAreaElement).value).toBe(
			'Plan'
		);
		await waitFor(() => expect($(root, '[data-edytor-starter-add-icon]')).toBeTruthy());
		expect($(root, '[data-edytor-starter-add-cover]')).toBeTruthy();
		expect($(root, '[data-edytor-starter-properties]')).toBeTruthy();
		for (const kind of [
			'paragraph',
			'code',
			'table',
			'columns',
			'image',
			'file',
			'video',
			'audio',
			'embed',
			'bookmark',
			'equation',
			'toc'
		])
			expect(edytor.blocks.has(kind), kind).toBe(true);
		expect(edytor.allowNesting).toBe(true);
		expect($(root, '[data-edytor]')!.getAttribute('aria-label')).toBe('Plan');
	});

	test('each page part toggle removes its part', async () => {
		const { root } = await mount({ cover: false, icon: false, title: false });
		expect($(root, '[data-edytor-starter-title]')).toBeNull();
		expect($(root, '[data-edytor-starter-add-icon]')).toBeNull();
		expect($(root, '[data-edytor-starter-add-cover]')).toBeNull();
		expect($(root, '[data-edytor-starter-properties]')).toBeNull();
	});

	test('each plugin toggle leaves its plugin out, and its kinds with it', async () => {
		const all = starterPlugins({}).length;
		for (const key of ['code', 'table', 'equation', 'slashMenu', 'blockHandles'] as const)
			expect(starterPlugins({ plugins: { [key]: false } }).length, key).toBe(all - 1);
		// The page link needs pages (or a search).
		expect(starterPlugins({ pages: [{ id: 'x', title: 'X' }] }).length).toBe(all + 1);
		const { edytor } = await mount({ plugins: { table: false, code: false, columns: false } });
		expect(edytor.blocks.has('table')).toBe(false);
		expect(edytor.blocks.has('code')).toBe(false);
		expect(edytor.blocks.has('columns')).toBe(false);
		expect(edytor.blocks.has('equation')).toBe(true);
	});

	test('extra plugins come first: their kinds win', async () => {
		const { edytor } = await mount({
			extraPlugins: [() => ({ blocks: { note: { element: 'aside' } } })]
		});
		expect(edytor.blocks.has('note')).toBe(true);
	});

	test('the title writes the document data, Enter moves into the first block, one undo step', async () => {
		const { root, edytor } = await mount();
		const field = $(root, '[data-edytor-starter-title] textarea') as HTMLTextAreaElement;
		field.value = 'Plan B';
		await fireEvent.input(field);
		expect(data(edytor).title).toBe('Plan B');
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(edytor.selection.caret?.block.id).toBe('p1');
		expect(edytor.selection.caret?.offset).toBe(0);
		await undoOnce(edytor);
		expect(data(edytor).title).toBe('Plan');
		expect(edytor.value.children[0]?.content).toEqual([{ text: 'Body' }]);
	});

	test('the icon: an emoji from the picker, one undo step', async () => {
		const { root, edytor } = await mount();
		await waitFor(() => expect($(root, '[data-edytor-starter-add-icon]')).toBeTruthy());
		await fireEvent.click($(root, '[data-edytor-starter-add-icon]')!);
		const picker = $(root, '[data-edytor-starter-icon-picker]')!;
		expect(picker.getAttribute('role')).toBe('dialog');
		const rocket = [...picker.querySelectorAll('button')].find((b) => b.textContent === '🚀');
		await fireEvent.click(rocket!);
		expect(data(edytor).icon).toEqual({ emoji: '🚀' });
		await waitFor(() => expect($(root, '[data-edytor-starter-icon]')?.textContent).toContain('🚀'));
		await undoOnce(edytor);
		expect(data(edytor).icon).toBeUndefined();
	});

	test('the icon: an image link', async () => {
		const { root, edytor } = await mount();
		await waitFor(() => expect($(root, '[data-edytor-starter-add-icon]')).toBeTruthy());
		await fireEvent.click($(root, '[data-edytor-starter-add-icon]')!);
		const input = $(
			root,
			'[data-edytor-starter-icon-picker] input[type="url"]'
		) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'https://example.com/i.png' } });
		await fireEvent.submit(input.form!);
		expect(data(edytor).icon).toEqual({ url: 'https://example.com/i.png' });
	});

	test('the cover: add, reposition (one write), change by link, remove; each one undo step', async () => {
		const { root, edytor } = await mount();
		await waitFor(() => expect($(root, '[data-edytor-starter-add-cover]')).toBeTruthy());
		await fireEvent.click($(root, '[data-edytor-starter-add-cover]')!);
		expect((data(edytor).cover as { position: number }).position).toBe(50);
		await waitFor(() => expect($(root, '[data-edytor-starter-cover] img')).toBeTruthy());

		await fireEvent.click($(root, '[data-edytor-starter-reposition]')!);
		const slider = $(root, '[data-edytor-starter-cover] [role="slider"]')!;
		await fireEvent.keyDown(slider, { key: 'ArrowUp' });
		await fireEvent.keyDown(slider, { key: 'ArrowUp' });
		expect((data(edytor).cover as { position: number }).position).toBe(50);
		await fireEvent.keyDown(slider, { key: 'Enter' });
		expect((data(edytor).cover as { position: number }).position).toBe(54);
		await undoOnce(edytor);
		expect((data(edytor).cover as { position: number }).position).toBe(50);

		await fireEvent.click($(root, '[data-edytor-starter-change-cover]')!);
		const input = $(root, '[data-edytor-starter-cover-menu] input[type="url"]') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'https://example.com/c.jpg' } });
		await fireEvent.submit(input.form!);
		expect((data(edytor).cover as { url: string }).url).toBe('https://example.com/c.jpg');

		await fireEvent.click($(root, '[data-edytor-starter-change-cover]')!);
		await fireEvent.click($(root, '[data-edytor-starter-remove-cover]')!);
		expect(data(edytor).cover).toBeUndefined();
		await undoOnce(edytor);
		expect((data(edytor).cover as { url: string }).url).toBe('https://example.com/c.jpg');
	});

	test('the cover and the icon upload through `upload`', async () => {
		const upload = async (file: File) => `https://cdn.test/${file.name}`;
		const { root, edytor } = await mount({ upload });
		await waitFor(() => expect($(root, '[data-edytor-starter-add-icon]')).toBeTruthy());
		await fireEvent.click($(root, '[data-edytor-starter-add-icon]')!);
		const input = $(
			root,
			'[data-edytor-starter-icon-picker] input[type="file"]'
		) as HTMLInputElement;
		const file = new File(['x'], 'face.png', { type: 'image/png' });
		Object.defineProperty(input, 'files', { value: [file], configurable: true });
		await fireEvent.change(input);
		await waitFor(() => expect(data(edytor).icon).toEqual({ url: 'https://cdn.test/face.png' }));
	});

	test('every property type writes its value, one undo step each', async () => {
		const { root, edytor } = await mount({ properties: SCHEMA, people: PEOPLE });
		const cell = (id: string) => $(root, `[data-edytor-starter-property="${id}"]`)!;
		const values = () => (data(edytor).properties ?? {}) as Record<string, unknown>;

		// A select: shadcn's Select (its trigger, then an option).
		await pick(cell('status').querySelector('[data-slot="select-trigger"]')!, 'done');
		expect(values().status).toBe('done');
		// A list and a person: the Combobox (a Popover over a Command), each pick toggles.
		await choose(root, cell('tags'), 'b');
		expect(values().tags).toEqual(['b']);
		await choose(root, cell('owner'), 'Ada');
		expect(values().owner).toEqual(['ada']);
		// A date: the Date Picker writes ISO `YYYY-MM-DD`, shown in the locale.
		await fireEvent.click(cell('due').querySelector('[data-edytor-starter-date]')!);
		const calendar = await waitFor(() => $(root, '[data-edytor-starter-calendar="due"]')!);
		const day = [...calendar.querySelectorAll<HTMLElement>('[data-bits-day]')].find(
			(element) =>
				element.textContent?.trim() === '20' && !element.hasAttribute('data-outside-month')
		)!;
		await fireEvent.click(day);
		expect(values().due).toMatch(/^\d{4}-\d{2}-20$/);
		await waitFor(() =>
			expect(cell('due').querySelector('time')?.textContent).toBe(
				formatDate(values().due as string, 'en-US')
			)
		);
		await fireEvent.input(cell('size').querySelector('input')!, { target: { value: '3' } });
		expect(values().size).toBe(3);
		await fireEvent.click(cell('shipped').querySelector('[role="checkbox"]')!);
		expect(values().shipped).toBe(true);
		await fireEvent.input(cell('link').querySelector('input')!, {
			target: { value: 'https://edytor.dev' }
		});
		expect(values().link).toBe('https://edytor.dev');
		expect(cell('link').querySelector('a')?.getAttribute('href')).toBe('https://edytor.dev');
		await fireEvent.input(cell('notes').querySelector('input')!, { target: { value: 'hi' } });
		expect(values().notes).toBe('hi');
		// A cell is labelled by its property's name.
		const labelled = cell('notes').querySelector('input')!.getAttribute('aria-labelledby')!;
		expect(root.ownerDocument.getElementById(labelled)?.textContent?.trim()).toBe('Notes');

		// A badge's remove button removes the value; an empty list removes the property.
		await fireEvent.click(cell('tags').querySelector('[role="listitem"] button')!);
		expect('tags' in values()).toBe(false);
		await undoOnce(edytor);
		expect(values().tags).toEqual(['b']);
	});

	test("a date is ISO in the data, the locale's on the page, the same text on the server", async () => {
		expect(formatDate('2026-10-13', 'en-US')).toBe('Oct 13, 2026');
		expect(formatDate('2026-10-13', 'fr-FR')).toBe('13 oct. 2026');
		// Not an ISO date: shown as written.
		expect(formatDate('next week', 'en-US')).toBe('next week');
		expect(formatDate('2026-02-30', 'en-US')).toBe('2026-02-30');
		const { root } = await mount({
			locale: 'de-DE',
			properties: [{ id: 'due', name: 'Due', type: 'date' }],
			value: {
				data: { title: 'Plan', properties: { due: '2026-10-13' } },
				children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'Body' }] }]
			}
		});
		const time = $(root, '[data-edytor-starter-property="due"] time')!;
		expect(time.getAttribute('datetime')).toBe('2026-10-13');
		expect(time.textContent).toBe('13.10.2026');
	});

	test('properties: hiding keeps the value, under the hidden properties, and Show brings it back', async () => {
		const { root, edytor } = await mount({
			properties: SCHEMA,
			value: {
				data: { title: 'Plan', properties: { notes: 'keep me' } },
				children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'Body' }] }]
			}
		});
		const hidden = () => $(root, '[data-edytor-starter-hidden-properties]');
		const toggle = () => $(root, '[data-edytor-starter-hidden-toggle]')!;
		expect(toggle().textContent?.trim()).toBe('1 hidden property');
		// The schema's hidden one is added from Add a property.
		await fireEvent.click($(root, '[data-edytor-starter-add-property]')!);
		const menu = await waitFor(() => $(root, '[data-edytor-starter-add-menu]')!);
		await fireEvent.click(menu.querySelector('[data-property-id="later"]')!);
		expect($(root, '[data-edytor-starter-property="later"]:not([data-hidden])')).toBeTruthy();
		expect((data(edytor).shownProperties as Record<string, boolean>).later).toBe(true);
		expect(hidden()).toBeNull();

		// Hide: the value stays in the data, the row moves under the collapsible.
		await fireEvent.click(
			$(root, '[data-edytor-starter-property="notes"] [data-edytor-starter-hide-property]')!
		);
		expect((data(edytor).properties as Record<string, unknown>).notes).toBe('keep me');
		expect((data(edytor).shownProperties as Record<string, boolean>).notes).toBe(false);
		expect(toggle().textContent?.trim()).toBe('1 hidden property');
		await fireEvent.click(toggle());
		const row = await waitFor(
			() =>
				$(root, '[data-edytor-starter-hidden-properties] [data-edytor-starter-property="notes"]')!
		);
		expect((row.querySelector('input') as HTMLInputElement).value).toBe('keep me');
		await fireEvent.click(row.querySelector('[data-edytor-starter-show-property]')!);
		expect($(root, '[data-edytor-starter-property="notes"]:not([data-hidden])')).toBeTruthy();
		expect((data(edytor).properties as Record<string, unknown>).notes).toBe('keep me');
		await undoOnce(edytor);
		expect((data(edytor).shownProperties as Record<string, boolean>).notes).toBe(false);
		expect((data(edytor).properties as Record<string, unknown>).notes).toBe('keep me');
	});

	test('editableProperties false: no add, no hide', async () => {
		const { root } = await mount({ properties: SCHEMA, editableProperties: false });
		expect($(root, '[data-edytor-starter-add-property]')).toBeNull();
		expect($(root, '[data-edytor-starter-hide-property]')).toBeNull();
	});

	test('readonly shows the values only', async () => {
		const { root } = await mount({
			readonly: true,
			properties: SCHEMA,
			people: PEOPLE,
			value: {
				data: {
					title: 'Plan',
					icon: { emoji: '🌱' },
					cover: { url: 'https://example.com/c.jpg', position: 20 },
					properties: { status: 'done', owner: ['ada'], shipped: true }
				},
				children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'Body' }] }]
			}
		});
		expect(
			root.querySelectorAll(
				'[data-edytor-starter] input, [data-edytor-starter] select, [data-edytor-starter] textarea'
			).length
		).toBe(0);
		expect($(root, '[data-edytor-starter-title]')!.textContent).toContain('Plan');
		expect($(root, '[data-edytor-starter-icon]')!.textContent).toContain('🌱');
		expect($(root, '[data-edytor-starter-icon] button')).toBeNull();
		expect($(root, '[data-edytor-starter-change-cover]')).toBeNull();
		expect($(root, '[data-edytor-starter-cover] img')!.getAttribute('style')).toContain('20%');
		expect($(root, '[data-edytor-starter-property="status"]')!.textContent).toContain('done');
		expect($(root, '[data-edytor-starter-property="owner"]')!.textContent).toContain('Ada');
		expect($(root, '[data-edytor-starter-add-property]')).toBeNull();
		expect($(root, '[data-edytor-starter-add-icon]')).toBeNull();
	});

	test("the editor and its chrome read shadcn's tokens, no colour of their own", async () => {
		const { root } = await mount();
		const starter = $(root, '[data-edytor-starter]')!;
		expect(starter.classList.contains('edytor-notion')).toBe(true);
		// The theme's variables are the tokens (`chrome/tokens.css`): `.dark` flips them all.
		const style = getComputedStyle(starter);
		expect(style.getPropertyValue('--notion-text').trim()).toBe('var(--foreground)');
		expect(style.getPropertyValue('--notion-hover').trim()).toBe('var(--accent)');
		expect(style.getPropertyValue('--edytor-menu-background').trim()).toBe('var(--popover)');
		// Every menu, panel and card paints with the tokens: no literal colour in their styles
		// (shadows aside, and the cover's default gradient).
		const files = import.meta.glob('/registry/edytor/**/*.svelte', {
			query: '?raw',
			import: 'default',
			eager: true
		}) as Record<string, string>;
		expect(Object.keys(files).length).toBeGreaterThan(20);
		for (const [file, source] of Object.entries(files)) {
			const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
			const literal = css
				.replace(/rgba\(0, 0, 0, 0\.\d+\)/g, '')
				.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi);
			expect(literal, file).toBeNull();
		}
	});

	test('comments: the plugin is listed with a client, its user from `people`', async () => {
		const without = starterPlugins({}).length;
		const client = createMemoryCommentsClient({ user: 'ada' });
		expect(starterPlugins({ comments: client, people: PEOPLE }).length).toBe(without + 1);
		expect(starterPlugins({ comments: false }).length).toBe(without);
		expect(starterPlugins({ comments: client, plugins: { comments: false } }).length).toBe(without);
		const { edytor } = await mount({ comments: client, people: PEOPLE, user: 'ada' });
		const controller = commentsController(edytor as never)!;
		expect(controller).toBeTruthy();
		expect(controller.user.id).toBe('ada');
		expect(controller.user.name).toBe('Ada');
	});

	test('a snippet override replaces its part', async () => {
		const title = createRawSnippet((payload: () => { title: string }) => ({
			render: () => `<h1 data-custom-title>${payload().title}!</h1>`
		}));
		const cell = createRawSnippet((payload: () => { value: unknown }) => ({
			render: () => `<b data-custom-cell>${String(payload().value ?? '')}</b>`
		}));
		const { root } = await mount({
			title,
			properties: [{ id: 'notes', type: 'text' }],
			propertyCells: { text: cell },
			value: {
				data: { title: 'Plan', properties: { notes: 'hey' } },
				children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'Body' }] }]
			}
		});
		expect($(root, '[data-custom-title]')!.textContent).toBe('Plan!');
		expect($(root, '[data-edytor-starter-title]')).toBeNull();
		expect($(root, '[data-custom-cell]')!.textContent).toBe('hey');
	});
});
