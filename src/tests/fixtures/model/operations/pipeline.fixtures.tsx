/** @jsxImportSource ../../../jsx */
/**
 * Operation-pipeline regression coverage for the review fixes:
 *
 * - D5: grouped moves ride the same interception contract as single
 *   ops — `onBeforeOperation` normalization, `onAfterOperation`
 *   notification, the readonly gate and one transaction/history step.
 * - D16: the document semantic `defaultType` is the fallback authority
 *   for `defaultChild`, `clear()` and the empty-root bootstrap (arch-v2
 *   D3 / D-13: `getDefaultBlock` and its implicit caret-block argument
 *   became `defaultChild(parent)` over adopted data).
 * - D20: `transformText` memoizes — repeated `children`/`renderChildren`
 *   reads do not re-run the transformer.
 * - D21: pending text-carrier aliases retire with their owner — a dead
 *   id never resolves to a dead wrapper.
 * - `onDeselect`: fires when a block leaves the selected set.
 */
import { expect, vi } from 'vitest';

import { createDocument } from '$lib/crdt/index.js';
import { Edytor } from '$lib/edytor.svelte.js';
import type { ChangePayload, Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { Text } from '$lib/text/text.svelte.js';
import { emptyFixture } from '../../helpers/model.js';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';
import { createTestEdytor, expectBlockInvariantSnapshot } from '../../../test.utils.js';

type RecordedCall = {
	phase: 'before' | 'after';
	operation: string;
	block: unknown;
	payload: unknown;
};

const makeRecorder =
	(calls: RecordedCall[]): Plugin =>
	() => ({
		onBeforeOperation: (change: ChangePayload) => {
			calls.push({
				phase: 'before',
				operation: change.operation,
				block: change.block,
				payload: change.payload
			});
		},
		onAfterOperation: (change) => {
			calls.push({
				phase: 'after',
				operation: change.operation,
				block: change.block,
				payload: change.payload
			});
		}
	});

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description:
			'intercepts grouped moves through the block operation pipeline (D5) — hooks, payload and context block',
		input: (
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>three</paragraph>
				<paragraph>four</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const calls: RecordedCall[] = [];
			edytor.plugins.push(makeRecorder(calls)(edytor));

			const [one, two] = edytor.root!.children;
			// `path`'s tail is the final index in the destination parent with
			// the moved members already excluded — reduced children are
			// [three, four], so index 1 lands [three, one, two, four].
			const moved = one.moveBlocks({ blocks: [one, two], path: [1] });

			expect(moved).toEqual([one, two]);

			const moveCalls = calls.filter((call) => call.operation === 'moveBlocks');
			expect(moveCalls.map((call) => call.phase)).toEqual(['before', 'after']);
			// The anchor block reported to plugins is the first moved block.
			expect(moveCalls[0].block).toBe(one);
			expect(moveCalls[0].payload).toEqual({ blocks: [one, two], path: [1] });
			expect(moveCalls[1].payload).toEqual({ blocks: [one, two], path: [1] });

			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>three</paragraph>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>four</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description:
			'lets onBeforeOperation normalize the grouped-move payload (D5) — the retargeted path lands',
		input: (
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>three</paragraph>
				<paragraph>four</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const retarget: Plugin = () => ({
				onBeforeOperation: (change) => {
					if (change.operation !== 'moveBlocks') {
						return;
					}
					// Retarget the drop index — the op resolves the normalized
					// path like `moveBlock` does.
					return { ...change.payload, path: [3] };
				}
			});
			edytor.plugins.push(retarget(edytor));

			const [one, two] = edytor.root!.children;
			one.moveBlocks({ blocks: [one, two], path: [1] });
		},
		output: (
			<root>
				<paragraph>three</paragraph>
				<paragraph>four</paragraph>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'gates grouped moves in readonly editors (D5)',
		readonly: true,
		input: (
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>three</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const [one, two] = edytor.root!.children;
			const moved = one.moveBlocks({ blocks: [one, two], path: [2] });
			expect(moved).toBeUndefined();
		},
		output: (
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>three</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description:
			'routes relative grouped moves through the operation pipeline (D5) with one intercepted moveBlocks op',
		input: (
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>three</paragraph>
				<paragraph>four</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const calls: RecordedCall[] = [];
			edytor.plugins.push(makeRecorder(calls)(edytor));

			const [one, two, three] = edytor.root!.children;
			const request = { blocks: [one, two], target: three, position: 'after' as const };
			expect(edytor.canMoveBlocks(request)).toBe(true);
			const moved = edytor.moveBlocks(request);

			expect(moved).toEqual([one, two]);
			expect(edytor.selection.selectedBlocks.size).toBe(0);
			const moveCalls = calls.filter((call) => call.operation === 'moveBlocks');
			// ONE intercepted op — the bare transact() path would emit none.
			expect(moveCalls.map((call) => call.phase)).toEqual(['before', 'after']);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>three</paragraph>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
				<paragraph>four</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'rejects a relative move from a different editor without changing either document',
		input: (
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const foreign = createTestEdytor(
				<root>
					<paragraph>foreign</paragraph>
				</root>
			).edytor;
			try {
				const request = {
					blocks: [foreign.root!.children[0]],
					target: edytor.root!.children[1],
					position: 'before' as const
				};
				expect(edytor.canMoveBlocks(request)).toBe(false);
				expect(edytor.moveBlocks(request)).toEqual([]);
				expect(foreign.root!.children[0].firstText?.stringContent).toBe('foreign');
			} finally {
				foreign.destroy();
			}
		},
		output: (
			<root>
				<paragraph>one</paragraph>
				<paragraph>two</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description:
			'moves existing children to the end of their parent with a reduced destination index',
		input: (
			<root>
				<paragraph>
					parent
					<paragraph>one</paragraph>
					<paragraph>two</paragraph>
					<paragraph>three</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const parent = edytor.root!.children[0];
			const [one, two] = parent.children;
			const request = { blocks: [one, two], target: parent, position: 'inside' as const };
			expect(edytor.canMoveBlocks(request)).toBe(true);
			expect(edytor.moveBlocks(request)).toEqual([one, two]);
		},
		output: (
			<root>
				<paragraph>
					parent
					<paragraph>three</paragraph>
					<paragraph>one</paragraph>
					<paragraph>two</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'rejects a relative sibling move whose destination parent is void',
		input: (
			<root>
				<paragraph>source</paragraph>
				<divider>
					<paragraph>child</paragraph>
				</divider>
			</root>
		),
		run: ({ edytor }) => {
			const [source, parent] = edytor.root!.children;
			const target = parent.children[0];
			const request = { blocks: [source], target, position: 'before' as const };
			expect(edytor.canMoveBlocks(request)).toBe(false);
			expect(edytor.moveBlocks(request)).toEqual([]);
		},
		output: (
			<root>
				<paragraph>source</paragraph>
				<divider>
					<paragraph>child</paragraph>
				</divider>
			</root>
		)
	}),
	defineModelOperationFixture({
		description:
			'adopts an injected document semantic defaultType for defaultChild, clear() and the empty-root bootstrap (D16)',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const document = createDocument({
				semantics: { defaultType: 'heading' },
				value: { children: [] }
			});
			const edytor = new Edytor({ document, plugins: [richTextPlugin] });
			// `clear()` tails into `setAtTextOffset` on a tick — the DOM walk
			// never resolves headless, so pin the model-level setter.
			edytor.selection.setAtTextOffset = async () => {};

			// The facade bootstrap block took the document default already.
			expect(edytor.root!.children[0].type).toBe('heading');
			expect(edytor.defaultChild(edytor.root!)).toBe('heading');
			expect(edytor.defaultChild(edytor.root!.children[0])).toBe('heading');

			// `clear()` reseeds one block of the semantic default type.
			edytor.clear();
			expect(edytor.root!.children.map((block) => block.type)).toEqual(['heading']);

			// The empty-root bootstrap in `normalizeChildren` reseeds the
			// semantic default rather than a hardcoded paragraph.
			edytor.root!.deleteChildren(0, edytor.root!.children.length);
			edytor.root!.normalizeChildren();
			expect(edytor.root!.children[0].type).toBe('heading');
			expectBlockInvariantSnapshot(edytor);
		}
	}),
	defineModelOperationFixture({
		description:
			'keeps parent-sensitive plugin defaults ahead of the semantic fallback (D16) — lists still default to list-item',
		input: (
			<root>
				<unordered-list>
					<list-item>item|</list-item>
				</unordered-list>
			</root>
		),
		run: ({ edytor }) => {
			const list = edytor.root!.children[0];
			expect(edytor.defaultChild(list)).toBe('list-item');
			// Unrelated parents still fall back to the semantic default.
			expect(edytor.defaultChild(list.children[0])).toBe('paragraph');
		}
	}),
	defineModelOperationFixture({
		description:
			'memoizes transformText output across repeated children/renderChildren reads (D20)',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const transformText = vi.fn(({ content }: { content: { text: string }[] }) => content);
			const transformPlugin: Plugin = (editor) => ({
				blocks: {
					// Extend the rich-text definition so `marks`/lifecycle stay
					// intact; listed first, since the first definition wins (D-11).
					paragraph: { ...(richTextPlugin(editor).blocks!.paragraph as object), transformText }
				}
			});

			const { edytor } = createTestEdytor(emptyFixture, {
				plugins: [transformPlugin, richTextPlugin],
				value: { children: [{ type: 'paragraph', content: [{ text: 'seed' }] }] }
			});
			const text = edytor.root!.children[0].content[0] as Text;

			transformText.mockClear();
			const first = text.children;
			expect(text.children).toBe(first);
			expect(text.renderChildren).toBe(text.renderChildren);
			expect(transformText).toHaveBeenCalledTimes(1);

			// A source change re-derives exactly once per state.
			text.insertAt(text.length, '!');
			text.children;
			text.children;
			expect(transformText).toHaveBeenCalledTimes(2);
		}
	}),
	defineModelOperationFixture({
		description:
			'retires pending text-carrier aliases when the owner wrapper dies (D21) — no dead-id → dead-wrapper resolution',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const { edytor } = createTestEdytor(emptyFixture, {
				value: { children: [{ type: 'paragraph', content: [{ text: 'ab' }] }] }
			});
			const block = edytor.root!.children[0];

			// Insert a text part adjacent to the existing segment — its atoms
			// merge into the live segment and the pending carrier is retired
			// with its id aliased to the owner.
			const pending = new Text({ parent: block, content: [{ text: 'c' }] });
			block.insertParts(1, [pending]);

			expect(block.content).toHaveLength(1);
			const aliasIds = [...edytor.idToText.keys()].filter((key) => key.startsWith('t_'));
			expect(aliasIds).toHaveLength(1);
			const owner = edytor.idToText.get(aliasIds[0])!;
			expect(owner._live).toBe(true);
			expect(owner._pendingAliases?.has(aliasIds[0])).toBe(true);
			expect(edytor.getTextById(aliasIds[0])).toBe(owner);

			// Emptying the segment keeps the owner alive (the text-first
			// invariant retains an empty segment), so the alias stays valid…
			block.deleteParts(0, 1);
			expect(edytor.idToText.get(aliasIds[0])).toBe(owner);

			// …but killing the owner purges the alias — the map never
			// resolves a dead id to a dead wrapper.
			edytor.root!.deleteChildren(0, 1);
			expect(owner._live).toBe(false);
			expect(edytor.idToText.get(aliasIds[0])).toBeUndefined();
			expect([...edytor.idToText.keys()].filter((key) => key.startsWith('t_'))).toHaveLength(0);
		}
	}),
	defineModelOperationFixture({
		description: 'invokes BlockDefinition.onDeselect when a block leaves the selected set',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const onSelect = vi.fn();
			const onDeselect = vi.fn();
			const lifecyclePlugin: Plugin = (editor) => ({
				blocks: {
					paragraph: {
						...(richTextPlugin(editor).blocks!.paragraph as object),
						onSelect,
						onDeselect
					}
				}
			});

			const { edytor } = createTestEdytor(emptyFixture, {
				plugins: [lifecyclePlugin, richTextPlugin],
				value: { children: [{ type: 'paragraph', content: [{ text: 'a' }] }] }
			});
			const block = edytor.root!.children[0];

			edytor.selection.selectBlocks(block);
			expect(onSelect).toHaveBeenCalledWith({ block });
			expect(onDeselect).not.toHaveBeenCalled();

			// Both removal paths fire it — wholesale reselection…
			edytor.selection.selectBlocks();
			expect(onDeselect).toHaveBeenCalledTimes(1);
			expect(onDeselect).toHaveBeenCalledWith({ block });

			// …and the targeted removal path.
			edytor.selection.selectBlocks(block);
			edytor.selection.removeBlockFromSelection(block);
			expect(onDeselect).toHaveBeenCalledTimes(2);
		}
	})
]);
