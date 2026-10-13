import { expect, test, type Page } from './editorTest';
import { trackPageIssues, waitForEditorReady } from './helpers';
import {
	box,
	gapOf,
	grip,
	hitAt,
	host,
	fit,
	frames,
	overlap,
	para,
	plus,
	textBox,
	walk
} from './columnsPaths';

/**
 * Notion's column spacing (`columns/gaps.ts`, one measurement): a 46px gap,
 * the resize band and its line centered in it, a column-2 block's `+` and
 * grip in the gap's right part, flush with the column, and every block of a
 * column (a paragraph, a table, a code block) starting at the column's edge.
 * Column 1's handles stay in the page's margin.
 */

const DOC = [
	para('P', 'before'),
	{
		id: 'C',
		type: 'columns',
		children: [
			{ id: 'K1', type: 'column', children: [para('A', 'left one'), para('A2', 'left two')] },
			{
				id: 'K2',
				type: 'column',
				children: [
					para('B', 'right one'),
					{
						id: 'T',
						type: 'table',
						data: { columns: [{ id: 'c1' }, { id: 'c2' }] },
						children: [
							{
								id: 'R1',
								type: 'tableRow',
								children: [
									{
										id: 'T11',
										type: 'tableCell',
										data: { column: 'c1' },
										content: [{ text: 'one' }]
									},
									{
										id: 'T12',
										type: 'tableCell',
										data: { column: 'c2' },
										content: [{ text: 'two' }]
									}
								]
							}
						]
					},
					{ id: 'K', type: 'code', content: [{ text: 'let x = 1;' }] }
				]
			}
		]
	},
	para('Z', 'after')
];

/** The doc, with the table plugin (its scenario), the editor 160px in from the page's left. */
const openDoc = async (page: Page, children: unknown[]) => {
	await page.goto(
		`/test/dom?scenario=table&handles=true&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await fit(page);
	await page.getByTestId('editor-shell').evaluate((shell) => (shell.style.marginLeft = '160px'));
	await frames(page);
};

const left = (page: Page, id: string) => box(page, id).then((b) => b.x);

test.describe('columns: Notion’s spacing', () => {
	test('the band and its line centered in the 46px gap; a column’s blocks at its edge', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, DOC);
		const g = await gapOf(page);
		expect(Math.round(g.right - g.left)).toBe(46);
		const k2 = await box(page, 'K2');
		await expect(page.locator('[data-edytor-id="T"][data-edytor-table]')).toHaveCount(1);
		for (const id of ['B', 'T', 'K']) {
			expect(Math.abs((await left(page, id)) - k2.x)).toBeLessThanOrEqual(0.5);
		}
		const k1 = await box(page, 'K1');
		for (const id of ['A', 'A2'])
			expect(Math.abs((await left(page, id)) - k1.x)).toBeLessThanOrEqual(0.5);
		const a2 = await textBox(page, 'A2');
		const row = a2.y + a2.height / 2;
		// Over column 1 (no column-2 handle shown yet): the band is there, above the hidden handles.
		await walk(page, { x: a2.x + 40, y: row }, { x: a2.x + 20, y: row });
		await expect(page.locator('[data-edytor-column-resize]')).toHaveCount(1);
		const band = (await page.locator('[data-edytor-column-resize]').boundingBox())!;
		expect(Math.abs(band.x + band.width / 2 - g.mid)).toBeLessThanOrEqual(1);
		// The hover guide, the band's middle line, is the gap's middle.
		const line = await page.locator('[data-edytor-column-resize]').evaluate((node) => {
			const after = getComputedStyle(node, '::after');
			const rect = node.getBoundingClientRect();
			return rect.left + parseFloat(after.left) + parseFloat(after.width) / 2;
		});
		expect(Math.abs(line - g.mid)).toBeLessThanOrEqual(1);
		expect(await hitAt(page, g.mid, row)).toBe('resize');
		issues.assertClean();
	});

	test('a column-2 block’s + and grip in the gap’s right part, clear of both columns; column 1’s in the margin', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, DOC);
		const g = await gapOf(page);
		const [a, b] = [await textBox(page, 'A'), await textBox(page, 'B')];
		const row = b.y + b.height / 2;
		await walk(page, { x: b.x + 30, y: row }, { x: b.x + 6, y: row });
		await expect(host(page, 'B')).toHaveAttribute('data-visible', 'true');
		const [add, move] = [
			(await plus(page, 'B').boundingBox())!,
			(await grip(page, 'B').boundingBox())!
		];
		for (const button of [add, move]) {
			expect(button.x).toBeGreaterThanOrEqual(g.left - 0.5);
			expect(button.x + button.width).toBeLessThanOrEqual(g.right + 0.5);
			expect(overlap(button, a)).toBe(false);
			expect(overlap(button, { x: g.right, width: 1000 })).toBe(false);
		}
		// Together, flush with the column; the grip right of the line.
		expect(Math.abs(move.x + move.width - g.right)).toBeLessThanOrEqual(1);
		expect(Math.abs(move.x - (add.x + add.width))).toBeLessThanOrEqual(1);
		expect(move.x).toBeGreaterThanOrEqual(g.mid);
		// The band stays above them (a press where its guide shows resizes): the
		// grip whole and the +'s part left of the band take their own press.
		const band = (await page.locator('[data-edytor-column-resize]').boundingBox())!;
		expect(Math.abs(band.x + band.width / 2 - g.mid)).toBeLessThanOrEqual(1);
		expect(overlap(move, band)).toBe(false);
		expect(add.x).toBeLessThan(band.x - 4);
		expect(await hitAt(page, (add.x + band.x) / 2, row)).toBe('handle:B');
		expect(await hitAt(page, g.mid, row)).toBe('resize');
		expect(await hitAt(page, move.x + move.width / 2, row)).toBe('handle:B');
		// Column 1's handle stays left of the column, in the page's margin.
		const k1 = await box(page, 'K1');
		const ar = a.y + a.height / 2;
		await walk(page, { x: a.x + 30, y: ar }, { x: a.x + 6, y: ar });
		await expect(host(page, 'A')).toHaveAttribute('data-visible', 'true');
		const ag = (await grip(page, 'A').boundingBox())!;
		expect(ag.x + ag.width).toBeLessThanOrEqual(k1.x + 0.5);
		issues.assertClean();
	});
});
