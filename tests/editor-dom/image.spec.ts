/**
 * WU-21 — the image chrome in real browsers (Notion's): hovering an image
 * shows a resize handle on each side; a drag resizes it live and its
 * release writes `data.width` (one undo step); a centered image grows on
 * both sides, a left-aligned one from its right; Escape drops the drag.
 * A pasted or dropped image file shows its upload, then the image. Expected values
 * come from the plan (WU-21) and Notion, not from running the code.
 */
import { expect, test, type Page } from './editorTest';
import {
	getCaretPoint,
	modKey,
	readJsonByTestId,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

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

	test('a click in the text closes the alt field', async ({ page }) => {
		await open(page);
		await page.locator('[data-edytor-image] img').first().hover();
		await page.locator('[data-edytor-image-alt-toggle]').click();
		await expect(page.locator('[data-edytor-image-alt]')).toBeFocused();
		await page.locator('[data-edytor-image] + figcaption').first().click();
		await expect(page.locator('[data-edytor-image-alt-panel]')).toHaveCount(0);
		// The pointer left the image: the chrome is no longer held on it.
		await page.mouse.move(1, 1);
		await expect(page.locator('[data-edytor-image-toolbar]')).toHaveCount(0);
	});
});

/** The model caret, as `[block id, offset]`. */
const modelCaret = (page: Page) =>
	page.evaluate(() => {
		const caret = (window as Window & { __EDYTOR__?: any }).__EDYTOR__?.selection.caret;
		return caret ? [caret.block.id as string, caret.offset as number] : null;
	});

/**
 * Record every caret the page reports from the next press on: the DOM
 * selection at each `selectionchange`, as its offset in the image's
 * caption (`null` outside it) and the model caret at that moment.
 */
const recordCarets = (page: Page) =>
	page.evaluate(() => {
		const w = window as Window & { __EDYTOR__?: any; __carets?: unknown[] };
		const caption = document.querySelector<HTMLElement>(
			'[data-edytor-type="image"] [data-edytor-text="true"]'
		)!;
		let pressed = false;
		w.__carets = [];
		window.addEventListener('pointerdown', () => (pressed = true), { capture: true });
		document.addEventListener('selectionchange', () => {
			if (!pressed) return;
			const selection = document.getSelection()!;
			const { anchorNode, anchorOffset } = selection;
			let offset: number | null = null;
			if (anchorNode && caption.contains(anchorNode)) {
				const range = document.createRange();
				range.setStart(caption, 0);
				range.setEnd(anchorNode, anchorOffset);
				offset = range.toString().length;
			}
			const caret = w.__EDYTOR__?.selection.caret;
			w.__carets!.push({ offset, model: caret ? [caret.block.id, caret.offset] : null });
		});
	});
const recorded = (page: Page) =>
	page.evaluate(
		() =>
			(window as Window & { __carets?: unknown[] }).__carets as {
				offset: number | null;
				model: [string, number] | null;
			}[]
	);

test.describe('a press in an image (sel.press.nested-editable, sel.press.void)', () => {
	test('a click in the middle of the caption puts the caret there in one step', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const caption = page.locator('[data-edytor-type="image"] [data-edytor-text="true"]');
		await expect(caption).toHaveText('caption');
		await caption.scrollIntoViewIfNeeded();
		const point = await getCaretPoint(page, 0, 4);
		await recordCarets(page);
		await page.mouse.move(point.x, point.y);
		await page.mouse.down();
		// The press's own caret is reported before the release (a user holds the button).
		await expect.poll(async () => (await recorded(page)).length).toBeGreaterThan(0);
		await page.mouse.up();
		await expect.poll(() => modelCaret(page)).toEqual(['img', 4]);
		// Every caret reported from the press to the release, and after it, is
		// the click's: never the caption's start, never the document's.
		const carets = await recorded(page);
		expect(carets.length).toBeGreaterThan(0);
		expect(carets.map((c) => c.offset)).toEqual(carets.map(() => 4));
		expect(carets.filter((c) => c.model).every((c) => c.model![1] === 4)).toBe(true);
		await page.keyboard.type('X');
		await expect(caption).toHaveText('captXion');
		issues.assertClean();
	});

	test('a press on the image selects its block, no caret in the caption; Delete removes it (sel.press.void)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const img = page.locator('[data-edytor-image] img').first();
		await img.scrollIntoViewIfNeeded();
		const image = (await img.boundingBox())!;
		await recordCarets(page);
		await page.mouse.click(image.x + image.width / 2, image.y + image.height / 2);
		await expect
			.poll(() =>
				page.evaluate(() => (window as Window & { __EDYTOR__?: any }).__EDYTOR__?.selection.value)
			)
			.toMatchObject({ kind: 'blocks', ids: ['img'] });
		await expect(page.locator('[data-edytor-id="img"][data-edytor-block]')).toHaveAttribute(
			'data-edytor-selected',
			'true'
		);
		expect(await modelCaret(page)).toBeNull();
		// No caret ever reported in the caption from the press on.
		expect((await recorded(page)).filter((c) => c.offset !== null)).toEqual([]);
		await page.keyboard.press('Delete');
		await expect(page.locator('[data-edytor-type="image"]')).toHaveCount(0);
		issues.assertClean();
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

	test('a dropped image file lands where the indicator shows, uploads, one step', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		// The drop point: the lower half of `after image`'s row, in its text column
		// (`drop.files.place`: after it).
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
				for (const type of ['dragenter', 'dragover', 'drop'] as const) {
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
			{ x: box.x + 2, y: box.y + box.height * 0.75 }
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
				{ type: 'image', src: 'data:image/png;' }
			]);
		await expect(page.locator('[data-edytor-image-uploading]')).toHaveCount(0);
		await page.keyboard.press(`${modKey}+z`);
		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children.length)
			.toBe(2);
		issues.assertClean();
	});

	test('a dropped image shows at once from the file while a slow upload runs, then the uploaded URL', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => Object.assign(window, { __EDYTOR_UPLOAD_HOLD__: true }));
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
				for (const type of ['dragenter', 'dragover', 'drop'] as const) {
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
			{ x: box.x + 2, y: box.y + box.height * 0.75 }
		);
		// Before the upload answers: the file itself, from its object URL, never stored.
		const preview = page.locator('[data-edytor-image-uploading] img');
		await expect(preview).toHaveAttribute('src', /^blob:/);
		await expect
			.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
			.toBe(true);
		const pending = await readJsonByTestId<Value>(page, 'value');
		expect(pending.children.map((block) => block.data?.src?.toString().slice(0, 5))).toEqual([
			'data:',
			undefined,
			undefined
		]);
		await page.evaluate(() =>
			(window as { __EDYTOR_RELEASE_UPLOADS__?: () => void }).__EDYTOR_RELEASE_UPLOADS__?.()
		);
		await expect(page.locator('[data-edytor-image-uploading]')).toHaveCount(0);
		await expect(page.locator('[data-edytor-image] img').last()).toHaveAttribute(
			'src',
			/^data:image\/png;/
		);
		issues.assertClean();
	});

	test('an image and a PDF dropped together: an image block and a file block, one step', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
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
				transfer.items.add(new File(['%PDF-1.4'], 'notes.pdf', { type: 'application/pdf' }));
				const editor = document.querySelector('[data-edytor]')!;
				for (const type of ['dragenter', 'dragover', 'drop'] as const) {
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
			{ x: box.x + 2, y: box.y + box.height * 0.75 }
		);
		await expect(page.locator('[data-edytor-media-uploading] progress')).toHaveCount(1);
		await expect
			.poll(async () => {
				const value = await readJsonByTestId<Value>(page, 'value');
				return value.children.map((block) => ({
					type: block.type,
					src: typeof block.data?.src === 'string' ? block.data.src.slice(0, 5) : undefined,
					name: block.data?.name
				}));
			})
			.toEqual([
				{ type: 'image', src: 'data:', name: undefined },
				{ type: 'paragraph', src: undefined, name: undefined },
				{ type: 'image', src: 'data:', name: undefined },
				{ type: 'file', src: 'blob:', name: 'notes.pdf' }
			]);
		await expect(page.locator('[data-edytor-file-name]')).toHaveText('notes.pdf');
		await page.keyboard.press(`${modKey}+z`);
		await expect
			.poll(async () => (await readJsonByTestId<Value>(page, 'value')).children.length)
			.toBe(2);
		issues.assertClean();
	});
});
