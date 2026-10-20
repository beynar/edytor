/**
 * A block's content as its parts: the text segments between inline atoms
 * and the atoms, alternating, starting and ending with a segment (an empty
 * content is one empty `start` segment), each at its display offsets (an
 * atom counts 1). One pure function of the index's runs, memoized per runs
 * array: the cells render it, the handles and the projection read it.
 */
import type { ContentRun } from './text/runs.js';

export const START = 'start';

type TextRun = Extract<ContentRun, { kind: 'text' }>;

/** The text between two inline atoms (or a content edge), keyed causally. */
export type Segment = {
	readonly kind: 'text';
	/** The id of the atom before this segment, or {@link START}. */
	readonly key: string;
	readonly text: string;
	readonly runs: readonly TextRun[];
	/** Its position among the block's segments. */
	readonly segOrd: number;
	readonly start: number;
	readonly end: number;
};

export type AtomPart = {
	readonly kind: 'inline';
	readonly key: string;
	readonly id: string;
	readonly type: string;
	readonly data: Readonly<Record<string, unknown>> | undefined;
	readonly start: number;
	readonly end: number;
};

export type Part = Segment | AtomPart;

const memo = new WeakMap<readonly ContentRun[], readonly Part[]>();

export const partsOf = (runs: readonly ContentRun[]): readonly Part[] => {
	const hit = memo.get(runs);
	if (hit) return hit;
	const parts: Part[] = [];
	let [key, segment, start, at, segOrd] = [START, [] as TextRun[], 0, 0, 0];
	const close = () =>
		parts.push(
			Object.freeze({
				kind: 'text' as const,
				key,
				text: segment.map((run) => run.text).join(''),
				runs: Object.freeze(segment),
				segOrd: segOrd++,
				start,
				end: at
			})
		);
	for (const run of runs) {
		if (run.kind === 'text') {
			segment.push(run);
			at += run.text.length;
			continue;
		}
		close();
		parts.push(
			Object.freeze({
				kind: 'inline' as const,
				key: run.id,
				id: run.id,
				type: run.type,
				data: run.data,
				start: at,
				end: ++at
			})
		);
		[key, segment, start] = [run.id, [], at];
	}
	close();
	memo.set(runs, Object.freeze(parts));
	return parts;
};

/** The text segment showing `offset`: the first ending at or after it (a seam belongs to the left text), else the last. */
export const segmentAt = <P extends { kind: string; end: number }>(
	parts: readonly P[],
	offset: number
) => {
	const texts = parts.filter((part): part is Extract<P, { kind: 'text' }> => part.kind === 'text');
	return texts.find((part) => offset <= part.end) ?? texts.at(-1)!;
};
