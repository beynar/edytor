/** @jsxImportSource ../../jsx */
import { defineDomFixture, defineFixtures } from '../types.js';
import {
	clickBlock,
	clickPlaceholder,
	clickText,
	doubleClickText,
	dragSelection,
	expectFocusedBlocks,
	tripleClickText
} from '../../dom/test.utils.js';

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'accepts a native element selection on an empty first paragraph',
		input: (
			<root>
				<paragraph></paragraph>
				<paragraph>note</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: ({ edytor }) => clickBlock(edytor, [0], 'start'),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		expectNativeSelection: {
			anchorNodeType: 'text',
			anchorOffset: 0,
			collapsed: true
		},
		assert: async ({ edytor }) => {
			expectFocusedBlocks(edytor, [[0]]);
		}
	}),
	defineDomFixture({
		description: 'focuses empty middle and last paragraphs by click target path',
		input: (
			<root>
				<paragraph>alpha</paragraph>
				<paragraph></paragraph>
				<paragraph></paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await clickBlock(edytor, [1], 'start');
			await clickBlock(edytor, [2], 'start');
		},
		expectSelection: {
			startBlockPath: [2],
			endBlockPath: [2],
			startTextPath: [2, 0],
			endTextPath: [2, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		assert: async ({ edytor }) => {
			expectFocusedBlocks(edytor, [[2]]);
		}
	}),
	defineDomFixture({
		description: 'maps click offsets inside a non-empty paragraph',
		input: (
			<root>
				<paragraph>hello</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await clickText(edytor, [0, 0], 0);
			await clickText(edytor, [0, 0], 2);
			await clickText(edytor, [0, 0], 5);
		},
		expectSelection: {
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		},
		expectNativeSelection: {
			anchorNodeType: 'text',
			anchorOffset: 5,
			collapsed: true,
			text: 'hello'
		}
	}),
	defineDomFixture({
		description: 'normalizes placeholder clicks back onto the underlying empty text',
		input: (
			<root>
				<paragraph></paragraph>
				<paragraph>note|</paragraph>
			</root>
		),
		placeholder: 'Write something here ...',
		run: ({ edytor }) => clickPlaceholder(edytor, [0]),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		expectNativeSelection: {
			anchorNodeType: 'text',
			anchorOffset: 0,
			collapsed: true
		}
	}),
	defineDomFixture({
		description: 'tracks selection around inline mention boundaries',
		input: (
			<root>
				<paragraph>
					|
					<mention />
					tail
				</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await clickText(edytor, [0, 2], 0);
			await dragSelection(edytor, [0, 0], 0, [0, 2], 2);
		},
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 2],
			yStart: 0,
			yEnd: 2,
			isCollapsed: false,
			isTextSpanning: true
		}
	}),
	defineDomFixture({
		description: 'switches focus between nested parent and child content',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>Child</paragraph>
				</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await clickText(edytor, [0, 0], 3);
			await clickText(edytor, [0, 0, 0], 2);
		},
		expectSelection: {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			startTextPath: [0, 0, 0],
			endTextPath: [0, 0, 0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		},
		assert: async ({ edytor }) => {
			expectFocusedBlocks(edytor, [[0, 0]]);
		}
	}),
	defineDomFixture({
		description: 'creates forward and reverse ranges within a single text node',
		input: (
			<root>
				<paragraph>hello world</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await dragSelection(edytor, [0, 0], 1, [0, 0], 5);
			await dragSelection(edytor, [0, 0], 5, [0, 0], 1, { reverse: true });
		},
		expectSelection: {
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 1,
			yEnd: 5,
			isCollapsed: false,
			content: 'ello'
		}
	}),
	defineDomFixture({
		description: 'creates forward and reverse ranges across marked spans in the same block',
		input: (
			<root>
				<paragraph>
					<bold>Hello</bold> world
				</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			const firstText = edytor.root!.children[0].firstText!;
			await dragSelection(edytor, firstText, 2, firstText, 8);
			await dragSelection(edytor, firstText, 8, firstText, 2, { reverse: true });
		},
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 2,
			yEnd: 8,
			isCollapsed: false,
			isTextSpanning: false,
			isBlockSpanning: false
		}
	}),
	defineDomFixture({
		description: 'creates forward and reverse ranges across sibling blocks',
		input: (
			<root>
				<paragraph>Alpha</paragraph>
				<paragraph>Beta</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await dragSelection(edytor, [0, 0], 2, [1, 0], 2);
			await dragSelection(edytor, [1, 0], 2, [0, 0], 2, { reverse: true });
		},
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [1],
			startTextPath: [0, 0],
			endTextPath: [1, 0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: false,
			isTextSpanning: true,
			isBlockSpanning: true
		}
	}),
	defineDomFixture({
		description: 'double clicks a word and triple clicks the whole text block',
		input: (
			<root>
				<paragraph>hello world</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await doubleClickText(edytor, [0, 0], 7);
			await tripleClickText(edytor, [0, 0], 2);
		},
		expectSelection: {
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 11,
			isCollapsed: false,
			content: 'hello world'
		},
		expectNativeSelection: {
			anchorNodeType: 'text',
			collapsed: false
		}
	}),
	defineDomFixture({
		description: 'caret anchors round-trip through inline atoms and follow edits',
		input: (
			<root>
				<paragraph>
					ab
					<mention />
					cd|
				</paragraph>
			</root>
		),
		run: async () => {
			// The fixture `|` auto-selects the caret; nothing else to do.
		},
		expectSelection: {
			startTextPath: [0, 2],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		},
		assert: async ({ edytor }) => {
			const block = edytor.root!.children[0]!;
			const tail = block.lastText!;
			const anchor = edytor.selection.state.relativePosition;
			// The selection state's caret anchor is a backing-text anchor —
			// {b: home block id of the backing text, a: {i, a}}.
			if (!anchor || typeof anchor.b !== 'string' || typeof anchor.a?.a !== 'number') {
				throw new Error('expected a backing-text anchor on the selection state');
			}
			const resolved = edytor.selection.resolveTextAnchor(anchor);
			if (!resolved || resolved.text.id !== tail?.id || resolved.offset !== 2) {
				throw new Error(
					`anchor resolved to ${resolved?.text.id}@${resolved?.offset}, expected ${tail?.id}@2`
				);
			}
			// An edit in front of the caret shifts the anchored position —
			// written through the facade (the engine-authoritative path).
			// The display offset moves 5 → 6…
			edytor.facade.insertText(block.id, 0, 'X');
			const display = edytor.facade.resolveAnchor(anchor);
			if (!display || display.offset !== 6) {
				throw new Error(
					`anchor after prepend resolved to display offset ${display?.offset}, expected 6`
				);
			}
			// …while the offset inside the 'cd' segment stays at its end (2).
			const shifted = edytor.selection.resolveTextAnchor(anchor);
			if (!shifted || shifted.text.id !== tail.id || shifted.offset !== 2) {
				throw new Error(
					`anchor after prepend resolved to ${shifted?.text.id}@${shifted?.offset}, expected ${tail.id}@2`
				);
			}
		}
	})
]);
