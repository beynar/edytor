/** @jsxImportSource ../../jsx */
import { defineDomFixture, defineFixtures } from '../types.js';
import { dispatchDomBeforeInput, dispatchDomKeyDown, dragSelection } from '../../dom/test.utils.js';

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'undoes and redoes a text insertion while restoring the caret',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '!'
			});
			await dispatchDomKeyDown(document, { key: 'z', code: 'KeyZ', metaKey: true });
			return dispatchDomKeyDown(document, {
				key: 'z',
				code: 'KeyZ',
				metaKey: true,
				shiftKey: true
			});
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'undoes and redoes a paragraph split while restoring the active block',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await dispatchDomBeforeInput(editor, {
				inputType: 'insertParagraph'
			});
			await dispatchDomKeyDown(document, { key: 'z', code: 'KeyZ', metaKey: true });
			return dispatchDomKeyDown(document, {
				key: 'z',
				code: 'KeyZ',
				metaKey: true,
				shiftKey: true
			});
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph></paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'undoes and redoes a multi-block bold toggle while restoring the range',
		input: (
			<root>
				<paragraph>Alpha</paragraph>
				<paragraph>Beta</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await dragSelection(edytor, [0, 0], 0, [1, 0], 4);
			await dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'z', code: 'KeyZ', metaKey: true });
			return dispatchDomKeyDown(document, {
				key: 'z',
				code: 'KeyZ',
				metaKey: true,
				shiftKey: true
			});
		},
		output: (
			<root>
				<paragraph>
					<bold>Alpha</bold>
				</paragraph>
				<paragraph>
					<bold>Beta</bold>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		}
	}),
	defineDomFixture({
		description: 'undoes and redoes selected block deletion while restoring the focused block',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'Backspace', code: 'Backspace' });
			await dispatchDomKeyDown(document, { key: 'z', code: 'KeyZ', metaKey: true });
			return dispatchDomKeyDown(document, {
				key: 'z',
				code: 'KeyZ',
				metaKey: true,
				shiftKey: true
			});
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
		}
	})
]);
