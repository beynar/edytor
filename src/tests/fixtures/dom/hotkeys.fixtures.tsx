/** @jsxImportSource ../../jsx */
import { expect, vi } from 'vitest';

import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { defineDomFixture, defineFixtures } from '../types.js';
import { dispatchDomKeyDown } from '../../dom/test.utils.js';

const mockApplePlatform = (edytor: Edytor) => {
	Object.defineProperty(edytor.hotKeys, 'isMac', {
		configurable: true,
		get: () => true
	});
};

const altGrProbe = vi.fn();
const altGrProbePlugin: Plugin = () => ({
	hotkeys: { 'mod+alt+q': altGrProbe }
});

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'cycles mod+a from text selection to block selection to document selection',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			return dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
		},
		expectSelection: {
			selectedBlockPaths: [[0], [1]]
		}
	}),
	defineDomFixture({
		description: 'nests the current block on tab and preserves the caret offset',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
			</root>
		),
		run: () => dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' }),
		output: (
			<root>
				<paragraph>
					First
					<paragraph>Second</paragraph>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected tab nesting to prevent native keyboard behavior');
			}
		}
	}),
	defineDomFixture({
		description: 'tab over a selection of sibling blocks nests them all and keeps them selected',
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
			await dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true });
			return dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' });
		},
		output: (
			<root>
				<paragraph>
					First
					<paragraph>Second</paragraph>
					<paragraph>Third</paragraph>
				</paragraph>
			</root>
		),
		expectSelection: {
			selectedBlockPaths: [
				[0, 0],
				[0, 1]
			]
		}
	}),
	defineDomFixture({
		description:
			'shift+tab over selected sibling blocks outdents them; the siblings after them follow the last',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
					<paragraph>Se|cond</paragraph>
					<paragraph>Third</paragraph>
					<paragraph>Fourth</paragraph>
				</paragraph>
			</root>
		),
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true });
			return dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab', shiftKey: true });
		},
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
				</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>
					Third
					<paragraph>Fourth</paragraph>
				</paragraph>
			</root>
		),
		expectSelection: { selectedBlockPaths: [[1], [2]] }
	}),
	defineDomFixture({
		description: 'shift+tab on a middle nested item takes its following siblings along',
		input: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
					<paragraph>Se|cond</paragraph>
					<paragraph>Third</paragraph>
				</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: () => dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab', shiftKey: true }),
		output: (
			<root>
				<paragraph>
					Parent
					<paragraph>First</paragraph>
				</paragraph>
				<paragraph>
					Second
					<paragraph>Third</paragraph>
				</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [1], yStart: 2, isCollapsed: true }
	}),
	defineDomFixture({
		description:
			'grows block selection with shift+arrowdown and collapses it back to a caret on escape',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true });
			return dispatchDomKeyDown(document, { key: 'Escape', code: 'Escape' });
		},
		expectSelection: {
			selectedBlockPaths: [],
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes selected blocks with backspace and focuses the previous block',
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
			yStart: 5,
			yEnd: 5,
			isCollapsed: true,
			selectedBlockPaths: []
		}
	}),
	defineDomFixture({
		description: 'moves a selected block down with the arrow-move plugin',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, arrowMovePlugin],
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			return dispatchDomKeyDown(document, {
				key: 'ArrowDown',
				code: 'ArrowDown',
				metaKey: true
			});
		},
		output: (
			<root>
				<paragraph>Second</paragraph>
				<paragraph>First</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		expectSelection: {
			selectedBlockPaths: [[1]]
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected arrow-move hotkey to prevent native navigation');
			}
		}
	}),
	defineDomFixture({
		// Notion's Mod+Enter only modifies a to-do or a toggle; it never splits (DW-03).
		description: 'claims mod+enter in a paragraph without changing it',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: () =>
			dispatchDomKeyDown(document, {
				key: 'Enter',
				code: 'Enter',
				metaKey: true
			}),
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected mod+enter to prevent native keyboard behavior');
			}
		}
	}),
	// ——— Non-Latin layout fallback (G5) ————————————————————————————————
	defineDomFixture({
		description: 'applies mod+b when a Cyrillic layout reports a non-ASCII key',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: () => dispatchDomKeyDown(document, { key: 'в', code: 'KeyB', metaKey: true }),
		output: (
			<root>
				<paragraph>
					He<bold>ll</bold>o
				</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected the Cyrillic mod chord to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'does not reinterpret a bare Cyrillic keypress through event.code',
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: () => dispatchDomKeyDown(document, { key: 'б', code: 'KeyB' }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			if ((result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected a bare non-ASCII keypress to stay native');
			}
		}
	}),
	defineDomFixture({
		description: 'does not apply the layout fallback to AltGr keydowns',
		plugins: [richTextPlugin, mentionPlugin, altGrProbePlugin],
		input: (
			<root>
				<paragraph>He|ll|o</paragraph>
			</root>
		),
		run: async () => {
			altGrProbe.mockClear();
			return dispatchDomKeyDown(document, {
				key: '@',
				code: 'KeyQ',
				ctrlKey: true,
				altKey: true
			});
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			expect(altGrProbe).not.toHaveBeenCalled();
			if ((result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected the AltGr keydown to stay native');
			}
		}
	}),
	// ——— macOS Emacs bindings (G6) —————————————————————————————————————
	defineDomFixture({
		description: 'deletes the character before the caret with ctrl+h on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return dispatchDomKeyDown(document, { key: 'h', code: 'KeyH', ctrlKey: true });
		},
		output: (
			<root>
				<paragraph>Helo</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 2, yEnd: 2, isCollapsed: true },
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected ctrl+h to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'deletes the character after the caret with ctrl+d on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return dispatchDomKeyDown(document, { key: 'd', code: 'KeyD', ctrlKey: true });
		},
		output: (
			<root>
				<paragraph>Helo</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 3, yEnd: 3, isCollapsed: true },
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected ctrl+d to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'kills to the end of the block with ctrl+k on Apple platforms',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return dispatchDomKeyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true });
		},
		output: (
			<root>
				<paragraph>Hel</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 3, yEnd: 3, isCollapsed: true },
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected ctrl+k to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'inserts a line break and keeps the caret before it with ctrl+o',
		input: (
			<root>
				<paragraph>ab|cd</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return dispatchDomKeyDown(document, { key: 'o', code: 'KeyO', ctrlKey: true });
		},
		output: (
			<root>
				<paragraph>{'ab\ncd'}</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 2, yEnd: 2, isCollapsed: true },
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected ctrl+o to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'moves the caret to the block boundaries with ctrl+a and ctrl+e',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', ctrlKey: true });
			return dispatchDomKeyDown(document, { key: 'e', code: 'KeyE', ctrlKey: true });
		},
		expectSelection: { startBlockPath: [0], yStart: 5, yEnd: 5, isCollapsed: true },
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected ctrl+a/ctrl+e to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'collapses the caret into the previous block with ctrl+b at a block start',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>|Second</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', ctrlKey: true });
		},
		expectSelection: { startBlockPath: [0], yStart: 5, yEnd: 5, isCollapsed: true },
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected ctrl+b to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'collapses the caret into the next block with ctrl+f at a block end',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return dispatchDomKeyDown(document, { key: 'f', code: 'KeyF', ctrlKey: true });
		},
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected ctrl+f to prevent the native event');
			}
		}
	}),
	defineDomFixture({
		description: 'prevents but does not run Emacs mutations in readonly mode',
		readonly: true,
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			mockApplePlatform(edytor);
			return dispatchDomKeyDown(document, { key: 'k', code: 'KeyK', ctrlKey: true });
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected readonly ctrl+k to be prevented without mutating');
			}
		}
	})
]);
