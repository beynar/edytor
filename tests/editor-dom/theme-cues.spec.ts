import { expect, test, type Page } from './editorTest';
import { notionTheme, trackPageIssues, waitForEditorReady } from './helpers';

/**
 * The overlay's visual cues (a drop line, a nest backdrop, a resize guide,
 * an image's pill, another user's caret) are placed by their plugins and
 * painted by a theme: the plugins' CSS carries no colour, so without the
 * theme they are unpainted, and the Notion theme paints them, its class on
 * the editor itself (the overlay is the editor's sibling) as on an element
 * around it. A peer's colour reaches the theme as `--edytor-remote-color`.
 */

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/** Notion's paint of each cue (the demo's look before the theme took it), a peer in its own colour. */
const NOTION = {
	drop: 'rgba(35, 131, 226, 0.43)',
	backdrop: 'rgba(35, 131, 226, 0.14)',
	tableDrop: 'rgba(35, 131, 226, 0.43)',
	columnGuide: 'rgba(35, 131, 226, 0.43)',
	caret: 'rgb(220, 38, 38)',
	range: 'rgb(220, 38, 38)',
	label: 'rgb(220, 38, 38)',
	pill: 'rgba(15, 15, 15, 0.6)'
};

/** One element per cue in the overlay, as the plugins mark them; its paint, by name. */
const paint = (page: Page) =>
	page.evaluate(() => {
		const layer = document.querySelector<HTMLElement>('[data-edytor-overlay]')!;
		const cue = (attributes: Record<string, string>, style = '') => {
			const node = document.createElement('span');
			for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
			node.setAttribute('style', style);
			layer.append(node);
			return node;
		};
		const nodes = {
			drop: cue({ 'data-edytor-drop-indicator': 'true' }),
			backdrop: cue({ 'data-edytor-drop-backdrop': 'true', 'data-shown': 'true' }),
			tableDrop: cue({ 'data-edytor-table-drop': 'row' }),
			columnGuide: cue({ 'data-edytor-column-resize-guide': '' }),
			caret: cue({ 'data-edytor-remote-cursor': '' }, '--edytor-remote-color: #dc2626'),
			range: cue({ 'data-edytor-remote-selection': '' }, '--edytor-remote-color: #dc2626')
		};
		const label = document.createElement('span');
		label.setAttribute('data-edytor-remote-cursor-label', '');
		nodes.caret.append(label);
		const pill = cue({ 'data-edytor-image-resize': 'right' });
		const read = {
			...Object.fromEntries(
				Object.entries(nodes).map(([name, node]) => [name, getComputedStyle(node).backgroundColor])
			),
			label: getComputedStyle(label).backgroundColor,
			pill: getComputedStyle(pill, '::after').backgroundColor
		};
		for (const node of [...Object.values(nodes), pill]) node.remove();
		return read;
	});

test.describe('theme.cues: the plugins place the overlay cues, a theme paints them', () => {
	test('without the theme every cue is unpainted; the Notion theme paints each, a peer in its colour', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic&handles=true');
		await waitForEditorReady(page, { requireRuntime: true });

		const bare = await paint(page);
		expect(Object.values(bare).every((color) => color === TRANSPARENT)).toBe(true);

		// The class on the editor itself: the overlay is its sibling.
		await notionTheme(page);
		expect(await paint(page)).toEqual(NOTION);
		issues.assertClean();
	});

	test('the demo, its class on an element around the editor, paints them the same', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/');
		await waitForEditorReady(page);
		expect(await paint(page)).toEqual(NOTION);
		issues.assertClean();
	});
});
