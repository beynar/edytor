/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import { defineCursorFixture, defineFixtures } from '../../types.js';

export const fixtures = defineFixtures([
	defineCursorFixture({
		description: 'gets the cursor position in a simple document',
		input: (
			<root>
				<paragraph>
					Hello <bold>wo|rld</bold>!
				</paragraph>
			</root>
		),
		output: {
			start: { path: [0, 0], offset: 8 },
			end: null
		},
		assert: async ({ value }) => {
			expect(value).toMatchObject({
				type: 'root',
				children: [
					{
						type: 'paragraph',
						content: [{ text: 'Hello ' }, { text: 'world', marks: { bold: true } }, { text: '!' }]
					}
				]
			});
		}
	}),
	defineCursorFixture({
		description: 'gets both start and end cursor positions with marks and inline blocks',
		input: (
			<root>
				<paragraph>
					He|llo <bold>world</bold>! <mention>hello</mention> Hel|lo
				</paragraph>
			</root>
		),
		output: {
			start: { path: [0, 0], offset: 2 },
			end: { path: [0, 2], offset: 4 }
		}
	}),
	defineCursorFixture({
		description: 'handles one cursor position across multiple blocks',
		input: (
			<root>
				<paragraph>
					Hello <bold>world</bold>! <mention>hello</mention> Hel|lo
				</paragraph>
				<paragraph>
					Hello <bold>world</bold>! <mention>hello</mention> Hello
				</paragraph>
				<paragraph>
					Hello <bold>wo|rld</bold>! <mention>hello</mention> Hello
				</paragraph>
			</root>
		),
		output: {
			start: { path: [0, 2], offset: 4 },
			end: { path: [2, 0], offset: 8 }
		}
	}),
	defineCursorFixture({
		description: 'handles one cursor position inside a nested block',
		input: (
			<root>
				<paragraph>
					Hello <bold>world</bold>! <mention>hello</mention> Hello
					<paragraph>
						Hello <bold>world</bold>! <mention>hello</mention> Hello
					</paragraph>
					<paragraph>
						Hello <bold>world</bold>! <mention>hello</mention> Hel|lo
					</paragraph>
				</paragraph>
				<paragraph>
					Hello <bold>world</bold>! <mention>hello</mention> Hello
				</paragraph>
				<paragraph>
					Hello <bold>world</bold>! <mention>hello</mention> Hello
				</paragraph>
			</root>
		),
		output: {
			start: { path: [0, 1, 2], offset: 4 },
			end: null
		}
	})
]);
