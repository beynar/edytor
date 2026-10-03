import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * Columns, Notion parity (the 2026-10-04 review): a block selection in a
 * column is replaced in place by typing and pasting (`layout.flow-slot`);
 * the block-selection arrows never select a column; the gap between two
 * columns shows a resize guide on hover; a block in a column has its `+`
 * (Alt+click: a new column to the right); a block selection made with a
 * grip takes Backspace and Shift+arrows. The jsdom rows are
 * `src/tests/fixtures/dom/columns-*.test.tsx`.
 *
 * `P "before", C[K1[A "left one", A2 "left two"], K2[B "right"]], Z "after"`.
 */

type Edytor = {
	value: { children: Array<{ id: string; type: string; children?: unknown[] }> };
	selection: {
		state: { startBlock?: { id: string }; yStart: number; isCollapsed: boolean };
		selectedBlocks: Set<{ id: string }>;
	};
};

const fit = (page: Page, width = 800) =>
	page.getByTestId('editor-shell').evaluate((shell, px) => (shell.style.width = `${px}px`), width);

const open = async (page: Page, query = '') => {
	await page.goto(`/test/dom?scenario=columns&handles=true${query}`);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
};

const box = async (page: Page, id: string) =>
	(await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;

const KNOWN = ['P', 'C', 'K1', 'K2', 'A', 'A2', 'B', 'Z'];

/** Root blocks as ids, a layout as its columns' blocks; a block an op minted is `NEW`. */
const shape = (page: Page) =>
	page.evaluate((known) => {
		const edytor = (window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__;
		type Node = { id: string; children?: Node[] };
		const name = (id: string) => (known.includes(id) ? id : 'NEW');
		const walk = (blocks: Node[] = []): unknown[] =>
			blocks.map((b) => (b.children?.length ? [name(b.id), walk(b.children)] : name(b.id)));
		return walk(edytor.value.children as Node[]);
	}, KNOWN);

const selected = (page: Page) =>
	page.evaluate(() =>
		[...(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.selectedBlocks]
			.map((b) => b.id)
			.sort()
	);

const caretBlock = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __EDYTOR__: Edytor }).__EDYTOR__.selection.state.startBlock?.id ??
			null
	);

const textOf = (page: Page, id: string) =>
	page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first().innerText();

const clickAt = async (page: Page, id: string, edge: 'start' | 'end') => {
	const text = page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();
	const rect = (await text.boundingBox())!;
	await page.mouse.click(
		edge === 'start' ? rect.x + 1 : rect.x + rect.width - 1,
		rect.y + rect.height / 2
	);
	await page.keyboard.press(edge === 'start' ? 'Home' : 'End');
	await expect.poll(() => caretBlock(page)).toBe(id);
};

/** Mod+A twice in `id`: its block selected. */
const selectBlock = async (page: Page, id: string) => {
	await clickAt(page, id, 'end');
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ControlOrMeta+a');
	await expect.poll(() => selected(page)).toEqual([id]);
};

const LAYOUT = [
	'C',
	[
		['K1', ['A', 'A2']],
		['K2', ['B']]
	]
];

test.describe('columns: a block selection replaced in place (layout.flow-slot)', () => {
	test("typing over a column's only block keeps the column and the layout", async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await selectBlock(page, 'B');
		await page.keyboard.type('x');
		await expect
			.poll(() => shape(page))
			.toEqual([
				'P',
				[
					'C',
					[
						['K1', ['A', 'A2']],
						['K2', ['NEW']]
					]
				],
				'Z'
			]);
		await expect(page.locator('[data-edytor-id="K2"] [data-edytor-text]').first()).toHaveText('x');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => shape(page)).toEqual(['P', LAYOUT, 'Z']);
		issues.assertClean();
	});

	for (const id of ['B', 'Z']) {
		test(`Mod+V over block-selected ${id}: the pasted line takes its place`, async ({
			page,
			context,
			browserName
		}) => {
			test.skip(browserName !== 'chromium', 'clipboard permissions: Chromium only');
			await context.grantPermissions(['clipboard-read', 'clipboard-write']);
			await open(page);
			await page.evaluate(() => navigator.clipboard.writeText('pasted'));
			await selectBlock(page, id);
			await page.keyboard.press('ControlOrMeta+v');
			await expect
				.poll(() => shape(page))
				.toEqual(
					id === 'B'
						? [
								'P',
								[
									'C',
									[
										['K1', ['A', 'A2']],
										['K2', ['NEW']]
									]
								],
								'Z'
							]
						: ['P', LAYOUT, 'NEW']
				);
			expect(await textOf(page, 'P')).toBe('before');
		});
	}
});

test.describe('columns: the block-selection arrows never select a column', () => {
	test("Shift+ArrowDown from column 1's last block extends to column 2's first; Backspace deletes what shows", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await selectBlock(page, 'A2');
		await page.keyboard.press('Shift+ArrowDown');
		await expect.poll(() => selected(page)).toEqual(['A2', 'B']);
		await page.keyboard.press('Shift+ArrowDown');
		await expect.poll(() => selected(page)).toEqual(['A2', 'B', 'Z']);
		await page.keyboard.press('Shift+ArrowUp');
		await expect.poll(() => selected(page)).toEqual(['A2', 'B']);
		await page.keyboard.press('Backspace');
		await expect.poll(() => shape(page)).toEqual(['P', 'A', 'Z']);
		issues.assertClean();
	});

	test("ArrowDown over a selected block steps over the column onto the next column's block", async ({
		page
	}) => {
		await open(page);
		await selectBlock(page, 'A2');
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => selected(page)).toEqual(['B']);
		await page.keyboard.press('ArrowUp');
		await expect.poll(() => selected(page)).toEqual(['A2']);
	});
});
