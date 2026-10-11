/** @jsxImportSource ../../../jsx */
import type { Edytor } from '$lib/edytor.svelte.js';
import { expect } from 'vitest';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';
import {
	expectBlockInvariantSnapshot,
	expectMarksState,
	expectTextValue,
	findBlockAndTextAtPath,
	runBeforeInput
} from '../../../test.utils.js';
import { richTextOperations } from '$lib/plugins/richtext/richTextOperations.js';

const getStartText = (edytor: Edytor) => findBlockAndTextAtPath(edytor)([0, 0]).text;

/** Type `data` at the selection, as the browser's `beforeinput` does. */
const type = (edytor: Edytor, data: string) =>
	runBeforeInput(edytor, { inputType: 'insertText', data });

/** Toggle `mark` over the selection (at a caret: stage it), as the toolbar does. */
const toggle = (edytor: Edytor, mark: string) => richTextOperations(edytor).setMarkAtRange(mark);

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description: 'inserts text at a collapsed caret',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const text = getStartText(edytor);
			await type(edytor, 'p');
			expectTextValue(text, [{ text: 'Helplo' }]);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>Helplo</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'replaces a ranged selection inside one text',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const text = getStartText(edytor);
			await type(edytor, 'y');
			expectTextValue(text, [{ text: 'Heyo' }]);
		},
		output: (
			<root>
				<paragraph>Heyo</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'applies pending marks on the next insert and clears them afterward',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const text = getStartText(edytor);
			toggle(edytor, 'bold');
			expectMarksState(text, { pending: { bold: true } });
			await type(edytor, '!');
			expectTextValue(text, [{ text: 'Hello' }, { text: '!', marks: { bold: true } }]);
			expectMarksState(text, { pending: undefined });
		},
		output: (
			<root>
				<paragraph>
					Hello<bold>!</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'applies pending marks from an empty text',
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const text = getStartText(edytor);
			toggle(edytor, 'bold');
			expectMarksState(text, { pending: { bold: true } });
			await type(edytor, 'X');
			expectTextValue(text, [{ text: 'X', marks: { bold: true } }]);
			expectMarksState(text, { pending: undefined });
		},
		output: (
			<root>
				<paragraph>
					<bold>X</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'replaces a range through the view: its deletion, then the insertion',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const { id } = getStartText(edytor).parent;
			edytor.deleteText(id, 1, 3);
			edytor.insertText(id, 1, 'XX');
		},
		output: (
			<root>
				<paragraph>HXXo</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'leaves text unchanged when inserting an empty string',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			expect(edytor.insertText(text.parent.id, 3, '').status).toBe('noop');
			expectTextValue(text, [{ text: 'Hello' }]);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'supports the auto-dot replacement path',
		input: (
			<root>
				<paragraph>Hello.|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await type(edytor, '. ');
		},
		output: (
			<root>
				<paragraph>Hello. </paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'deletes backward inside a text node',
		input: (
			<root>
				<paragraph>Hello| world</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runBeforeInput(edytor, { inputType: 'deleteContentBackward' });
		},
		output: (
			<root>
				<paragraph>Hell world</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'deletes forward inside a text node',
		input: (
			<root>
				<paragraph>Hello| world</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runBeforeInput(edytor, { inputType: 'deleteContentForward' });
		},
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'deletes a ranged selection',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runBeforeInput(edytor, { inputType: 'deleteContentForward' });
		},
		output: (
			<root>
				<paragraph>Heo</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'ignores backward delete at the start of an empty text node',
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runBeforeInput(edytor, { inputType: 'deleteContentBackward' });
		},
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'ignores forward delete at the end of a text node',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const text = getStartText(edytor);
			await runBeforeInput(edytor, { inputType: 'deleteContentForward' });
			expectTextValue(text, [{ text: 'Hello' }]);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'ignores zero-length deletes',
		input: (
			<root>
				<paragraph>He|llo</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			expect(edytor.deleteText(text.parent.id, 2, 0).status).toBe('noop');
			expectTextValue(text, [{ text: 'Hello' }]);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'toggles pending marks on a collapsed selection',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			toggle(edytor, 'bold');
			expectMarksState(text, { pending: { bold: true } });
			toggle(edytor, 'bold');
			expectMarksState(text, { pending: {} });
		}
	}),
	defineModelOperationFixture({
		description: 'adds a mark across an unmarked range',
		input: (
			<root>
				<paragraph>|hello| world</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			toggle(edytor, 'bold');
		},
		output: (
			<root>
				<paragraph>
					<bold>hello</bold> world
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'removes a mark when toggling an already marked range',
		input: (
			<root>
				<paragraph>
					<bold>|hello|</bold> world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			toggle(edytor, 'bold');
		},
		output: (
			<root>
				<paragraph>hello world</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'locks mixed-mark range behavior by applying the mark across the entire selection',
		input: (
			<root>
				<paragraph>
					<bold>he</bold>|llo wo|rld
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			toggle(edytor, 'bold');
		},
		output: (
			<root>
				<paragraph>
					<bold>hello wo</bold>rld
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'removes all marks across a range while preserving the plain text content',
		input: (
			<root>
				<paragraph>
					<bold>
						<italic>|hello|</italic>
					</bold>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			richTextOperations(edytor).removeAllMarksAtRange();
			expectTextValue(text, [{ text: 'hello' }]);
		},
		output: (
			<root>
				<paragraph>hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'replaces the full text content with marked segments',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			edytor.setBlock(text.parent.id, {
				content: [{ text: 'Hi' }, { text: ' there', marks: { italic: true } }]
			});
			expectTextValue(text, [{ text: 'Hi' }, { text: ' there', marks: { italic: true } }]);
		},
		output: (
			<root>
				<paragraph>
					Hi<italic> there</italic>
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'replaces text with an empty value while keeping the block editable',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			edytor.setBlock(text.parent.id, { content: [] });
			expectTextValue(text, []);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	})
]);
