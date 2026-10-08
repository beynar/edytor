/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint V5 rows, dom lane: the `selectionchange` classifier
 * (R10, §4.4 `surface/projector`, L23). Each observation is compared with the
 * projector's last display, the render epoch and the gesture serial:
 *
 * - echo — the DOM still shows the last display: nothing is derived;
 * - render drift — our render moved the DOM caret after the last
 *   observation, with no gesture since: the value is displayed again;
 * - foreign write — no gesture and no render: adopted (assistive tech, host
 *   code; probe C4, O1);
 * - intent — a gesture since the last observation: adopted;
 * - the two named, counted, time-bounded signatures (plan §9.1 rule 5):
 *   the Android post-delete snap-back (the caret one position right of a
 *   model-owned merge point, before any gesture) and the IME post-commit
 *   jump (a move right after a composition commit, before any gesture).
 *
 * F-S10: after settle the DOM caret equals the model caret, and no timer is
 * left scheduled by the post-commit rule (F-O1: the rules compare timestamps
 * at use, they schedule nothing).
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Edytor } from '$lib/edytor.svelte.js';
import { Text as ModelText } from '$lib/text/text.svelte.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since V5. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

const ANDROID_CHROME_UA =
	'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const withUserAgent = (ua: string) =>
	vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);

/** The selection as (block, display offsets): the plan's coordinates. */
const range = (edytor: Edytor) => {
	const { start, end, isCollapsed } = edytor.selection.projection;
	return {
		block: start?.block ?? null,
		start: start?.offset ?? null,
		end: end?.offset ?? null,
		isCollapsed
	};
};

/** The text leaf and offset of a display offset inside a text element. */
const point = (element: Element, offset: number): [Node, number] => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let at = 0;
	for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
		const length = (leaf as globalThis.Text).length;
		if (offset <= at + length) return [leaf, offset - at];
		at += length;
	}
	return [element, 0];
};

/** The DOM caret as a display offset inside `element` (null when it is elsewhere). */
const domCaret = (element: Element) => {
	const selection = window.getSelection();
	if (!selection?.anchorNode || !selection.isCollapsed) return null;
	if (!element.contains(selection.anchorNode)) return null;
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let at = 0;
	for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
		if (leaf === selection.anchorNode) return at + selection.anchorOffset;
		at += (leaf as globalThis.Text).length;
	}
	return selection.anchorNode === element ? selection.anchorOffset : null;
};

/** Past the observer's reconciliation of our own render (its records are deferred ≈16 ms). */
const settle = async () => {
	await new Promise((resolve) => setTimeout(resolve, 60));
	await flushDomUpdates();
};

/** A move nobody gestured for (the browser, assistive tech, host code), then its `selectionchange`. */
const moveWithoutGesture = (element: Element, start: number, end = start) => {
	const [startNode, startOffset] = point(element, start);
	const [endNode, endOffset] = point(element, end);
	window.getSelection()!.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
	document.dispatchEvent(new Event('selectionchange'));
};

describe('F-S10 — echo, render drift, foreign write, intent', () => {
	pin('echo: the selectionchange of a display is not derived', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|hello world</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText!;
		await edytor.selection.setAtTextOffset(text, 3);
		await flushDomUpdates();
		expect(domCaret(text.node!)).toBe(3);
		const epoch = edytor.selection.epoch;
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(edytor.selection.epoch).toBe(epoch);
		expect(range(edytor)).toMatchObject({ start: 3, isCollapsed: true });
	});

	pin('render drift: a remount under the caret is displayed again, not adopted', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>|hello world</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText!;
		await edytor.selection.setAtTextOffset(text, 3);
		await flushDomUpdates();
		text.refreshFromModel();
		await flushDomUpdates();
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 3, isCollapsed: true });
		expect(domCaret(text.node!)).toBe(3);
	});

	pin(
		'foreign write after a typed character: host code selects 0 → 3, the model adopts it',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>hello world</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const text = edytor.root!.children[0]!.firstText!;
			await setNativeSelection(edytor, text, 5);
			await dispatchDomBeforeInput(edytor.node!, { inputType: 'insertText', data: 'X' });
			await flushDomUpdates();
			expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('helloX world');
			await settle();
			const element = edytor.root!.children[0]!.firstText!.node!;
			moveWithoutGesture(element, 0, 3);
			await flushDomUpdates();
			expect(range(edytor)).toMatchObject({ start: 0, end: 3, isCollapsed: false });
		}
	);

	row(
		'a move while our render is unreconciled: after settle the DOM caret is the model caret',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>hello world</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, 5);
			await dispatchDomBeforeInput(edytor.node!, { inputType: 'insertText', data: 'X' });
			await flushDomUpdates();
			const element = edytor.root!.children[0]!.firstText!.node!;
			// Before the observer reconciled the typed character's render.
			moveWithoutGesture(element, 1);
			await settle();
			expect(domCaret(element)).toBe(range(edytor).start);
		}
	);
});

/**
 * `first` / `second`, caret at the start of `second`, then a model-owned
 * Backspace merge; settled (the merge's own DOM records reconciled), still
 * inside the Android rule's window.
 */
const mergeWithBackspace = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>first</paragraph>
			<paragraph>second</paragraph>
		</root>,
		{ autoSelectFixture: false }
	);
	const { edytor } = rendered;
	await setNativeSelection(edytor, edytor.root!.children[1]!.firstText!, 0);
	await dispatchDomBeforeInput(edytor.node!, { inputType: 'deleteContentBackward' });
	await flushDomUpdates();
	expect(edytor.root!.children.length).toBe(1);
	expect(range(edytor)).toMatchObject({ start: 5, isCollapsed: true });
	// Inside the rule's window, past the observer's reconciliation of the merge.
	await settle();
	const merged = edytor.root!.children[0]!;
	const text = merged.content.find(
		(part): part is ModelText => part instanceof ModelText && part.stringContent.startsWith('first')
	)!;
	return { ...rendered, text };
};

describe('F-S10 — the Android post-delete snap-back (named rule)', () => {
	pin(
		'Android: a +1 caret right after a model-owned merge snaps back to the merge point',
		async () => {
			withUserAgent(ANDROID_CHROME_UA);
			const { edytor, text } = await mergeWithBackspace();
			moveWithoutGesture(text.node!, 6);
			await flushDomUpdates();
			expect(range(edytor)).toMatchObject({ start: 5, isCollapsed: true });
			expect(domCaret(text.node!)).toBe(5);
		}
	);

	pin('not Android: the same +1 move is a foreign write, adopted', async () => {
		const { edytor, text } = await mergeWithBackspace();
		moveWithoutGesture(text.node!, 6);
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 6, isCollapsed: true });
	});

	pin('Android, after the rule window: the +1 move is adopted', async () => {
		withUserAgent(ANDROID_CHROME_UA);
		const { edytor, text } = await mergeWithBackspace();
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 1000);
		moveWithoutGesture(text.node!, 6);
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 6, isCollapsed: true });
	});

	pin('Android: a navigational cross-text write never arms the rule (no delete ran)', async () => {
		withUserAgent(ANDROID_CHROME_UA);
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>first</paragraph>
				<paragraph>second</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const [first, second] = edytor.root!.children;
		// The merge's position signature: a caret at a text start, then a
		// write landing in another text — with no delete command.
		await edytor.selection.setAtTextOffset(second!.firstText!, 0);
		await flushDomUpdates();
		await edytor.selection.setAtTextOffset(first!.lastText!, 3);
		await flushDomUpdates();
		await settle();
		moveWithoutGesture(first!.lastText!.node!, 4);
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 4, isCollapsed: true });
	});

	row('Android: a gesture after the merge owns the caret — the +1 move is adopted', async () => {
		withUserAgent(ANDROID_CHROME_UA);
		const { edytor, text } = await mergeWithBackspace();
		edytor.markUserGesture();
		moveWithoutGesture(text.node!, 6);
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 6, isCollapsed: true });
	});
});

/** An empty paragraph composed to `é` (script-dispatched composition), caret after it. */
const commitComposition = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>ab</paragraph>
		</root>,
		{ autoSelectFixture: false }
	);
	const { edytor } = rendered;
	await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, 2);
	await dispatchComposition(edytor.node!, [
		{ type: 'compositionstart', data: '' },
		{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
		{ type: 'compositionend', data: 'é' }
	]);
	await flushDomUpdates();
	const text = edytor.root!.children[0]!.firstText!;
	expect(text.stringContent).toBe('abé');
	expect(range(edytor)).toMatchObject({ start: 3, isCollapsed: true });
	return { ...rendered, text };
};

/**
 * Timers and frames scheduled by the post-commit restore that are still pending.
 * The whole stack is read (V8 keeps 10 frames by default, which hid deep
 * callers). The overlay's repaint frame is chrome, not a caret restore: the
 * commit's caret publishes presence, and remote carets reposition (R11).
 */
const postCommitSchedule = () => {
	const pending = new Set<unknown>();
	const v8 = Error as ErrorConstructor & { stackTraceLimit: number };
	const owned = () => {
		const limit = v8.stackTraceLimit;
		v8.stackTraceLimit = Infinity;
		const stack = new Error().stack ?? '';
		v8.stackTraceLimit = limit;
		return (
			/stabilizeCompositionSelection/.test(stack) &&
			// The overlay's frame and the presence writer's throttle (a named timer
			// publishing the new caret) are not a restore: on a slow runner the
			// commit's write falls within the throttle window and arms it.
			!/Overlay\.invalidate|surface\/overlay\.ts|collaboration\/awarenessSelection\.ts/.test(stack)
		);
	};
	const setTimeoutOriginal = window.setTimeout;
	const clearTimeoutOriginal = window.clearTimeout;
	const rafOriginal = window.requestAnimationFrame;
	const cafOriginal = window.cancelAnimationFrame;
	window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
		let id: unknown;
		const run = (...runArgs: unknown[]) => {
			pending.delete(id);
			if (typeof handler === 'function') handler(...runArgs);
		};
		id = setTimeoutOriginal(run as TimerHandler, timeout, ...args);
		if (owned()) pending.add(id);
		return id;
	}) as typeof window.setTimeout;
	window.clearTimeout = ((id?: number) => {
		pending.delete(id);
		return clearTimeoutOriginal(id);
	}) as typeof window.clearTimeout;
	window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		const key = {};
		const id = rafOriginal((time) => {
			pending.delete(key);
			callback(time);
		});
		if (owned()) pending.add(key);
		return id;
	}) as typeof window.requestAnimationFrame;
	return {
		pending: () => pending.size,
		restore: () => {
			window.setTimeout = setTimeoutOriginal;
			window.clearTimeout = clearTimeoutOriginal;
			window.requestAnimationFrame = rafOriginal;
			window.cancelAnimationFrame = cafOriginal;
		}
	};
};

describe('F-S10 — the IME post-commit jump (named rule)', () => {
	pin(
		'a move right after the commit, with no gesture, is reverted to the commit caret',
		async () => {
			const { edytor, text } = await commitComposition();
			moveWithoutGesture(text.node!, 0);
			await flushDomUpdates();
			await new Promise((resolve) => setTimeout(resolve, 60));
			await flushDomUpdates();
			expect(range(edytor)).toMatchObject({ start: 3, isCollapsed: true });
			expect(domCaret(text.node!)).toBe(3);
		}
	);

	pin('after the rule window, a move with no gesture is a foreign write, adopted', async () => {
		const { edytor, text } = await commitComposition();
		await new Promise((resolve) => setTimeout(resolve, 300));
		moveWithoutGesture(text.node!, 1);
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 1, isCollapsed: true });
	});

	pin('a gesture after the commit owns the caret: the move is adopted', async () => {
		const { edytor, text } = await commitComposition();
		edytor.markUserGesture();
		moveWithoutGesture(text.node!, 1);
		await flushDomUpdates();
		await new Promise((resolve) => setTimeout(resolve, 60));
		await flushDomUpdates();
		expect(range(edytor)).toMatchObject({ start: 1, isCollapsed: true });
	});

	row(
		'F-O1: the commit schedules no restore timer or frame (the rule compares timestamps)',
		async () => {
			const schedule = postCommitSchedule();
			try {
				await commitComposition();
				expect(schedule.pending()).toBe(0);
			} finally {
				schedule.restore();
			}
		}
	);
});
