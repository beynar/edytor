import type { Text } from './text.svelte.js';

const ZERO_WIDTH_SPACE = '\u200B';
const PLACEHOLDER_SELECTOR = '[data-edytor-text-placeholder]';
const TEXT_SELECTOR = '[data-edytor-text="true"]';

const hasVisibleTextElementContent = (element: Element) =>
	Boolean(element.textContent?.replaceAll(ZERO_WIDTH_SPACE, '').length);

/**
 * Scan `root`'s subtree for stale text placeholders and remove them:
 * every placeholder under a parent that already contains a visible text
 * element, plus all but the last placeholder under parents that don't
 * (duplicate placeholders transiently co-exist across Svelte remounts —
 * only the newest is kept). A legitimate placeholder — the only one under
 * a parent whose texts are all empty — is never removed.
 *
 * Returns the number of removed placeholders.
 */
export const removeStalePlaceholdersIn = (root: ParentNode | null | undefined): number => {
	if (!root) {
		return 0;
	}

	const placeholdersByParent = new Map<HTMLElement, HTMLElement[]>();
	const placeholders = Array.from(root.querySelectorAll<HTMLElement>(PLACEHOLDER_SELECTOR));

	for (const placeholder of placeholders) {
		const parent = placeholder.parentElement;
		if (!parent) {
			continue;
		}

		const parentPlaceholders = placeholdersByParent.get(parent);
		if (parentPlaceholders) {
			parentPlaceholders.push(placeholder);
		} else {
			placeholdersByParent.set(parent, [placeholder]);
		}
	}

	let removed = 0;
	for (const [parent, parentPlaceholders] of placeholdersByParent) {
		// Direct children only — `heading`/`quote` blocks render nested
		// children inside the same element as their own content, so a
		// descendant query would read a child's text as the parent's own.
		const hasText = Array.from(parent.children).some(
			(child): child is HTMLElement =>
				child instanceof HTMLElement &&
				child.matches(TEXT_SELECTOR) &&
				hasVisibleTextElementContent(child)
		);

		if (hasText) {
			parentPlaceholders.forEach((placeholder) => {
				placeholder.remove();
				removed++;
			});
			continue;
		}

		parentPlaceholders.slice(0, -1).forEach((placeholder) => {
			placeholder.remove();
			removed++;
		});
	}
	return removed;
};

/** A lazily-resolved repair root — re-evaluated at every pass. */
type PlaceholderRootResolver = () => ParentNode | null | undefined;

/** Bounded-scheduling counters — read by tests to prove coalescing. */
export type PlaceholderRepairStats = {
	/** Repair windows opened (one per burst of `add`/`addKeyed` calls). */
	windows: number;
	/** Scan passes that ran with a non-empty pending set — a scheduled
	 *  phase with nothing queued exits without touching the DOM. */
	passes: number;
	/** Individual roots scanned across all passes. */
	rootsScanned: number;
	/** Placeholder elements removed across all passes. */
	removed: number;
};

export type PlaceholderRepairQueue = {
	/**
	 * Queue a DOM root for repair — deduped by element identity. Roots that
	 * disconnect or scan clean are dropped; a root whose placeholders were
	 * actually removed stays pending so the next pass re-verifies it
	 * (Svelte can re-render a placeholder after the model settles).
	 */
	add(root: ParentNode | null | undefined): void;
	/**
	 * Queue a lazily-resolved root keyed by `key` — repeated adds of the
	 * same key coalesce into one pending entry. The resolver runs at every
	 * pass, so repair follows keyed remounts (`{#key}` swaps the node under
	 * the same wrapper) and late mounts instead of scanning a detached
	 * node.
	 */
	addKeyed(key: unknown, resolve: PlaceholderRootResolver): void;
	/** Cancel every pending pass and drop all queued roots — after this the queue is dead. */
	release(): void;
	readonly stats: PlaceholderRepairStats;
	/** Pending root entries — diagnostic. */
	readonly size: number;
};

/**
 * Deferred retry delays for a repair window. The placeholder-vs-empty-text
 * race these cover is real: `Text.svelte` renders
 * `[data-edytor-text-placeholder]` from `$derived` state and the browser
 * can land DOM text (native input, IME commit) before the model/Svelte
 * update that would retract it — the retried passes keep catching that
 * ordering gap after the synchronous one has run.
 */
const DEFERRED_REPAIR_MS = [50, 250, 1000] as const;

/** Prompt (microtask) passes granted to newly-queued roots per window. */
const PROMPT_PASSES_PER_WINDOW = 6;

/**
 * One coalesced stale-placeholder repair queue — a single instance lives
 * per editor view. `add`/`addKeyed` calls within a flush window share one
 * scheduled phase chain (immediate → microtask → rAF → deferred retries);
 * a burst of N commits schedules ONE repair round instead of N
 * overlapping ones. `release()` (view `destroy()`) cancels everything —
 * no pass may act on a dead view.
 */
export const createPlaceholderRepairQueue = (): PlaceholderRepairQueue => {
	// `roots` dedupes element roots by identity; `keyedRoots` dedupes lazy
	// resolvers by their caller-chosen key (block id, text wrapper, …).
	const roots = new Set<ParentNode>();
	const keyedRoots = new Map<unknown, PlaceholderRootResolver>();
	let windowOpen = false;
	let released = false;
	let rafId: number | null = null;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	// Prompt-pass budget: a newly-queued root gets swept within a microtask
	// instead of waiting up to ~1s for the next deferred phase, but the
	// budget caps how often sustained bursts can turn arrivals into passes —
	// once spent, new entries ride the normal phase chain.
	let promptPassesLeft = PROMPT_PASSES_PER_WINDOW;
	let promptScheduled = false;
	const stats: PlaceholderRepairStats = { windows: 0, passes: 0, rootsScanned: 0, removed: 0 };

	const isLiveRoot = (root: ParentNode | null | undefined): root is ParentNode =>
		Boolean(root) && (root as Node).isConnected !== false;

	const scanRoot = (root: ParentNode): boolean => {
		stats.rootsScanned++;
		const removed = removeStalePlaceholdersIn(root);
		stats.removed += removed;
		return removed > 0;
	};

	const runPass = () => {
		if (released || (roots.size === 0 && keyedRoots.size === 0)) {
			return;
		}
		stats.passes++;
		for (const root of roots) {
			// Drop roots that are detached or already clean — they are
			// repaired as far as this window is concerned. A root a pass
			// actually changed stays queued for re-verification.
			if (!isLiveRoot(root) || !scanRoot(root)) {
				roots.delete(root);
			}
		}
		for (const [key, resolve] of keyedRoots) {
			let root: ParentNode | null | undefined;
			try {
				root = resolve();
			} catch {
				// A throwing resolver must not abort the pass (later roots
				// would be skipped) or re-throw on every future pass —
				// drop the poisoned entry.
				keyedRoots.delete(key);
				continue;
			}
			if (!isLiveRoot(root) || !scanRoot(root)) {
				keyedRoots.delete(key);
			}
		}
	};

	const closeWindow = () => {
		roots.clear();
		keyedRoots.clear();
		promptPassesLeft = PROMPT_PASSES_PER_WINDOW;
		promptScheduled = false;
		windowOpen = false;
	};

	/**
	 * A root/key that was not already pending arrives mid-window: schedule
	 * one extra microtask pass (deduped across simultaneous arrivals, capped
	 * per window) so the new arrival is swept promptly. Once the budget is
	 * spent, arrivals ride the scheduled phases — a sustained burst of
	 * distinct roots cannot turn the prompt path back into per-add scans.
	 */
	const schedulePromptPass = (isNew: boolean) => {
		if (!isNew || promptScheduled || promptPassesLeft === 0) {
			return;
		}
		promptPassesLeft--;
		promptScheduled = true;
		queueMicrotask(() => {
			promptScheduled = false;
			runPass();
		});
	};

	const schedule = () => {
		windowOpen = true;
		stats.windows++;
		// Immediate pass — callers schedule after the model commit, often
		// post-`tick()`, so the DOM already shows the settled render.
		runPass();
		queueMicrotask(() => {
			if (!released) {
				runPass();
			}
		});
		if (typeof requestAnimationFrame === 'function') {
			rafId = requestAnimationFrame(() => {
				rafId = null;
				runPass();
			});
		}
		DEFERRED_REPAIR_MS.forEach((delay, index) => {
			const timer = setTimeout(() => {
				timers.delete(timer);
				runPass();
				if (index === DEFERRED_REPAIR_MS.length - 1) {
					closeWindow();
				}
			}, delay);
			timers.add(timer);
		});
	};

	return {
		add(root) {
			if (released || !root) {
				return;
			}
			const isNew = !roots.has(root);
			roots.add(root);
			if (!windowOpen) {
				schedule();
			} else {
				schedulePromptPass(isNew);
			}
		},
		addKeyed(key, resolve) {
			if (released) {
				return;
			}
			const isNew = !keyedRoots.has(key);
			keyedRoots.set(key, resolve);
			if (!windowOpen) {
				schedule();
			} else {
				schedulePromptPass(isNew);
			}
		},
		release() {
			released = true;
			roots.clear();
			keyedRoots.clear();
			promptPassesLeft = 0;
			if (rafId !== null && typeof cancelAnimationFrame === 'function') {
				cancelAnimationFrame(rafId);
			}
			rafId = null;
			for (const timer of timers) {
				clearTimeout(timer);
			}
			timers.clear();
			windowOpen = false;
		},
		stats,
		get size() {
			return roots.size + keyedRoots.size;
		}
	};
};

/**
 * Schedule placeholder repair for a text — the scan stays scoped to the
 * text's parent element (resolved lazily so remounts retarget the live
 * node) and rides the editor's coalesced repair window.
 */
export const scheduleRemoveStalePlaceholders = (text: Text) => {
	text.edytor.placeholderRepair.addKeyed(text, () => text.node?.parentElement ?? undefined);
};
