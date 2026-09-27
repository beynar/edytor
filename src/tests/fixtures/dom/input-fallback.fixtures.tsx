/** @jsxImportSource ../../jsx */
import { defineDomFixture, defineFixtures } from '../types.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomInput,
	flushDomUpdates
} from '../../dom/test.utils.js';
import type { Text } from '$lib/text/text.svelte.js';

const setCollapsedDomSelection = (text: Text, offset: number) => {
	if (!text.node) {
		throw new Error('Cannot set DOM selection for an unmounted text');
	}

	const target = text.node.firstChild ?? text.node;
	const range = document.createRange();
	if (target.nodeType === Node.TEXT_NODE) {
		range.setStart(target, Math.min(offset, target.textContent?.length ?? 0));
	} else {
		range.setStart(text.node, Math.min(offset, text.node.childNodes.length));
	}
	range.collapse(true);

	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	(target.parentElement ?? text.node).focus();
};

const forceSelectionChange = async (text: Text, offset: number) => {
	setCollapsedDomSelection(text, offset);
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
};

const waitForCompositionSelectionStabilization = async () => {
	await new Promise((resolve) => setTimeout(resolve, 40));
	await flushDomUpdates();
};

const mutateDomTextAndDispatchInput = async (
	editor: HTMLElement,
	text: Text,
	value: string,
	caretOffset = value.length,
	inputType = 'insertText'
) => {
	if (!text.node) {
		throw new Error('Cannot mutate an unmounted text');
	}

	text.node.textContent = value;
	setCollapsedDomSelection(text, caretOffset);
	await dispatchDomInput(editor, { inputType });
};

const mutateDomTextWithoutInput = async (text: Text, value: string, caretOffset = value.length) => {
	if (!text.node) {
		throw new Error('Cannot mutate an unmounted text');
	}

	const textNode =
		Array.from(text.node.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) ??
		text.node.firstChild;
	if (textNode?.nodeType === Node.TEXT_NODE) {
		textNode.textContent = value;
	} else {
		text.node.textContent = value;
	}
	setCollapsedDomSelection(text, caretOffset);
	await flushDomUpdates();
};

const insertUnmanagedDomNode = async (text: Text) => {
	const paragraph = text.parent.node?.querySelector('p');
	if (!paragraph) {
		throw new Error('Expected a rendered paragraph element');
	}

	const injected = document.createElement('span');
	injected.dataset.testUnmanaged = 'true';
	injected.textContent = ' injected';
	paragraph.append(injected);
	await flushDomUpdates();
};

const removeManagedTextNode = async (text: Text) => {
	if (!text.node) {
		throw new Error('Cannot remove an unmounted text');
	}

	text.node.remove();
	await flushDomUpdates();
};

const removeManagedBlockNode = async (text: Text) => {
	if (!text.parent.node) {
		throw new Error('Cannot remove an unmounted block');
	}

	text.parent.node.remove();
	await flushDomUpdates();
};

const dispatchBeforeInputWithoutFlush = (
	editor: HTMLElement,
	inputType: string,
	data: string | null,
	cancelable = true
) => {
	const event = new Event('beforeinput', {
		bubbles: true,
		cancelable
	}) as InputEvent;

	Object.defineProperties(event, {
		inputType: {
			value: inputType,
			configurable: true
		},
		data: {
			value: data,
			configurable: true
		},
		dataTransfer: {
			value: null,
			configurable: true
		}
	});

	editor.dispatchEvent(event);
	return event;
};

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'reconciles a plain input event when beforeinput did not run',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			await mutateDomTextAndDispatchInput(editor, edytor.root!.children[0].firstText, 'Hello!');
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'reconciles an autocorrect-style input replacement',
		input: (
			<root>
				<paragraph>teh| cat</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			await mutateDomTextAndDispatchInput(
				editor,
				edytor.root!.children[0].firstText,
				'the cat',
				3,
				'insertReplacementText'
			);
		},
		output: (
			<root>
				<paragraph>the cat</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'lets native replacement beforeinput fall through for input reconciliation',
		input: (
			<root>
				<paragraph>teh| cat</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			const event = dispatchBeforeInputWithoutFlush(editor, 'insertReplacementText', 'the');
			if (event.defaultPrevented) {
				throw new Error('Expected native replacement beforeinput to remain unprevented');
			}

			await mutateDomTextAndDispatchInput(
				editor,
				edytor.root!.children[0].firstText,
				'the cat',
				3,
				'insertReplacementText'
			);
		},
		output: (
			<root>
				<paragraph>the cat</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'handles non-cancelable composition beforeinput through the model',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			const text = edytor.root!.children[0].firstText;
			editor.dispatchEvent(new Event('compositionstart', { bubbles: true, cancelable: true }));

			const event = dispatchBeforeInputWithoutFlush(editor, 'insertCompositionText', 'é', false);
			if (event.defaultPrevented) {
				throw new Error('Expected non-cancelable composition beforeinput to remain unprevented');
			}
			if (text.stringContent !== 'Helloé') {
				throw new Error('Expected non-cancelable composition beforeinput to update the model');
			}

			const endEvent =
				typeof CompositionEvent === 'function'
					? new CompositionEvent('compositionend', {
							bubbles: true,
							cancelable: true,
							data: 'é'
						})
					: Object.assign(new Event('compositionend', { bubbles: true, cancelable: true }), {
							data: 'é'
						});
			editor.dispatchEvent(endEvent);
			await waitForCompositionSelectionStabilization();
		},
		output: (
			<root>
				<paragraph>Helloé</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'preserves marks when reconciling a DOM text insertion',
		input: (
			<root>
				<paragraph>
					<bold>Hello|</bold>
				</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			await mutateDomTextAndDispatchInput(editor, edytor.root!.children[0].firstText, 'Hello!');
		},
		output: (
			<root>
				<paragraph>
					<bold>Hello!</bold>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'ignores the paired input event after handled beforeinput',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			const text = edytor.root!.children[0].firstText;
			dispatchBeforeInputWithoutFlush(editor, 'insertText', '!');
			await mutateDomTextAndDispatchInput(editor, text, 'Hello!!', 7);
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'reconciles a raw DOM text mutation when no input event fires',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await mutateDomTextWithoutInput(edytor.root!.children[0].firstText, 'Hello!');
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'ignores observed DOM text mutations while composition is active',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			const text = edytor.root!.children[0].firstText;
			await dispatchComposition(editor, [{ type: 'compositionstart' }]);
			await mutateDomTextWithoutInput(text, 'Hello IME', 9);
			await dispatchComposition(editor, [{ type: 'compositionend', data: '' }]);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineDomFixture({
		description: 'restores the caret after a delayed browser selection jump following composition',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			const text = edytor.root!.children[0].firstText;
			await dispatchComposition(editor, [
				{ type: 'compositionstart', data: '' },
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
				{ type: 'compositionend', data: 'é' }
			]);
			await forceSelectionChange(text, 0);
			await waitForCompositionSelectionStabilization();
		},
		output: (
			<root>
				<paragraph>éHello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'commits final insertFromComposition beforeinput without dropping text',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await dispatchComposition(editor, [
				{ type: 'compositionstart', data: '' },
				{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
				{ type: 'compositionend', data: 'に' }
			]);
			await waitForCompositionSelectionStabilization();
		},
		output: (
			<root>
				<paragraph>にHello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'replaces intermediate composition text with final insertFromComposition data',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await dispatchComposition(editor, [
				{ type: 'compositionstart', data: '' },
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
				{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
				{ type: 'compositionend', data: 'に' }
			]);
			await waitForCompositionSelectionStabilization();
		},
		output: (
			<root>
				<paragraph>にHello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description:
			'replaces intermediate composition text at a fresh split block start (shared-backing seam)',
		input: (
			<root>
				<paragraph>alpha|Hello</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
			await dispatchComposition(editor, [
				{ type: 'compositionstart', data: '' },
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
				{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
				{ type: 'compositionend', data: 'に' }
			]);
			await waitForCompositionSelectionStabilization();
		},
		output: (
			<root>
				<paragraph>alpha</paragraph>
				<paragraph>にHello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		// R7 rewrite (answer (b), D-25): the paragraph element is the kind's own
		// markup around its slot, not a strict container — a node beside the text
		// element stays there and never reaches the model.
		description: 'keeps an unmanaged node the kind’s markup holds beside the text element (D-25)',
		fails: true,
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await insertUnmanagedDomNode(edytor.root!.children[0].firstText);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		},
		assert: ({ container }) => {
			if (!container.querySelector('[data-test-unmanaged]')) {
				throw new Error('Expected the kind’s own markup to keep the unmanaged node (D-25)');
			}
		}
	}),
	defineDomFixture({
		description: 'restores managed text nodes removed outside the renderer',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await removeManagedTextNode(edytor.root!.children[0].firstText);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		},
		assert: ({ container }) => {
			if (!container.querySelector('[data-edytor-text="true"]')) {
				throw new Error('Expected the observer to restore the managed text node');
			}
		}
	}),
	defineDomFixture({
		description: 'restores managed block nodes removed outside the renderer',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await removeManagedBlockNode(edytor.root!.children[0].firstText);
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		},
		assert: ({ container }) => {
			if (container.querySelectorAll('[data-edytor-block="true"]').length < 2) {
				throw new Error('Expected the observer to restore the managed block node');
			}
		}
	}),
	defineDomFixture({
		description: 'inserts yanked text through the insertText command path',
		input: (
			<root>
				<paragraph>Hello |there</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'insertFromYank', 'yank');
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Hello yankthere</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 10,
			yEnd: 10,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'inserts transposed text through the insertText command path',
		input: (
			<root>
				<paragraph>Hello |there</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'insertTranspose', 'X');
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Hello Xthere</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 7,
			yEnd: 7,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description:
			'handles a cancelable insertReplacementText over a range through the model (collapsed cases are browser-owned)',
		input: (
			<root>
				<paragraph>Hello |wor|ld</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'insertReplacementText', 'X');
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Hello Xld</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 7,
			yEnd: 7,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes a selected range on deleteByCut',
		input: (
			<root>
				<paragraph>Hello |wor|ld</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'deleteByCut', null);
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Hello ld</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes a selected range on deleteByDrag',
		input: (
			<root>
				<paragraph>Hello |wor|ld</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'deleteByDrag', null);
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Hello ld</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes a selected range on deleteByComposition',
		input: (
			<root>
				<paragraph>Hello |wor|ld</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'deleteByComposition', null);
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Hello ld</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes to line start on deleteHardLineBackward',
		input: (
			<root>
				<paragraph>Hello|world</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'deleteHardLineBackward', null);
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>world</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes to line end on deleteHardLineForward',
		input: (
			<root>
				<paragraph>Hello|world</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'deleteHardLineForward', null);
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes forward one grapheme on generic deleteContent',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			dispatchBeforeInputWithoutFlush(editor, 'deleteContent', null);
			await flushDomUpdates();
		},
		output: (
			<root>
				<paragraph>Helo</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description:
			'a browser-owned backward delete during composition leaves the model span intact for the next composition write',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			const text = edytor.root!.children[0].firstText;
			await dispatchComposition(editor, [
				{ type: 'compositionstart' },
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'nich' }
			]);
			if (text.stringContent !== 'Hellonich') {
				throw new Error(`expected intermediate composition text, got "${text.stringContent}"`);
			}
			// Chrome IME backspaces are non-cancelable and browser-owned —
			// the model keeps 'nich' until the next composition write
			// replaces the whole span (DOM mutations stay suppressed).
			const event = dispatchBeforeInputWithoutFlush(editor, 'deleteContentBackward', null, false);
			if (event.defaultPrevented) {
				throw new Error('expected browser-owned composition delete to remain unprevented');
			}
			await flushDomUpdates();
			if (text.stringContent !== 'Hellonich') {
				throw new Error(
					`browser-owned delete should not edit the model mid-composition, got "${text.stringContent}"`
				);
			}
			await dispatchComposition(editor, [
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'nik' },
				{ type: 'compositionend', data: 'nik' }
			]);
			await waitForCompositionSelectionStabilization();
		},
		output: (
			<root>
				<paragraph>Hellonik</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 8,
			yEnd: 8,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'clears a dangling composition after the editor loses focus',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			await dispatchComposition(editor, [
				{ type: 'compositionstart' },
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' }
			]);
			if (!edytor.isComposing || edytor.composition.preview !== 'é') {
				throw new Error('expected an active composition before focus loss');
			}
			// Focus loss abandons the session: what the host shows is adopted (D-7).
			editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
			await new Promise((resolve) => setTimeout(resolve, 80));
			await flushDomUpdates();
			if (edytor.isComposing) {
				throw new Error('expected dangling composition state to be cleared after blur');
			}
		},
		output: (
			<root>
				<paragraph>Helloé</paragraph>
			</root>
		)
	})
]);
