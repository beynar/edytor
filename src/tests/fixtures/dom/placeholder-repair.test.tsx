/** @jsxImportSource ../../jsx */
/**
 * U6 placeholder-repair probes — the coalesced `PlaceholderRepairQueue`
 * (one per Edytor view), scoped commit-driven repair, and the anchor
 * preservation contract that justified deleting `Block.attach`'s inert
 * empty-text-node observer.
 *
 * These run in jsdom (`vitest --config vitest.dom.config.ts`) — real DOM,
 * real Svelte mount — where the queue's phase timing can be driven
 * deterministically.
 */
import { describe, expect, test } from 'vitest';
import { tick } from 'svelte';
import {
	createPlaceholderRepairQueue,
	removeStalePlaceholdersIn
} from '$lib/text/removeStalePlaceholders.js';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	dispatchDomBeforeInput
} from '../../dom/test.utils.js';

const PLACEHOLDER = 'data-edytor-text-placeholder';
const TEXT = 'data-edytor-text';

const makeParentWithText = (visibleText: string) => {
	const parent = document.createElement('div');
	const text = document.createElement('span');
	text.setAttribute(TEXT, 'true');
	text.textContent = visibleText;
	parent.append(text);
	document.body.append(parent);
	return parent;
};

const addPlaceholder = (parent: HTMLElement) => {
	const placeholder = document.createElement('span');
	placeholder.setAttribute(PLACEHOLDER, '');
	placeholder.textContent = 'placeholder';
	parent.append(placeholder);
	return placeholder;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('removeStalePlaceholdersIn — scoped scan semantics', () => {
	test('removes placeholders only under parents with visible text and drops duplicates', () => {
		const parent = makeParentWithText('visible');
		const stale = addPlaceholder(parent);
		expect(removeStalePlaceholdersIn(parent)).toBe(1);
		expect(stale.isConnected).toBe(false);

		// Empty parent: the LAST placeholder is kept, earlier dups dropped.
		const emptyParent = makeParentWithText('');
		const dupA = addPlaceholder(emptyParent);
		const dupB = addPlaceholder(emptyParent);
		expect(removeStalePlaceholdersIn(emptyParent)).toBe(1);
		expect(dupA.isConnected).toBe(false);
		expect(dupB.isConnected).toBe(true);

		// Zero-width-space-only text still counts as empty.
		const zwspParent = makeParentWithText('\u200B');
		const kept = addPlaceholder(zwspParent);
		expect(removeStalePlaceholdersIn(zwspParent)).toBe(0);
		expect(kept.isConnected).toBe(true);
	});
});

describe('createPlaceholderRepairQueue', () => {
	test('coalesces a burst of adds into one window with a bounded phase count', async () => {
		const queue = createPlaceholderRepairQueue();
		const parent = makeParentWithText('x');
		addPlaceholder(parent);

		for (let i = 0; i < 50; i++) {
			queue.add(parent);
		}
		// The immediate pass already removed the stale placeholder.
		expect(queue.stats.windows).toBe(1);
		expect(parent.querySelector(`[${PLACEHOLDER}]`)).toBeNull();

		await sleep(1100);
		// 6 scheduled phases per window maximum (immediate + microtask +
		// rAF + 50/250/1000 deferred) — never 7-per-add. rAF is absent in
		// jsdom so the real count is lower.
		expect(queue.stats.passes).toBeLessThanOrEqual(6);
		expect(queue.stats.rootsScanned).toBeLessThanOrEqual(6);
		expect(queue.size).toBe(0);
		queue.release();
	});

	test('roots that scanned clean are dropped from the pending set', async () => {
		const queue = createPlaceholderRepairQueue();
		const parent = makeParentWithText('x');
		queue.add(parent); // immediate pass scans once — nothing to remove
		expect(queue.size).toBe(0); // clean → dropped synchronously
		const passesAfterFirst = queue.stats.passes;
		await sleep(1100);
		expect(queue.stats.passes).toBe(passesAfterFirst); // later passes no-op
		queue.release();
	});

	test('a root a pass actually changed stays queued for re-verification', async () => {
		const queue = createPlaceholderRepairQueue();
		const parent = makeParentWithText('x');
		addPlaceholder(parent);
		queue.add(parent);
		expect(queue.stats.removed).toBe(1);
		// Kept pending until it scans clean on a later pass.
		expect(queue.size).toBe(1);
		await sleep(1100);
		expect(queue.size).toBe(0);
		queue.release();
	});

	test('keyed resolvers dedupe by key and retarget across remounts', async () => {
		const queue = createPlaceholderRepairQueue();
		let node: HTMLElement | null = makeParentWithText('x');
		const stale = addPlaceholder(node);
		for (let i = 0; i < 10; i++) {
			queue.addKeyed('block:b1', () => node);
		}
		expect(queue.size).toBe(1); // 10 adds → 1 pending entry
		expect(stale.isConnected).toBe(false);

		// Remount: the old node detaches, the resolver now yields the new
		// one — repair follows instead of scanning the dead subtree. The
		// first window is still open (its pass removed a node → the key
		// stays queued), so this add only retargets the resolver and the
		// already-scheduled next pass does the sweep.
		node.remove();
		node = makeParentWithText('x');
		const remountedStale = addPlaceholder(node);
		queue.addKeyed('block:b1', () => node);
		await tick();
		expect(remountedStale.isConnected).toBe(false);
		await sleep(1100);
		expect(queue.size).toBe(0);
		queue.release();
	});

	test('a throwing keyed resolver is dropped and does not poison other entries', async () => {
		const queue = createPlaceholderRepairQueue();
		const parent = makeParentWithText('x');
		const stale = addPlaceholder(parent);

		queue.addKeyed('poison', () => {
			throw new Error('resolver blew up');
		});
		queue.add(parent);

		// The immediate pass ran the keyed entry: the throwing resolver
		// was dropped. `parent` arrived mid-window → prompt microtask
		// pass sweeps it — the poison must not have aborted the pass.
		await tick();
		expect(stale.isConnected).toBe(false);

		// Later passes do not re-throw — the poisoned entry is gone and
		// the changed root drains after re-verification.
		await sleep(1100);
		expect(queue.size).toBe(0);
		queue.release();
	});

	test('release() cancels every pending phase — nothing runs afterwards', async () => {
		const queue = createPlaceholderRepairQueue();
		const parent = makeParentWithText('x');
		addPlaceholder(parent);
		queue.add(parent);
		const passesAtRelease = queue.stats.passes;
		queue.release();
		expect(queue.size).toBe(0);
		queue.add(parent); // dead queue — no-op
		expect(queue.size).toBe(0);
		await sleep(1100);
		expect(queue.stats.passes).toBe(passesAtRelease);
	});
});

describe('mounted editor — placeholder repair', () => {
	test('a commit queues the touched block root and a stale placeholder there is gone', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>World</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		const text = block.firstText;
		const scansBefore = edytor.placeholderRepair.stats.rootsScanned;

		const applied = edytor.transact(() => text.insertAt(text.length, '!'));
		expect(applied).toBe(true);
		await tick(); // facade handler's tick().then → addKeyed(block root)
		await flushDomUpdates();
		// The commit's keyed roots land inside the already-open repair
		// window — the immediate/microtask passes may have run before the
		// add, so let the first deferred retry (50ms) sweep them.
		await sleep(60);

		// The commit scheduled scoped repair on the touched block — its
		// resolver ran at least once.
		expect(edytor.placeholderRepair.stats.rootsScanned).toBeGreaterThan(scansBefore);
		expect(editor.isConnected).toBe(true);

		// Stale placeholder injected into the touched block's content parent
		// is swept by the queued repair (or the mutation observer's own
		// repair pass — either way it must not survive).
		const stale = addPlaceholder(text.node!.parentElement!);
		edytor.placeholderRepair.add(block.node);
		await flushDomUpdates();
		expect(stale.isConnected).toBe(false);
	});

	test('a 60-commit burst in one paragraph opens ≤2 repair windows and stays idle-drained', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>a|</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText;

		for (let i = 0; i < 60; i++) {
			edytor.transact(() => {
				text.insertAt(text.length, 'x');
			});
		}
		await flushDomUpdates();

		const stats = edytor.placeholderRepair.stats;
		// Old code: 60 commits × 8 full-editor passes = ~480 scans. Coalesced:
		// one window for the whole synchronous burst, ≤6 phases inside it,
		// each scanning only the touched block root.
		expect(stats.windows).toBeLessThanOrEqual(2);
		expect(stats.passes).toBeLessThanOrEqual(12);
		expect(stats.rootsScanned).toBeLessThanOrEqual(12);

		// After the longest deferred retry, nothing stays pending.
		await sleep(1100);
		expect(edytor.placeholderRepair.size).toBe(0);
		expect(text.stringContent).toBe(`a${'x'.repeat(60)}`);
	});

	test('placeholder lifecycle: empty → type → gone, delete-all → back', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph></paragraph>
				<paragraph>note</paragraph>
			</root>,
			{ placeholder: 'Write something here ...' }
		);
		const placeholders = () =>
			Array.from(editor.querySelectorAll(`[${PLACEHOLDER}]`)).filter(
				(el) => (el as HTMLElement).offsetParent !== null || el.isConnected
			);

		expect(editor.querySelectorAll(`[${PLACEHOLDER}]`)).toHaveLength(1);
		const text = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, text, 0);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'A' });
		await flushDomUpdates();
		expect(editor.querySelectorAll(`[${PLACEHOLDER}]`)).toHaveLength(0);
		expect(placeholders()).toHaveLength(0);

		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await flushDomUpdates();
		expect(editor.querySelectorAll(`[${PLACEHOLDER}]`)).toHaveLength(1);
	});

	test('empty text-node anchors inside a block survive renders and sweeps', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>
		);
		const blockNode = edytor.root!.children[0]!.node!;
		// Svelte uses empty text nodes as {#if}/{#each} fragment anchors —
		// the removed Block.attach observer never matched its own acceptNode
		// predicate (node.parentElement === node can never be true), and
		// domTextMutationObserver explicitly preserves empty text nodes.
		// Pin: injected empty text nodes still survive.
		const anchor = document.createTextNode('');
		blockNode.append(anchor);
		const text = edytor.root!.children[0]!.firstText;
		edytor.transact(() => {
			text.insertAt(text.length, '!');
		});
		await flushDomUpdates();
		await sleep(1100); // outlast every deferred repair phase
		expect(anchor.isConnected).toBe(true);
		expect(editor.contains(anchor)).toBe(true);
	});

	test('release on unmount: no repair pass runs after the view is destroyed', async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>
		);
		const queue = rendered.edytor.placeholderRepair;
		queue.add(rendered.edytor.node);
		rendered.unmount(); // EdytorHarness cleanup → edytor.destroy() → release()
		const passes = queue.stats.passes;
		await sleep(1100);
		expect(queue.stats.passes).toBe(passes);
		expect(queue.size).toBe(0);
	});
});
