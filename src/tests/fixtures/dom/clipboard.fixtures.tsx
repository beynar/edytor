/** @jsxImportSource ../../jsx */
import { expect } from 'vitest';

import { EDYTOR_FRAGMENT_MIME, readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import {
	clickText,
	dispatchClipboardPaste,
	dispatchCopy,
	dispatchCut
} from '../../dom/test.utils.js';
import { defineDomFixture, defineFixtures } from '../types.js';

const readFragmentFromRecord = (clipboardData: Record<string, string>) =>
	readEdytorClipboardFragment({
		getData: (type: string) => clipboardData[type] ?? ''
	});

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'copy writes internal, html, and plain clipboard formats without history',
		input: (
			<root>
				<paragraph>Hel|lo|</paragraph>
			</root>
		),
		run: async ({ edytor, editor }) => {
			const undoCount = edytor.undoManager.undoStack.length;
			const result = await dispatchCopy(editor);
			return { result, undoCount };
		},
		assert: async ({ result }) => {
			const { result: copyResult, undoCount } = result as {
				result: Awaited<ReturnType<typeof dispatchCopy>>;
				undoCount: number;
			};
			expect(copyResult.defaultPrevented).toBe(true);
			expect(copyResult.clipboardData[EDYTOR_FRAGMENT_MIME]).toBeTruthy();
			expect(copyResult.clipboardData['text/html']).toContain('data-edytor-fragment');
			expect(copyResult.clipboardData['text/plain']).toBe('lo');
			expect(readFragmentFromRecord(copyResult.clipboardData)).toMatchObject({
				kind: 'content',
				content: [{ text: 'lo' }]
			});
			expect(undoCount).toBe(0);
		}
	}),
	defineDomFixture({
		description: 'cut writes clipboard data and deletes selected text',
		input: (
			<root>
				<paragraph>Hel|lo|</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchCut(editor),
		output: (
			<root>
				<paragraph>Hel</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			const cutResult = result as Awaited<ReturnType<typeof dispatchCut>>;
			expect(cutResult.defaultPrevented).toBe(true);
			expect(cutResult.clipboardData[EDYTOR_FRAGMENT_MIME]).toBeTruthy();
			expect(cutResult.clipboardData['text/plain']).toBe('lo');
		}
	}),
	defineDomFixture({
		description: 'paste consumes internal fragments before html/plain fallbacks',
		input: (
			<root>
				<paragraph>
					<bold>Hel|lo</bold> <mention></mention>ta|il
				</paragraph>
				<paragraph>target</paragraph>
			</root>
		),
		run: async ({ edytor, editor }) => {
			const copyResult = await dispatchCopy(editor);
			await clickText(edytor, [1, 0], 0);
			return dispatchClipboardPaste(editor, {
				...copyResult.clipboardData,
				'text/html': '<p>External</p>',
				'text/plain': 'Plain'
			});
		},
		output: (
			<root>
				<paragraph>
					<bold>Hello</bold> <mention></mention>tail
				</paragraph>
				<paragraph>
					<bold>lo</bold> <mention></mention>tatarget
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			startTextPath: [1, 2],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			expect((result as { defaultPrevented: boolean }).defaultPrevented).toBe(true);
		}
	}),
	defineDomFixture({
		description: 'cut selected blocks removes the selected block and keeps clipboard content',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		run: async ({ edytor, editor }) => {
			edytor.selection.selectBlocks(edytor.root!.children[1]);
			return dispatchCut(editor);
		},
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			const cutResult = result as Awaited<ReturnType<typeof dispatchCut>>;
			expect(cutResult.defaultPrevented).toBe(true);
			expect(cutResult.clipboardData['text/plain']).toBe('Second');
			expect(readFragmentFromRecord(cutResult.clipboardData)).toMatchObject({
				kind: 'blocks',
				blocks: [{ type: 'paragraph', content: [{ text: 'Second' }] }]
			});
		}
	}),
	defineDomFixture({
		description: 'readonly allows copy but blocks cut and paste mutations',
		input: (
			<root>
				<paragraph>Hel|lo|</paragraph>
			</root>
		),
		readonly: true,
		run: async ({ editor }) => {
			const copyResult = await dispatchCopy(editor);
			const cutResult = await dispatchCut(editor);
			const pasteResult = await dispatchClipboardPaste(editor, { 'text/plain': 'X' });
			return { copyResult, cutResult, pasteResult };
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			const { copyResult, cutResult, pasteResult } = result as {
				copyResult: Awaited<ReturnType<typeof dispatchCopy>>;
				cutResult: Awaited<ReturnType<typeof dispatchCut>>;
				pasteResult: Awaited<ReturnType<typeof dispatchClipboardPaste>>;
			};
			expect(copyResult.defaultPrevented).toBe(true);
			expect(copyResult.clipboardData['text/plain']).toBe('lo');
			expect(cutResult.defaultPrevented).toBe(false);
			expect(pasteResult.defaultPrevented).toBe(false);
		}
	}),
	defineDomFixture({
		description: 'paste replaces selected blocks with internal content fragments',
		input: (
			<root>
				<paragraph>Al|pha|</paragraph>
				<paragraph>Replace me</paragraph>
				<paragraph>Keep me</paragraph>
			</root>
		),
		run: async ({ edytor, editor }) => {
			const copyResult = await dispatchCopy(editor);
			edytor.selection.selectBlocks(edytor.root!.children[1]);
			return dispatchClipboardPaste(editor, copyResult.clipboardData);
		},
		output: (
			<root>
				<paragraph>Alpha</paragraph>
				<paragraph>pha</paragraph>
				<paragraph>Keep me</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		// D-24 G-a: external HTML falls back to its text/plain (no HTML import plugin).
		description: 'external html paste places its text/plain over the selected block',
		input: (
			<root>
				<paragraph>Before</paragraph>
				<paragraph>Replace me</paragraph>
				<paragraph>After</paragraph>
			</root>
		),
		run: async ({ edytor, editor }) => {
			edytor.selection.selectBlocks(edytor.root!.children[1]);
			return dispatchClipboardPaste(editor, {
				'text/html': '<p><strong>HTML</strong></p>',
				'text/plain': 'Plain'
			});
		},
		output: (
			<root>
				<paragraph>Before</paragraph>
				<paragraph>Plain</paragraph>
				<paragraph>After</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	})
]);
