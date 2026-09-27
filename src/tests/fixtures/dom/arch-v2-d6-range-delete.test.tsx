/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint D6 rows, dom lane (the doc halves live in
 * `src/tests/crdt/arch-v2/d6-range-delete.test.ts`).
 *
 * - F-D12 — `[ordered-list > [i1 "one", i2 "two"], P "three"]`; select
 *   i1@0 → P@2; Backspace → `[P "ree"]`, caret `P@0`; no empty container
 *   left (P5: red on the reference, the emptied `ordered-list` stays).
 * - `del.range.outside-survives` through the real command: the later item of
 *   a container the range dies through survives (red on the reference: it
 *   died with the container).
 *
 * Expected values come from the plan rows and the contract, never from
 * running the code.
 */
import { describe, expect, it } from 'vitest';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { createBeforeInputSnapshot } from '$lib/events/beforeInputSnapshot.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	assertCanonicalTree,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference: expected-fail until D6 lands. */
const row = it.fails;

const backspace = (edytor: Edytor) =>
	runBeforeInputCommand(
		edytor,
		createBeforeInputSnapshot(
			edytor,
			{
				inputType: 'deleteContentBackward',
				data: null,
				dataTransfer: null,
				cancelable: true,
				preventDefault() {}
			} as InputEvent,
			null
		)
	);

const caret = (edytor: Edytor) => ({
	text: edytor.selection.state.startText?.stringContent,
	at: edytor.selection.state.yStart,
	collapsed: edytor.selection.state.isCollapsed
});

describe('F-D12 — nested, empty container (dom)', () => {
	row('i1@0 → P@2, Backspace → [P "ree"], caret P@0', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>one</list-item>
					<list-item>two</list-item>
				</ordered-list>
				<paragraph>three</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const i1 = edytor.root!.children[0]!.children[0]!.firstText;
		const p = edytor.root!.children[1]!.firstText;
		const pId = edytor.root!.children[1]!.id;
		await setNativeSelection(edytor, i1, 0, p, 2);
		await backspace(edytor);
		await flushDomUpdates();
		assertCanonicalTree(edytor, [{ type: 'paragraph', id: pId, content: [{ text: 'ree' }] }]);
		expect(caret(edytor)).toEqual({ text: 'ree', at: 0, collapsed: true });
	});
});

describe('del.range.outside-survives (dom)', () => {
	row('alpha@2 → beta@2: gamma survives the dying list', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>alpha</paragraph>
				<ordered-list>
					<list-item>beta</list-item>
					<list-item>gamma</list-item>
				</ordered-list>
				<paragraph>omega</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const alpha = edytor.root!.children[0]!.firstText;
		const beta = edytor.root!.children[1]!.children[0]!.firstText;
		await setNativeSelection(edytor, alpha, 2, beta, 2);
		await backspace(edytor);
		await flushDomUpdates();
		assertCanonicalTree(edytor, [
			{ type: 'paragraph', content: [{ text: 'alta' }] },
			{ type: 'list-item', content: [{ text: 'gamma' }] },
			{ type: 'paragraph', content: [{ text: 'omega' }] }
		]);
		expect(caret(edytor)).toEqual({ text: 'alta', at: 2, collapsed: true });
	});
});
