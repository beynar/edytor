import { expect, test, type Page } from './editorTest';
import { modKey, trackPageIssues, waitForEditorReady } from './helpers';

/**
 * A container's body in real browsers (`body.*` and `callout.icon` in
 * docs/editor-delete-contract.md): an open toggle's and a callout's empty
 * body shows a hint whose click starts it, Enter at the end of the header
 * goes into it, a block dropped on the hint nests inside, and a callout's
 * icon is picked in a popover, by mouse or keyboard, as one undo step. The
 * jsdom rows are `src/tests/fixtures/dom/container-bodies.test.tsx`.
 */
const open = async (page: Page, children: unknown[], params = '') => {
	await page.goto(
		`/test/dom?scenario=dst${params}&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

type Outline = string | [string, Outline[]];
/** The document as `type "text"` lines, children nested. */
const outline = (page: Page) =>
	page.evaluate(() => {
		const walk = (block: any): unknown => {
			const text = (block.content ?? []).map((p: any) => p.text ?? '@').join('');
			const self = text ? `${block.type} "${text}"` : block.type;
			return block.children?.length ? [self, block.children.map(walk)] : self;
		};
		return (window as unknown as { __EDYTOR__: any }).__EDYTOR__.value.children.map(walk);
	}) as Promise<Outline[]>;

const caret = (page: Page) =>
	page.evaluate(() => {
		const state = (window as unknown as { __EDYTOR__: any }).__EDYTOR__.selection.state;
		return [state.startBlock?.parent?.id ?? null, state.startBlock?.index, state.yStart];
	});

const iconOf = (page: Page, id: string) =>
	page.evaluate(
		(id) => (window as unknown as { __EDYTOR__: any }).__EDYTOR__.idToBlock.get(id)?.data.icon,
		id
	);

const toggle = [
	{ id: 't', type: 'toggle', content: [{ text: 'Title' }] },
	{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] }
];
const callout = [
	{ id: 'c', type: 'callout', data: { icon: '💡' }, content: [{ text: 'Note' }] },
	{ id: 'p', type: 'paragraph', content: [{ text: 'after' }] }
];

/** Click at the end of block `id`'s own text. */
const endOf = async (page: Page, id: string) => {
	const text = page.locator(`[data-edytor-id="${id}"] [data-edytor-text]`).first();
	const box = (await text.boundingBox())!;
	await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
	await expect.poll(() => caret(page)).toEqual([expect.anything(), expect.anything(), 4]);
};

test.describe('container bodies', () => {
	test("an open toggle's hint: a click starts the body, typing goes there, undo takes it back", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, toggle);
		const details = page.locator('[data-edytor-id="t"]');
		const hint = details.locator('[data-edytor-empty-body]');
		// Closed: the browser hides the body, the hint with it.
		await expect(hint).toBeHidden();
		await details.locator('summary').evaluate((summary) => {
			(summary.parentElement as HTMLDetailsElement).open = true;
		});
		await expect(hint).toBeVisible();
		await expect(hint).toHaveText('Empty toggle. Click or drop blocks inside.');
		await hint.click();
		await expect
			.poll(() => outline(page))
			.toEqual([['toggle "Title"', ['paragraph']], 'paragraph "after"']);
		await expect.poll(() => caret(page)).toEqual(['t', 0, 0]);
		await expect(hint).toHaveCount(0);
		await page.keyboard.type('Inside');
		await expect
			.poll(() => outline(page))
			.toEqual([['toggle "Title"', ['paragraph "Inside"']], 'paragraph "after"']);
		await page.keyboard.press(`${modKey}+z`);
		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(() => outline(page)).toEqual(['toggle "Title"', 'paragraph "after"']);
		issues.assertClean();
	});

	test('`> ` makes an open toggle; Enter after its title goes into its body', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [{ id: 'a', type: 'paragraph', content: [] }]);
		await page.locator('[data-edytor-id="a"]').click();
		await expect.poll(() => caret(page)).toEqual(['root', 0, 0]);
		await page.keyboard.type('> Title');
		await expect.poll(() => outline(page)).toEqual(['toggle "Title"']);
		const details = page.locator('[data-edytor-id="a"]');
		await expect
			.poll(() => details.evaluate((node) => (node as HTMLDetailsElement).open))
			.toBe(true);
		await expect(details.locator('[data-edytor-empty-body]')).toBeVisible();
		await page.keyboard.press('Enter');
		await page.keyboard.type('Body');
		await expect.poll(() => outline(page)).toEqual([['toggle "Title"', ['paragraph "Body"']]]);
		issues.assertClean();
	});

	test("Enter at the end of a callout's title goes into its content", async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, callout);
		const title = page.locator('[data-edytor-id="c"] [data-edytor-callout-title]');
		await expect(title).toHaveCSS('font-weight', '600');
		await endOf(page, 'c');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Body');
		await expect
			.poll(() => outline(page))
			.toEqual([['callout "Note"', ['paragraph "Body"']], 'paragraph "after"']);
		issues.assertClean();
	});

	test("a callout's hint: a click starts its content", async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, callout);
		const hint = page.locator('[data-edytor-id="c"] [data-edytor-empty-body]');
		await expect(hint).toHaveText('Empty callout. Click or drop blocks inside.');
		await hint.click();
		await page.keyboard.type('Body');
		await expect
			.poll(() => outline(page))
			.toEqual([['callout "Note"', ['paragraph "Body"']], 'paragraph "after"']);
		issues.assertClean();
	});

	test('a block dropped on the hint nests inside the callout', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, callout, '&handles=true');
		const hint = page.locator('[data-edytor-id="c"] [data-edytor-empty-body]');
		const box = (await hint.boundingBox())!;
		await page.locator('[data-edytor-id="p"]').hover();
		await page
			.locator('[data-testid="block-handle"][data-block-id="p"]')
			.dragTo(hint, { targetPosition: { x: 8, y: box.height / 2 } });
		await expect.poll(() => outline(page)).toEqual([['callout "Note"', ['paragraph "after"']]]);
		issues.assertClean();
	});

	test('the icon picker by mouse: a choice is one undo step', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, callout);
		const icon = page.getByRole('button', { name: 'Change icon' });
		await icon.click();
		const picker = page.getByRole('menu', { name: 'Callout icons' });
		await expect(picker).toBeVisible();
		await expect(icon).toHaveAttribute('aria-expanded', 'true');
		await picker.getByRole('menuitemradio', { name: '🔥' }).click();
		await expect(picker).toHaveCount(0);
		await expect.poll(() => iconOf(page, 'c')).toBe('🔥');
		await expect(icon).toHaveText('🔥');
		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(() => iconOf(page, 'c')).toBe('💡');
		issues.assertClean();
	});

	test('the icon picker by keyboard: the arrows walk, Enter picks, Escape gives the keys back', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, callout);
		await endOf(page, 'c');
		const icon = page.getByRole('button', { name: 'Change icon' });
		await icon.click();
		const picker = page.getByRole('menu', { name: 'Callout icons' });
		await expect(picker).toBeFocused();
		await expect(picker).toHaveAttribute(
			'aria-activedescendant',
			(await picker.getByRole('menuitemradio', { name: '💡' }).getAttribute('id'))!
		);
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect.poll(() => iconOf(page, 'c')).toBe('💡');
		// The editor holds the keys again, its caret where it was.
		await page.keyboard.type('!');
		await expect.poll(() => outline(page)).toEqual(['callout "Note!"', 'paragraph "after"']);
		await icon.click();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(picker.getByRole('menuitemradio', { name: '❗' })).toHaveAttribute(
			'data-active',
			''
		);
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect.poll(() => iconOf(page, 'c')).toBe('❗');
		await icon.click();
		await page.keyboard.press('End');
		await expect(picker.getByRole('menuitem', { name: 'Remove icon' })).toHaveAttribute(
			'data-active',
			''
		);
		await page.keyboard.press('Enter');
		await expect.poll(() => iconOf(page, 'c')).toBe('');
		await expect(page.getByRole('button', { name: 'Add icon' })).toHaveCount(1);
		issues.assertClean();
	});
});
