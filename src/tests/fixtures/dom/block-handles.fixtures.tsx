/** @jsxImportSource ../../jsx */
import { expect } from 'vitest';

import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
import type { Plugin } from '$lib/plugins.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { dispatchDomKeyDown, flushDomUpdates } from '../../dom/test.utils.js';
import { defineDomFixture, defineFixtures } from '../types.js';

const blockHandlePlugins = [richTextPlugin, mentionPlugin, blockHandlesPlugin];
const preventMovePlugin: Plugin = () => ({
	onBeforeOperation: ({ operation, prevent }) => {
		if (operation === 'moveBlock') {
			prevent();
		}
	}
});

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'renders visible block handles for mounted editable blocks',
		plugins: blockHandlePlugins,
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: () => flushDomUpdates(),
		assert: async ({ getAllByTestId }) => {
			const handles = getAllByTestId('block-handle');
			expect(handles).toHaveLength(2);
			expect(handles.every((handle) => handle.getAttribute('draggable') === 'true')).toBe(true);
		}
	}),
	defineDomFixture({
		description: 'moves a block before its previous sibling with the keyboard fallback',
		plugins: blockHandlePlugins,
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: async ({ getAllByTestId }) => {
			const secondHandle = getAllByTestId('block-handle')[1];
			await dispatchDomKeyDown(secondHandle, { key: 'ArrowUp', code: 'ArrowUp', altKey: true });
		},
		output: (
			<root>
				<paragraph>Second</paragraph>
				<paragraph>First</paragraph>
			</root>
		),
		expectSelection: {
			selectedBlockPaths: [[0]]
		}
	}),
	defineDomFixture({
		description: 'treats a plugin-prevented handle move as a canceled keyboard action',
		plugins: [...blockHandlePlugins, preventMovePlugin],
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: async ({ getAllByTestId }) => {
			await dispatchDomKeyDown(getAllByTestId('block-handle')[1], {
				key: 'ArrowUp',
				code: 'ArrowUp',
				altKey: true
			});
		},
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		)
	}),
	defineDomFixture({
		description: 'moves a block inside its previous sibling with the keyboard fallback',
		plugins: blockHandlePlugins,
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: async ({ getAllByTestId }) => {
			const secondHandle = getAllByTestId('block-handle')[1];
			await dispatchDomKeyDown(secondHandle, {
				key: 'ArrowRight',
				code: 'ArrowRight',
				altKey: true
			});
		},
		output: (
			<root>
				<paragraph>
					First
					<paragraph>Second</paragraph>
				</paragraph>
			</root>
		),
		expectSelection: {
			selectedBlockPaths: [[0, 0]]
		}
	}),
	defineDomFixture({
		// U10 regression — chromium `block-handles.spec.ts` "drags multiple
		// selected sibling blocks together" lost BOTH dragged blocks: the
		// pre-v14 path cloned JSON, deleted the sources, then re-inserted the
		// same ids, which `facade.insertBlock` refuses (registry entries are
		// retained after delete). The grouped drag now goes through one
		// `facade.moveBlocks` transaction — identity preserved, one undo step.
		description: 'drags multiple selected sibling blocks together (identity preserved)',
		plugins: blockHandlePlugins,
		input: (
			<root>
				<paragraph>lead</paragraph>
				<paragraph>note</paragraph>
				<paragraph>tail</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const [lead, note, tail] = edytor.root!.children;
			const leadCrdtId = edytor.facade!.crdtId(lead.id);
			const noteCrdtId = edytor.facade!.crdtId(note.id);
			edytor.selection.selectBlocks(lead, note);
			const moved = edytor.moveBlocks({ blocks: [lead, note], target: tail, position: 'after' });
			await flushDomUpdates();
			return { moved, lead, note, leadCrdtId, noteCrdtId };
		},
		output: (
			<root>
				<paragraph>tail</paragraph>
				<paragraph>lead</paragraph>
				<paragraph>note</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			const { moved, lead, note, leadCrdtId, noteCrdtId } = result as any;
			// The SAME wrappers came back — no clone/delete/recreate.
			expect(moved).toEqual([lead, note]);
			expect(lead._live).toBe(true);
			expect(note._live).toBe(true);
			// Engine identity retained through the grouped move.
			expect(moved[0].edytor.facade!.crdtId(lead.id)).toBe(leadCrdtId);
			expect(moved[0].edytor.facade!.crdtId(note.id)).toBe(noteCrdtId);
		},
		expectSelection: {
			selectedBlockPaths: [[1], [2]]
		}
	}),
	defineDomFixture({
		description: 'drags a selected group inside a target block',
		plugins: blockHandlePlugins,
		input: (
			<root>
				<paragraph>parent</paragraph>
				<paragraph>lead</paragraph>
				<paragraph>note</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const [parent, lead, note] = edytor.root!.children;
			edytor.selection.selectBlocks(lead, note);
			edytor.moveBlocks({ blocks: [lead, note], target: parent, position: 'inside' });
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>
					parent
					<paragraph>lead</paragraph>
					<paragraph>note</paragraph>
				</paragraph>
			</root>
		),
		expectSelection: {
			selectedBlockPaths: [
				[0, 0],
				[0, 1]
			]
		}
	})
]);
