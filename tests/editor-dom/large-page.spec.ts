/**
 * P8 — a 5,000-block page under the Notion theme with its opt-in
 * `--edytor-block-visibility: auto` (`themes/notion.css`): top-level blocks
 * carry `content-visibility: auto`, so the browser skips rendering the
 * blocks off screen. What must keep working over skipped
 * blocks, in every engine:
 *
 * - the rule applies to top-level blocks only;
 * - the native caret reaches the last block (Cmd/Ctrl+End) and typing lands
 *   there, in view (scroll-to-caret);
 * - a text selection across thousands of skipped blocks deletes them;
 * - find-in-page (`window.find`) reaches a skipped block's text;
 * - a far block's handle mounts once it nears the viewport (the handles'
 *   near band, one screen above and below, measured on the overlay's
 *   frames), aligned with its block, and drags it; only the band's blocks
 *   have one;
 * - a remote caret in a skipped block shows at its text once scrolled to.
 *
 * IME over a skipped block is the cdp lane's (`large-page.cdp.spec.ts`).
 */
import { expect, test, type Page } from './editorTest';

const open = async (page: Page, query = '') => {
	await page.goto(`/test/large?${query}`);
	await page.waitForFunction(() => '__large' in window, null, { timeout: 60_000 });
};

/** The visible view's block (a `peer=1` page holds a hidden second view). */
const block = (page: Page, id: string) =>
	page.locator(`main > [data-edytor] [data-edytor-id="${id}"]`);
const textOf = (page: Page, id: string) =>
	block(page, id).locator('[data-edytor-text="true"]').first();

/** The top-level block ids, read through the editor. */
const rootIds = (page: Page) =>
	page.evaluate(() =>
		(
			window as unknown as { __edytor: { value: { children: { id: string }[] } } }
		).__edytor.value.children.map((b) => b.id)
	);

/** The block the editor's selection value focuses. */
const focusBlock = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __edytor: any }).__edytor.selection.value.focus?.b as string
	);

const inViewport = (page: Page, id: string) =>
	page.evaluate((id) => {
		const rect = document
			.querySelector(`main > [data-edytor] [data-edytor-id="${id}"]`)!
			.getBoundingClientRect();
		return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.height > 0;
	}, id);

test.describe('P8 — a large page with content-visibility', () => {
	test.setTimeout(120_000);

	test('top-level blocks skip rendering off screen under the opt-in; the theme’s default keeps them visible', async ({
		page
	}) => {
		await open(page);
		const styleOf = (id: string) =>
			page.evaluate(
				(id) =>
					getComputedStyle(document.querySelector(`[data-edytor-id="${id}"]`)!).contentVisibility,
				id
			);
		expect(await styleOf('b0')).toBe('auto');
		expect(await styleOf('b4999')).toBe('auto');
		expect(await page.locator('[data-edytor-block="true"]').count()).toBe(5000);
		// The theme's default (no opt-in): rendered as usual.
		await open(page, 'cv=0');
		expect(await styleOf('b4999')).toBe('visible');
	});

	test('the native caret reaches the last block; typing lands there, in view', async ({ page }) => {
		await open(page, process.env.P8_CV === '0' ? 'cv=0' : '');
		await textOf(page, 'b1').click();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
		// The editor adopts the browser's caret move (its selectionchange) before the key.
		await expect.poll(() => focusBlock(page)).toBe('b4999');
		await page.keyboard.type('!');
		await expect
			.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-edytor')))
			.toBe(true);
		// (WebKit's Cmd+ArrowDown stops at the last line's start, the others at its end.)
		await expect(textOf(page, 'b4999')).toHaveText(/^!|!$/);
		// Scroll-to-caret: the caret's line is on screen, to a subpixel (the block may run past the bottom edge).
		await expect
			.poll(() =>
				page.evaluate(() => {
					const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
					return rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
				})
			)
			.toBe(true);
	});

	test('a text selection across 4,000 skipped blocks deletes them', async ({ page }) => {
		await open(page, process.env.P8_CV === '0' ? 'cv=0' : '');
		await textOf(page, 'b2').click();
		await page.keyboard.press('End');
		await block(page, 'b4002').scrollIntoViewIfNeeded();
		const target = (await textOf(page, 'b4002').boundingBox())!;
		await page.keyboard.down('Shift');
		await page.mouse.click(target.x + 2, target.y + target.height / 2);
		await page.keyboard.up('Shift');
		// The editor adopts the native range (its selectionchange), from b2 to a block 4,000 below.
		const focus = await expect
			.poll(() =>
				page.evaluate(() => {
					const value = (window as unknown as { __edytor: any }).__edytor.selection.value;
					return value.kind === 'text' && value.anchor.b === 'b2' ? value.focus.b : null;
				})
			)
			.toMatch(/^b40\d\d$/)
			.then(() =>
				page.evaluate(
					() => (window as unknown as { __edytor: any }).__edytor.selection.value.focus.b as string
				)
			);
		await page.keyboard.press('Backspace');
		const gone = Number(focus.slice(1)) - 3;
		await expect.poll(async () => (await rootIds(page)).length).toBe(5000 - gone - 1);
		const ids = await rootIds(page);
		expect(ids.slice(0, 3)).toEqual(['b0', 'b1', 'b2']);
		expect(ids).not.toContain('b3');
		expect(ids).not.toContain(focus);
		expect(ids).toContain(`b${Number(focus.slice(1)) + 1}`);
	});

	test('find-in-page reaches a skipped block’s text', async ({ page }) => {
		await open(page);
		const found = await page.evaluate(() => {
			const find = (window as unknown as { find?: (s: string) => boolean }).find;
			if (typeof find !== 'function') return null;
			return find.call(window, 'Block 4321 ');
		});
		test.skip(found === null, 'this engine has no window.find');
		expect(found).toBe(true);
		const where = await page.evaluate(() => {
			const node = window.getSelection()?.anchorNode;
			return (node instanceof Element ? node : node?.parentElement)
				?.closest('[data-edytor-block="true"]')
				?.getAttribute('data-edytor-id');
		});
		expect(where).toBe('b4321');
		// The match is shown: its block is rendered and on screen.
		await expect.poll(() => inViewport(page, 'b4321')).toBe(true);
	});

	test('handles.after-paint: an Enter paints its new block before the block’s handle mounts', async ({
		page
	}) => {
		await open(page);
		await textOf(page, 'b3000').scrollIntoViewIfNeeded();
		await textOf(page, 'b3000').click();
		await page.keyboard.press('End');
		// In the Enter's own frame, after its callbacks and layout and before its paint
		// (a ResizeObserver callback), the new block shows and its handle does not yet.
		await page.evaluate(() => {
			const w = window as unknown as { __paint: { id: string; handle: boolean } | null };
			w.__paint = null;
			const root = document.querySelector<HTMLElement>('main > [data-edytor]')!;
			const tops = () =>
				[...root.querySelectorAll<HTMLElement>(':scope > [data-edytor-block="true"]')].map(
					(n) => n.dataset.edytorId!
				);
			const before = new Set(tops());
			const observer = new ResizeObserver(() => {
				const added = tops().filter((id) => !before.has(id));
				if (!added.length || w.__paint) return;
				w.__paint = {
					id: added[0]!,
					handle: !!document.querySelector(
						`[data-edytor-block-handle-host][data-block-id="${added[0]}"]`
					)
				};
				observer.disconnect();
			});
			observer.observe(root);
		});
		await page.keyboard.press('Enter');
		const paint = await page
			.waitForFunction(() => (window as unknown as { __paint: unknown }).__paint)
			.then((h) => h.jsonValue() as Promise<{ id: string; handle: boolean }>);
		expect(paint.handle).toBe(false);
		// The task after that paint mounts it.
		await expect(
			page.locator(`[data-edytor-block-handle-host][data-block-id="${paint.id}"]`)
		).toHaveCount(1);
	});

	test('a far block’s handle mounts near the viewport, aligned with it, and drags it', async ({
		page
	}) => {
		await open(page);
		await block(page, 'b3000').scrollIntoViewIfNeeded();
		const box = (await textOf(page, 'b3001').boundingBox())!;
		await page.mouse.move(box.x + 10, box.y + box.height / 2);
		const handle = page.locator('[data-testid="block-handle"]');
		await expect.poll(() => handle.count()).toBeGreaterThan(0);
		// The hovered block's handle sits on its first text row.
		const aligned = await page.evaluate(() => {
			const text = document
				.querySelector('[data-edytor-id="b3001"] [data-edytor-text="true"]')!
				.getBoundingClientRect();
			return [...document.querySelectorAll('[data-testid="block-handle"]')].some((h) => {
				const r = h.getBoundingClientRect();
				return (
					r.width > 0 &&
					Math.abs(r.top + r.height / 2 - (text.top + 12)) <= 6 &&
					r.right <= text.left
				);
			});
		});
		expect(aligned).toBe(true);
		// Drag b3001 below b3003.
		const grip = await page.evaluate(() => {
			const text = document
				.querySelector('[data-edytor-id="b3001"] [data-edytor-text="true"]')!
				.getBoundingClientRect();
			const hit = [...document.querySelectorAll<HTMLElement>('[data-testid="block-handle"]')].find(
				(h) => Math.abs(h.getBoundingClientRect().top + 12 - (text.top + 12)) <= 6
			)!;
			const r = hit.getBoundingClientRect();
			return { x: r.right - 8, y: r.top + r.height / 2 };
		});
		const below = (await block(page, 'b3003').boundingBox())!;
		await page.mouse.move(grip.x, grip.y);
		await page.mouse.down();
		await page.mouse.move(below.x + 40, below.y + below.height * 0.8, { steps: 12 });
		await page.mouse.move(below.x + 44, below.y + below.height * 0.8, { steps: 4 });
		await page.mouse.up();
		await expect
			.poll(async () => {
				const ids = await rootIds(page);
				return ids.slice(ids.indexOf('b3000'), ids.indexOf('b3000') + 4);
			})
			.toEqual(['b3000', 'b3002', 'b3003', 'b3001']);
	});

	test('only the blocks within a screen of the viewport have a handle', async ({ page }) => {
		await open(page);
		const handled = () =>
			page.evaluate(() =>
				[...document.querySelectorAll<HTMLElement>('[data-testid="block-handle"]')].map(
					(h) => h.dataset.blockId
				)
			);
		await expect.poll(async () => (await handled()).includes('b1')).toBe(true);
		const atTop = await handled();
		// Three screens of blocks at most, of 5,000.
		expect(atTop.length).toBeLessThan(300);
		expect(atTop).not.toContain('b2500');
		await page.evaluate(() => {
			const far = document.querySelector('main > [data-edytor] [data-edytor-id="b2500"]')!;
			window.scrollTo(0, far.getBoundingClientRect().top + window.scrollY);
		});
		await expect.poll(async () => (await handled()).includes('b2500')).toBe(true);
		const there = await handled();
		expect(there).not.toContain('b1');
		expect(there.length).toBeLessThan(300);
	});

	test('a remote caret in a skipped block shows at its text once scrolled to', async ({ page }) => {
		await open(page, 'peer=1');
		await page.evaluate(() => {
			const peer = (window as unknown as { __peer: any }).__peer;
			const text = peer.idToBlock.block('b4000').firstText;
			peer.selection.setAtTextOffset(text, 6);
		});
		const cursor = page.locator('[data-edytor-remote-cursor]');
		await expect.poll(() => cursor.count()).toBeGreaterThan(0);
		await block(page, 'b4000').scrollIntoViewIfNeeded();
		await expect
			.poll(() =>
				page.evaluate(() => {
					const caret = document
						.querySelector('[data-edytor-remote-cursor]')!
						.getBoundingClientRect();
					const text = document
						.querySelector(
							'main > [data-edytor] [data-edytor-id="b4000"] [data-edytor-text="true"]'
						)!
						.getBoundingClientRect();
					return (
						caret.height > 0 &&
						caret.top >= text.top - 4 &&
						caret.bottom <= text.bottom + 4 &&
						caret.left > text.left &&
						caret.left < text.right
					);
				})
			)
			.toBe(true);
	});
});
