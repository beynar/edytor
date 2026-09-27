/**
 * arch-v2 R6 — the compare-to-truth observer in shadow (plan §9.3 R6, §9.1
 * rule 3): its verdicts compared with what today's observer does.
 *
 * The surface observer (`src/lib/surface/observer.svelte.ts`) logs one
 * `pass` entry per compare pass (its findings, the contents it found equal,
 * the contents the pre pass found already adopted) and today's observer logs
 * one `observer` entry per action (`adopt`: a command ran; `invert`: a
 * remount, a removal, a restore, a heal). Per content, a divergence
 * **episode** opens at the first pass that finds it and closes at the first
 * pass that finds the content equal again (or at the end). The shadow's
 * verdict is the episode's first; today's observer's is what it did during
 * the episode. They agree when:
 * - adopt: the observer adopted (a command ran);
 * - invert: the observer inverted (remount, removal, restore, heal);
 * - ime, readonly: the observer did nothing.
 * An observer action outside any episode agrees only when the next pre pass
 * found that content already adopted (the DOM ahead of the render, equal to
 * its cell: the `input` handler adopted before the flush).
 *
 * Every difference is classed below with the §8 row it answers to; a
 * difference no class explains is unexplained (a shadow bug, or a missing
 * row). Environment-free: used by the dom lane and, Node-side, by the
 * browser lanes on the page's raw log.
 */

export type Finding = { block: string | null; verdict: string; why: string; place?: unknown };
export type ShadowEntry =
	| {
			view: string;
			src: 'pass';
			findings: Finding[];
			equal: (string | null)[];
			ahead: string[];
	  }
	| {
			view: string;
			src: 'observer';
			block: string | null;
			action: 'adopt' | 'invert';
			why: string;
			/** A composition session was live when it acted. */
			live?: boolean;
	  };

type Action = { action: 'adopt' | 'invert'; why: string };
type Episode = { verdict: string; why: string; actions: Action[] };
export type Difference = { key: string; shadow: string; observer: string; block: string };

/**
 * The classes of difference (name → predicate, §8 row), found by the census.
 * Each states why the two disagree; every one is today's observer acting on
 * a content (or the root) that equals what its cells render.
 */
export const CLASSES: { name: string; row: string; test: (d: Difference) => boolean }[] = [
	{
		// Today's liveness inference reads the renderer's own records (a mark
		// element added, a text node replaced) as damage and remounts the
		// content; the input pipeline's forced refresh remounts an equal content.
		name: 'own-render-remounted',
		row: 'F-O10 (R7): nothing the renderer wrote is adopted or inverted',
		test: (d) => d.shadow === 'equal' && /^(invert:remount\+?)+$/.test(d.observer)
	},
	{
		// Keyed moves of block elements read as removals of live managed nodes: re-inserted.
		name: 'own-render-restored',
		row: 'F-O10 (R7): nothing the renderer wrote is adopted or inverted',
		test: (d) => d.shadow === 'equal' && /^invert:restore(\+invert:remount)?$/.test(d.observer)
	},
	{
		// Nodes inside a kind's own markup around the slots (a callout's icon the
		// snippet renders, a foreign node beside the text element): tolerant.
		name: 'extension-markup-removed',
		row: 'D-25 / §6 D59 (R11): extension markup around the slots is tolerant (F-O13 (c))',
		test: (d) => d.shadow === 'equal' && d.observer === 'invert:remove'
	},
	{
		// A browser edit and a same-task model change that re-renders the
		// content: the flush overwrites the edit; today nothing adopts it (it is
		// lost), the pre pass snapshotted it and places it through its anchor.
		name: 'edit-lost-to-same-task-render',
		row: 'F-O13 (b), (e) (R7): the edit is adopted once, where it was typed',
		test: (d) =>
			d.shadow === 'adopt:snapshot' &&
			(d.observer === 'none' || /^(invert:remount\+?)+$/.test(d.observer))
	},
	{
		// Drift an expectation claims (a model-owned attempt, the composition
		// tail) on a content the flush re-renders: the render restores the
		// current cell; today's observer has nothing left to do.
		name: 'claimed-drift-restored-by-render',
		row: 'F-O13 (d): the DOM ends at the cell’s current text, never at the text last rendered',
		test: (d) => /^invert:(drift|tail)$/.test(d.shadow) && d.observer === 'none'
	},
	{
		// A foreign element with text inside a text element: the location
		// default adopts its text and removes the element; today removes both.
		name: 'foreign-text-in-strict-container',
		row: '§12.5 BI2-2 (R7): text inside a content is adopted, unregistered children of strict containers removed',
		test: (d) => d.shadow === 'adopt:location' && /invert:remove/.test(d.observer)
	}
];

const ROOT = '<root>';

export const createObserverCensus = () => {
	const open = new Map<string, Episode>();
	const orphans = new Map<string, Action[]>();
	let steps = 0;
	let compared = 0;
	let episodes = 0;
	let agreed = 0;
	const differences: Difference[] = [];

	const judge = (key: string, episode: Episode, end: boolean) => {
		episodes++;
		const kinds = new Set(episode.actions.map((a) => a.action));
		const did = episode.actions.map((a) => `${a.action}:${a.why}`);
		const observer = did.length ? [...new Set(did)].join('+') : 'none';
		const ok =
			episode.verdict === 'adopt'
				? kinds.has('adopt')
				: episode.verdict === 'invert'
					? kinds.has('invert')
					: kinds.size === 0 || (end && episode.verdict === 'ime');
		if (ok && !(end && episode.verdict !== 'ime')) return void agreed++;
		const block = key.slice(key.indexOf('|') + 1);
		differences.push({
			key: `${end ? 'unresolved:' : ''}${episode.verdict}:${episode.why}/${observer}`,
			shadow: `${episode.verdict}:${episode.why}`,
			observer,
			block
		});
	};

	const orphaned = (key: string, actions: Action[]) => {
		const block = key.slice(key.indexOf('|') + 1);
		const observer = [...new Set(actions.map((a) => `${a.action}:${a.why}`))].join('+');
		differences.push({ key: `equal/${observer}`, shadow: 'equal', observer, block });
	};

	const push = (entry: ShadowEntry) => {
		if (entry.src === 'observer') {
			const key = `${entry.view}|${entry.block ?? ROOT}`;
			const action = { action: entry.action, why: entry.why };
			const episode = open.get(key);
			// The IME host's hand-back: after the session ended, restoring the host is the catch-up.
			if (episode?.verdict === 'ime' && !entry.live && entry.action === 'invert') return;
			if (episode) episode.actions.push(action);
			else orphans.set(key, [...(orphans.get(key) ?? []), action]);
			return;
		}
		steps++;
		const { view } = entry;
		for (const id of entry.ahead ?? []) {
			const key = `${view}|${id}`;
			const actions = orphans.get(key);
			if (!actions) continue;
			orphans.delete(key);
			episodes++;
			if (actions.every((a) => a.action === 'adopt')) agreed++;
			else orphaned(key, actions);
		}
		for (const finding of entry.findings) {
			compared++;
			const key = `${view}|${finding.block ?? ROOT}`;
			if (finding.verdict === 'equal') continue;
			if (!open.has(key)) {
				open.set(key, { verdict: finding.verdict, why: finding.why, actions: [] });
				const early = orphans.get(key);
				if (early) {
					open.get(key)!.actions.push(...early);
					orphans.delete(key);
				}
			}
		}
		for (const id of entry.equal) {
			compared++;
			const key = `${view}|${id ?? ROOT}`;
			const episode = open.get(key);
			if (episode) {
				open.delete(key);
				judge(key, episode, false);
			}
			const actions = orphans.get(key);
			if (actions) {
				orphans.delete(key);
				orphaned(key, actions);
			}
		}
	};

	/** Close every open episode (a test end, a page end). */
	const end = () => {
		for (const [key, episode] of open) judge(key, episode, true);
		open.clear();
		for (const [key, actions] of orphans) orphaned(key, actions);
		orphans.clear();
	};

	const classify = (d: Difference) => CLASSES.find((c) => c.test(d))?.name ?? null;

	return {
		push,
		end,
		get differences() {
			return differences;
		},
		summary: () => {
			const byClass: Record<string, { row: string; differences: number }> = {};
			const unexplained: Difference[] = [];
			for (const d of differences) {
				const name = classify(d);
				if (!name) {
					unexplained.push(d);
					continue;
				}
				const row = CLASSES.find((c) => c.name === name)!.row;
				(byClass[name] ??= { row, differences: 0 }).differences++;
			}
			return {
				steps,
				compared,
				episodes,
				agreed,
				differing: differences.length,
				byClass,
				unexplained
			};
		}
	};
};

export type ObserverCensus = ReturnType<typeof createObserverCensus>;
export type CensusSummary = ReturnType<ObserverCensus['summary']>;

/** Sum summaries (one per test, page or file). */
export const mergeSummaries = (summaries: CensusSummary[]) => {
	const out = {
		steps: 0,
		compared: 0,
		episodes: 0,
		agreed: 0,
		differing: 0,
		byClass: {} as Record<string, { row: string; differences: number }>,
		unexplained: [] as Difference[]
	};
	for (const s of summaries) {
		out.steps += s.steps;
		out.compared += s.compared;
		out.episodes += s.episodes;
		out.agreed += s.agreed;
		out.differing += s.differing;
		for (const [name, c] of Object.entries(s.byClass))
			(out.byClass[name] ??= { row: c.row, differences: 0 }).differences += c.differences;
		out.unexplained.push(...s.unexplained);
	}
	return out;
};
