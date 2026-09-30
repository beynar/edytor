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

/** Where a block's own text starts (`x`), and its box's left edge (`blockX`). */
const textColumn = (page: Page, text: string) =>
	page.evaluate((text) => {
		const own = Array.from(
			document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
		).find((node) => node.textContent === text)!;
		const block = own.closest<HTMLElement>('[data-edytor-block="true"]')!;
		return { x: own.getClientRects()[0]!.left, blockX: block.getBoundingClientRect().left };
	}, text);

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
		// Onto the lower half of "Nested child"'s row, more than one nesting step
		// right of its text: the children sit one step in, so the parent's left
		// edge is the nested blocks' handle gutter.
		await dragHandleToBlock(page, 3, 1, 0.75, { horizontalOffset: 64 });

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

	test("an expanded parent's lower half places at its first child, the line there, not below its subtree", async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		const blocks = page.locator('[data-edytor-block="true"]');
		const [parent, child, tail] = await Promise.all(
			[0, 1, 2].map(async (index) => (await blocks.nth(index).boundingBox())!)
		);
		const source = (await page.getByTestId('block-handle').nth(3).boundingBox())!;
		const indicator = page.locator('[data-edytor-drop-indicator]');
		// The lower half of the parent's own row (its box down to its first child).
		const lower = parent.y + (child.y - parent.y) * 0.75;

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		// The drag library ignores the drag events of the frame the drag starts in.
		await page.mouse.move(parent.x + 8, lower, { steps: 12 });
		for (const x of [parent.x + 12, parent.x + 96]) {
			await page.mouse.move(x, lower, { steps: 6 });
			await expect(blocks.nth(1)).toHaveAttribute('data-edytor-block-drop-position', 'before');
			await expect(indicator).toHaveAttribute('data-position', 'before');
			const bar = (await indicator.boundingBox())!;
			// At the first child's top, indented to its column; not below the subtree.
			expect(Math.abs(bar.y + bar.height / 2 - child.y)).toBeLessThanOrEqual(3);
			expect(Math.abs(bar.x - child.x)).toBeLessThanOrEqual(1);
			expect(bar.y).toBeLessThan(tail.y);
			await expect(page.locator('[data-edytor-drop-backdrop][data-shown="true"]')).toHaveCount(1);
		}
		await page.mouse.up();

		await expect.poll(() => readRootTexts(page)).toEqual(['Hello']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual([
			'After',
			'Nested child',
			'Nested tail'
		]);
		issues.assertClean();
	});

	test("tints the future parent's own row while a drop nests, and commits that nest", async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		const parent = page.locator('[data-edytor-block="true"]').first();
		// Rounded blocks must not bend the backdrop: it is the overlay's, not a block style.
		await parent.evaluate((node) => ((node as HTMLElement).style.borderRadius = '16px'));
		const firstChild = page.locator('[data-edytor-block="true"]').nth(1);
		const row = await parent.locator('p').first().boundingBox();
		const box = await parent.boundingBox();
		const childBox = await firstChild.boundingBox();
		const source = await page.getByTestId('block-handle').nth(3).boundingBox();
		if (!row || !box || !childBox || !source) throw new Error('Missing drag source or target');
		const shown = page.locator('[data-edytor-drop-backdrop][data-shown="true"]');
		// The lower half of its own row: its first child's slot (it shows its children).
		const lower = box.y + (childBox.y - box.y) * 0.75;

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(row.x + 32, lower, { steps: 12 });
		await page.mouse.move(row.x + 64, lower, { steps: 5 });
		await expect(firstChild).toHaveAttribute('data-edytor-block-drop-position', 'before');
		await expect(shown).toHaveCount(1);
		const geometry = await page.evaluate(() => {
			const backdrop = document.querySelector<HTMLElement>('[data-edytor-drop-backdrop]')!;
			const block = document.querySelector<HTMLElement>('[data-edytor-block="true"]')!;
			const child = block.querySelector<HTMLElement>('[data-edytor-block="true"]')!;
			const [b, p, c] = [backdrop, block, child].map((node) => node.getBoundingClientRect());
			return {
				left: Math.round(b!.left - p!.left),
				width: Math.round(b!.width - p!.width),
				top: Math.round(b!.top - p!.top),
				// Its own row: down to where its first child begins, not its subtree.
				bottom: Math.round(b!.bottom - c!.top),
				radius: getComputedStyle(backdrop).borderRadius,
				blockBackground: getComputedStyle(block).backgroundColor,
				inOverlay: backdrop.parentElement?.hasAttribute('data-edytor-overlay')
			};
		});
		expect(geometry).toEqual({
			left: 0,
			width: 0,
			top: 0,
			bottom: 0,
			radius: '4px',
			blockBackground: 'rgba(0, 0, 0, 0)',
			inOverlay: true
		});
		await expect(shown).toHaveCSS('opacity', '1');
		// Painted in the built CSS, not just laid out (a minifier must not void the default).
		await expect(shown).toHaveCSS('background-color', 'rgba(35, 131, 226, 0.14)');

		// A plain before drop: the backdrop fades out.
		await page.mouse.move(box.x + 64, box.y + 2, { steps: 12 });
		await page.mouse.move(box.x + 96, box.y + 2, { steps: 5 });
		await expect(page.locator('[data-edytor-drop-indicator][data-position="before"]')).toHaveCount(
			1
		);
		await expect(shown).toHaveCount(0);

		// Back over the parent's row, then dropped: the move it showed is the one committed.
		await page.mouse.move(row.x + 32, lower, { steps: 12 });
		await page.mouse.move(row.x + 64, lower, { steps: 5 });
		await expect(shown).toHaveCount(1);
		await page.mouse.up();

		await expect.poll(() => readRootTexts(page)).toEqual(['Hello']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual([
			'After',
			'Nested child',
			'Nested tail'
		]);
		await expect(page.locator('[data-edytor-drop-backdrop]')).toHaveCount(0);
		issues.assertClean();
	});

	test("the Notion theme's backdrop color survives the build as a valid color", async ({
		page
	}) => {
		await page.goto('/');
		await waitForEditorReady(page);
		// The controller copies the variable onto the backdrop, so it must be one color.
		const painted = await page.evaluate(() => {
			const theme = document.querySelector<HTMLElement>('.edytor-notion')!;
			const value = getComputedStyle(theme).getPropertyValue('--edytor-drop-backdrop-color');
			const probe = document.createElement('div');
			probe.style.background = value;
			theme.append(probe);
			const color = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return color;
		});
		expect(painted).toBe('rgba(35, 131, 226, 0.14)');
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

	test("reparents below the last nested block at the level of the pointer's x, even when the parent is the final root block", async ({
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

		// The lower half of "After", the last child, the pointer at Hello's text column (over
		// Hello's indent, left of After's box): the root.
		const hello = await textColumn(page, 'Hello');
		const last = (await page.locator('[data-edytor-block="true"]').nth(3).boundingBox())!;
		const source = (await page.getByTestId('block-handle').nth(1).boundingBox())!;
		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(hello.x + 6, last.y + last.height * 0.9, { steps: 12 });
		await page.mouse.move(hello.x + 2, last.y + last.height * 0.9, { steps: 4 });
		await expect(page.locator('[data-edytor-block="true"]').first()).toHaveAttribute(
			'data-edytor-block-drop-position',
			'after'
		);
		await page.mouse.up();
		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'Nested child']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual(['Nested tail', 'After']);
		await expectSelection(page, { selectedBlockPaths: [[1]] });
		issues.assertClean();
	});

	test("the last block three levels deep: the pointer's x picks each ancestor's level, down to the root", async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = (text: string, children?: unknown[]) => ({
				type: 'paragraph',
				content: [{ text }],
				...(children && { children })
			});
			edytor.root.children[0].insertBlockBefore({
				block: block('L1', [block('L2', [block('L3', [block('L4')])])])
			});
		});
		await expect.poll(() => readRootTexts(page)).toEqual(['L1', 'Hello', 'After']);
		await settleHandles(page);
		const ids = await page.evaluate(() =>
			Object.fromEntries(
				Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).map(
					(node) => [
						node.textContent,
						node.closest<HTMLElement>('[data-edytor-block="true"]')!.dataset.edytorId
					]
				)
			)
		);
		const blockOf = (text: string) =>
			page.locator(`[data-edytor-block="true"][data-edytor-id="${ids[text]}"]`);
		const deepest = (await blockOf('L4').boundingBox())!;
		const lower = deepest.y + deepest.height * 0.75;
		const after = await page.evaluate(
			() => (window as Window & { __EDYTOR__?: any }).__EDYTOR__.root.children.at(-1).id
		);
		const source = (await page
			.locator(`[data-testid="block-handle"][data-block-id="${after}"]`)
			.boundingBox())!;
		const indicator = page.locator('[data-edytor-drop-indicator][data-position="after"]');
		const backdrop = page.locator('[data-edytor-drop-backdrop][data-shown="true"]');

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(deepest.x + 40, lower, { steps: 12 });
		for (const [level, parent] of [
			['L4', 'L3'],
			['L3', 'L2'],
			['L2', 'L1'],
			['L1', null]
		] as const) {
			const { x, blockX } = await textColumn(page, level);
			await page.mouse.move(x + 2, lower, { steps: 8 });
			await expect(blockOf(level)).toHaveAttribute('data-edytor-block-drop-position', 'after');
			const bar = (await indicator.boundingBox())!;
			// Below L4's row, indented to the level's column.
			expect(Math.abs(bar.x - blockX)).toBeLessThanOrEqual(1);
			expect(Math.abs(bar.y + bar.height / 2 - (deepest.y + deepest.height))).toBeLessThanOrEqual(
				3
			);
			if (parent) {
				const id = await blockOf(parent).getAttribute('data-edytor-id');
				await expect(backdrop).toHaveAttribute('data-block-id', id!);
			} else await expect(backdrop).toHaveCount(0);
		}
		await page.mouse.up();

		await expect.poll(() => readRootTexts(page)).toEqual(['L1', 'After', 'Hello']);
		issues.assertClean();
	});

	test("the only child of the document's last block moves out after it: its parent's row and the gap under it reparent", async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = (text: string, children?: unknown[]) => ({
				type: 'paragraph',
				content: [{ text }],
				...(children && { children })
			});
			edytor.root.children.at(-1).insertBlockAfter({ block: block('Last', [block('Only')]) });
		});
		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'After', 'Last']);
		await settleHandles(page);
		const [last, only] = await page.evaluate(() => {
			const parent = (window as Window & { __EDYTOR__?: any }).__EDYTOR__.root.children.at(-1);
			return [parent.id as string, parent.children[0].id as string];
		});
		const lastBlock = page.locator(`[data-edytor-block="true"][data-edytor-id="${last}"]`);
		const box = (await page
			.locator(`[data-edytor-block="true"][data-edytor-id="${only}"]`)
			.boundingBox())!;
		const column = await textColumn(page, 'Last');
		const row = (await lastBlock.locator('p').first().boundingBox())!;
		const source = (await page
			.locator(`[data-testid="block-handle"][data-block-id="${only}"]`)
			.boundingBox())!;
		const indicator = page.locator('[data-edytor-drop-indicator]');

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + 40, box.y + box.height * 0.75, { steps: 12 });
		for (const [x, y] of [
			// Last's own row, its lower half, however far right: after it, never inside it.
			[column.x + 2, row.y + row.height * 0.75],
			[column.x + 96, row.y + row.height * 0.75],
			// The gap Only leaves under Last's row: its row, low, at its left edge (its own
			// handle, left of it, keeps the pointer) and further right.
			[box.x + 2, box.y + box.height * 0.9],
			[box.x + 40, box.y + box.height * 0.75]
		]) {
			await page.mouse.move(x, y, { steps: 8 });
			await expect(lastBlock).toHaveAttribute('data-edytor-block-drop-position', 'after');
			await expect(indicator).toHaveAttribute('data-position', 'after');
			await expect(page.locator('[data-edytor-drop-backdrop][data-shown="true"]')).toHaveCount(0);
		}
		await page.mouse.up();

		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'After', 'Last', 'Only']);
		expect((await readBlocks(page))[2].children ?? []).toEqual([]);
		issues.assertClean();
	});

	test('the last nested block released over its own row stays put: its levels are not offered there', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		const before = await readBlocks(page);
		expect(before[0].children?.map(textOf)).toEqual(['Nested child', 'Nested tail']);

		// "Nested tail" (handle 2) ends Hello's group: at Hello's column, its lower half
		// would outdent it after Hello, were its own row a drop target.
		const hello = await textColumn(page, 'Hello');
		const tail = (await page.locator('[data-edytor-block="true"]').nth(2).boundingBox())!;
		const source = (await page.getByTestId('block-handle').nth(2).boundingBox())!;
		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		for (const [x, y] of [
			[tail.x + 40, tail.y + tail.height * 0.25],
			[tail.x + 40, tail.y + tail.height * 0.75],
			[hello.x + 2, tail.y + tail.height * 0.75]
		]) {
			await page.mouse.move(x, y, { steps: 8 });
			await expect(page.locator('[data-edytor-drop-indicator]')).toHaveCount(0);
		}
		await page.mouse.up();

		expect(await readBlocks(page)).toEqual(before);
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
			expect(height).toBe(4);
			expect(radius).toBe('0px');
		};

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(target.x + 32, target.y + 2, { steps: 12 });
		await page.mouse.move(target.x + 64, target.y + 2, { steps: 5 });
		await expectStraightIndicator('before');
		// The bottom half, left of the nest threshold (one step past the text start): after.
		await page.mouse.move(target.x + 12, target.y + target.height - 2, { steps: 12 });
		await page.mouse.move(target.x + 16, target.y + target.height - 2, { steps: 5 });
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
		await page.mouse.move(first.x + 12, first.y + first.height - 2, { steps: 12 });
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

	test('drags the blocks a text range spans by the first handle, showing their count', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=navigation&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		// A text range from "Start" into "Nested middle": Start, Parent and its child.
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const [start, parent] = edytor.root.children;
			edytor.selection.setAtRange(start.firstText, 1, parent.children[0].firstText, 3);
		});
		const source = await page.getByTestId('block-handle').first().boundingBox();
		const target = await page.locator('[data-edytor-block="true"]').last().boundingBox();
		if (!source || !target) throw new Error('Missing drag source or target');

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		await page.mouse.move(target.x + 8, target.y + target.height - 2, { steps: 12 });
		await page.mouse.move(target.x + 12, target.y + target.height - 2, { steps: 5 });
		const indicator = page.locator('[data-edytor-drop-indicator][data-position="after"]');
		await expect(indicator).toHaveAttribute('data-count', '2');
		await expect(indicator.locator('[data-edytor-drag-count]')).toHaveText('2');
		await page.mouse.up();

		const blocks = await readBlocks(page);
		expect(blocks.map(textOf)).toEqual(['image caption', 'Finish', 'Start', 'Parent']);
		expect(blocks[3]?.children?.map(textOf)).toEqual(['Nested middle']);
		// The blocks the range covered stay selected, the moved child too.
		await expectSelection(page, { selectedBlockPaths: [[2], [3], [3, 0]] });
		await page.evaluate(() => (window as Window & { __EDYTOR__?: any }).__EDYTOR__.history.undo());
		await expect
			.poll(() => readRootTexts(page))
			.toEqual(['Start', 'Parent', 'image caption', 'Finish']);
		issues.assertClean();
	});

	test("Notion's zones: the lower half is after near the left, inside past one nesting step", async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await settleHandles(page);
		const source = (await page.getByTestId('block-handle').nth(1).boundingBox())!;
		const target = page.locator('[data-edytor-block="true"]').first();
		const box = (await target.boundingBox())!;
		const textLeft = await target
			.locator('[data-edytor-text="true"]')
			.first()
			.evaluate((node) => node.getClientRects()[0]!.left);
		const lower = box.y + box.height * 0.75;
		const indicator = page.locator('[data-edytor-drop-indicator]');
		const backdrop = page.locator('[data-edytor-drop-backdrop][data-shown="true"]');

		await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
		await page.mouse.down();
		// The top half, however far right: before. (A second move: the drag library
		// ignores the drag events of the frame the drag starts in.)
		await page.mouse.move(textLeft + 116, box.y + box.height * 0.25, { steps: 12 });
		await page.mouse.move(textLeft + 120, box.y + box.height * 0.25, { steps: 4 });
		await expect(indicator).toHaveAttribute('data-position', 'before');
		// The lower half near the left: after, as a sibling, no backdrop.
		await page.mouse.move(textLeft + 8, lower, { steps: 12 });
		await expect(indicator).toHaveAttribute('data-position', 'after');
		await expect(backdrop).toHaveCount(0);
		// The same half, moved right past one nesting step (24px) of the text start: inside.
		await page.mouse.move(textLeft + 40, lower, { steps: 8 });
		await expect(indicator).toHaveAttribute('data-position', 'inside');
		await expect(backdrop).toHaveCount(1);
		await page.mouse.move(textLeft + 16, lower, { steps: 8 });
		await expect(indicator).toHaveAttribute('data-position', 'after');
		await page.mouse.move(textLeft + 48, lower, { steps: 8 });
		await expect(indicator).toHaveAttribute('data-position', 'inside');
		await page.mouse.up();

		await expect.poll(() => readRootTexts(page)).toEqual(['lead', '']);
		expect((await readBlocks(page))[0].children?.map(textOf)).toEqual(['note']);
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
