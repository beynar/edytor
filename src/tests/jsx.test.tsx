/** @jsxImportSource ./jsx */
import { describe, it, expect, should } from 'vitest';

describe('converts document with natural text and marks', () => {
	it('should convert document with natural text and marks', () => {
		const { value } = (
			<root>
				<paragraph>
					Hello <bold>world</bold>!
				</paragraph>
				<paragraph>
					This is <italic>formatted</italic> text with{' '}
					<bold>
						multiple <italic>nested</italic> styles
					</bold>
					.
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
				},
				{
					type: 'paragraph',
					content: [
						{
							text: 'This is '
						},
						{
							text: 'formatted',
							marks: { italic: true }
						},
						{
							text: ' text with '
						},
						{
							text: 'multiple ',
							marks: { bold: true }
						},
						{
							text: 'nested',
							marks: { bold: true, italic: true }
						},
						{
							text: ' styles',
							marks: { bold: true }
						},
						{
							text: '.'
						}
					]
				}
			]
		};

		expect(value).toMatchObject(expected);
	});

	it('should convert document with nested paragraphs', () => {
		const { value } = (
			<root>
				<paragraph>
					First level
					<paragraph>
						Second level
						<paragraph>Third level</paragraph>
					</paragraph>
				</paragraph>
			</root>
		);

		const expected = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'First level' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Second level' }],
							children: [
								{
									type: 'paragraph',
									content: [{ text: 'Third level' }]
								}
							]
						}
					]
				}
			]
		};

		expect(value).toMatchObject(expected);
	});

	it('should convert document with complex nested marks and paragraphs', () => {
		const { value } = (
			<root>
				<paragraph>
					Start with{' '}
					<bold>
						bold text and <italic>italic inside bold</italic>
					</bold>
					<paragraph>
						Nested paragraph with{' '}
						<italic>
							italic and <bold>bold inside italic</bold>
							and{' '}
							<underline>
								underlined text <bold>with bold</bold>
							</underline>
						</italic>
					</paragraph>
				</paragraph>
				<paragraph>
					<bold>
						Multiple{' '}
						<italic>
							styles <underline>at once</underline>
						</italic>
					</bold>
					<paragraph>
						Deep nesting with{' '}
						<bold>
							bold{' '}
							<italic>
								and italic <underline>and underline</underline>
							</italic>
						</bold>
					</paragraph>
				</paragraph>
			</root>
		);

		const expected = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'Start with ' },
						{ text: 'bold text and ', marks: { bold: true } },
						{ text: 'italic inside bold', marks: { bold: true, italic: true } }
					],
					children: [
						{
							type: 'paragraph',
							content: [
								{ text: 'Nested paragraph with ' },
								{ text: 'italic and ', marks: { italic: true } },
								{ text: 'bold inside italic', marks: { italic: true, bold: true } },
								{ text: 'and ', marks: { italic: true } },
								{ text: 'underlined text ', marks: { italic: true, underline: true } },
								{ text: 'with bold', marks: { italic: true, underline: true, bold: true } }
							]
						}
					]
				},
				{
					type: 'paragraph',
					content: [
						{ text: 'Multiple ', marks: { bold: true } },
						{ text: 'styles ', marks: { bold: true, italic: true } },
						{ text: 'at once', marks: { bold: true, italic: true, underline: true } }
					],
					children: [
						{
							type: 'paragraph',
							content: [
								{ text: 'Deep nesting with ' },
								{ text: 'bold ', marks: { bold: true } },
								{ text: 'and italic ', marks: { bold: true, italic: true } },
								{ text: 'and underline', marks: { bold: true, italic: true, underline: true } }
							]
						}
					]
				}
			]
		};

		expect(value).toMatchObject(expected);
	});
});

describe('handles special cases and attributes', () => {
	it('should handle custom attributes on elements', () => {
		const { value } = (
			<root>
				<paragraph id="p1" className="intro">
					Paragraph with attributes
				</paragraph>
				<paragraph data-custom="value" align="center">
					<bold>Custom attributes</bold>
				</paragraph>
			</root>
		);

		const expected = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'Paragraph with attributes' }],
					data: {
						id: 'p1',
						className: 'intro'
					}
				},
				{
					type: 'paragraph',
					content: [
						{
							text: 'Custom attributes',
							marks: { bold: true }
						}
					],
					data: {
						'data-custom': 'value',
						align: 'center'
					}
				}
			]
		};

		expect(value).toMatchObject(expected);
	});

	it('should handle mixed content with arrays and fragments', () => {
		const items = ['First', 'Second', 'Third'];
		const { value } = (
			<root>
				<paragraph>
					{items.map((item, index) => (
						<span>
							<bold>{item}</bold>
							{index < items.length - 1 ? ', ' : ''}
						</span>
					))}
				</paragraph>
				<paragraph>
					Mixed content:
					<bold>One</bold> and <italic>Two</italic>
				</paragraph>
			</root>
		);

		const expected = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'First', marks: { bold: true } },
						{ text: ', ' },
						{ text: 'Second', marks: { bold: true } },
						{ text: ', ' },
						{ text: 'Third', marks: { bold: true } }
					]
				},
				{
					type: 'paragraph',
					content: [
						{ text: 'Mixed content:' },
						{ text: 'One', marks: { bold: true } },
						{ text: ' and ' },
						{ text: 'Two', marks: { italic: true } }
					]
				}
			]
		};

		expect(value).toMatchObject(expected);
	});

	it('should handle deeply nested marks with whitespace', () => {
		const { value } = (
			<root>
				<paragraph>
					<bold>
						Bold
						<italic>
							{' '}
							Italic
							<underline> Underlined </underline>
							Italic{' '}
						</italic>
						Bold
					</bold>
				</paragraph>
			</root>
		);

		const expected = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'Bold', marks: { bold: true } },
						{ text: ' Italic', marks: { bold: true, italic: true } },
						{ text: ' Underlined ', marks: { bold: true, italic: true, underline: true } },
						{ text: 'Italic ', marks: { bold: true, italic: true } },
						{ text: 'Bold', marks: { bold: true } }
					]
				}
			]
		};

		expect(value).toMatchObject(expected);
	});

	it('should handle inline blocks like mentions alongside text with marks', () => {
		const { value } = (
			<root>
				<paragraph>
					Hello <mention data-id="123">@john</mention> and <bold>welcome</bold> to the team! Let's
					also mention <italic>our friend</italic> <mention data-id="456">@jane</mention> here.
				</paragraph>
			</root>
		);

		const expected = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'Hello ' },
						{ type: 'mention', data: { 'data-id': '123' } },
						{ text: ' and ' },
						{ text: 'welcome', marks: { bold: true } },
						{ text: " to the team! Let's also mention " },
						{ text: 'our friend', marks: { italic: true } },
						{ text: ' ' },
						{ type: 'mention', data: { 'data-id': '456' } },
						{ text: ' here.' }
					]
				}
			]
		};

		expect(value).toMatchObject(expected);
	});
});
