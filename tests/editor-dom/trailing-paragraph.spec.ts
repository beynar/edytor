import { expect, test, type Page } from './editorTest';
import { waitForEditorReady } from './helpers';

/**
 * Leaving the document's last nested block in real browsers
 * (`nav.trailing.exit`, `nav.trailing.press` in
 * docs/editor-delete-contract.md, Notion): ArrowDown on the last line of
 * the last stop, when it is not a top-level paragraph, and a press below
 * the last block put the caret in a trailing top-level paragraph, created
 * when the last block is not an empty one. The jsdom rows are
 * `src/tests/fixtures/dom/trailing-paragraph.test.tsx`.
 */
type Json = Record<string, unknown>;
const block = (type: string, id: string, text: string, children?: Json[]): Json => ({
	id,
	type,
	content: [{ text }],
	...(children && { children })
});
const p = (id: string, text: string, children?: Json[]) => block('paragraph', id, text, children);

const open = async (page: Page, children: Json[], scenario = 'dst') => {
	await page.goto(
		`/test/dom?scenario=${scenario}&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

/** The top-level blocks as `type:text`. */
const shape = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
		return edytor.value.children.map(
			(b: any) => `${b.type}:${(b.content ?? []).map((part: any) => part.text ?? '@').join('')}`
		);
	});

/** The model caret: its block's id (or `new` for a block the fixture did not name), offset. */
const caret = (page: Page, ids: string[]) =>
	page.evaluate((known) => {
		const { state } = (window as unknown as { __EDYTOR__: any }).__EDYTOR__.selection;
		const id = state.startBlock?.id;
		return [known.includes(id) ? id : 'new', state.yStart, state.isCollapsed];
	}, ids);

/** Open (or close) the toggle `id` as a click on its marker would. */
const expand = (page: Page, id: string, open = true) =>
	page.evaluate(
		([id, open]) => {
			(document.querySelector(`[data-edytor-id="${id}"]`) as HTMLDetailsElement).open = open;
		},
		[id, open] as const
	);

/** Click at the end of block `id`'s text and wait until the model holds that caret. */
const endOf = async (page: Page, id: string) => {
	const text = page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();
	const box = (await text.boundingBox())!;
	await page.mouse.click(box.x + box.width + 2, box.y + box.height / 2);
	const length = (await text.textContent())!.length;
	await expect
		.poll(() =>
			page.evaluate(() => {
				const state = (window as unknown as { __EDYTOR__: any }).__EDYTOR__.selection.state;
				return [state.startBlock?.id, state.yStart, state.isCollapsed];
			})
		)
		.toEqual([id, length, true]);
};

test.describe('ArrowDown at the last stop (nav.trailing.exit)', () => {
	test("from an open toggle's last child: a paragraph after the toggle, typing lands there; undo gives the caret back", async ({
		page
	}) => {
		await open(page, [p('P', 'before'), block('toggle', 'T', 'Toggle', [p('C', 'child')])]);
		await expand(page, 'T');
		await endOf(page, 'C');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page, ['P', 'T', 'C'])).toEqual(['new', 0, true]);
		await expect.poll(() => shape(page)).toHaveLength(3);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => shape(page)).toEqual(['paragraph:before', 'toggle:Toggle']);
		await expect.poll(() => caret(page, ['P', 'T', 'C'])).toEqual(['C', 5, true]);
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page, ['P', 'T', 'C'])).toEqual(['new', 0, true]);
		await page.keyboard.type('x');
		await expect
			.poll(() => shape(page))
			.toEqual(['paragraph:before', 'toggle:Toggle', 'paragraph:x']);
	});

	test("from a closed toggle's header", async ({ page }) => {
		await open(page, [block('toggle', 'T', 'Toggle', [p('C', 'hidden')])]);
		await endOf(page, 'T');
		// The click in its summary may have opened it.
		await expand(page, 'T', false);
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page, ['T', 'C'])).toEqual(['new', 0, true]);
		await page.keyboard.type('y');
		await expect.poll(() => shape(page)).toEqual(['toggle:Toggle', 'paragraph:y']);
	});

	test('from a callout, then ArrowDown again stays in the trailing paragraph', async ({ page }) => {
		await open(page, [block('callout', 'K', 'A note')]);
		await endOf(page, 'K');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page, ['K'])).toEqual(['new', 0, true]);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.type('z');
		await expect.poll(() => shape(page)).toEqual(['callout:A note', 'paragraph:z']);
	});

	test("from the first column's last block of a layout at the end", async ({ page }) => {
		await open(page, [
			p('P', 'before'),
			{
				id: 'L',
				type: 'columns',
				children: [
					{ id: 'K1', type: 'column', children: [p('A', 'left')] },
					{ id: 'K2', type: 'column', children: [p('B', 'right')] }
				]
			}
		]);
		await endOf(page, 'A');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page, ['P', 'A', 'B'])).toEqual(['new', 0, true]);
		await page.keyboard.type('w');
		await expect.poll(() => shape(page)).toEqual(['paragraph:before', 'columns:', 'paragraph:w']);
	});

	test("from a table's last row", async ({ page }) => {
		const cell = (id: string, column: string) => ({
			...block('tableCell', id, id.toLowerCase()),
			data: { column }
		});
		await open(
			page,
			[
				{
					id: 'T',
					type: 'table',
					data: { columns: [{ id: 'c1' }, { id: 'c2' }] },
					children: [
						{ id: 'R1', type: 'tableRow', children: [cell('A', 'c1'), cell('B', 'c2')] },
						{ id: 'R2', type: 'tableRow', children: [cell('C', 'c1'), cell('D', 'c2')] }
					]
				}
			],
			'table'
		);
		await endOf(page, 'C');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page, ['A', 'B', 'C', 'D'])).toEqual(['new', 0, true]);
		await expect.poll(() => shape(page)).toEqual(['table:', 'paragraph:']);
	});

	test('a wrapped last line: ArrowDown on its first line box is the browser’s', async ({
		page
	}) => {
		await open(page, [block('callout', 'K', 'word '.repeat(80).trim())]);
		await page.addStyleTag({ content: '[data-edytor] { width: 360px; }' });
		const text = page.locator('[data-edytor-id="K"] [data-edytor-text]').first();
		const box = (await text.boundingBox())!;
		// The first line box, a few characters in.
		await page.mouse.click(box.x + 20, box.y + 6);
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { __EDYTOR__: any }).__EDYTOR__.selection.state.startBlock?.id
				)
			)
			.toBe('K');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => caret(page, ['K'])).toEqual(['K', expect.any(Number), true]);
		expect(await shape(page)).toEqual([`callout:${'word '.repeat(80).trim()}`]);
	});
});

test.describe('a press below the last block (nav.trailing.press)', () => {
	const pressBelow = async (page: Page) => {
		const last = page.locator('[data-edytor] > [data-edytor-block]').last();
		const box = (await last.boundingBox())!;
		const host = (await page.locator('[data-edytor]').first().boundingBox())!;
		expect(host.y + host.height).toBeGreaterThan(box.y + box.height + 8);
		await page.mouse.click(box.x + 20, box.y + box.height + 6);
	};

	test('after a toggle: a trailing paragraph takes the caret and the typing', async ({ page }) => {
		await open(page, [p('P', 'before'), block('toggle', 'T', 'Toggle', [p('C', 'child')])]);
		await pressBelow(page);
		await expect.poll(() => caret(page, ['P', 'T', 'C'])).toEqual(['new', 0, true]);
		await page.keyboard.type('x');
		await expect
			.poll(() => shape(page))
			.toEqual(['paragraph:before', 'toggle:Toggle', 'paragraph:x']);
	});

	test('after an empty paragraph: that one takes the caret', async ({ page }) => {
		await open(page, [block('toggle', 'T', 'Toggle'), p('E', '')]);
		await pressBelow(page);
		await expect.poll(() => caret(page, ['T', 'E'])).toEqual(['E', 0, true]);
		await page.keyboard.type('x');
		await expect.poll(() => shape(page)).toEqual(['toggle:Toggle', 'paragraph:x']);
	});
});
