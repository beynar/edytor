/**
 * `drop.files.place` in real browsers (Notion's): files dragged from outside
 * over the view show the block drag's drop indicator where they land (the
 * lower half of a block's own row: a bar under it), a drag moving off the
 * view or leaving the window clears it, and the drop places one block per file there, each of the kind
 * that takes it, one undo step. A synthetic `DataTransfer` holding `File`s,
 * dispatched as `dragenter`/`dragover`/`drop` at coordinates (no engine
 * drags real files under automation). Expected values come from the
 * contract row and Notion, not from running the code.
 */
import { expect, test, type Page } from './editorTest';
import { modKey, readJsonByTestId, trackPageIssues, waitForEditorReady } from './helpers';

type Value = { children: Array<{ type: string; data?: Record<string, unknown> }> };

const types = async (page: Page) =>
	(await readJsonByTestId<Value>(page, 'value')).children.map((block) => block.type);

/**
 * Dispatch `events` with a transfer of a PNG and a PDF at (x, y) on the host
 * (on the page around it with `onPage`). A `dragleave` has no related
 * target: the drag leaves the window.
 */
const dragFiles = (
	page: Page,
	events: string[],
	at: { x: number; y: number },
	onPage = false,
	files: Pick[] = ['png', 'pdf']
) =>
	page.evaluate(
		({ events, x, y, onPage, files }) => {
			const bytes = Uint8Array.from(
				atob(
					'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
				),
				(c) => c.charCodeAt(0)
			);
			const transfer = new DataTransfer();
			if (files.includes('png'))
				transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
			if (files.includes('pdf'))
				transfer.items.add(new File(['%PDF-1.4'], 'notes.pdf', { type: 'application/pdf' }));
			const editor = onPage ? document.body : document.querySelector('[data-edytor]')!;
			for (const type of events) {
				const event = new DragEvent(type, {
					bubbles: true,
					cancelable: true,
					dataTransfer: transfer,
					clientX: x,
					clientY: y,
					relatedTarget: null
				});
				if (event.dataTransfer !== transfer)
					Object.defineProperty(event, 'dataTransfer', { value: transfer });
				editor.dispatchEvent(event);
			}
		},
		{ events, ...at, onPage, files }
	);

/** The lower half of the last block's own row, just inside its text column. */
const lowerHalfOfLast = async (page: Page) => {
	const text = (await page.locator('[data-edytor-text="true"]').last().boundingBox())!;
	return { x: text.x + 2, y: text.y + text.height * 0.75, bottom: text.y + text.height };
};

test.describe('drop.files.place', () => {
	test('files dragged over a block show the indicator under it; dropped, they land there, one step', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=image');
		await waitForEditorReady(page);
		await expect.poll(() => types(page)).toEqual(['image', 'paragraph']);
		const at = await lowerHalfOfLast(page);
		const block = (await page.locator('[data-edytor-block="true"]').last().boundingBox())!;

		await dragFiles(page, ['dragenter', 'dragover'], at);
		const bar = page.locator('[data-edytor-drop-indicator]');
		await expect(bar).toHaveCount(1);
		await expect(bar).toHaveAttribute('data-position', 'after');
		const box = (await bar.boundingBox())!;
		// The bar centred on the block's bottom edge, across its width.
		expect(Math.abs(box.y + box.height / 2 - (block.y + block.height))).toBeLessThanOrEqual(2);
		expect(Math.abs(box.x - block.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(box.width - block.width)).toBeLessThanOrEqual(1);

		await dragFiles(page, ['drop'], at);
		await expect(bar).toHaveCount(0);
		await expect.poll(() => types(page)).toEqual(['image', 'paragraph', 'image', 'file']);
		await expect(page.locator('[data-edytor-file-name]')).toHaveText('notes.pdf');
		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(() => types(page)).toEqual(['image', 'paragraph']);
		issues.assertClean();
	});

	test('a drag moving off the view, to the page around it, clears the indicator', async ({
		page
	}) => {
		await page.goto('/test/dom?scenario=image');
		await waitForEditorReady(page);
		const at = await lowerHalfOfLast(page);
		await dragFiles(page, ['dragenter', 'dragover'], at);
		await expect(page.locator('[data-edytor-drop-indicator]')).toHaveCount(1);
		await dragFiles(page, ['dragenter', 'dragover'], at, true);
		await expect(page.locator('[data-edytor-drop-indicator]')).toHaveCount(0);
		await expect(page.locator('[data-edytor-block-drop-position]')).toHaveCount(0);
		await dragFiles(page, ['dragleave'], at, true);
		await expect.poll(() => types(page)).toEqual(['image', 'paragraph']);
	});

	test('a drag leaving the window clears the indicator', async ({ page }) => {
		await page.goto('/test/dom?scenario=image');
		await waitForEditorReady(page);
		const at = await lowerHalfOfLast(page);
		await dragFiles(page, ['dragenter', 'dragover'], at);
		await expect(page.locator('[data-edytor-drop-indicator]')).toHaveCount(1);
		await dragFiles(page, ['dragleave'], at);
		await expect(page.locator('[data-edytor-drop-indicator]')).toHaveCount(0);
		await expect(page.locator('[data-edytor-block-drop-position]')).toHaveCount(0);
		await expect.poll(() => types(page)).toEqual(['image', 'paragraph']);
	});

	test.describe("with only an image uploader, the line reads the dragged files' types", () => {
		const open = async (page: Page) => {
			await page.goto('/test/dom?uploads=image');
			await waitForEditorReady(page);
			return { before: await types(page), at: await lowerHalfOfLast(page) };
		};
		const bar = (page: Page) => page.locator('[data-edytor-drop-indicator]');

		test('a PDF shows no line and inserts nothing', async ({ page }) => {
			const { before, at } = await open(page);
			await dragFiles(page, ['dragenter', 'dragover'], at, false, ['pdf']);
			await page.evaluate(() => new Promise(requestAnimationFrame));
			await expect(bar(page)).toHaveCount(0);
			await dragFiles(page, ['drop'], at, false, ['pdf']);
			await page.evaluate(() => new Promise(requestAnimationFrame));
			expect(await types(page)).toEqual(before);
		});

		test('a PNG shows the line and inserts an image there', async ({ page }) => {
			const { before, at } = await open(page);
			await dragFiles(page, ['dragenter', 'dragover'], at, false, ['png']);
			await expect(bar(page)).toHaveAttribute('data-position', 'after');
			await dragFiles(page, ['drop'], at, false, ['png']);
			await expect.poll(() => types(page)).toEqual([...before, 'image']);
		});

		test('mixed files: the line shows where the image fits, and only it lands', async ({
			page
		}) => {
			const { before, at } = await open(page);
			await dragFiles(page, ['dragenter', 'dragover'], at);
			await expect(bar(page)).toHaveAttribute('data-position', 'after');
			await dragFiles(page, ['drop'], at);
			await expect.poll(() => types(page)).toEqual([...before, 'image']);
		});
	});
});
