import { expect, test, type Page } from './editorTest';
import { setSelectionByTextIndex, trackPageIssues } from './helpers';

const handle = (page: Page, id: string) =>
	page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);

const openBlockMenu = async (page: Page, id: string) => {
	await handle(page, id).click();
	await expect(page.getByRole('menu', { name: 'Block actions' })).toBeVisible();
};

/** Notion's "Turn into": the block menu's flyout. */
const turnInto = async (page: Page, id: string, label: string) => {
	await openBlockMenu(page, id);
	await page.getByTestId('block-menu-turn').hover();
	await page
		.getByRole('menu', { name: 'Turn into' })
		.getByRole('menuitem', { name: label, exact: true })
		.click();
};

const rootOrder = (page: Page) =>
	page
		.locator('[data-edytor] > [data-edytor-block="true"]')
		.evaluateAll((blocks) => blocks.map((block) => block.getAttribute('data-edytor-id')));

test.describe('document demo', () => {
	test('keeps code line hover consistent with the code surface', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		const line = page.locator('[data-edytor-id="page-code-line"]');
		await expect(line).toBeVisible();
		const background = await line.evaluate((node) => getComputedStyle(node).backgroundColor);
		await line.hover();
		await expect
			.poll(() => line.evaluate((node) => getComputedStyle(node).backgroundColor))
			.toBe(background);
		issues.assertClean();
	});

	test('the block menu keeps its block selected, then returns to text', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		const block = page.locator('[data-edytor-id="page-section-intro"]');
		// Notion: the block stays highlighted while its menu is open…
		await openBlockMenu(page, 'page-section-intro');
		await expect(block).toHaveAttribute('data-edytor-selected', 'true');
		await page.getByTestId('block-menu-turn').hover();
		await page
			.getByRole('menu', { name: 'Turn into' })
			.getByRole('menuitem', { name: 'Heading 3', exact: true })
			.click();
		// …and an action returns to a text caret in it.
		await expect(block).not.toHaveAttribute('data-edytor-selected', 'true');
		await expect
			.poll(() =>
				block.evaluate((node) => node.contains(window.getSelection()?.anchorNode ?? null))
			)
			.toBe(true);
		issues.assertClean();
	});

	test('places a dragged block on a new line inside a bullet', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		const target = page.locator('[data-edytor-id="page-bullet-two"]');
		const targetBox = await target.boundingBox();
		if (!targetBox) throw new Error('Missing bullet target');
		await handle(page, 'page-section-intro').dragTo(target, {
			targetPosition: { x: Math.min(80, targetBox.width / 2), y: targetBox.height / 2 }
		});
		const child = target.locator('[data-edytor-id="page-section-intro"]');
		await expect(child).toHaveCount(1);
		await expect
			.poll(() =>
				target.evaluate((list) => {
					const content = list.querySelector(':scope > div:first-child');
					const nested = list.querySelector('[data-edytor-id="page-section-intro"]');
					if (!content || !nested) return false;
					const contentRect = content.getBoundingClientRect();
					const childRect = nested.getBoundingClientRect();
					return childRect.top >= contentRect.bottom - 2;
				})
			)
			.toBe(true);
		issues.assertClean();
	});

	for (const [name, blockId] of [
		['callout', 'page-callout'],
		['todo', 'page-task-one']
	]) {
		test(`places a dragged block below ${name} content`, async ({ page }) => {
			const issues = trackPageIssues(page);
			await page.goto('/');
			const target = page.locator(`[data-edytor-id="${blockId}"]`);
			const targetBox = await target.boundingBox();
			if (!targetBox) throw new Error(`Missing ${name} target`);
			await handle(page, 'page-section-intro').dragTo(target, {
				targetPosition: { x: Math.min(80, targetBox.width / 2), y: targetBox.height / 2 }
			});
			const child = target.locator('[data-edytor-id="page-section-intro"]');
			await expect(child).toHaveCount(1);
			await expect
				.poll(() =>
					target.evaluate((block) => {
						const content = block.querySelector(':scope > div:first-of-type');
						const nested = block.querySelector('[data-edytor-id="page-section-intro"]');
						if (!content || !nested) return false;
						return nested.getBoundingClientRect().top >= content.getBoundingClientRect().bottom - 2;
					})
				)
				.toBe(true);
			issues.assertClean();
		});
	}

	test('keeps nested blocks on the next row across other editable block types', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		for (const [name, blockId, sourceId] of [
			['paragraph', 'page-section-intro', 'page-intro'],
			['heading', 'page-section', 'page-section-intro'],
			['quote', 'page-quote', 'page-section-intro'],
			['numbered list', 'page-bullet-one', 'page-section-intro']
		]) {
			// A fresh local document per case: the demo persists, so `/` would keep the last move.
			await page.goto(`/?doc=nested-${name.replace(/\s/g, '-')}`);
			if (name === 'numbered list') await turnInto(page, blockId, 'Numbered list');
			const target = page.locator(`[data-edytor-id="${blockId}"]`);
			const targetBox = await target.boundingBox();
			if (!targetBox) throw new Error(`Missing ${name} target`);
			await handle(page, sourceId).dragTo(target, {
				targetPosition: { x: Math.min(80, targetBox.width / 2), y: targetBox.height / 2 }
			});
			const parentId = await page
				.locator(`[data-edytor-id="${sourceId}"]`)
				.evaluate((node) =>
					node.parentElement?.closest('[data-edytor-block="true"]')?.getAttribute('data-edytor-id')
				);
			expect(parentId, `${name} owns the moved block`).toBe(blockId);
			const child = target.locator(`[data-edytor-id="${sourceId}"]`);
			await expect(child, `${name} accepts the nested block`).toHaveCount(1);
			const onNextRow = await target.evaluate((block, movedId) => {
				const ownText = Array.from(
					block.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
				).filter((text) => text.closest('[data-edytor-block="true"]') === block);
				const nested = block.querySelector<HTMLElement>(`[data-edytor-id="${movedId}"]`);
				if (!ownText.length || !nested) return false;
				const ownTextBottom = Math.max(
					...ownText.map((text) => text.getBoundingClientRect().bottom)
				);
				return nested.getBoundingClientRect().top >= ownTextBottom - 2;
			}, sourceId);
			expect(onNextRow, `${name} renders its child below its text`).toBe(true);
		}
		issues.assertClean();
	});

	test('nests a dragged block into the closed toggle row', async ({ page }) => {
		await page.goto('/');
		const summary = page.locator('[data-edytor-id="page-toggle"] summary');
		await summary.scrollIntoViewIfNeeded();
		const source = await handle(page, 'page-quote').boundingBox();
		const target = await summary.boundingBox();
		if (!source || !target) throw new Error('Missing toggle drag coordinates');
		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(target.x + 80, target.y + target.height / 2, { steps: 12 });
		await expect(page.locator('[data-edytor-drop-indicator]')).toHaveAttribute(
			'data-position',
			'inside'
		);
		// Notion's nesting bar: plain (no border, no dot), below the target's row and
		// indented one column (24px) past its text: never a box around the target.
		const bar = await page.locator('[data-edytor-drop-indicator]').evaluate((node) => {
			const style = getComputedStyle(node);
			const box = node.getBoundingClientRect();
			return {
				border: style.borderLeftWidth,
				dot: getComputedStyle(node, '::after').content,
				height: box.height,
				x: box.left,
				y: box.top
			};
		});
		expect(bar).toMatchObject({ border: '0px', dot: 'none', height: 4 });
		expect(bar.x).toBeGreaterThanOrEqual(target.x + 20);
		expect(bar.y).toBeGreaterThan(target.y + target.height / 2);
		await page.mouse.up();
		const toggle = page.locator('[data-edytor-id="page-toggle"]');
		const nested = toggle.locator('[data-edytor-id="page-quote"]');
		await expect(nested).toHaveCount(1);
		await summary.click();
		const summaryBox = await summary.boundingBox();
		const childBox = await nested.boundingBox();
		if (!summaryBox || !childBox) throw new Error('Missing visible toggle rows');
		expect(childBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height - 2);
	});

	test('hydrates cleanly and shows a working selection toolbar', async ({ page }) => {
		const issues = trackPageIssues(page);
		const hydrationWarnings: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'warning' && message.text().includes('hydration_mismatch')) {
				hydrationWarnings.push(message.text());
			}
		});

		await page.goto('/');
		await expect(page.locator('[data-edytor]')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'A calmer place to think' })).toBeVisible();
		const textIndex = await page
			.locator('[data-edytor-text="true"]')
			.evaluateAll((texts) =>
				texts.findIndex((text) => Boolean(text.closest('[data-edytor-id="page-section-intro"]')))
			);
		expect(textIndex).toBeGreaterThanOrEqual(0);
		await setSelectionByTextIndex(page, textIndex, 0, textIndex, 5);
		await expect(page.getByTestId('selection-toolbar')).toBeVisible();
		await page.getByTestId('toolbar-bold').click();
		await expect(page.locator('[data-edytor-id="page-section-intro"] strong')).toHaveCount(1);

		expect(hydrationWarnings).toEqual([]);
		issues.assertClean();
	});

	test('transforms, duplicates, and deletes blocks from the handle menu', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await expect(handle(page, 'page-callout')).toBeVisible();

		await turnInto(page, 'page-section-intro', 'Heading 3');
		await expect(page.locator('[data-edytor-id="page-section-intro"] > h3')).toHaveText(
			'Start with a thought. Give it structure when you need it.'
		);

		await openBlockMenu(page, 'page-callout');
		await page.getByRole('menuitem', { name: /Duplicate/ }).click();
		await expect(page.locator('[data-edytor-type="callout"]')).toHaveCount(2);

		await openBlockMenu(page, 'page-callout');
		await page.getByRole('menuitem', { name: /Delete/ }).click();
		await expect(handle(page, 'page-callout')).toHaveCount(0);
		await expect(page.locator('[data-edytor-type="callout"]')).toHaveCount(1);
		issues.assertClean();
	});

	test('moves blocks from the handle menu and nests them with Tab', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await expect(handle(page, 'page-callout')).toBeVisible();
		const originalOrder = await rootOrder(page);

		await openBlockMenu(page, 'page-callout');
		await page.getByRole('menuitem', { name: /Move up/ }).click();
		await expect
			.poll(async () => (await rootOrder(page)).indexOf('page-callout'))
			.toBe(originalOrder.indexOf('page-callout') - 1);

		// Notion nests from the keyboard: Tab, then Shift+Tab.
		await page.locator('[data-edytor-id="page-task-two"] [data-edytor-text]').first().click();
		await page.keyboard.press('Tab');
		await expect(
			page.locator('[data-edytor] > [data-edytor-block="true"][data-edytor-id="page-task-two"]')
		).toHaveCount(0);
		await expect(handle(page, 'page-task-two')).toHaveCount(1);

		await page.keyboard.press('Shift+Tab');
		await expect(
			page.locator('[data-edytor] > [data-edytor-block="true"][data-edytor-id="page-task-two"]')
		).toHaveCount(1);
		issues.assertClean();
	});

	test('searches actions from the keyboard, and Escape returns to the text', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/?doc=block-menu-keys');
		await openBlockMenu(page, 'page-callout');
		const search = page.getByRole('textbox', { name: 'Search actions' });
		await expect(search).toBeFocused();
		await page.keyboard.type('dup');
		await expect(
			page.getByRole('menu', { name: 'Block actions' }).getByRole('menuitem')
		).toHaveText(['Duplicate']);
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-edytor-type="callout"]')).toHaveCount(2);

		await openBlockMenu(page, 'page-section-intro');
		await page.keyboard.press('ArrowDown');
		await expect(
			page.getByRole('menu', { name: 'Block actions' }).locator('[data-selected="true"]')
		).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0);
		await expect
			.poll(() =>
				page
					.locator('[data-edytor-id="page-section-intro"]')
					.evaluate((node) => node.contains(window.getSelection()?.anchorNode ?? null))
			)
			.toBe(true);
		issues.assertClean();
	});

	test('creates an editable code block from the slash menu', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await page.locator('[data-edytor-id="page-end"] p').click();
		await page.keyboard.type('/code');
		await expect(page.getByTestId('slash-menu-item')).toHaveText('Code');
		await page.keyboard.press('Enter');
		await page.keyboard.type('hello');
		await expect(page.locator('[data-edytor-id="page-end"] pre code').last()).toContainText(
			'hello'
		);
		issues.assertClean();
	});

	test('copies code and block links', async ({ page, browserName }) => {
		test.skip(browserName !== 'chromium', 'Clipboard permission is verified in Chromium');
		const issues = trackPageIssues(page);
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/');
		await expect(page.locator('#block-page-callout')).toHaveCount(1);

		await page.getByRole('button', { name: 'Copy', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe('const idea = "start somewhere";');

		await openBlockMenu(page, 'page-callout');
		await page.getByRole('menuitem', { name: /Copy link to block/ }).click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toMatch(/\/#block-page-callout$/);
		issues.assertClean();
	});
});
