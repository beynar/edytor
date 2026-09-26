/** @jsxImportSource ../../../jsx */
import { expect, vi } from 'vitest';

import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { emptyFixture } from '../../helpers/model.js';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';
import { runHotkey } from '../../../test.utils.js';

const mockApplePlatform = (edytor: Edytor) => {
	Object.defineProperty(edytor.hotKeys, 'isMac', {
		configurable: true,
		get: () => true
	});
};

const expectDefaultPrevented = (result: unknown) => {
	if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
		throw new Error('Expected the hotkey to prevent the native event');
	}
};

const altGrProbe = vi.fn();
const altGrProbePlugin: Plugin = () => ({
	hotkeys: { 'mod+alt+q': altGrProbe }
});

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description: 'undoes and redoes document changes with mod+z and mod+shift+z',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const startText = edytor.selection.state.startText;
			if (!startText) {
				throw new Error('Missing startText for undo/redo test');
			}

			startText.insertText({ value: '!' });
			await runHotkey(edytor, 'mod+z');
			await runHotkey(edytor, 'mod+shift+z');
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'splits the current block at the end with mod+enter',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => runHotkey(edytor, 'mod+enter'),
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph></paragraph>
			</root>
		),
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected mod+enter to prevent the native event');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'moves from text-range selection to block selection with repeated mod+a',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runHotkey(edytor, 'mod+a');
			await runHotkey(edytor, 'mod+a');
		},
		expectSelection: { selectedBlockPaths: [[0]] }
	}),
	defineModelOperationFixture({
		description: 'inserts a tab character inside a code line',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = |1;' }] }]
				}
			]
		},
		run: ({ edytor }) => runHotkey(edytor, 'tab'),
		expectSelection: { startBlockPath: [0, 0], yStart: 15, yEnd: 15, isCollapsed: true },
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [{ type: 'codeLine', data: {}, content: [{ text: 'const value = \t1;' }] }]
					}
				]
			}
		} as never
	}),
	defineModelOperationFixture({
		description: 'accepts code suggestions on tab and clears the suggestion state',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = 1;|' }] }]
				}
			]
		},
		run: async ({ edytor }) => {
			const startBlock = edytor.selection.state.startBlock;
			if (!startBlock) {
				throw new Error('Missing startBlock for code suggestion test');
			}

			startBlock.suggestions = [[{ text: ' // done' }]];
			await runHotkey(edytor, 'tab');
		},
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [
							{ type: 'codeLine', data: {}, content: [{ text: 'const value = 1; // done' }] }
						]
					}
				]
			}
		} as never,
		assert: ({ edytor }) => {
			expect(edytor.selection.state.startBlock?.suggestions ?? null).toBeNull();
		}
	}),
	defineModelOperationFixture({
		description: 'clears code suggestions on escape',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = 1;|' }] }]
				}
			]
		},
		run: async ({ edytor }) => {
			const startBlock = edytor.selection.state.startBlock;
			if (!startBlock) {
				throw new Error('Missing startBlock for suggestion clear test');
			}

			startBlock.suggestions = [[{ text: ' // done' }]];
			await runHotkey(edytor, 'escape');
		},
		assert: ({ edytor }) => {
			expect(edytor.selection.state.startBlock?.suggestions ?? null).toBeNull();
		}
	}),
	defineModelOperationFixture({
		description: 'routes shift+enter in code lines to insertParagraph',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = 1;|' }] }]
				}
			]
		},
		run: ({ edytor }) => runHotkey(edytor, 'shift+enter'),
		expectSelection: { startBlockPath: [0, 1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [
							{ type: 'codeLine', data: {}, content: [{ text: 'const value = 1;' }] },
							{ type: 'paragraph', data: {} }
						]
					}
				]
			}
		} as never
	}),
	// ——— Non-Latin layout fallback (G5) ————————————————————————————————
	defineModelOperationFixture({
		description: 'matches mod+b when a Cyrillic layout reports a non-ASCII key',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: ({ edytor }) => runHotkey(edytor, 'mod+b', { key: 'в', code: 'KeyB' }),
		output: (
			<root>
				<paragraph>
					He<bold>ll</bold>o
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'does not run mod bindings for a bare non-ASCII keypress',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: ({ edytor }) => runHotkey(edytor, 'mod+b', { key: 'б', code: 'KeyB', ctrlKey: false }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: ({ result }) => {
			if ((result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected a bare non-ASCII keypress to stay native');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'does not apply the layout fallback to AltGr-modified keydowns',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, altGrProbePlugin],
		run: async ({ edytor }) => {
			altGrProbe.mockClear();
			return runHotkey(edytor, 'mod+alt+q', { key: '@', code: 'KeyQ' });
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: ({ result }) => {
			expect(altGrProbe).not.toHaveBeenCalled();
			if ((result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected the AltGr keydown to stay native');
			}
		}
	}),
	// ——— Windows/Linux Ctrl+Y redo (G6) ————————————————————————————————
	defineModelOperationFixture({
		description: 'redoes document changes with ctrl+y on non-Apple platforms',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const startText = edytor.selection.state.startText;
			if (!startText) {
				throw new Error('Missing startText for redo test');
			}

			startText.insertText({ value: '!' });
			await runHotkey(edytor, 'mod+z');
			return runHotkey(edytor, 'ctrl+y');
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		),
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'keeps the y-combinations native on Apple platforms',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			const startText = edytor.selection.state.startText;
			if (!startText) {
				throw new Error('Missing startText for Apple redo test');
			}

			startText.insertText({ value: '!' });
			await runHotkey(edytor, 'mod+z', { ctrlKey: false, metaKey: true });
			const ctrlY = await runHotkey(edytor, 'ctrl+y');
			const modY = await runHotkey(edytor, 'mod+y', { ctrlKey: false, metaKey: true });
			return { ctrlY, modY };
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: ({ result }) => {
			const { ctrlY, modY } = result as {
				ctrlY: { defaultPrevented: boolean };
				modY: { defaultPrevented: boolean };
			};
			if (ctrlY.defaultPrevented || modY.defaultPrevented) {
				throw new Error('Expected y-combinations to stay native on Apple platforms');
			}
		}
	}),
	// ——— macOS Emacs bindings (G6) —————————————————————————————————————
	defineModelOperationFixture({
		description: 'deletes the character before the caret with ctrl+h on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+h');
		},
		output: (
			<root>
				<paragraph>Helo</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 2, yEnd: 2, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'merges with the previous block on ctrl+h at a block start',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>|Second</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+h');
		},
		output: (
			<root>
				<paragraph>FirstSecond</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 5, yEnd: 5, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'deletes the character after the caret with ctrl+d on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+d');
		},
		output: (
			<root>
				<paragraph>Helo</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 3, yEnd: 3, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'kills to the end of the block with ctrl+k on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+k');
		},
		output: (
			<root>
				<paragraph>Hel</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 3, yEnd: 3, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'joins the next block on ctrl+k at a block end on Apple platforms',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+k');
		},
		output: (
			<root>
				<paragraph>HelloWorld</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 5, yEnd: 5, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'deletes a block selection with ctrl+h on Apple platforms',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			const secondBlock = edytor.root?.children[1];
			if (!secondBlock) {
				throw new Error('Missing second block for ctrl+h test');
			}
			edytor.selection.selectBlocks(secondBlock);
			return runHotkey(edytor, 'ctrl+h');
		},
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'inserts a line break and keeps the caret before it with ctrl+o',
		input: (
			<root>
				<paragraph>ab|cd</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+o');
		},
		output: (
			<root>
				<paragraph>{'ab\ncd'}</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 2, yEnd: 2, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'moves the caret to the block start with ctrl+a on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+a');
		},
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'moves the caret to the block end with ctrl+e on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+e');
		},
		expectSelection: { startBlockPath: [0], yStart: 5, yEnd: 5, isCollapsed: true },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	// ctrl+b/ctrl+f block-boundary crossing depends on `*EditableText`
	// getters that require mounted text nodes — covered in the DOM and
	// Playwright lanes instead.
	defineModelOperationFixture({
		description: 'leaves mid-text caret movement to the native handler for ctrl+b and ctrl+f',
		input: (
			<root>
				<paragraph>He|llo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			const ctrlB = await runHotkey(edytor, 'ctrl+b');
			const ctrlF = await runHotkey(edytor, 'ctrl+f');
			return { ctrlB, ctrlF };
		},
		expectSelection: { startBlockPath: [0], yStart: 2, yEnd: 2, isCollapsed: true },
		assert: ({ result }) => {
			const { ctrlB, ctrlF } = result as {
				ctrlB: { defaultPrevented: boolean };
				ctrlF: { defaultPrevented: boolean };
			};
			if (ctrlB.defaultPrevented || ctrlF.defaultPrevented) {
				throw new Error('Expected mid-text ctrl+b/ctrl+f to stay native');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'moves a block selection to the previous block with ctrl+p',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			const secondBlock = edytor.root?.children[1];
			if (!secondBlock) {
				throw new Error('Missing second block for ctrl+p test');
			}
			edytor.selection.selectBlocks(secondBlock);
			return runHotkey(edytor, 'ctrl+p');
		},
		expectSelection: { selectedBlockPaths: [[0]] },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'moves a block selection to the next block with ctrl+n',
		input: (
			<root>
				<paragraph>|First</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			const firstBlock = edytor.root?.children[0];
			if (!firstBlock) {
				throw new Error('Missing first block for ctrl+n test');
			}
			edytor.selection.selectBlocks(firstBlock);
			return runHotkey(edytor, 'ctrl+n');
		},
		expectSelection: { selectedBlockPaths: [[1]] },
		assert: ({ result }) => expectDefaultPrevented(result)
	}),
	defineModelOperationFixture({
		description: 'keeps Emacs bindings native on non-Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const ctrlK = await runHotkey(edytor, 'ctrl+k');
			const ctrlH = await runHotkey(edytor, 'ctrl+h');
			return { ctrlK, ctrlH };
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 3, yEnd: 3, isCollapsed: true },
		assert: ({ result }) => {
			const { ctrlK, ctrlH } = result as {
				ctrlK: { defaultPrevented: boolean };
				ctrlH: { defaultPrevented: boolean };
			};
			if (ctrlK.defaultPrevented || ctrlH.defaultPrevented) {
				throw new Error('Expected Emacs bindings to stay native on non-Apple platforms');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'keeps Emacs bindings inert while composing',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			edytor.isComposing = true;
			return runHotkey(edytor, 'ctrl+k');
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: ({ result }) => {
			if ((result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected composing keydowns to pass through untouched');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'prevents but does not run Emacs mutations in readonly mode',
		readonly: true,
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return runHotkey(edytor, 'ctrl+k');
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: ({ result }) => expectDefaultPrevented(result)
	})
]);
