import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

const ALIGNMENT_TOLERANCE_PX = 3;

const readBlockAlignment = (page: Page) =>
	page.evaluate(() => {
		const blockIds = [
			'page-section',
			'page-section-intro',
			'page-callout',
			'page-bullet-one',
			'page-quote',
			'page-toggle',
			'page-code'
		];

		const firstTextLineCenter = (element: Element) => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			let leaf = walker.nextNode();
			while (leaf) {
				const content = leaf.textContent ?? '';
				const firstNonSpace = content.search(/\S/);
				if (firstNonSpace >= 0) {
					const range = document.createRange();
					range.setStart(leaf, firstNonSpace);
					range.setEnd(leaf, firstNonSpace + 1);
					const rect = range.getBoundingClientRect();
					if (rect.height > 0) return rect.top + rect.height / 2;
				}
				leaf = walker.nextNode();
			}
			throw new Error(`No visible text line in ${element.outerHTML.slice(0, 120)}`);
		};

		return blockIds.map((id) => {
			const handle = document.querySelector<HTMLElement>(
				`[data-testid="block-handle"][data-block-id="${id}"]`
			);
			const block = document.querySelector<HTMLElement>(
				`[data-edytor-block][data-edytor-id="${id}"]`
			);
			if (!handle || !block) throw new Error(`Missing handle or block ${id}`);

			const handleRect = handle.getBoundingClientRect();
			const handleCenter = handleRect.top + handleRect.height / 2;
			const line =
				id === 'page-code'
					? block.querySelector(':scope > div:first-child')
					: block.querySelector('[data-edytor-text="true"]');
			if (!line) throw new Error(`Missing visible line for ${id}`);
			const lineCenter =
				id === 'page-code'
					? (() => {
							const rect = line.getBoundingClientRect();
							return rect.top + rect.height / 2;
						})()
					: firstTextLineCenter(line);

			return { id, handleCenter, lineCenter, delta: handleCenter - lineCenter };
		});
	});

const readMenuGeometry = (page: Page, blockId: string) =>
	page.evaluate((id) => {
		const handle = document.querySelector<HTMLElement>(
			`[data-testid="block-handle"][data-block-id="${id}"]`
		);
		const menu = document.querySelector<HTMLElement>('[data-demo-block-menu]');
		if (!handle || !menu) throw new Error(`Missing handle or menu for ${id}`);
		const handleRect = handle.getBoundingClientRect();
		const menuRect = menu.getBoundingClientRect();
		return {
			xGap: menuRect.left - handleRect.right,
			yGap: menuRect.top - handleRect.top,
			handleX: handleRect.left,
			handleY: handleRect.top,
			isUnclamped:
				handleRect.right + 8 + menuRect.width < window.innerWidth - 8 &&
				handleRect.top + menuRect.height < window.innerHeight - 8
		};
	}, blockId);

const openMenu = async (page: Page, blockId: string) => {
	await page.locator(`[data-testid="block-handle"][data-block-id="${blockId}"]`).click();
	await expect(page.getByRole('menu', { name: 'Block actions' })).toBeVisible();
};

const expectMenuAligned = async (page: Page, blockId: string) => {
	const geometry = await readMenuGeometry(page, blockId);
	expect(geometry.isUnclamped).toBe(true);
	await expect
		.poll(async () => Math.abs((await readMenuGeometry(page, blockId)).xGap - 8))
		.toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
	await expect
		.poll(async () => Math.abs((await readMenuGeometry(page, blockId)).yGap))
		.toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
};

test.describe('demo block handle alignment', () => {
	test('centers handles on each block’s first visible row', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 1440, height: 1100 });
		await page.goto('/');
		await waitForEditorReady(page);
		await expect
			.poll(async () =>
				(await readBlockAlignment(page)).every(
					(row) => Math.abs(row.delta) <= ALIGNMENT_TOLERANCE_PX
				)
			)
			.toBe(true);
		const rows = await readBlockAlignment(page);
		for (const row of rows) {
			expect
				.soft(
					Math.abs(row.delta),
					`${row.id}: handle center ${row.handleCenter.toFixed(1)}px, row center ${row.lineCenter.toFixed(1)}px`
				)
				.toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
		}
		issues.assertClean();
	});

	test('keeps the open block menu beside its handle while scrolling', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 1440, height: 1100 });
		await page.goto('/');
		await waitForEditorReady(page);
		await page.evaluate(() => {
			const main = document.querySelector<HTMLElement>('.demo-main');
			if (!main) throw new Error('Missing demo main container');
			main.style.paddingBottom = '1200px';
		});
		await openMenu(page, 'page-intro');
		await expectMenuAligned(page, 'page-intro');
		const before = await readMenuGeometry(page, 'page-intro');
		await page.evaluate(() => window.scrollBy(0, 80));
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(40);
		await expect
			.poll(async () => (await readMenuGeometry(page, 'page-intro')).handleY)
			.toBeLessThan(before.handleY - 40);
		await expectMenuAligned(page, 'page-intro');
		issues.assertClean();
	});

	test('keeps the open block menu beside its handle after viewport resize', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 1440, height: 1100 });
		await page.goto('/');
		await waitForEditorReady(page);
		await openMenu(page, 'page-intro');
		await expectMenuAligned(page, 'page-intro');
		const before = await readMenuGeometry(page, 'page-intro');
		await page.setViewportSize({ width: 1200, height: 1100 });
		await expect
			.poll(async () => (await readMenuGeometry(page, 'page-intro')).handleX)
			.toBeLessThan(before.handleX - 40);
		await expectMenuAligned(page, 'page-intro');
		issues.assertClean();
	});

	test('realigns a handle after its block moves', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 1440, height: 1100 });
		await page.goto('/');
		await waitForEditorReady(page);
		await openMenu(page, 'page-section');
		await page.getByRole('menuitem', { name: 'Move down' }).click();
		await expect
			.poll(async () => {
				const section = (await readBlockAlignment(page)).find((row) => row.id === 'page-section');
				return Math.abs(section?.delta ?? Infinity);
			})
			.toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
		issues.assertClean();
	});

	test('aligns a handle when a readonly editor becomes editable', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=callout&handles=true&dynamicReadonly=true&readonly=true');
		await waitForEditorReady(page, { requireRuntime: true });
		const handle = page.getByTestId('block-handle').first();
		await expect(handle).toBeHidden();
		await page.getByTestId('toggle-readonly').click();
		await expect(handle).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => {
					const handle = document.querySelector<HTMLElement>('[data-testid="block-handle"]');
					const line =
						handle?.parentElement?.nextElementSibling?.querySelector('[data-edytor-text]');
					if (!handle || !line) return Infinity;
					const handleRect = handle.getBoundingClientRect();
					const lineRect = line.getClientRects()[0];
					if (!lineRect) return Infinity;
					return Math.abs(
						handleRect.top + handleRect.height / 2 - (lineRect.top + lineRect.height / 2)
					);
				})
			)
			.toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
		issues.assertClean();
	});

	test('keeps a flipped menu in a narrow viewport and scrolls focused actions into view', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.setViewportSize({ width: 390, height: 500 });
		await page.goto('/');
		await waitForEditorReady(page);
		await openMenu(page, 'page-title');
		await page.keyboard.press('End');
		await expect
			.poll(() =>
				page.evaluate(() => {
					const menu = document.querySelector<HTMLElement>('[data-demo-block-menu]');
					const focused = document.activeElement;
					if (!menu || !(focused instanceof HTMLElement)) return false;
					const menuRect = menu.getBoundingClientRect();
					const focusedRect = focused.getBoundingClientRect();
					return (
						menuRect.left >= 7 &&
						menuRect.right <= innerWidth - 7 &&
						menuRect.top >= 7 &&
						menuRect.bottom <= innerHeight - 7 &&
						focused.textContent?.includes('Delete') &&
						focusedRect.top >= menuRect.top &&
						focusedRect.bottom <= menuRect.bottom &&
						menu.scrollTop > 0
					);
				})
			)
			.toBe(true);
		issues.assertClean();
	});
});
