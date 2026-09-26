/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint D3 rows, dom lane (the doc halves live in
 * `src/tests/crdt/arch-v2/d3-capability.test.ts`).
 *
 * - F-D4 — `ordered-list > [li "one"]`: Enter at end, middle, start gives
 *   `[li "one", li ""]`, `[li "o", li "ne"]`, `[li "", li "one"]`; an island
 *   merged out into the list leaves its child as an `li` (G5). Red on the
 *   reference (P12, P10).
 * - F-S14 (dev-check half) — a kind declared `rendersContent: true` (the
 *   default) whose snippet renders no `content()`: the dev check reports the
 *   undeclared phantom. Kinds that declare `rendersContent: false` (the list
 *   containers) and kinds that render their content are not reported. The
 *   seam half ("the caret lands on the next displayable stop") is V3's.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { d3KindsPlugin } from '../../dom/D3KindsPlugin.svelte';
import type { Edytor } from '$lib/edytor.svelte.js';

/** `[type, text]` of each child of the first root block. */
const listShape = (edytor: Edytor) =>
	(edytor.value.children?.[0]?.children ?? []).map((child) => [
		child.type,
		(child.content ?? []).map((part) => ('text' in part ? part.text : '')).join('')
	]);

describe('F-D4 — same definition, different position (dom)', () => {
	test.fails('Enter at the end of a list item creates a list item', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>one|</list-item>
				</ordered-list>
			</root>
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(listShape(edytor)).toEqual([
			['list-item', 'one'],
			['list-item', '']
		]);
	});

	test('Enter in the middle of a list item creates a list item', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>o|ne</list-item>
				</ordered-list>
			</root>
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(listShape(edytor)).toEqual([
			['list-item', 'o'],
			['list-item', 'ne']
		]);
	});

	test.fails('Enter at the start of a list item creates a list item', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>|one</list-item>
				</ordered-list>
			</root>
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		expect(listShape(edytor)).toEqual([
			['list-item', ''],
			['list-item', 'one']
		]);
	});

	test.fails('an island merged out of a list leaves its child as a list item', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>one</list-item>
					<box>
						<line>two</line>
					</box>
				</ordered-list>
			</root>,
			{ plugins: [richTextPlugin, d3KindsPlugin], autoSelectFixture: false }
		);
		const list = edytor.root!.children[0]!;
		const box = list.children[1]!;
		await setNativeSelection(edytor, box.content[0] as never, 0);
		box.mergeBlockBackward();
		await flushDomUpdates();
		expect(listShape(edytor).map(([type]) => type)).toEqual(['list-item', 'list-item']);
		expect(listShape(edytor).at(-1)).toEqual(['list-item', 'two']);
	});
});

describe('F-S14 — dev check of declared rendersContent', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const phantomReports = (spy: ReturnType<typeof vi.spyOn>) =>
		spy.mock.calls.filter((args) => String(args[0]).includes('rendersContent'));

	test.fails('an undeclared phantom content slot is reported', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await renderDomEdytor(
			<root>
				<panel>
					<paragraph>inside|</paragraph>
				</panel>
			</root>,
			{ plugins: [richTextPlugin, d3KindsPlugin] }
		);
		const reports = phantomReports(warn);
		expect(reports.length).toBeGreaterThan(0);
		expect(String(reports[0]![0])).toContain('"panel"');
	});

	test('declared containers and content-rendering kinds are not reported', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>one|</list-item>
				</ordered-list>
				<paragraph>two</paragraph>
			</root>,
			{ plugins: [richTextPlugin, d3KindsPlugin] }
		);
		expect(phantomReports(warn)).toEqual([]);
	});
});
