/**
 * WU-21 — the image chrome in real browsers (Notion's): hovering an image
 * shows a resize handle on each side; a drag resizes it live and its
 * release writes `data.width` (one undo step); a centered image grows on
 * both sides, a left-aligned one from its right; Escape drops the drag.
 * A pasted or dropped image file shows its upload, then the image. Expected values
 * come from the plan (WU-21) and Notion, not from running the code.
 */
import { expect, test, type Page } from './editorTest';
import { modKey, readJsonByTestId, trackPageIssues, waitForEditorReady } from './helpers';

type Value = { children: Array<{ type: string; data?: Record<string, unknown> }> };

const imageData = async (page: Page) =>
	(await readJsonByTestId<Value>(page, 'value')).children[0]?.data ?? {};

const imageWidth = (page: Page) =>
	page
		.locator('[data-edytor-image] img')
		.first()
		.evaluate((img) => img.getBoundingClientRect().width);

const open = async (page: Page) => {
	await page.goto('/test/dom?scenario=image');
	await waitForEditorReady(page);
	await expect.poll(() => imageWidth(page)).toBe(400);
};

/** Hover the image, then drag the `side` handle by `dx` px (Escape before the release with `cancel`). */
const dragHandle = async (page: Page, side: 'left' | 'right', dx: number, cancel = false) => {
	await page.locator('[data-edytor-image] img').first().hover();
	const handle = page.locator(`[data-edytor-image-resize="${side}"]`);
	await expect(handle).toBeVisible();
	const box = (await handle.boundingBox())!;
	const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx / 2, y, { steps: 4 });
	await page.mouse.move(x + dx, y, { steps: 4 });
	if (cancel) await page.keyboard.press('Escape');
	await page.mouse.up();
};

test.describe('image resize (WU-21)', () => {
	test('a centered image grows on both sides: twice the move, one undo step', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await dragHandle(page, 'right', -100);
		await expect.poll(() => imageData(page)).toMatchObject({ width: 200 });
		await expect.poll(() => imageWidth(page)).toBe(200);
		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(async () => (await imageData(page)).width).toBeUndefined();
		await expect.poll(() => imageWidth(page)).toBe(400);
		issues.assertClean();
	});

	test('a left-aligned image resizes from the handle it is dragged by', async ({ page }) => {
		await open(page);
		await page.locator('[data-edytor-image] img').first().hover();
		await page.locator('[data-edytor-image-align="left"]').click();
		await expect.poll(() => imageData(page)).toMatchObject({ align: 'left' });
		await dragHandle(page, 'left', 60);
		await expect.poll(() => imageData(page)).toMatchObject({ width: 340, align: 'left' });
		await expect.poll(() => imageWidth(page)).toBe(340);
	});

	test('Escape drops the drag: nothing is written', async ({ page }) => {
		await open(page);
		await dragHandle(page, 'right', -100, true);
		await expect.poll(() => imageWidth(page)).toBe(400);
		expect((await imageData(page)).width).toBeUndefined();
	});

	test('the alt field sets the image alt', async ({ page }) => {
		await open(page);
		await page.locator('[data-edytor-image] img').first().hover();
		await page.locator('[data-edytor-image-alt-toggle]').click();
		const field = page.locator('[data-edytor-image-alt]');
		await expect(field).toBeFocused();
		await page.keyboard.type('A blue box');
		await page.keyboard.press('Enter');
		await expect.poll(() => imageData(page)).toMatchObject({ alt: 'A blue box' });
		await expect(page.locator('[data-edytor-image] img').first()).toHaveAttribute(
			'alt',
			'A blue box'
		);
	});
});

test.describe('image file paste and drop (WU-21)', () => {
	test('a pasted image file shows its upload, then the image', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		// The caret at the end of `after image`.
		await page.locator('[data-edytor-text="true"]').last().click();
		await page.keyboard.press('End');
		await page.evaluate(() => {
			// A 1×1 PNG.
			const bytes = Uint8Array.from(
				atob(
					'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
				),
				(c) => c.charCodeAt(0)
			);
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
			const event = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: transfer });
			document.querySelector('[data-edytor]')!.dispatchEvent(event);
		});
		await expect(page.locator('[data-edytor-image-uploading]')).toHaveCount(1);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<Value>(page, 'value');
				return value.children.map((block) => ({
					type: block.type,
					src: typeof block.data?.src === 'string' ? block.data.src.slice(0, 15) : undefined
				}));
			})
			.toEqual([
				{ type: 'image', src: 'data:image/svg+' },
				{ type: 'paragraph', src: undefined },
				{ type: 'image', src: 'data:image/png;' },
				{ type: 'paragraph', src: undefined }
			]);
		await expect(page.locator('[data-edytor-image-uploading]')).toHaveCount(0);
		// One step: the undo takes the pasted image back whole.
		await page.keyboard.press(`${modKey}+z`);
		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children.length)
			.toBe(2);
		issues.assertClean();
	});

	test('a dropped image file lands at the drop point, uploads, one step', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		// The drop point: the end of `after image` (the text element spans its line).
		const box = (await page.locator('[data-edytor-text="true"]').last().boundingBox())!;
		await page.evaluate(
			({ x, y }) => {
				const bytes = Uint8Array.from(
					atob(
						'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
					),
					(c) => c.charCodeAt(0)
				);
				const transfer = new DataTransfer();
				transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
				const editor = document.querySelector('[data-edytor]')!;
				for (const type of ['dragover', 'drop'] as const) {
					const event = new DragEvent(type, {
						bubbles: true,
						cancelable: true,
						dataTransfer: transfer,
						clientX: x,
						clientY: y
					});
					if (event.dataTransfer !== transfer)
						Object.defineProperty(event, 'dataTransfer', { value: transfer });
					editor.dispatchEvent(event);
				}
			},
			{ x: box.x + box.width - 4, y: box.y + box.height / 2 }
		);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<Value>(page, 'value');
				return value.children.map((block) => ({
					type: block.type,
					src: typeof block.data?.src === 'string' ? block.data.src.slice(0, 15) : undefined
				}));
			})
			.toEqual([
				{ type: 'image', src: 'data:image/svg+' },
				{ type: 'paragraph', src: undefined },
				{ type: 'image', src: 'data:image/png;' },
				{ type: 'paragraph', src: undefined }
			]);
		await expect(page.locator('[data-edytor-image-uploading]')).toHaveCount(0);
		await page.keyboard.press(`${modKey}+z`);
		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children.length)
			.toBe(2);
		issues.assertClean();
	});
});
