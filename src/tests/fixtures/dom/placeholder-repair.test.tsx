/** @jsxImportSource ../../jsx */
/**
 * The placeholder attribute in a mounted editor (plan §2.4 "Placeholder
 * attribute", D-8; R5 replaced the U6 repair queue with it).
 *
 * The empty text of an empty block carries `data-placeholder`; the attribute
 * follows the model through every commit and is an owned attribute of the
 * text element, so foreign damage to it is healed like any other.
 */
import { describe, expect, test } from 'vitest';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	dispatchDomBeforeInput
} from '../../dom/test.utils.js';

const MARKED = '[data-edytor-text][data-placeholder]';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mounted editor — placeholder attribute', () => {
	test('placeholder lifecycle: empty → type → gone, delete-all → back', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph></paragraph>
				<paragraph>note</paragraph>
			</root>,
			{ placeholder: 'Write something here ...' }
		);
		expect(editor.querySelectorAll(MARKED)).toHaveLength(1);
		const text = edytor.root!.children[0]!.firstText!;
		expect(text.node?.getAttribute('data-placeholder')).toBe('Write something here ...');
		await setNativeSelection(edytor, text, 0);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'A' });
		await flushDomUpdates();
		expect(editor.querySelectorAll(MARKED)).toHaveLength(0);

		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await flushDomUpdates();
		expect(editor.querySelectorAll(MARKED)).toHaveLength(1);
	});

	test('an empty heading with non-empty children keeps its own placeholder', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>x</paragraph>
			</root>,
			{
				placeholder: 'Type here',
				value: {
					children: [
						{
							id: 'h',
							type: 'heading',
							data: { level: 'h1' },
							content: [],
							children: [{ id: 'c', type: 'paragraph', content: [{ text: 'child' }] }]
						}
					]
				}
			}
		);
		const heading = edytor.idToBlock.get('h')!;
		expect(heading.firstText?.node?.getAttribute('data-placeholder')).toBe('Type here');
		expect(editor.querySelectorAll(MARKED)).toHaveLength(1);
	});

	test('foreign damage to the attribute is healed from the model', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph></paragraph>
				<paragraph>note</paragraph>
			</root>,
			{ placeholder: 'Write' }
		);
		const [empty, full] = edytor.root!.children.map((block) => block.firstText!.node!);
		empty.removeAttribute('data-placeholder');
		full.setAttribute('data-placeholder', 'spoof');
		await flushDomUpdates();
		await sleep(20);
		expect(empty.getAttribute('data-placeholder')).toBe('Write');
		expect(full.hasAttribute('data-placeholder')).toBe(false);
		expect(editor.querySelectorAll(MARKED)).toHaveLength(1);
	});

	test('empty text-node anchors inside a block survive renders', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>
		);
		const blockNode = edytor.root!.children[0]!.node!;
		// Svelte uses empty text nodes as {#if}/{#each} fragment anchors.
		const anchor = document.createTextNode('');
		blockNode.append(anchor);
		const text = edytor.root!.children[0]!.firstText!;
		edytor.transact(() => {
			text.insertAt(text.length, '!');
		});
		await flushDomUpdates();
		await sleep(20);
		expect(anchor.isConnected).toBe(true);
		expect(editor.contains(anchor)).toBe(true);
	});
});
