/** @jsxImportSource ../../jsx */
/**
 * Android Chrome post-delete caret-shift restore.
 *
 * Android Chrome mutates the DOM anyway after a canceled
 * `deleteContentBackward` and then reports a `selectionchange` whose
 * collapsed caret sits one position right of the model-computed merge
 * point (the `postDeleteSelectionToRestore` pattern in Lexical). The
 * selection layer records the caret written right after a local
 * deletion and snaps the tell-tale `offset + 1` echo back to it.
 *
 * These tests exercise the full path in jsdom: a real model merge (a
 * local transaction with a non-empty deleteSet arms the tracker), a
 * real programmatic caret write, and a dispatched `selectionchange`
 * carrying the shifted DOM caret.
 */
import { describe, expect, test } from 'vitest';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	expectNativeSelection
} from '../../dom/test.utils.js';
import { Text as ModelText } from '$lib/text/text.svelte.js';

const ANDROID_CHROME_UA =
	'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const setUserAgent = (ua: string) => {
	const prototype = Object.getPrototypeOf(window.navigator);
	const descriptor =
		Object.getOwnPropertyDescriptor(window.navigator, 'userAgent') ??
		Object.getOwnPropertyDescriptor(prototype, 'userAgent');
	Object.defineProperty(window.navigator, 'userAgent', {
		get: () => ua,
		configurable: true
	});
	return () => {
		if (descriptor && descriptor.get && 'userAgent' in window.navigator) {
			delete (window.navigator as { userAgent?: string }).userAgent;
		}
	};
};

const mergeSecondIntoFirst = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>first</paragraph>
			<paragraph>second</paragraph>
		</root>,
		{ autoSelectFixture: false }
	);
	const { edytor } = rendered;
	const second = edytor.root!.children[1]!;
	await setNativeSelection(edytor, second.firstText!, 0);

	// The model-owned cross-paragraph backward delete. Production merges
	// always run through `runBeforeInputDeleteCommand`, which stamps
	// `lastDeleteCommandAt` — the arming gate for the snap-back.
	edytor.selection.lastDeleteCommandAt = Date.now();
	second.mergeBlockBackward();
	await flushDomUpdates();
	expect(edytor.root!.children.length).toBe(1);

	// The caret the production delete path writes: the merge boundary —
	// "first".length — regardless of whether the merge produced one
	// joined text or kept two boundary texts.
	const merged = edytor.root!.children[0]!;
	const mergeText = merged.content.find(
		(part) => part instanceof ModelText && part.stringContent.startsWith('first')
	) as ModelText;
	const mergeOffset = 'first'.length;
	await edytor.selection.setAtTextOffset(mergeText, mergeOffset);
	await flushDomUpdates();
	expect(edytor.selection.state.yStart).toBe(mergeOffset);
	expect(edytor.selection.state.isCollapsed).toBe(true);

	return { ...rendered, mergeText, mergeOffset };
};

describe('Android post-delete caret-shift restore', () => {
	test('snaps a post-delete offset+1 selectionchange back to the merge point', async () => {
		const restoreUA = setUserAgent(ANDROID_CHROME_UA);
		try {
			const { edytor, mergeText, mergeOffset } = await mergeSecondIntoFirst();

			// Re-arm the delete window: the real-time setup above (merge,
			// flushes, the caret write) can exceed the 250ms arming window
			// under parallel-suite load, expiring the gate before the
			// tell-tale arrives. Same evidence `runBeforeInputDeleteCommand`
			// stamps in production — this is what keeps the test about the
			// snap-back rather than about scheduling speed.
			edytor.selection.lastDeleteCommandAt = Date.now();

			// The tell-tale: collapsed caret exactly one position right of
			// the merge point on the same text.
			await setNativeSelection(edytor, mergeText, mergeOffset + 1);
			await flushDomUpdates();

			expect(edytor.selection.state.yStart).toBe(mergeOffset);
			expect(edytor.selection.state.isCollapsed).toBe(true);
			expectNativeSelection({ collapsed: true, anchorOffset: mergeOffset });
		} finally {
			restoreUA();
		}
	});

	test('does not touch a +1 selectionchange outside Android Chrome', async () => {
		// Default jsdom UA — not Android Chrome.
		const { edytor, mergeText, mergeOffset } = await mergeSecondIntoFirst();

		await setNativeSelection(edytor, mergeText, mergeOffset + 1);
		await flushDomUpdates();

		expect(edytor.selection.state.yStart).toBe(mergeOffset + 1);
	});

	test('does not snap back a real caret move after a navigational cross-text write', async () => {
		const restoreUA = setUserAgent(ANDROID_CHROME_UA);
		try {
			const rendered = await renderDomEdytor(
				<root>
					<paragraph>first</paragraph>
					<paragraph>second</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const { edytor } = rendered;
			const [first, second] = edytor.root!.children;

			// The navigational signature that used to false-arm: collapsed
			// caret at the START of one text, programmatic write landing in
			// a different text — with NO delete command in the window.
			await edytor.selection.setAtTextOffset(second!.firstText!, 0);
			await flushDomUpdates();
			const target = first!.lastText!;
			await edytor.selection.setAtTextOffset(target, 3);
			await flushDomUpdates();

			// A real user move to offset+1 must apply — the arming gate is
			// keyed to actual deletes (`lastDeleteCommandAt`).
			await setNativeSelection(edytor, target, 4);
			await flushDomUpdates();

			expect(edytor.selection.state.yStart).toBe(4);
		} finally {
			restoreUA();
		}
	});

	test('does not touch a +1 selectionchange when no deletion armed the restore', async () => {
		const restoreUA = setUserAgent(ANDROID_CHROME_UA);
		try {
			const rendered = await renderDomEdytor(
				<root>
					<paragraph>hello world</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const { edytor } = rendered;
			const text = edytor.root!.children[0]!.firstText!;
			await edytor.selection.setAtTextOffset(text, 2);
			await flushDomUpdates();

			// Same tell-tale shape but no local deletion preceded it —
			// this is just a caret move and must apply normally.
			await setNativeSelection(edytor, text, 3);
			await flushDomUpdates();

			expect(edytor.selection.state.yStart).toBe(3);
		} finally {
			restoreUA();
		}
	});
});
