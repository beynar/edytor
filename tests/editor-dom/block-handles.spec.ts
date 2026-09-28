import { expect, test, type Page } from './editorTest';

import { expectSelection, readJsonByTestId, trackPageIssues, waitForEditorReady } from './helpers';

type SerializedBlock = {
	children?: SerializedBlock[];
	content?: Array<{ text?: string }>;
	type: string;
};

type SerializedValue = {
	children: SerializedBlock[];
};

const stripBlock = (block: SerializedBlock): SerializedBlock => {
	const stripped: SerializedBlock = { type: block.type };
	if (block.content) {
		stripped.content = block.content;
	}
	if (block.children) {
		stripped.children = block.children.map(stripBlock);
	}
	return stripped;
};

/** Handles mount once the viewport observer reports: wait until every visible block has one. */
const settleHandles = (page: Page) =>
	expect
		.poll(() =>
			page.evaluate(() => {
				const blocks = Array.from(
					document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')
				).filter((block) => block.getBoundingClientRect().height > 0);
				return document.querySelectorAll('[data-testid="block-handle"]').length === blocks.length;
			})
		)
		.toBe(true);

const readBlocks = async (page: Page) => {
	const value = await readJsonByTestId<SerializedValue>(page, 'value');
	return value.children.map(stripBlock);
};

const textOf = (block: SerializedBlock) =>
	block.content?.map((part) => part.text ?? '').join('') ?? '';

const readRootTexts = async (page: Page) => (await readBlocks(page)).map(textOf);

/** Each handle sits left of its block, on the block's own first text row. */
const expectHandleHostsAligned = async (page: Page) => {
	await expect
		.poll(() =>
			page.evaluate(() => {
				const handles = Array.from(
					document.querySelectorAll<HTMLElement>('[data-testid="block-handle"]')
				);
				return {
					count: handles.length,
					aligned: handles.every((handle) => {
						const block = document.querySelector<HTMLElement>(
							`[data-edytor-block="true"][data-edytor-id="${handle.dataset.blockId}"]`
						);
						const row = block?.querySelector('[data-edytor-text="true"]')?.getClientRects()[0];
						const rect = handle.getBoundingClientRect();
						const blockRect = block?.getBoundingClientRect();
						if (!row || !blockRect) return false;
						const center = rect.top + rect.height / 2;
						return (
							Math.abs(center - (row.top + row.height / 2)) <= 3 && rect.right <= blockRect.left + 1
						);
					})
				};
			})
		)
		.toEqual({ count: 3, aligned: true });
};

const dragHandleToBlock = async (
	page: Page,
	sourceHandleIndex: number,
	targetBlockIndex: number,
	verticalRatio: number,
	options: { force?: boolean; horizontalOffset?: number } = {}
) => {
	const target = page.locator('[data-edytor-block="true"]').nth(targetBlockIndex);
	const box = await target.boundingBox();
	if (!box) {
		throw new Error(`Missing target block ${targetBlockIndex}`);
	}

	await page
		.getByTestId('block-handle')
		.nth(sourceHandleIndex)
		.dragTo(target, {
			force: options.force,
			targetPosition: {
				x: options.horizontalOffset ?? Math.max(4, Math.min(12, box.width / 2)),
				y: Math.max(1, Math.min(box.height - 1, box.height * verticalRatio))
			}
		});
};

const selectRootBlocks = async (page: Page, indexes: number[]) => {
	await page.evaluate((selectedIndexes) => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		const blocks = selectedIndexes.map((index) => edytor.root.children[index]);
		edytor.selection.selectBlocks(...blocks);
	}, indexes);
};

test.describe('browser block handles and DnD', () => {
	test('drags a block before another block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await dragHandleToBlock(page, 1, 0, 0.05);

		await expect.poll(() => readRootTexts(page)).toEqual(['note', 'lead', '']);
		await expectSelection(page, { selectedBlockPaths: [[0]] });
		await expectHandleHostsAligned(page);
		issues.assertClean();
	});

	test('drags a block after another block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await dragHandleToBlock(page, 0, 1, 0.95);

		await expect.poll(() => readRootTexts(page)).toEqual(['note', 'lead', '']);
		await expectSelection(page, { selectedBlockPaths: [[1]] });
		issues.assertClean();
	});

	test('drags a block inside another block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await dragHandleToBlock(page, 3, 0, 0.5);

		await expect
			.poll(() => readBlocks(page))
			.toEqual([
				{
					type: 'paragraph',
					content: [{ text: 'Hello' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Nested child' }],
							children: [{ type: 'paragraph', content: [{ text: 'After' }] }]
						},
						{ type: 'paragraph', content: [{ text: 'Nested tail' }] }
					]
				}
			]);
		await expectSelection(page, { selectedBlockPaths: [[0, 0, 0]] });
		issues.assertClean();
	});

	test('nests into a parent with children from its own text row', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		const parentRow = page.locator('[data-edytor-block="true"]').first().locator('p').first();
		await page
			.getByTestId('block-handle')
			.nth(3)
			.dragTo(parentRow, {
				targetPosition: { x: 32, y: 12 }
			});

		await expect.poll(() => readRootTexts(page)).toEqual(['Hello']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual([
			'Nested child',
			'Nested tail',
			'After'
		]);
		issues.assertClean();
	});

	test('uses the visible row of a collapsed toggle when reordering', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.root.children[0].setBlock({ value: { type: 'toggle' } });
		});
		const toggle = page.locator('details[data-edytor-block="true"]').first();
		await expect(toggle).not.toHaveAttribute('open');
		const summary = toggle.locator('summary');
		await page
			.getByTestId('block-handle')
			.last()
			.dragTo(summary, {
				targetPosition: { x: 32, y: 1 }
			});

		await expect.poll(() => readRootTexts(page)).toEqual(['After', 'Hello']);
		expect((await readBlocks(page))[1].children?.map(textOf)).toEqual([
			'Nested child',
			'Nested tail'
		]);
		issues.assertClean();
	});

	test('outdents a nested block before a root-level sibling', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await dragHandleToBlock(page, 1, 3, 0.05);

		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'Nested child', 'After']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual(['Nested tail']);
		await expectSelection(page, { selectedBlockPaths: [[1]] });
		issues.assertClean();
	});

	test('outdents at the left gutter even when the parent is the final root block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.root.children[1].moveBlock({ path: [0, 2] });
		});
		await expect.poll(() => readRootTexts(page)).toEqual(['Hello']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual([
			'Nested child',
			'Nested tail',
			'After'
		]);

		await dragHandleToBlock(page, 1, 2, 0.95, { horizontalOffset: 8 });
		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'Nested child']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual(['Nested tail', 'After']);
		await expectSelection(page, { selectedBlockPaths: [[1]] });
		issues.assertClean();
	});

	test('offers a keyboard outdent and hides handles when readonly changes', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		const nestedHandle = page.getByTestId('block-handle').nth(1);
		await nestedHandle.focus();
		await nestedHandle.press('Alt+ArrowLeft');
		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'Nested child', 'After']);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.readonly = true;
		});
		await expect(page.getByTestId('block-handle').first()).toBeHidden();

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.readonly = false;
		});
		await expect(page.getByTestId('block-handle').first()).toBeVisible();
		issues.assertClean();
	});

	test('shows the active drop position and clears it after dropping', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await page
			.locator('[data-edytor-block="true"]')
			.first()
			.evaluate((node) => {
				(node as HTMLElement).style.borderRadius = '16px';
			});
		const source = await page.getByTestId('block-handle').nth(1).boundingBox();
		const target = await page.locator('[data-edytor-block="true"]').first().boundingBox();
		if (!source || !target) {
			throw new Error('Missing drag source or target');
		}

		const expectStraightIndicator = async (position: 'before' | 'after') => {
			await expect(page.locator('[data-edytor-block="true"]').first()).toHaveAttribute(
				'data-edytor-block-drop-position',
				position
			);
			const indicator = page.locator(`[data-edytor-drop-indicator][data-position="${position}"]`);
			await expect(indicator).toHaveCount(1);
			const { height, radius } = await indicator.evaluate((node) => ({
				height: node.getBoundingClientRect().height,
				radius: getComputedStyle(node).borderRadius
			}));
			expect(height).toBe(2);
			expect(radius).toBe('0px');
		};

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(target.x + 32, target.y + 2, { steps: 12 });
		await page.mouse.move(target.x + 64, target.y + 2, { steps: 5 });
		await expectStraightIndicator('before');
		await page.mouse.move(target.x + 64, target.y + target.height - 2, { steps: 12 });
		await page.mouse.move(target.x + 96, target.y + target.height - 2, { steps: 5 });
		await expectStraightIndicator('after');
		await page.mouse.up();

		await expect(
			page.locator('[data-edytor-block="true"][data-edytor-block-drop-position]')
		).toHaveCount(0);
		await expect(page.locator('[data-edytor-drop-indicator]')).toHaveCount(0);
		issues.assertClean();
	});

	test('centers one indicator in the gap from either adjacent block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await page
			.locator('[data-edytor-block="true"]')
			.nth(1)
			.evaluate((node) => {
				(node as HTMLElement).style.marginTop = '24px';
			});
		const source = await page.getByTestId('block-handle').nth(2).boundingBox();
		const first = await page.locator('[data-edytor-block="true"]').nth(0).boundingBox();
		const second = await page.locator('[data-edytor-block="true"]').nth(1).boundingBox();
		if (!source || !first || !second) {
			throw new Error('Missing drag source or adjacent blocks');
		}
		const gapCenter = (first.y + first.height + second.y) / 2;
		expect(second.y).toBeGreaterThan(first.y + first.height);

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(first.x + 64, first.y + first.height - 2, { steps: 12 });
		await expect(page.locator('[data-edytor-drop-indicator][data-position="after"]')).toHaveCount(
			1
		);
		const after = await page.locator('[data-edytor-drop-indicator]').boundingBox();
		await page.mouse.move(second.x + 64, second.y + 2, { steps: 12 });
		await expect(page.locator('[data-edytor-drop-indicator][data-position="before"]')).toHaveCount(
			1
		);
		const before = await page.locator('[data-edytor-drop-indicator]').boundingBox();
		if (!after || !before) {
			throw new Error('Missing drop indicator');
		}
		expect(after.y + after.height / 2).toBeCloseTo(gapCenter, 1);
		expect(before.y).toBeCloseTo(after.y, 1);
		expect(before.x).toBeCloseTo(after.x, 1);
		expect(before.width).toBeCloseTo(after.width, 1);
		await page.mouse.up();
		await expect.poll(() => readRootTexts(page)).toEqual(['lead', '', 'note']);
		issues.assertClean();
	});

	test('keeps the drop placement through a small gap beside a block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await page
			.locator('[data-edytor-block="true"]')
			.nth(1)
			.evaluate((node) => {
				(node as HTMLElement).style.marginTop = '24px';
			});
		const source = await page.getByTestId('block-handle').nth(2).boundingBox();
		const target = await page.locator('[data-edytor-block="true"]').nth(1).boundingBox();
		const previous = await page.locator('[data-edytor-block="true"]').first().boundingBox();
		if (!source || !target || !previous) {
			throw new Error('Missing drag source or target');
		}
		const gapY = target.y - 6;
		expect(gapY).toBeGreaterThan(previous.y + previous.height);

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(target.x + 32, target.y + 2, { steps: 12 });
		await page.mouse.move(target.x + 64, target.y + 2, { steps: 5 });
		await expect(page.locator('[data-edytor-block="true"]').nth(1)).toHaveAttribute(
			'data-edytor-block-drop-position',
			'before'
		);
		await page.mouse.move(target.x + 64, gapY, { steps: 12 });
		await page.mouse.move(target.x + 96, gapY, { steps: 5 });
		await expect(page.locator('[data-edytor-block="true"]').nth(1)).toHaveAttribute(
			'data-edytor-block-drop-position',
			'before'
		);
		await page.mouse.up();

		await expect.poll(() => readRootTexts(page)).toEqual(['lead', '', 'note']);
		await expect(page.locator('[data-edytor-drop-indicator]')).toHaveCount(0);
		issues.assertClean();
	});

	test('drags multiple selected sibling blocks together', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await selectRootBlocks(page, [0, 1]);
		await dragHandleToBlock(page, 0, 2, 0.95);

		await expect.poll(() => readRootTexts(page)).toEqual(['', 'lead', 'note']);
		await expectSelection(page, { selectedBlockPaths: [[1], [2]] });
		issues.assertClean();
	});

	test('guards against dropping a block into its own descendant', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await dragHandleToBlock(page, 0, 1, 0.5, { force: true });

		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'After']);
		const firstBlock = (await readBlocks(page))[0];
		expect(firstBlock.children?.map(textOf)).toEqual(['Nested child', 'Nested tail']);
		issues.assertClean();
	});

	test('uses the upper half of a void block for a before drop', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=divider&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await page.locator('[data-edytor-type="divider"]').evaluate((node) => {
			(node as HTMLElement).style.height = '32px';
		});
		await dragHandleToBlock(page, 2, 1, 0.4);

		await expect.poll(() => readRootTexts(page)).toEqual(['before divider', 'after divider', '']);
		issues.assertClean();
	});

	test('uses the lower half of a void block for an after drop', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=divider&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		await page.locator('[data-edytor-type="divider"]').evaluate((node) => {
			(node as HTMLElement).style.height = '32px';
		});
		await dragHandleToBlock(page, 0, 1, 0.6);

		await expect.poll(() => readRootTexts(page)).toEqual(['', 'before divider', 'after divider']);
		issues.assertClean();
	});
});
