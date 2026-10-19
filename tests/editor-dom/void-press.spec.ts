/**
 * A press on a void block's chrome (`sel.press.void`, Notion): the block is
 * selected, no caret placed; a control inside keeps its whole press (a
 * native control, an interactive role, an element the app marks
 * `data-edytor-control`, a link: a bookmark's card and a file's row open
 * on a plain click). The image rows are in `image.spec.ts`; the jsdom rows in
 * `src/tests/fixtures/dom/selectstart-guard.test.tsx`.
 */
import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

const media = [
	{ id: 'p', type: 'paragraph', content: [{ text: 'Before' }] },
	{ id: 'bm', type: 'bookmark', data: { url: 'https://example.com/', title: 'Example' } },
	{ id: 'f', type: 'file', data: { src: 'https://example.com/report.pdf', name: 'report.pdf' } },
	{ id: 'q', type: 'paragraph', content: [{ text: 'After' }] }
];

const open = async (page: Page) => {
	await page.goto(
		`/test/dom?scenario=dst&media=1&uploads=1&dst=${encodeURIComponent(JSON.stringify({ children: media }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};
const value = (page: Page) =>
	page.evaluate(() => (window as Window & { __EDYTOR__?: any }).__EDYTOR__?.selection.value);
const center = async (page: Page, selector: string) => {
	const target = page.locator(selector).first();
	await target.scrollIntoViewIfNeeded();
	const box = (await target.boundingBox())!;
	return [box.x + box.width / 2, box.y + box.height / 2] as const;
};

test.describe('a press on a void block (sel.press.void)', () => {
	for (const [name, id, selector, url] of [
		['a bookmark card', 'bm', '[data-edytor-bookmark] a', 'https://example.com/'],
		['a file row', 'f', '[data-edytor-file] a', 'https://example.com/report.pdf']
	] as const) {
		test(`a plain click on ${name} opens its link and selects nothing`, async ({
			page,
			context
		}) => {
			await open(page);
			const opened: string[] = [];
			context.on('page', (tab) => opened.push(tab.url()));
			// The new tab opens nothing on the network: the request is answered here.
			await context.route('https://example.com/**', (route) =>
				route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' })
			);
			const [x, y] = await center(page, selector);
			await page.mouse.click(x, y);
			await expect.poll(() => opened.length).toBe(1);
			expect(opened[0]).toContain(url.replace('https://', ''));
			await expect(page.locator(`[data-edytor-id="${id}"][data-edytor-block]`)).not.toHaveAttribute(
				'data-edytor-selected',
				'true'
			);
			expect((await value(page))?.kind).not.toBe('blocks');
		});
	}
});

test.describe('controls inside a void block keep their press (the demo widget)', () => {
	const openDemo = async (page: Page) => {
		await page.goto(`/?doc=void-press-${test.info().project.name}-${Date.now()}`);
		await expect(page.locator('[data-edytor-type="widget"] button')).toBeVisible();
	};
	const widget = '[data-edytor-type="widget"]';

	test('its button and its marked element get their clicks, its input types; the empty area selects it', async ({
		page
	}) => {
		await openDemo(page);
		const block = page.locator(`${widget}[data-edytor-block]`);
		await page.locator(`${widget} button`).click();
		await expect(page.locator(`${widget} button`)).toHaveText('Clicked 1 times');
		await expect(block).not.toHaveAttribute('data-edytor-selected', 'true');
		await page.locator(`${widget} input`).click();
		await page.keyboard.type('note');
		await expect(page.locator(`${widget} input`)).toHaveValue('note');
		await expect(page.locator(`${widget} input`)).toBeFocused();
		await page.locator(`${widget} [data-edytor-control]`).click();
		await expect(page.locator(`${widget} [data-edytor-control]`)).toContainText('1 taps');
		await expect(block).not.toHaveAttribute('data-edytor-selected', 'true');
		// The card's empty area: the block is selected, the host focused.
		const hintArea = page.locator(`${widget} .demo-widget-hint`);
		await hintArea.scrollIntoViewIfNeeded();
		const hint = (await hintArea.boundingBox())!;
		await page.mouse.click(hint.x + hint.width - 4, hint.y + hint.height / 2);
		await expect(block).toHaveAttribute('data-edytor-selected', 'true');
		await expect(page.locator('[data-edytor]')).toBeFocused();
		// The caption is the browser's: a click there types at the click.
		const caption = page.locator(`${widget} [data-edytor-text="true"]`);
		await caption.click();
		await page.keyboard.press('End');
		await page.keyboard.type('!');
		await expect(caption).toHaveText('The widget’s caption!');
		await expect(block).not.toHaveAttribute('data-edytor-selected', 'true');
	});

	/** Count every `data-selecting="true"` the page shows from now on (the editor's text drag state). */
	const watchSelecting = (page: Page) =>
		page.evaluate(() => {
			const w = window as Window & { __selecting?: number };
			w.__selecting = document.querySelectorAll('[data-selecting="true"]').length;
			new MutationObserver((records) => {
				for (const record of records)
					if ((record.target as Element).getAttribute('data-selecting') === 'true')
						w.__selecting!++;
			}).observe(document.body, {
				subtree: true,
				attributes: true,
				attributeFilter: ['data-selecting']
			});
		});
	const selecting = (page: Page) =>
		page.evaluate(() => (window as Window & { __selecting?: number }).__selecting);
	const selectedBlocks = (page: Page) => page.locator('[data-edytor-selected="true"]').count();

	test('fast clicks on its button are the button’s: no text drag, no block selection', async ({
		page,
		browserName
	}) => {
		await openDemo(page);
		await watchSelecting(page);
		const button = page.locator(`${widget} button`);
		await button.click();
		await button.click();
		// A triple click: three clicks of one gesture (detail 1, 2, 3).
		await button.click({ clickCount: 3 });
		await expect(button).toHaveText('Clicked 5 times');
		expect(await selecting(page)).toBe(0);
		expect(await selectedBlocks(page)).toBe(0);
		// WebKit never focuses a button a click presses (as Safari).
		if (browserName !== 'webkit') await expect(button).toBeFocused();
	});

	test('a triple click in its input selects the input’s own text; its marked element counts its clicks', async ({
		page
	}) => {
		await openDemo(page);
		await watchSelecting(page);
		const input = page.locator(`${widget} input`);
		await input.click();
		await page.keyboard.type('one two');
		await input.click({ clickCount: 3 });
		expect(
			await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])
		).toEqual([0, 7]);
		await expect(input).toBeFocused();
		const custom = page.locator(`${widget} [data-edytor-control]`);
		await custom.click();
		await custom.click({ clickCount: 2 });
		await custom.click({ clickCount: 2 });
		await expect(custom).toContainText('5 taps');
		expect(await selecting(page)).toBe(0);
		expect(await selectedBlocks(page)).toBe(0);
		await expect(input).toHaveValue('one two');
	});
});
