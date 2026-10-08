/** @jsxImportSource ../../jsx */
import { expect } from 'vitest';

import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createAttachmentProbe } from '../helpers/attachments.js';
import { dispatchDomBeforeInput, dispatchDomKeyDown, dragSelection } from '../../dom/test.utils.js';
import { defineDomFixture, defineFixtures } from '../types.js';

const splitProbe = createAttachmentProbe();
const backwardMergeProbe = createAttachmentProbe();
const forwardMergeProbe = createAttachmentProbe();
const deleteProbe = createAttachmentProbe();
const markProbe = createAttachmentProbe();
const selectionProbe = createAttachmentProbe();

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'insertParagraph only attaches the new block/text path',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, splitProbe.plugin],
		run: async ({ editor }) => {
			splitProbe.clear();
			return dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph></paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		assert: async ({ edytor }) => {
			const events = splitProbe.read();
			const attachedBlocks = events.filter(
				(event) => event.kind === 'block' && event.phase === 'attach'
			);
			const detachedBlocks = events.filter(
				(event) => event.kind === 'block' && event.phase === 'detach'
			);
			const attachedTexts = events.filter(
				(event) => event.kind === 'text' && event.phase === 'attach'
			);
			const newBlockId = edytor.root?.children[1]?.id;
			const newTextId = edytor.root?.children[1]?.firstText?.id;

			expect(detachedBlocks).toEqual([]);
			expect(attachedBlocks.map((event) => event.id)).toEqual([newBlockId]);
			expect(attachedTexts.map((event) => event.id)).toEqual([newTextId]);
		}
	}),
	defineDomFixture({
		description: 'backward merge detaches only the removed trailing block path',
		input: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>|World</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, backwardMergeProbe.plugin],
		run: async ({ editor, edytor }) => {
			const removedBlockId = edytor.root?.children[1]?.id;
			const removedTextId = edytor.root?.children[1]?.firstText?.id;
			backwardMergeProbe.clear();
			await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
			return { removedBlockId, removedTextId };
		},
		output: (
			<root>
				<paragraph>HelloWorld</paragraph>
			</root>
		),
		assert: async ({ result, edytor }) => {
			const events = backwardMergeProbe.read();
			const detachedBlocks = events.filter(
				(event) => event.kind === 'block' && event.phase === 'detach'
			);
			const detachedTexts = events.filter(
				(event) => event.kind === 'text' && event.phase === 'detach'
			);
			const survivingBlockId = edytor.root?.children[0]?.id;

			expect(detachedBlocks.map((event) => event.id)).toContain(
				(result as { removedBlockId?: string }).removedBlockId
			);
			expect(detachedTexts.map((event) => event.id)).toContain(
				(result as { removedTextId?: string }).removedTextId
			);
			expect(detachedBlocks.map((event) => event.id)).not.toContain(survivingBlockId);
		}
	}),
	defineDomFixture({
		description: 'forward merge detaches only the removed next block path',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, forwardMergeProbe.plugin],
		run: async ({ editor, edytor }) => {
			const removedBlockId = edytor.root?.children[1]?.id;
			const removedTextId = edytor.root?.children[1]?.firstText?.id;
			forwardMergeProbe.clear();
			await dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' });
			return { removedBlockId, removedTextId };
		},
		output: (
			<root>
				<paragraph>HelloWorld</paragraph>
			</root>
		),
		assert: async ({ result, edytor }) => {
			const events = forwardMergeProbe.read();
			const detachedBlocks = events.filter(
				(event) => event.kind === 'block' && event.phase === 'detach'
			);
			const detachedTexts = events.filter(
				(event) => event.kind === 'text' && event.phase === 'detach'
			);
			const survivingBlockId = edytor.root?.children[0]?.id;

			expect(detachedBlocks.map((event) => event.id)).toContain(
				(result as { removedBlockId?: string }).removedBlockId
			);
			expect(detachedTexts.map((event) => event.id)).toContain(
				(result as { removedTextId?: string }).removedTextId
			);
			expect(detachedBlocks.map((event) => event.id)).not.toContain(survivingBlockId);
		}
	}),
	defineDomFixture({
		description: 'selected block deletion detaches removed nodes and keeps survivors stable',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, deleteProbe.plugin],
		run: async ({ edytor }) => {
			const removedBlockId = edytor.root?.children[1]?.id;
			const survivingIds = [edytor.root?.children[0]?.id, edytor.root?.children[2]?.id];
			deleteProbe.clear();
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'Backspace', code: 'Backspace' });
			return { removedBlockId, survivingIds };
		},
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			const events = deleteProbe.read();
			const detachedBlocks = events.filter(
				(event) => event.kind === 'block' && event.phase === 'detach'
			);
			expect(detachedBlocks.map((event) => event.id)).toContain(
				(result as { removedBlockId?: string }).removedBlockId
			);
			for (const id of (result as { survivingIds: Array<string | undefined> }).survivingIds) {
				expect(detachedBlocks.map((event) => event.id)).not.toContain(id);
			}
		}
	}),
	defineDomFixture({
		description: 'mark toggles do not remount block wrappers',
		input: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		autoSelectFixture: false,
		plugins: [richTextPlugin, mentionPlugin, markProbe.plugin],
		run: async ({ edytor }) => {
			markProbe.clear();
			await dragSelection(edytor, [0, 0], 0, [1, 0], 5);
			await dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
		},
		assert: async () => {
			const events = markProbe.read();
			expect(events.filter((event) => event.kind === 'block')).toEqual([]);
		}
	}),
	defineDomFixture({
		description: 'selection-only changes do not trigger attach churn',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, selectionProbe.plugin],
		run: async ({ edytor }) => {
			selectionProbe.clear();
			await dragSelection(edytor, [0, 0], 1, [1, 0], 3);
		},
		assert: async () => {
			expect(selectionProbe.read()).toEqual([]);
		}
	})
]);
