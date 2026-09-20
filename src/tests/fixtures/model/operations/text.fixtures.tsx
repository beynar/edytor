/** @jsxImportSource ../../../jsx */
import type { Edytor } from '$lib/edytor.svelte.js';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';
import {
	expectBlockInvariantSnapshot,
	expectMarksState,
	expectTextValue,
	findBlockAndTextAtPath
} from '../../../test.utils.js';

const getStartText = (edytor: Edytor) => findBlockAndTextAtPath(edytor)([0, 0]).text;

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description: 'inserts text at a collapsed caret',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			text.insertText({ value: 'p' });
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
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			text.insertText({ value: 'y' });
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
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			text.markText({ mark: 'bold', toggle: true });
			expectMarksState(text, { pending: { bold: true } });
			text.insertText({ value: '!' });
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
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			text.markText({ mark: 'bold', toggle: true });
			expectMarksState(text, { pending: { bold: true } });
			text.insertText({ value: 'X' });
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
		description: 'honors explicit start and end overrides',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			getStartText(edytor).insertText({ value: 'XX', start: 1, end: 4 });
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
			text.insertText({ value: '' });
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
		run: ({ edytor }) => {
			getStartText(edytor).insertText({ value: '. ', isAutoDot: true });
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
		run: ({ edytor }) => {
			getStartText(edytor).deleteText({ direction: 'BACKWARD', length: 1 });
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
		run: ({ edytor }) => {
			getStartText(edytor).deleteText({ direction: 'FORWARD', length: 1 });
		},
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'deletes a ranged selection with the supplied length',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			getStartText(edytor).deleteText({ direction: 'FORWARD', length: 2 });
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
		run: ({ edytor }) => {
			getStartText(edytor).deleteText({ direction: 'BACKWARD', length: 1 });
		},
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'clamps backward delete length to the text start',
		input: (
			<root>
				<paragraph>He|llo</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			getStartText(edytor).deleteText({ direction: 'BACKWARD', length: 5 });
		},
		output: (
			<root>
				<paragraph>llo</paragraph>
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
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			text.deleteText({ direction: 'FORWARD', length: 1 });
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
			text.deleteText({ direction: 'BACKWARD', length: 0 });
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
			text.markText({ mark: 'bold', toggle: true });
			expectMarksState(text, { pending: { bold: true } });
			text.markText({ mark: 'bold', toggle: true });
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
			getStartText(edytor).markText({ mark: 'bold', toggle: true });
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
			getStartText(edytor).markText({ mark: 'bold', toggle: true });
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
			getStartText(edytor).markText({ mark: 'bold', toggle: true });
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
			text.removeMarksFromText({});
			expectTextValue(text, [{ text: 'hello' }]);
		},
		output: (
			<root>
				<paragraph>hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'splits plain text at the selection offset and returns the trailing content',
		input: (
			<root>
				<paragraph>he|llo</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			const result = text.splitText({});
			if (JSON.stringify(result) !== JSON.stringify([{ text: 'llo', marks: undefined }])) {
				throw new Error('Unexpected splitText result for plain text');
			}
			expectTextValue(text, [{ text: 'he' }]);
		},
		output: (
			<root>
				<paragraph>he</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'splits text at the start boundary and returns all content',
		input: (
			<root>
				<paragraph>|hello</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			const result = text.splitText({});
			if (JSON.stringify(result) !== JSON.stringify([{ text: 'hello', marks: undefined }])) {
				throw new Error('Unexpected splitText result at text start');
			}
			expectTextValue(text, []);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'splits text at the end boundary and returns an empty fragment',
		input: (
			<root>
				<paragraph>hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const text = getStartText(edytor);
			const result = text.splitText({});
			if (JSON.stringify(result) !== JSON.stringify([{ text: '', marks: undefined }])) {
				throw new Error('Unexpected splitText result at text end');
			}
			expectTextValue(text, [{ text: 'hello' }]);
			expectBlockInvariantSnapshot(edytor);
		},
		output: (
			<root>
				<paragraph>hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'splits marked text and preserves mark attributes in the returned content',
		input: (
			<root>
				<paragraph>
					<bold>he|llo</bold> world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const result = getStartText(edytor).splitText({});
			if (
				JSON.stringify(result) !==
				JSON.stringify([
					{ text: 'llo', marks: { bold: true } },
					{ text: ' world', marks: undefined }
				])
			) {
				throw new Error('Unexpected splitText result for marked text');
			}
		},
		output: (
			<root>
				<paragraph>
					<bold>he</bold>
				</paragraph>
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
			text.setText({
				value: [{ text: 'Hi' }, { text: ' there', marks: { italic: true } }]
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
			text.setText({ value: [] });
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
