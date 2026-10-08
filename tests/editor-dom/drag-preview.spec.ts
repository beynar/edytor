import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';

/**
 * The drag ghost (Notion): every handle drag sets a custom drag image — never
 * the grip alone — a copy of the dragged blocks rendered with the editor's
 * theme and only scaled down (no card, background, shadow, opacity or fade),
 * for one block, one selected block and several. Recorded by a spy on
 * `DataTransfer.setDragImage` while the ghost is mounted for the browser's
 * picture. The jsdom rows are `drag-preview.test.tsx`.
 */

type Recorded = {
	x: number;
	y: number;
	count?: string;
	badge: string | null;
	types: string[];
	text: string;
	live: number;
	/** Paint the ghost's own wrappers add (the badge aside): none. */
	paint: string[];
	transform: string;
	width: number;
	height: number;
	scaledHeight: number;
	title: { fontSize: string; fontWeight: string } | null;
	nested: number | null;
};

const kid = (id: string) => ({ id, type: 'paragraph', content: [{ text: id }] });
const children = [
	{ id: 'T', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Title' }] },
	{ id: 'a', type: 'paragraph', content: [{ text: 'alpha' }], children: [kid('nested')] },
	{ id: 'b', type: 'paragraph', content: [{ text: 'beta' }] },
	{ id: 'c', type: 'paragraph', content: [{ text: 'gamma' }] }
];

const open = async (page: Page) => {
	await page.addInitScript(() => {
		const recorded: unknown[] = [];
		Object.assign(window, { __dragImages: recorded });
		const setDragImage = DataTransfer.prototype.setDragImage;
		DataTransfer.prototype.setDragImage = function (image: Element, x: number, y: number) {
			const preview = image.querySelector<HTMLElement>('[data-edytor-drag-preview]');
			if (preview) {
				const list = preview.querySelector<HTMLElement>('[data-edytor] > div')!;
				const clones = [...list.children] as HTMLElement[];
				const textLeft = (node: Element | null | undefined) => {
					const range = document.createRange();
					const leaf = node && document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
					if (!leaf) return null;
					range.selectNodeContents(leaf);
					return range.getBoundingClientRect().left;
				};
				const h1 = preview.querySelector('h1');
				const own = clones[0]?.querySelector(':scope > p');
				const child = clones[0]?.querySelector('[data-edytor-children] p');
				const [parentLeft, childLeft] = [textLeft(own), textLeft(child)];
				const scaled = preview.querySelector<HTMLElement>('[style*="scale"]')!;
				const box = scaled.parentElement!;
				const wrappers = [preview, ...preview.querySelectorAll<HTMLElement>('*')].filter(
					(node) =>
						!node.closest('[data-edytor] > div > *') && !node.closest('[data-edytor-drag-count]')
				);
				recorded.push({
					x,
					y,
					count: preview.dataset.count,
					badge: preview.querySelector('[data-edytor-drag-count]')?.textContent ?? null,
					types: clones.map((clone) => clone.dataset.edytorType),
					text: preview.textContent?.replace(/[\s\u200B]+/g, ' ').trim(),
					live: preview.querySelectorAll(
						'[contenteditable], [id], [data-edytor-id], [data-edytor-block], [data-edytor-text], [data-edytor-selected]'
					).length,
					paint: [
						...new Set(
							wrappers.map((node) => {
								const style = getComputedStyle(node);
								return [
									style.boxShadow,
									style.backgroundColor,
									style.backgroundImage,
									style.opacity,
									style.borderRadius,
									style.maskImage
								].join(' | ');
							})
						)
					],
					transform: getComputedStyle(scaled).transform,
					width: box.getBoundingClientRect().width,
					height: box.getBoundingClientRect().height,
					scaledHeight: scaled.getBoundingClientRect().height,
					title: h1 && {
						fontSize: getComputedStyle(h1).fontSize,
						fontWeight: getComputedStyle(h1).fontWeight
					},
					nested: parentLeft !== null && childLeft !== null ? childLeft - parentLeft : null
				});
			}
			return setDragImage.call(this, image, x, y);
		};
	});
	await page.goto(
		`/test/dom?scenario=dst&handles=true&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await page.addStyleTag({
		content: readFileSync(new URL('../../src/lib/themes/notion.css', import.meta.url), 'utf8')
	});
	// Room for the handles left of the blocks; the route's grid would stretch the editor wide.
	await page.addStyleTag({
		content: '[data-edytor] { width: 640px; margin-inline-start: 96px }'
	});
	await page.locator('[data-edytor]').evaluate((node) => node.classList.add('edytor-notion'));
};

/** Drag `id`'s grip a little way down and answer what the drag image was set to. */
const dragGrip = async (page: Page, id: string) => {
	await page.locator(`[data-edytor-id="${id}"]`).first().hover();
	const grip = page.locator(`[data-testid="block-handle"][data-block-id="${id}"]`);
	await expect(grip).toBeVisible();
	const box = (await grip.boundingBox())!;
	const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const block = (await page.locator(`[data-edytor-id="${id}"]`).first().boundingBox())!;
	await page.mouse.move(at.x, at.y);
	await page.mouse.down();
	await page.mouse.move(at.x + 4, at.y + 4, { steps: 2 });
	await page.mouse.move(at.x + 12, at.y + 30, { steps: 4 });
	await expect
		.poll(() =>
			page.evaluate(() => (window as unknown as { __dragImages: unknown[] }).__dragImages.length)
		)
		.toBeGreaterThan(0);
	await page.mouse.up();
	const [image] = await page.evaluate(
		() => (window as unknown as { __dragImages: Recorded[] }).__dragImages
	);
	return { image: image!, grab: { x: at.x - block.x, y: at.y - block.y } };
};

test.describe('the drag ghost', () => {
	test('one block: its themed copy with its children, scaled, unstyled, no badge', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const { image, grab } = await dragGrip(page, 'a');
		expect(image).toMatchObject({
			count: '1',
			badge: null,
			types: ['paragraph'],
			text: 'alpha nested',
			live: 0,
			transform: 'matrix(0.8, 0, 0, 0.8, 0, 0)'
		});
		// No shadow, background, opacity, radius or mask on the ghost's wrappers.
		expect(image.paint).toEqual(['none | rgba(0, 0, 0, 0) | none | 1 | 0px | none']);
		// Sized to the scaled box, so the browser crops nothing: the 640px content
		// width capped at 600px, × 0.8.
		expect(image.width).toBe(480);
		expect(Math.abs(image.height - image.scaledHeight)).toBeLessThanOrEqual(1);
		// The nested paragraph one step in, as in the editor (the theme applies), scaled.
		expect(image.nested).toBeCloseTo(26 * 0.8, 0);
		// The pointer keeps its place: the grip is left of the block, the gutter makes up for it.
		expect(grab.x).toBeLessThan(0);
		expect(image.x).toBe(0);
		expect(Math.abs(image.y - grab.y * 0.8)).toBeLessThanOrEqual(1);
		issues.assertClean();
	});

	test('one selected block: its ghost too, never the grip alone', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.selection.selectBlocks(edytor.idToBlock.get('b'));
		});
		const { image } = await dragGrip(page, 'b');
		expect(image).toMatchObject({ count: '1', badge: null, types: ['paragraph'], text: 'beta' });
		expect(image.live).toBe(0);
		issues.assertClean();
	});

	test('a leading Heading 1 drags as a Heading 1, not as the page title', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		const title = await page
			.locator('[data-edytor-id="T"] > h1')
			.evaluate((node) => getComputedStyle(node).fontSize);
		expect(title).toBe('40px');
		const { image } = await dragGrip(page, 'T');
		expect(image.title).toEqual({ fontSize: '30px', fontWeight: '600' });
		issues.assertClean();
	});

	test('several blocks: each copied in document order, no count badge', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page);
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.selection.selectBlocks(...['c', 'b'].map((id) => edytor.idToBlock.get(id)));
		});
		const { image } = await dragGrip(page, 'b');
		expect(image).toMatchObject({
			count: '2',
			badge: null,
			types: ['paragraph', 'paragraph'],
			text: 'beta gamma',
			live: 0,
			transform: 'matrix(0.8, 0, 0, 0.8, 0, 0)'
		});
		expect(image.paint).toEqual(['none | rgba(0, 0, 0, 0) | none | 1 | 0px | none']);
		issues.assertClean();
	});
});
