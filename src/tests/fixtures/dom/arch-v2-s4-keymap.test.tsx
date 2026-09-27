/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint S4 rows (dom lane): one keydown handler per keyboard
 * occurrence, one precedence rule for bindings and definitions, built-in
 * bindings as rows (R7, O36, L36, L54).
 *
 * - F-I3 — a non-preventing `mod+alt+k` binding and a non-preventing `enter`
 *   binding each run once per keydown (reader C2 measured 2× and 3×).
 * - The same for Backspace inside text and for the keydown structural
 *   fallback (the fallback is the same occurrence as its keydown), while a
 *   `beforeinput` that no keydown offered (Android's `Unidentified` keydown)
 *   still reaches the `enter` binding once.
 * - F-P11 — slash query `/xyz` with zero matches; Enter is not swallowed.
 * - F-P12 — two blocks selected; arrow-move claims Mod+Down; the built-in
 *   Mod+Down does not also run (green on the reference: its multi-block branch
 *   leaves no text caret for the built-in to move; kept as a guard).
 * - F-P13 — a key handler throws a `TypeError`: the error surfaces (once), and
 *   the key is not half-executed.
 * - F-P14 — two extensions define `heading`: the first wins (README, D-11).
 * - O36 — consumer > extensions in list order > built-ins; first claim wins; a
 *   handler that does not claim lets the next one run.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snippet } from 'svelte';
import { Edytor } from '$lib/edytor.svelte.js';
import type { HotKey } from '$lib/hotkeys.js';
import type { Plugin } from '$lib/plugins.js';
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

/** Red on the reference; green since S4. */
const row = it.fails;
/** Green on the reference: a regression guard. */
const pin = it;

afterEach(() => {
	vi.restoreAllMocks();
});

/** An extension whose `chord` binding counts its runs and never claims. */
const counting = (chord: string, runs: { count: number }): Plugin => {
	const binding: HotKey = () => {
		runs.count++;
	};
	return () => ({ hotkeys: { [chord]: binding } });
};

const plugins = (...extra: Plugin[]) => [richTextPlugin, mentionPlugin, ...extra];

const texts = (edytor: Edytor) =>
	edytor.root!.children.map((block) => block.firstText?.stringContent ?? '');

const keydown = (target: HTMLElement, init: KeyboardEventInit & { key: string }): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', {
		code: init.key,
		...init,
		bubbles: true,
		cancelable: true
	});
	target.dispatchEvent(event);
	return event;
};

const beforeinput = (target: HTMLElement, inputType: string) => {
	const event = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
	Object.defineProperties(event, {
		inputType: { value: inputType },
		data: { value: null },
		dataTransfer: { value: null }
	});
	target.dispatchEvent(event);
	return event;
};

/**
 * One key press as a browser delivers it: the keydown, then — when no handler
 * claimed it — its `beforeinput` in the same task (no timer runs between).
 */
const press = async (editor: HTMLElement, key: string, inputType: string) => {
	const down = keydown(editor, { key });
	if (!down.defaultPrevented) beforeinput(editor, inputType);
	await flushDomUpdates();
	return down;
};

const surfaced = () => {
	const errors: unknown[] = [];
	const onError = (event: ErrorEvent) => {
		errors.push(event.error);
		event.preventDefault();
	};
	window.addEventListener('error', onError);
	const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(...args.filter((arg) => arg instanceof Error));
	});
	return {
		errors,
		stop: () => {
			window.removeEventListener('error', onError);
			consoleError.mockRestore();
		}
	};
};

describe('F-I3 — a binding runs once per keyboard occurrence', () => {
	row('a non-preventing mod+alt+k binding runs once per keydown', async () => {
		const runs = { count: 0 };
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>he|llo</paragraph>
			</root>,
			{ plugins: plugins(counting('mod+alt+k', runs)) }
		);
		await dispatchDomKeyDown(editor, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
		expect(runs.count).toBe(1);
	});

	row('a non-preventing enter binding runs once per press; the paragraph splits once', async () => {
		const runs = { count: 0 };
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>he|llo</paragraph>
			</root>,
			{ plugins: plugins(counting('enter', runs)) }
		);
		await press(editor, 'Enter', 'insertParagraph');
		expect(runs.count).toBe(1);
		expect(texts(edytor)).toEqual(['he', 'llo']);
	});

	row('a non-preventing backspace binding runs once per press inside text', async () => {
		const runs = { count: 0 };
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>he|llo</paragraph>
			</root>,
			{ plugins: plugins(counting('backspace', runs)) }
		);
		await press(editor, 'Backspace', 'deleteContentBackward');
		expect(runs.count).toBe(1);
		expect(texts(edytor)).toEqual(['hllo']);
	});

	row('the keydown structural fallback is the same occurrence: the binding runs once', async () => {
		const runs = { count: 0 };
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab</paragraph>
				<paragraph>|cd</paragraph>
			</root>,
			{ plugins: plugins(counting('backspace', runs)) }
		);
		// No `beforeinput` follows (the engine skipped it): the fallback merges.
		keydown(editor, { key: 'Backspace' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['abcd']);
		expect(runs.count).toBe(1);
	});

	pin(
		'a beforeinput no keydown offered (Android) still reaches the enter binding once',
		async () => {
			const runs = { count: 0 };
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>he|llo</paragraph>
				</root>,
				{ plugins: plugins(counting('enter', runs)) }
			);
			await press(editor, 'Unidentified', 'insertParagraph');
			expect(runs.count).toBe(1);
			expect(texts(edytor)).toEqual(['he', 'llo']);
		}
	);

	pin(
		'a claiming enter binding replaces the split (the bridge still offers Android Enter)',
		async () => {
			const runs = { count: 0 };
			const claiming: Plugin = () => ({
				hotkeys: {
					enter: ({ prevent }) =>
						prevent(() => {
							runs.count++;
						})
				}
			});
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>he|llo</paragraph>
				</root>,
				{ plugins: plugins(claiming) }
			);
			const down = await press(editor, 'Enter', 'insertParagraph');
			expect(down.defaultPrevented).toBe(true);
			await press(editor, 'Unidentified', 'insertParagraph');
			expect(runs.count).toBe(2);
			expect(texts(edytor)).toEqual(['hello']);
		}
	);
});

describe('F-P11 — an empty slash menu does not swallow Enter', () => {
	row('slash query /xyz with zero matches; Enter splits the paragraph', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: plugins(slashMenuPlugin) }
		);
		for (const data of '/xyz') {
			await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
		}
		expect(document.querySelectorAll('[data-testid="slash-menu-item"]').length).toBe(0);
		const down = await press(editor, 'Enter', 'insertParagraph');
		expect(down.defaultPrevented).toBe(false);
		expect(texts(edytor)).toEqual(['/xyz', '']);
	});
});

describe('F-P12 — a claimed key does not also run the built-in binding', () => {
	pin(
		'two blocks selected; arrow-move claims Mod+Down; the built-in Mod+Down does not run',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>A|</paragraph>
					<paragraph>B</paragraph>
					<paragraph>C</paragraph>
					<paragraph>D</paragraph>
				</root>,
				{ plugins: plugins(arrowMovePlugin) }
			);
			// Select A as a block (the select-all ladder), then extend to B.
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'ArrowDown', shiftKey: true });
			expect(edytor.selection.selectedBlocks.size).toBe(2);

			const down = await dispatchDomKeyDown(document, {
				key: 'ArrowDown',
				code: 'ArrowDown',
				metaKey: true
			});
			expect(down.defaultPrevented).toBe(true);
			expect(texts(edytor)).toEqual(['C', 'A', 'B', 'D']);
			// The built-in Mod+Down would have moved a caret to the document end.
			expect(
				Array.from(edytor.selection.selectedBlocks, (block) => block.firstText?.stringContent)
			).toEqual(['A', 'B']);
		}
	);
});

describe('F-P13 — a key handler that throws', () => {
	row('a TypeError surfaces once and the key is not half-executed', async () => {
		const throwing: Plugin = () => ({
			hotkeys: {
				enter: () => {
					(undefined as unknown as { boom(): void }).boom();
				}
			}
		});
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>he|llo</paragraph>
			</root>,
			{ plugins: plugins(throwing) }
		);
		const watch = surfaced();
		try {
			await press(editor, 'Enter', 'insertParagraph');
		} finally {
			watch.stop();
		}
		expect(watch.errors.length).toBe(1);
		expect(watch.errors[0]).toBeInstanceOf(TypeError);
		// The handler claimed nothing: Enter performs its own command, once.
		expect(texts(edytor)).toEqual(['he', 'llo']);
	});
});

describe('F-P14 — duplicate definitions: the first extension wins', () => {
	const snippet = (() => {}) as unknown as Snippet<[never]>;
	const defining =
		(marker: string): Plugin =>
		() => ({
			blocks: { heading: { snippet, placeholder: marker } as never },
			marks: { bold: { snippet, edge: 'inclusive', placeholder: marker } as never },
			inlineBlocks: { mention: { snippet, placeholder: marker } as never },
			commands: [{ id: 'heading', label: marker, run: () => {} }]
		});

	row('two extensions define heading (and a mark, an atom, a command): the first wins', () => {
		const edytor = new Edytor({
			plugins: [defining('first'), defining('second'), richTextPlugin]
		});
		expect((edytor.blocks.get('heading') as { placeholder?: string }).placeholder).toBe('first');
		expect((edytor.marks.get('bold') as { placeholder?: string }).placeholder).toBe('first');
		expect((edytor.inlineBlocks.get('mention') as { placeholder?: string }).placeholder).toBe(
			'first'
		);
		expect(edytor.commands.get('heading')?.label).toBe('first');
	});

	row('a consumer snippet still overrides the extension snippet (consumer > extensions)', () => {
		const own = (() => {}) as unknown as Snippet<[never]>;
		const edytor = new Edytor({
			plugins: [defining('first'), richTextPlugin],
			snippets: { headingBlock: own } as never
		});
		const heading = edytor.blocks.get('heading') as { snippet: unknown; placeholder?: string };
		expect(heading.snippet).toBe(own);
		expect(heading.placeholder).toBe('first');
	});
});

describe('O36 — one precedence rule for bindings', () => {
	const key = (init: KeyboardEventInit & { key: string }) =>
		new KeyboardEvent('keydown', { cancelable: true, ...init });

	pin('consumer > extensions in list order > built-ins; the first claim wins', () => {
		const calls: string[] = [];
		const observe =
			(name: string): HotKey =>
			() => {
				calls.push(name);
			};
		const claim =
			(name: string): HotKey =>
			({ prevent }) =>
				prevent(() => calls.push(name));
		const edytor = new Edytor({
			hotKeys: { 'mod+j': observe('consumer') },
			plugins: [
				() => ({ hotkeys: { 'mod+j': observe('first') } }),
				() => ({ hotkeys: { 'mod+j': claim('second') } }),
				() => ({ hotkeys: { 'mod+j': claim('third') } }),
				richTextPlugin
			]
		});
		edytor.hotKeys.init();
		const event = key({ key: 'j', ctrlKey: true });
		expect(edytor.hotKeys.isHotkey(event)).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		expect(calls).toEqual(['consumer', 'first', 'second']);
	});

	pin('registration chords are canonical: modifier order and case do not matter', () => {
		const calls: string[] = [];
		const edytor = new Edytor({
			hotKeys: { 'Shift+Alt+Mod+X': ({ prevent }) => prevent(() => calls.push('x')) },
			plugins: [richTextPlugin]
		});
		edytor.hotKeys.init();
		expect(
			edytor.hotKeys.isHotkey(key({ key: 'X', ctrlKey: true, altKey: true, shiftKey: true }))
		).toBe(true);
		expect(calls).toEqual(['x']);
	});
});
