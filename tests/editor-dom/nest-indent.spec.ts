import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * One nesting step under any kind (Notion): a paragraph nested under a
 * paragraph, a heading or a quote starts one step (24px, plus the child's
 * own 2px gutter in the Notion theme) right of its parent's text, through
 * the `data-edytor-children` container's `--edytor-nest-indent`. Lists,
 * to-dos, toggles and callouts, which already indent through their marker
 * column or padding, keep their children in their text column, unchanged.
 * The marker rows are `children-container.test.tsx`.
 */

const kid = (id: string) => ({ id, type: 'paragraph', content: [{ text: id }] });
const parent = (id: string, type: string, data?: Record<string, unknown>) => ({
	id,
	type,
	...(data && { data }),
	content: [{ text: `${id} text` }],
	children: [kid(`${id}-child`)]
});
const children = [
	parent('P', 'paragraph'),
	parent('H', 'heading', { level: 'h2' }),
	parent('Q', 'quote'),
	parent('L', 'bulleted-list-item'),
	parent('D', 'todo-item', { checked: false }),
	parent('T', 'toggle'),
	parent('C', 'callout', { icon: '💡' })
];

const open = async (page: Page) => {
	await page.goto(`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify({ children }))}`);
	await waitForEditorReady(page, { requireRuntime: true });
};

const notionTheme = async (page: Page) => {
	await page.addStyleTag({
		content: readFileSync(new URL('../../src/lib/themes/notion.css', import.meta.url), 'utf8')
	});
	await page.locator('[data-edytor]').evaluate((node) => node.classList.add('edytor-notion'));
};

/** How far right of each parent's own text its nested paragraph's text starts. */
const offsets = (page: Page) =>
	page.evaluate(() => {
		const textLeft = (id: string) => {
			const block = document.querySelector(`[data-edytor-id="${id}"]`)!;
			return block.querySelector('[data-edytor-text="true"]')!.getClientRects()[0]!.left;
		};
		return Object.fromEntries(
			['P', 'H', 'Q', 'L', 'D', 'T', 'C'].map((id) => [
				id,
				Math.round(textLeft(`${id}-child`) - textLeft(id))
			])
		);
	});

test.describe('nesting indentation', () => {
	test('the Notion theme: one step under a paragraph, heading or quote; lists unchanged', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await notionTheme(page);
		const measured = await offsets(page);
		test.info().annotations.push({ type: 'offsets', description: JSON.stringify(measured) });
		// 24px step + the child's own 2px gutter.
		for (const id of ['P', 'H', 'Q']) expect(Math.abs(measured[id]! - 24)).toBeLessThanOrEqual(3);
		// In the text column, as before: the child's own 2px gutter only.
		expect([measured.L, measured.D, measured.T, measured.C]).toEqual([2, 2, 2, 2]);
		issues.assertClean();
	});

	test('the default styles: one step under every kind', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const measured = await offsets(page);
		test.info().annotations.push({ type: 'offsets', description: JSON.stringify(measured) });
		for (const id of ['P', 'H', 'Q', 'C']) expect(measured[id]).toBe(24);
		issues.assertClean();
	});

	test('the step follows --edytor-nest-indent', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await notionTheme(page);
		await page.locator('[data-edytor]').evaluate((node) => {
			node.style.setProperty('--edytor-nest-indent', '40px');
		});
		const measured = await offsets(page);
		expect([measured.P, measured.H, measured.Q, measured.L]).toEqual([42, 42, 42, 2]);
		issues.assertClean();
	});
});
