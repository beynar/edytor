/** @jsxImportSource ./jsx */
import { describe, it, expect, should } from 'vitest';
import { findCursorPosition } from './test.utils';

describe('Get the cursor position', () => {
	it('should get the cursor position in a simple document', () => {
		const { value } = (
			<root>
				<paragraph>
					Hello <bold>wo|rld</bold>!
				</paragraph>
			</root>
		);

		const expected = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					content: [
						{
							text: 'Hello '
						},
						{
							text: 'world',
							marks: { bold: true }
						},
						{
							text: '!'
						}
					]
				}
			]
		};
		const cursor = findCursorPosition(value);
		expect(value).toMatchObject(expected);
		expect(cursor).toEqual({
			start: { path: [0, 0], offset: 8 },
			end: null
		});
	});

	it('should get both start and end cursor positions with marks and inline blocks', () => {
		const { value } = (
			<root>
				<paragraph>
					He|llo <bold>world</bold>! <mention>hello</mention> Hel|lo
				</paragraph>
			</root>
		);

		const cursor2 = findCursorPosition(value);
		expect(cursor2).toEqual({
			start: { path: [0, 0], offset: 2 },
			end: { path: [0, 2], offset: 4 }
		});
	});

	it('should handle only one cursor position', () => {
		const { value } = (
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
		);

		const cursor3 = findCursorPosition(value);
		expect(cursor3).toEqual({
			start: { path: [0, 2], offset: 4 },
			end: { path: [2, 0], offset: 8 }
		});
	});
	it('should handle one cursor position into a nested block', () => {
		const { value } = (
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
		);

		const cursor3 = findCursorPosition(value);
		expect(cursor3).toEqual({
			start: { path: [0, 1, 2], offset: 4 },
			end: null
		});
	});
});
