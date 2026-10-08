/** @jsxImportSource ../../jsx */
/**
 * Handles read through the cells (`concepts/editor-instance`, "Reactivity"):
 * a reactive reader (a template, a `$derived`, an `$effect`) of a handle
 * getter re-runs when a commit changes what the getter answers, the way
 * `block.data` already did. Inside a command (no reactive reader) the
 * getters read the document as before.
 *
 * And `onDocChange`: a view's subscriber to the change report itself, one
 * per commit that changed the visible document, without the whole-document
 * export `onChange` pays for.
 *
 * Expected values come from the rule (what the document holds after each
 * commit), never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocChange } from '$lib/crdt/index.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { Text } from '$lib/text/text.svelte.js';
import { mentionPlugin } from '../../atMention.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';
import { watch } from '../../dom/watch.svelte.js';

const stops: (() => void)[] = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	vi.restoreAllMocks();
});
const watched = <T,>(read: () => T) => {
	const w = watch(read);
	stops.push(w.stop);
	return w.seen;
};

describe('handle getters are reactive', () => {
	it('block.type follows a retype', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
				<paragraph>Two</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		const seen = watched(() => block.type);
		block.type = 'quote';
		await flushDomUpdates();
		expect(seen).toEqual(['paragraph', 'quote']);
	});

	it('a parent’s children and the root’s follow an insert and a delete', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
				<paragraph>Two</paragraph>
			</root>
		);
		const ids = watched(() => edytor.root!.children.map((child) => child.id));
		const [first, second] = edytor.root!.children;
		first!.insertBlockAfter({ block: { type: 'paragraph', content: [{ text: 'New' }] } });
		await flushDomUpdates();
		const added = edytor.root!.children[1]!.id;
		second!.removeBlock();
		await flushDomUpdates();
		expect(ids.at(0)).toEqual([first!.id, second!.id]);
		expect(ids.at(-1)).toEqual([first!.id, added]);
		expect(ids).toContainEqual([first!.id, added, second!.id]);
	});

	it('block.content and a text handle follow typing', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		const text = block.content[0] as Text;
		const strings = watched(() => text.stringContent);
		const lengths = watched(() => block.content.length);
		block.model!.insertText(3, '!');
		await flushDomUpdates();
		expect(strings).toEqual(['One', 'One!']);
		block.addInlineBlock({ offset: 4, block: { type: 'mention', data: { name: 'Ada' } } });
		await flushDomUpdates();
		// text, atom, text
		expect(lengths.at(-1)).toBe(3);
	});

	it('block.parent and block.index follow a move', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
				<paragraph>Two</paragraph>
				<paragraph>Three</paragraph>
			</root>
		);
		const [one, two, three] = edytor.root!.children;
		const places = watched(() => [three!.parent?.id, three!.index]);
		three!.nestBlock();
		await flushDomUpdates();
		expect(places).toEqual([
			['root', 2],
			[two!.id, 0]
		]);
		expect(one!.index).toBe(0);
	});

	it('block.isInTree follows a delete, and its undo', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
				<paragraph>Two</paragraph>
			</root>
		);
		const two = edytor.root!.children[1]!;
		const live = watched(() => two.isInTree);
		two.removeBlock();
		await flushDomUpdates();
		edytor.historyUndo();
		await flushDomUpdates();
		expect(live).toEqual([true, false, true]);
	});

	it('a peer’s change re-runs the readers too', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		const types = watched(() => block.type);
		const texts = watched(() => (block.content[0] as Text).stringContent);
		// A raw document write, outside the view's commands (as a remote update lands).
		edytor.facade.block(block.id).setType('heading');
		edytor.facade.block(block.id).insertText(0, '> ');
		await flushDomUpdates();
		expect(types).toEqual(['paragraph', 'heading']);
		expect(texts).toEqual(['One', '> One']);
	});

	it('a getter read outside any reactive reader still reads the document', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		edytor.transact(() => {
			block.type = 'quote';
			// Inside the command, before any commit: the document's answer.
			expect(block.type).toBe('quote');
		});
	});
});

describe('onDocChange', () => {
	it('receives each commit’s change report and never exports the document', async () => {
		const reports: DocChange[] = [];
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
				<paragraph>Two</paragraph>
			</root>,
			{ onDocChange: (change: DocChange) => reports.push(change) }
		);
		const exports = vi.spyOn(edytor.facade, 'toJSON');
		const [one, two] = edytor.root!.children;
		one!.model!.insertText(3, '!');
		two!.type = 'quote';
		await flushDomUpdates();
		expect(reports).toHaveLength(2);
		expect([...reports[0]!.content.keys()]).toEqual([one!.id]);
		expect(reports[1]!.meta.get(two!.id)?.type).toBe('quote');
		expect(exports).not.toHaveBeenCalled();
		// The report is shared with every subscriber of the document: read-only.
		const mutate = (change: DocChange) => {
			// @ts-expect-error a shared report is read-only
			change.removed.add(one!.id);
			// @ts-expect-error a shared report is read-only
			change.order.set(null, []);
		};
		void mutate;
	});

	it('a plugin’s onDocChange receives the same reports', async () => {
		const seen: DocChange[] = [];
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
			</root>,
			{
				plugins: [
					richTextPlugin,
					mentionPlugin,
					(() => ({ onDocChange: (change: DocChange) => void seen.push(change) })) as Plugin
				]
			}
		);
		edytor.root!.children[0]!.model!.insertText(0, 'A');
		await flushDomUpdates();
		expect(seen).toHaveLength(1);
		expect(seen[0]!.content.size).toBe(1);
	});

	it('a throwing consumer is logged and never starves the others', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const calls: string[] = [];
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
			</root>,
			{
				onDocChange: () => {
					calls.push('prop onDocChange');
					throw new Error('prop onDocChange');
				},
				onChange: () => {
					calls.push('prop onChange');
					throw new Error('prop onChange');
				},
				plugins: [
					richTextPlugin,
					mentionPlugin,
					(() => ({
						onDocChange: () => {
							calls.push('plugin onDocChange');
							throw new Error('plugin onDocChange');
						},
						onChange: () => void calls.push('plugin onChange')
					})) as Plugin
				]
			}
		);
		edytor.root!.children[0]!.model!.insertText(0, 'A');
		await flushDomUpdates();
		expect(calls).toEqual([
			'prop onDocChange',
			'plugin onDocChange',
			'prop onChange',
			'plugin onChange'
		]);
		expect(logged).toHaveBeenCalledTimes(3);
		expect(edytor.value.children[0]!.content).toEqual([{ text: 'AOne' }]);
	});
});
