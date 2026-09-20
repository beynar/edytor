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

const readBlocks = async (page: Page) => {
	const value = await readJsonByTestId<SerializedValue>(page, 'value');
	return value.children.map(stripBlock);
};

const textOf = (block: SerializedBlock) =>
	block.content?.map((part) => part.text ?? '').join('') ?? '';

const readRootTexts = async (page: Page) => (await readBlocks(page)).map(textOf);

const dragHandleToBlock = async (
	page: Page,
	sourceHandleIndex: number,
	targetBlockIndex: number,
	verticalRatio: number,
	options: { force?: boolean } = {}
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
				x: Math.max(4, Math.min(12, box.width / 2)),
				y: Math.max(1, Math.min(box.height - 1, box.height * verticalRatio))
			}
		});
};

const dispatchDragToBlock = async (
	page: Page,
	sourceHandleIndex: number,
	targetBlockIndex: number,
	verticalRatio: number
) => {
	await page.evaluate(
		({ sourceHandleIndex, targetBlockIndex, verticalRatio }) => {
			const handles = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="block-handle"]')
			);
			const blocks = Array.from(
				document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')
			);
			const source = handles[sourceHandleIndex];
			const target = blocks[targetBlockIndex];
			if (!source || !target) {
				throw new Error(`Missing drag source ${sourceHandleIndex} or target ${targetBlockIndex}`);
			}

			const rect = target.getBoundingClientRect();
			const dataTransfer = new DataTransfer();
			const clientX = rect.left + Math.max(1, rect.width / 2);
			const clientY = rect.top + rect.height * verticalRatio;
			const createDragEvent = (type: string) => {
				const event = new DragEvent(type, {
					bubbles: true,
					cancelable: true,
					clientX,
					clientY
				});
				Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
				return event;
			};

			source.dispatchEvent(createDragEvent('dragstart'));
			target.dispatchEvent(createDragEvent('dragover'));
			target.dispatchEvent(createDragEvent('drop'));
		},
		{ sourceHandleIndex, targetBlockIndex, verticalRatio }
	);
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
		await dragHandleToBlock(page, 1, 0, 0.05);

		await expect.poll(() => readRootTexts(page)).toEqual(['note', 'lead', '']);
		await expectSelection(page, { selectedBlockPaths: [[0]] });
		issues.assertClean();
	});

	test('drags a block after another block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await dragHandleToBlock(page, 0, 1, 0.95);

		await expect.poll(() => readRootTexts(page)).toEqual(['note', 'lead', '']);
		await expectSelection(page, { selectedBlockPaths: [[1]] });
		issues.assertClean();
	});

	test('drags a block inside another block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nested&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
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

	test('drags multiple selected sibling blocks together', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
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
		await dragHandleToBlock(page, 0, 1, 0.5, { force: true });

		await expect.poll(() => readRootTexts(page)).toEqual(['Hello', 'After']);
		const firstBlock = (await readBlocks(page))[0];
		expect(firstBlock.children?.map(textOf)).toEqual(['Nested child', 'Nested tail']);
		issues.assertClean();
	});

	test('guards against dropping inside a void block', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=divider&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });
		await dispatchDragToBlock(page, 0, 1, 0.5);

		await expect.poll(() => readRootTexts(page)).toEqual(['before divider', '', 'after divider']);
		issues.assertClean();
	});
});
