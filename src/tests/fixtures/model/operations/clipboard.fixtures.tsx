/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import {
	createEdytorClipboardFragment,
	EDYTOR_FRAGMENT_ATTRIBUTE,
	EDYTOR_FRAGMENT_MIME,
	insertEdytorClipboardFragment,
	readEdytorClipboardFragment,
	writeEdytorClipboardData
} from '$lib/clipboard/clipboard.js';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';

const createClipboardData = () => {
	const data = new Map<string, string>();
	return {
		data,
		clipboardData: {
			getData: (type: string) => data.get(type) ?? '',
			setData: (type: string, value: string) => {
				data.set(type, value);
				return true;
			}
		} satisfies Pick<DataTransfer, 'getData' | 'setData'>
	};
};

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description: 'extracts a same-block marked range as a content fragment',
		input: (
			<root>
				<paragraph>
					<bold>Hel|lo</bold> plain|
				</paragraph>
			</root>
		),
		run: ({ edytor }) => createEdytorClipboardFragment(edytor),
		assert: ({ result }) => {
			expect(result).toMatchObject({
				version: 1,
				source: 'edytor',
				kind: 'content',
				blockType: 'paragraph',
				content: [{ text: 'lo', marks: { bold: true } }, { text: ' plain' }]
			});
		}
	}),
	defineModelOperationFixture({
		description: 'extracts a range across an inline mention boundary',
		input: (
			<root>
				<paragraph>
					le|ad <mention></mention> ta|il
				</paragraph>
			</root>
		),
		run: ({ edytor }) => createEdytorClipboardFragment(edytor),
		assert: ({ result }) => {
			expect(result).toMatchObject({
				kind: 'content',
				content: [{ text: 'ad ' }, { type: 'mention', data: {} }, { text: ' ta' }]
			});
		}
	}),
	defineModelOperationFixture({
		description: 'writes and reads internal clipboard data from the custom mime type',
		input: (
			<root>
				<paragraph>Hel|lo|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const fragment = createEdytorClipboardFragment(edytor);
			if (!fragment) {
				throw new Error('Expected a clipboard fragment');
			}
			const { clipboardData, data } = createClipboardData();
			writeEdytorClipboardData(clipboardData, fragment);
			return {
				written: data,
				fragment: readEdytorClipboardFragment(clipboardData)
			};
		},
		assert: ({ result }) => {
			const { written, fragment } = result as {
				written: Map<string, string>;
				fragment: unknown;
			};
			expect(written.has(EDYTOR_FRAGMENT_MIME)).toBe(true);
			expect(written.get('text/html')).toContain('data-edytor-fragment');
			expect(written.get('text/plain')).toBe('lo');
			expect(fragment).toMatchObject({
				kind: 'content',
				content: [{ text: 'lo' }]
			});
		}
	}),
	defineModelOperationFixture({
		description: 'pastes an internal content fragment into another text node',
		input: (
			<root>
				<paragraph>
					<bold>Hel|lo</bold> plain|
				</paragraph>
				<paragraph>target</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const fragment = createEdytorClipboardFragment(edytor);
			if (!fragment) {
				throw new Error('Expected a clipboard fragment');
			}
			await edytor.selection.setAtTextOffset(edytor.root!.children[1].firstText, 0);
			await insertEdytorClipboardFragment(edytor, fragment);
		},
		expectSelection: {
			startBlockPath: [1],
			yStart: 8,
			yEnd: 8,
			isCollapsed: true
		},
		output: (
			<root>
				<paragraph>
					<bold>Hello</bold> plain
				</paragraph>
				<paragraph>
					<bold>lo</bold> plaintarget
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'pastes a selected nested block fragment with regenerated ids',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>Nested</paragraph>
				</paragraph>
				<paragraph>|target</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const source = edytor.root!.children[0];
			edytor.selection.selectBlocks(source);
			const originalIds = [source.id, source.children[0].id];
			const fragment = createEdytorClipboardFragment(edytor);
			if (!fragment) {
				throw new Error('Expected a block fragment');
			}
			await edytor.selection.setAtTextOffset(edytor.root!.children[1].firstText, 6);
			await insertEdytorClipboardFragment(edytor, fragment);
			return originalIds;
		},
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>Nested</paragraph>
				</paragraph>
				<paragraph>target</paragraph>
				<paragraph>
					Parent
					<paragraph>Nested</paragraph>
				</paragraph>
			</root>
		),
		assert: ({ edytor, result }) => {
			const originalIds = result as string[];
			const pasted = edytor.root!.children[2];
			expect(originalIds).not.toContain(pasted.id);
			expect(originalIds).not.toContain(pasted.children[0].id);
		}
	}),
	defineModelOperationFixture({
		description: 'ignores malformed internal data so callers can fall back',
		input: (
			<root>
				<paragraph>|target</paragraph>
			</root>
		),
		run: () => {
			return readEdytorClipboardFragment({
				getData: (type: string) =>
					type === EDYTOR_FRAGMENT_MIME
						? 'not-valid-base64'
						: '<p data-edytor-fragment="also-invalid">fallback</p>'
			} as Pick<DataTransfer, 'getData'>);
		},
		assert: ({ result }) => {
			expect(result).toBeNull();
		}
	}),
	defineModelOperationFixture({
		description: 'reads embedded internal fragments with single quoted reordered attributes',
		input: (
			<root>
				<paragraph>Hel|lo|</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const fragment = createEdytorClipboardFragment(edytor);
			if (!fragment) {
				throw new Error('Expected a clipboard fragment');
			}
			const { clipboardData, data } = createClipboardData();
			writeEdytorClipboardData(clipboardData, fragment);
			const encoded = data.get('text/html')?.match(/data-edytor-fragment="([^"]+)"/)?.[1];
			if (!encoded) {
				throw new Error('Expected embedded clipboard fragment');
			}

			return readEdytorClipboardFragment({
				getData: (type: string) =>
					type === 'text/html'
						? `<span hidden class="ignored" ${EDYTOR_FRAGMENT_ATTRIBUTE}='${encoded}'></span>`
						: ''
			});
		},
		assert: ({ result }) => {
			expect(result).toMatchObject({
				kind: 'content',
				content: [{ text: 'lo' }]
			});
		}
	}),
	defineModelOperationFixture({
		description: 'rejects malformed direct fragments without mutating the document',
		input: (
			<root>
				<paragraph>|target</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await insertEdytorClipboardFragment(edytor, {
				version: 1,
				source: 'edytor',
				kind: 'content',
				blockType: 'paragraph',
				content: [{ type: '' }]
			} as never);
		},
		output: (
			<root>
				<paragraph>target</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'plain text serialization includes mention labels',
		input: (
			<root>
				<paragraph>
					le|ad <mention name="Ada"></mention> ta|il
				</paragraph>
			</root>
		),
		run: ({ edytor }) => {
			const fragment = createEdytorClipboardFragment(edytor);
			if (!fragment) {
				throw new Error('Expected a clipboard fragment');
			}
			const { data, clipboardData } = createClipboardData();
			writeEdytorClipboardData(clipboardData, fragment);
			return data.get('text/plain');
		},
		assert: ({ result }) => {
			expect(result).toBe('ad @Ada ta');
		}
	}),
	defineModelOperationFixture({
		description: 'pastes a content fragment over selected blocks as one replacement block',
		input: (
			<root>
				<paragraph>Al|pha|</paragraph>
				<paragraph>Replace me</paragraph>
				<paragraph>Keep me</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const fragment = createEdytorClipboardFragment(edytor);
			if (!fragment || fragment.kind !== 'content') {
				throw new Error('Expected a content fragment');
			}
			edytor.selection.selectBlocks(edytor.root!.children[1]);
			await insertEdytorClipboardFragment(edytor, fragment);
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
	defineModelOperationFixture({
		description: 'extracts a parent-to-child partial selection as ordered block fragments',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>Nested</paragraph>
				</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const parent = edytor.root!.children[0];
			const child = parent.children[0];
			await edytor.selection.setAtRange(parent.firstText, 2, child.firstText, 3);
			return createEdytorClipboardFragment(edytor);
		},
		assert: ({ result }) => {
			expect(result).toMatchObject({
				kind: 'blocks',
				blocks: [
					{
						type: 'paragraph',
						content: [{ text: 'rent' }],
						children: [{ type: 'paragraph', content: [{ text: 'Nes' }] }]
					}
				]
			});
		}
	}),
	defineModelOperationFixture({
		description: 'extracts a nested child-to-sibling partial selection without duplicate ancestors',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>Nested</paragraph>
				</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const child = edytor.root!.children[0].children[0];
			const tail = edytor.root!.children[1];
			await edytor.selection.setAtRange(child.firstText, 2, tail.firstText, 2);
			return createEdytorClipboardFragment(edytor);
		},
		assert: ({ result }) => {
			expect(result).toMatchObject({
				kind: 'blocks',
				blocks: [
					{ type: 'paragraph', content: [{ text: 'sted' }] },
					{ type: 'paragraph', content: [{ text: 'Ta' }] }
				]
			});
		}
	})
]);
