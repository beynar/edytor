/** @jsxImportSource ../../jsx */
import { expect } from 'vitest';

import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import {
	clickText,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	dispatchPaste,
	dragSelection
} from '../../dom/test.utils.js';
import { defineDomFixture, defineFixtures } from '../types.js';

const createCallbackRecorder = () => {
	const changes: unknown[] = [];
	const selections: Array<{
		startBlockPath: number[] | null;
		endBlockPath: number[] | null;
		isCollapsed: boolean;
	}> = [];

	return {
		onChange(value: unknown) {
			changes.push(value);
		},
		onSelectionChange(selection: EdytorSelection) {
			selections.push({
				startBlockPath: selection.state.startBlock?.path ?? null,
				endBlockPath: selection.state.endBlock?.path ?? null,
				isCollapsed: selection.state.isCollapsed
			});
		},
		clear() {
			changes.length = 0;
			selections.length = 0;
		},
		read() {
			return {
				changes: [...changes],
				selections: [...selections]
			};
		}
	};
};

const selectionOnly = createCallbackRecorder();
const typing = createCallbackRecorder();
const paste = createCallbackRecorder();
const markToggle = createCallbackRecorder();
const deleteBlocks = createCallbackRecorder();

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'selection-only changes trigger onSelectionChange but not onChange',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		onChange: selectionOnly.onChange,
		onSelectionChange: selectionOnly.onSelectionChange,
		run: async ({ edytor }) => {
			selectionOnly.clear();
			await clickText(edytor, [1, 0], 2);
		},
		assert: async () => {
			const { changes, selections } = selectionOnly.read();
			expect(changes).toHaveLength(0);
			expect(selections.length).toBeGreaterThan(0);
			expect(selections.at(-1)).toMatchObject({
				startBlockPath: [1],
				endBlockPath: [1],
				isCollapsed: true
			});
		}
	}),
	defineDomFixture({
		description: 'typing triggers onChange',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		onChange: typing.onChange,
		onSelectionChange: typing.onSelectionChange,
		run: async ({ editor }) => {
			typing.clear();
			return dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '!'
			});
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		),
		assert: async () => {
			const { changes } = typing.read();
			expect(changes.length).toBeGreaterThan(0);
		}
	}),
	defineDomFixture({
		description: 'plain paste triggers onChange',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		onChange: paste.onChange,
		onSelectionChange: paste.onSelectionChange,
		run: async ({ editor }) => {
			paste.clear();
			return dispatchPaste(editor, ' world');
		},
		output: (
			<root>
				<paragraph>Hello world</paragraph>
			</root>
		),
		assert: async () => {
			const { changes } = paste.read();
			expect(changes.length).toBeGreaterThan(0);
		}
	}),
	defineDomFixture({
		description: 'mark toggles trigger onChange',
		input: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		autoSelectFixture: false,
		onChange: markToggle.onChange,
		onSelectionChange: markToggle.onSelectionChange,
		run: async ({ edytor }) => {
			markToggle.clear();
			await dragSelection(edytor, [0, 0], 0, [1, 0], 5);
			return dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
		},
		output: (
			<root>
				<paragraph>
					<bold>Hello</bold>
				</paragraph>
				<paragraph>
					<bold>World</bold>
				</paragraph>
			</root>
		),
		assert: async () => {
			const { changes } = markToggle.read();
			expect(changes.length).toBeGreaterThan(0);
		}
	}),
	defineDomFixture({
		description: 'selected block deletion triggers onChange and leaves a coherent selection',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		onChange: deleteBlocks.onChange,
		onSelectionChange: deleteBlocks.onSelectionChange,
		run: async () => {
			deleteBlocks.clear();
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			return dispatchDomKeyDown(document, { key: 'Backspace', code: 'Backspace' });
		},
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			isCollapsed: true
		},
		assert: async () => {
			const { changes, selections } = deleteBlocks.read();
			expect(changes.length).toBeGreaterThan(0);
			expect(selections.length).toBeGreaterThan(0);
		}
	}),
	defineDomFixture({
		description: 'editable roots default to translate=no',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async () => undefined,
		assert: async ({ editor }) => {
			expect(editor.getAttribute('translate')).toBe('no');
		}
	}),
	defineDomFixture({
		description: 'editable roots default to browser-mutation guard attributes',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async () => undefined,
		assert: async ({ editor }) => {
			expect(editor.getAttribute('role')).toBe('textbox');
			expect(editor.getAttribute('aria-multiline')).toBe('true');
			expect(editor.getAttribute('aria-readonly')).toBe('false');
			expect(editor.getAttribute('spellcheck')).toBe('true');
			expect(editor.getAttribute('autocorrect')).toBe('off');
			expect(editor.getAttribute('autocomplete')).toBe('off');
			expect(editor.getAttribute('autocapitalize')).toBe('none');
		}
	}),
	defineDomFixture({
		description: 'editable roots allow overriding translate',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		translate: 'yes',
		run: async () => undefined,
		assert: async ({ editor }) => {
			expect(editor.getAttribute('translate')).toBe('yes');
		}
	}),
	defineDomFixture({
		description: 'editable roots allow overriding browser-mutation guard attributes',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		spellcheck: false,
		autocorrect: 'on',
		autocomplete: 'on',
		autocapitalize: 'sentences',
		run: async () => undefined,
		assert: async ({ editor }) => {
			expect(editor.getAttribute('spellcheck')).toBe('false');
			expect(editor.getAttribute('autocorrect')).toBe('on');
			expect(editor.getAttribute('autocomplete')).toBe('on');
			expect(editor.getAttribute('autocapitalize')).toBe('sentences');
		}
	})
]);
