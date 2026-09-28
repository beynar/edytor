import type {
	JSONBlock,
	JSONDoc,
	JSONInlineBlock,
	JSONText,
	SerializableContent
} from '../../src/lib/utils/json.js';
import { alpha, bool, int, mulberry32, pick, type Rng } from '../../src/tests/crdt/harness/rng.js';

export const DST_SCHEMA_VERSION = 5;

export type DstSelectionMode = 'collapsed' | 'within-text' | 'cross-text';

export type DstTextSelectionSelector = {
	kind: 'text';
	mode: DstSelectionMode;
	startText: number;
	startOffset: number;
	endText: number;
	endOffset: number;
	reversed: boolean;
};

export type DstSelectionSelector =
	| DstTextSelectionSelector
	| { kind: 'preserve' }
	| { kind: 'node'; target: 'inline-or-block'; index: number; reversed: boolean }
	| { kind: 'block'; index: number; reversed: boolean }
	| { kind: 'root'; startBlock: number; endBlock: number; reversed: boolean }
	| { kind: 'document'; reversed: boolean };

/**
 * Navigation keys issued through the trusted keyboard path. The `Alt+Arrow*`
 * spellings record the *semantic* word-jump intent: the runner presses them
 * verbatim on darwin (Option+Arrow = word jump) and maps `Alt` to `Control`
 * on other platforms, where Alt+Arrow navigates browser history instead of
 * moving the caret.
 */
export type DstMoveKey =
	| 'ArrowLeft'
	| 'ArrowRight'
	| 'ArrowUp'
	| 'ArrowDown'
	| 'Home'
	| 'End'
	| 'Alt+ArrowLeft'
	| 'Alt+ArrowRight';

export type DstPointerTargetKind = 'inline' | 'blockText' | 'padding';
export type DstPointerEdge = 'left' | 'center' | 'right';

/**
 * Managed DOM surfaces a foreign mutation can target. `text`/`mark`/
 * `inlineBlock`/`root` index into the matching live DOM collection
 * (`[data-edytor-text="true"]`, `[data-edytor-mark]`,
 * `[data-edytor-inline-block]`, the `[data-edytor]` root); `block` indexes
 * `[data-edytor-block="true"]`. Indexes carry entropy and resolve
 * mod-count at action time, exactly like text selectors.
 */
export type DstForeignMutationTarget = 'text' | 'mark' | 'block' | 'inlineBlock' | 'root';

/**
 * Schema v4: deterministic foreign DOM damage. The payloads model
 * Grammarly-class extensions, spellcheck overlays, translate/GBoard
 * wrappers, and hostile scripts writing into managed DOM:
 *
 * - `foreignAttribute` writes a foreign marker attribute on a managed
 *   element (strict surfaces must strip it, tolerant surfaces may keep
 *   it — either way the residual is accounted in `dom.foreignResidual`
 *   and compared across engines).
 * - `managedAttribute` removes an editor-owned attribute (`attribute`
 *   indexes the runner's per-target owned-attribute table).
 * - `typeOver` rewrites the first text node inside a managed text
 *   element: `data: null` is an identical-value write (mobile type-over —
 *   `characterDataOldValue` must distinguish it from a real change);
 *   non-null `data` appends foreign text that reconciliation may adopt.
 * - `removeElement` deletes a managed element; the observer must restore
 *   it from the model without changing the document.
 * - `insertForeignElement` injects a tagged `<span>`: inside a text
 *   element its text may be adopted; at block/root level it must be
 *   removed without touching the model.
 */
export type DstForeignMutation =
	| {
			kind: 'foreignAttribute';
			target: DstForeignMutationTarget;
			index: number;
			attribute: number;
	  }
	| {
			kind: 'managedAttribute';
			target: DstForeignMutationTarget;
			index: number;
			attribute: number;
	  }
	| { kind: 'typeOver'; index: number; data: string | null }
	| {
			kind: 'removeElement';
			target: Exclude<DstForeignMutationTarget, 'root'>;
			index: number;
	  }
	| {
			kind: 'insertForeignElement';
			where: 'text' | 'block' | 'root';
			index: number;
			text: string;
	  };

export type DstAction =
	| { kind: 'type'; text: string }
	| { kind: 'insertText'; text: string }
	| { kind: 'backspace' }
	| { kind: 'delete' }
	| { kind: 'enter' }
	| { kind: 'softBreak' }
	| { kind: 'format'; mark: 'bold' | 'italic' | 'underline' | 'code' | 'strike' }
	| { kind: 'move'; key: DstMoveKey; extend: boolean }
	| { kind: 'undo' }
	| { kind: 'redo' }
	// ── schema v3: trusted keyboard ──────────────────────────────────────
	| { kind: 'wordDelete'; direction: 'backward' | 'forward' }
	// ── schema v5: ⌘⌫ backward line delete — a darwin-only native intent
	// (no honest cross-platform chord exists, so it is only generated on
	// darwin and replaying it elsewhere fails 'unsupported-action').
	// `forward` stays in the union for schema stability — only `backward`
	// is generated and no forward chord is defined yet ──────────────────
	| { kind: 'lineDelete'; direction: 'backward' | 'forward' }
	| { kind: 'tab' }
	| { kind: 'shiftTab' }
	// ── schema v3: trusted pointer (element-granularity targets only —
	// pixel-precise text offsets are banned: font metrics differ per engine)
	| {
			kind: 'pointerClick';
			target: DstPointerTargetKind;
			index: number;
			edge: DstPointerEdge;
	  }
	| { kind: 'pointerDrag'; startBlock: number; endBlock: number }
	| { kind: 'pointerDoubleClick'; index: number }
	| {
			kind: 'shiftClick';
			target: DstPointerTargetKind;
			index: number;
			edge: DstPointerEdge;
	  }
	// ── schema v3: synthetic input classes (page.evaluate-dispatched;
	// isTrusted:false — real IME/clipboard automation is not available
	// identically across all three engines)
	| {
			kind: 'composition';
			updates: string[];
			commit: string;
			commitViaBeforeinput: boolean;
	  }
	| { kind: 'paste'; text: string; html: string; fragment?: unknown }
	| { kind: 'cut' }
	| { kind: 'copy' }
	| { kind: 'drop'; index: number; text: string }
	// ── schema v4: foreign DOM damage (scripted writes through
	// page.evaluate — no input events are dispatched; the observer's
	// healing paths are the system under test)
	| { kind: 'foreignMutation'; mutation: DstForeignMutation };

/**
 * Trusted actions are performed through Playwright's real input pipeline
 * (keyboard/mouse — `isTrusted: true`). Synthetic actions are dispatched via
 * `page.evaluate` (`isTrusted: false`): there is no cross-engine trusted
 * automation for IME composition or clipboard payloads, so the identical
 * synthetic payload is sent to all three engines and the oracles assert the
 * dispatch reached the editor rather than faking trust.
 */
export const inputClassOf = (action: DstAction): 'trusted' | 'synthetic' =>
	action.kind === 'composition' ||
	action.kind === 'paste' ||
	action.kind === 'cut' ||
	action.kind === 'copy' ||
	action.kind === 'drop' ||
	action.kind === 'foreignMutation'
		? 'synthetic'
		: 'trusted';

export type DstStep = {
	selection: DstSelectionSelector;
	action: DstAction;
};

export type DstSchedule = {
	schemaVersion: typeof DST_SCHEMA_VERSION;
	seed: number;
	shape: string;
	document: JSONDoc;
	steps: DstStep[];
};

const TEXT_SAMPLES = [
	'',
	'a',
	'alpha',
	'A 🚀 Z',
	'e\u0301lan',
	'שלום',
	'한글',
	'line\nbreak',
	'one  two',
	'🙂🙂'
] as const;

const INSERT_SAMPLES = ['x', 'Z', ' ', '.', '!', 'ab'] as const;

/**
 * Synthetic IME programs. `updates` are the intermediate `compositionupdate`
 * / `beforeinput insertCompositionText` payloads; `commit` is the final
 * `compositionend` (and optional `insertFromComposition`) payload. Covers a
 * dead-key acute accent, a combining-mark sequence, a hangul jamo
 * composition, an emoji commit, a multi-step kana-ish program, and a
 * cancelled composition (empty commit).
 */
const COMPOSITION_SAMPLES: ReadonlyArray<{ updates: string[]; commit: string }> = [
	{ updates: ['e', 'é'], commit: 'é' },
	{ updates: ['e', 'e\u0301'], commit: 'e\u0301' },
	{ updates: ['\u314e', '\ud558', '\ud55c'], commit: '\ud55c' },
	{ updates: ['🙂'], commit: '🙂' },
	{ updates: ['n', 'ni', '\u306b'], commit: '\u306b' },
	{ updates: ['xy'], commit: '' }
];

/**
 * Synthetic clipboard paste payloads. Plain-text and multi-line entries
 * exercise the `insertFromPaste` path; html entries exercise the core HTML
 * import (P4.1, `clipboard/htmlFlow.ts`); the `fragment` entry carries a real
 * `application/x-edytor-fragment` payload (`{version:1, source:'edytor',
 * kind:'content', ...}` encoded as btoa(encodeURIComponent(json)) — see
 * src/lib/clipboard/fragmentData.ts) to cover `insertEdytorClipboardFragment`.
 * The empty payload is an honest probe: the editor must no-op on it.
 */
const PASTE_SAMPLES: ReadonlyArray<{ text: string; html: string; fragment?: unknown }> = [
	{ text: 'pasted text', html: '' },
	{ text: 'multi\nline\npaste', html: '' },
	{ text: 'x', html: '<b>x</b><p>y</p>' },
	{ text: 'frag', html: '<p>frag <i>one</i></p><p>two</p>' },
	{
		text: 'fragmented',
		html: '',
		fragment: {
			version: 1,
			source: 'edytor',
			kind: 'content',
			blockType: 'paragraph',
			content: [{ text: 'frag ' }, { text: 'bold', marks: { bold: true } }]
		}
	},
	{ text: '', html: '' }
];

const DROP_TEXT_SAMPLES = ['dropped text', 'drop 🚀 payload', ''] as const;

/**
 * Text payloads for injected foreign elements / adopted charData writes.
 * Short and distinctive so adoption diffs stay readable in artifacts.
 */
const FOREIGN_TEXT_SAMPLES = ['foreign', ' 🤖', 'grammar'] as const;

const FOREIGN_MUTATION_TARGETS: readonly DstForeignMutationTarget[] = [
	'text',
	'mark',
	'block',
	'inlineBlock',
	'root'
];

const MOVE_KEYS: readonly DstMoveKey[] = [
	'ArrowLeft',
	'ArrowRight',
	'ArrowUp',
	'ArrowDown',
	'Home',
	'End',
	'Alt+ArrowLeft',
	'Alt+ArrowRight'
];
const UNICODE_INSERT_SAMPLES = ['é', '🙂', 'e\u0301', '漢'] as const;

const markSamples: ReadonlyArray<Record<string, SerializableContent> | undefined> = [
	undefined,
	{ bold: true },
	{ italic: true },
	{ underline: true },
	{ strike: true },
	{ code: true },
	{ bold: true, italic: true },
	{ color: 'red' },
	{ highlight: 'yellow' },
	{ link: { href: 'https://example.com', target: '_blank' } }
];

const cloneMarks = (
	marks: Record<string, SerializableContent> | undefined
): Record<string, SerializableContent> | undefined =>
	marks === undefined ? undefined : structuredClone(marks);

const graphemes = (value: string): string[] => {
	type Segment = { segment: string };
	type SegmenterApi = { segment(value: string): Iterable<Segment> };
	type SegmenterConstructor = new (
		locale?: string | string[],
		options?: { granularity: 'grapheme' }
	) => SegmenterApi;
	const SegmenterCtor = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
	return SegmenterCtor
		? Array.from(
				new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(value),
				({ segment }) => String(segment)
			)
		: Array.from(value);
};

const textRun = (text: string, marks?: Record<string, SerializableContent>): JSONText => ({
	text,
	...(marks && Object.keys(marks).length > 0 ? { marks } : {})
});

const markedSegment = (rng: Rng, minimumRuns = 1): JSONText[] => {
	const runCount = int(rng, minimumRuns, Math.max(minimumRuns, 3));
	const runs: JSONText[] = [];
	for (let index = 0; index < runCount; index++) {
		const sample = pick(
			rng,
			TEXT_SAMPLES.filter((value) => value.length > 0)
		);
		const sampleGraphemes = graphemes(sample);
		const short = sampleGraphemes
			.slice(0, int(rng, 1, Math.min(sampleGraphemes.length, 6)))
			.join('');
		runs.push(textRun(short, cloneMarks(pick(rng, markSamples))));
	}
	return runs;
};

const mention = (id: string): JSONInlineBlock => ({
	type: 'mention',
	id,
	data: { label: id }
});

const generatedContent = (rng: Rng, blockId: string): Array<JSONText | JSONInlineBlock> => {
	const segmentCount = int(rng, 1, 3);
	const content: Array<JSONText | JSONInlineBlock> = [];
	for (let segment = 0; segment < segmentCount; segment++) {
		if (segment === 0 && bool(rng, 0.2)) {
			content.push(textRun(''));
		} else {
			content.push(...markedSegment(rng));
		}
		if (segment < segmentCount - 1) {
			content.push(mention(`${blockId}-i${segment}`));
		}
	}
	return content;
};

const paragraph = (
	id: string,
	content: Array<JSONText | JSONInlineBlock>,
	children?: JSONBlock[]
): JSONBlock => ({
	type: 'paragraph',
	id,
	content,
	...(children && children.length > 0 ? { children } : {})
});

export const shapeDocument = (seed: number, rng: Rng): { shape: string; document: JSONDoc } => {
	const prefix = `dst-${seed}`;
	switch ((seed - 1) % 8) {
		case 0:
			return {
				shape: 'empty-and-plain',
				document: {
					children: [
						paragraph(`${prefix}-b0`, [textRun('')]),
						paragraph(`${prefix}-b1`, [textRun('plain text')])
					]
				}
			};
		case 1:
			return {
				shape: 'dense-mark-boundaries',
				document: {
					children: [
						paragraph(`${prefix}-b0`, [
							textRun('a', { bold: true }),
							textRun('b', { italic: true }),
							textRun('c', { bold: true, italic: true }),
							textRun('d'),
							textRun('e', { link: { href: 'https://example.com' } })
						])
					]
				}
			};
		case 2:
			return {
				shape: 'inline-atom-boundaries',
				document: {
					children: [
						paragraph(`${prefix}-b0`, [
							textRun(''),
							mention(`${prefix}-b0-i0`),
							textRun('middle', { bold: true }),
							mention(`${prefix}-b0-i1`),
							textRun('')
						])
					]
				}
			};
		case 3:
			return {
				shape: 'nested-blocks',
				document: {
					children: [
						paragraph(
							`${prefix}-b0`,
							[textRun('parent')],
							[
								paragraph(`${prefix}-b0-c0`, [textRun('child', { underline: true })]),
								paragraph(`${prefix}-b0-c1`, [textRun('tail')])
							]
						),
						paragraph(`${prefix}-b1`, [textRun('after')])
					]
				}
			};
		case 4:
			return {
				shape: 'unicode-graphemes',
				document: {
					children: [
						paragraph(`${prefix}-b0`, [textRun('A 🚀 e\u0301 한글 שלום Z')]),
						paragraph(`${prefix}-b1`, [textRun('🙂🙂', { italic: true })])
					]
				}
			};
		case 5:
			return {
				shape: 'void-neighbours',
				document: {
					children: [
						paragraph(`${prefix}-b0`, [textRun('before')]),
						{ type: 'divider', id: `${prefix}-divider` },
						paragraph(`${prefix}-b1`, [textRun('after', { strike: true })])
					]
				}
			};
		case 6:
			return {
				shape: 'multiline-rich-blocks',
				document: {
					children: [
						{
							type: 'callout',
							id: `${prefix}-b0`,
							data: { icon: '!' },
							content: [textRun('line\nbreak', { code: true })]
						},
						{
							type: 'quote',
							id: `${prefix}-b1`,
							content: [textRun('quoted'), textRun(' words', { highlight: 'yellow' })]
						}
					]
				}
			};
		default: {
			const children: JSONBlock[] = [];
			for (let index = 0; index < int(rng, 2, 4); index++) {
				const id = `${prefix}-b${index}`;
				const nested =
					index === 0 && bool(rng)
						? [paragraph(`${id}-c0`, generatedContent(rng, `${id}-c0`))]
						: undefined;
				children.push(paragraph(id, generatedContent(rng, id), nested));
			}
			return { shape: 'generated-mixed', document: { children } };
		}
	}
};

const uint32 = (rng: Rng): number => Math.floor(rng() * 0x1_0000_0000) >>> 0;

const textSelectionFor = (
	rng: Rng,
	step: number,
	forcedMode?: DstSelectionMode
): DstTextSelectionSelector => ({
	kind: 'text',
	mode:
		forcedMode ??
		(step % 5 === 0
			? 'cross-text'
			: step % 3 === 0
				? 'within-text'
				: pick(rng, ['collapsed', 'within-text', 'cross-text'] as const)),
	startText: uint32(rng),
	startOffset: uint32(rng),
	endText: uint32(rng),
	endOffset: uint32(rng),
	reversed: bool(rng, 0.3)
});

/**
 * The forced cycle is mod-40. Positions 0–17 keep the v2 mapping exactly —
 * the same selector/action pairs consume the same rng draws, so existing
 * seeds' early steps stay stable. Positions 18–35 cover the v3 input
 * surface: vertical/word/Home/End navigation, word deletion, nest/unnest,
 * pointer input (element granularity only), synthetic composition, and
 * synthetic clipboard/drop. Positions 36–39 are the v4 foreign-DOM
 * mutation slots: foreign attribute writes, owned-attribute damage,
 * managed-node removal / type-over, and foreign element injection.
 * Schema v5 reuses slot 22: on darwin it also emits the ⌘⌫ line delete
 * (a platform-only native intent), off-darwin it stays a word delete.
 *
 * The first cycle deliberately mixes independent ranges with stateful input
 * programs. Later cycles retain the same coverage while adding random text
 * ranges. Structural selectors carry entropy and resolve against live DOM
 * state, exactly like text selectors resolve against live text segments.
 */
const DST_CYCLE_LENGTH = 40;

const selectionFor = (rng: Rng, step: number): DstSelectionSelector => {
	const forced = step % DST_CYCLE_LENGTH;
	if (forced >= 36) {
		// v4 slots. Foreign DOM damage acts on live elements under a live
		// collapsed caret — repair paths re-anchor a caret whose text was
		// removed or remounted. (Range-selection restore across foreign
		// remounts is a separate follow-up; a collapsed caret keeps the
		// oracle provable instead of asserting an unimplemented repair.)
		return textSelectionFor(rng, step, 'collapsed');
	}
	if (forced >= 18) {
		// v3 slots. Pointer actions produce their own selection, so their
		// selector step only seeds the pre-action state.
		switch (forced) {
			case 18: // ArrowUp
			case 19: // ArrowDown
			case 20: // Home/End
			case 21: // word jump
			case 28: // shiftClick needs a live anchor
				return textSelectionFor(rng, step, 'collapsed');
			case 22: // wordDelete/lineDelete — a caret only: over a range every
				// engine degrades ⌥⌫/⌘⌫ to a `deleteContent*` inputType, so the
				// word/line intent can never be delivered there.
				return textSelectionFor(rng, step, 'collapsed');
			case 23: // tab — caret or a real block selection
				return bool(rng, 0.4)
					? { kind: 'block', index: uint32(rng), reversed: false }
					: textSelectionFor(rng, step, 'collapsed');
			case 24: // shiftTab — mostly caret; a nested block when rolled
				return bool(rng, 0.3)
					? { kind: 'block', index: uint32(rng), reversed: false }
					: textSelectionFor(rng, step, 'collapsed');
			case 25: // pointerClick
			case 26: // pointerDrag
			case 27: // pointerDoubleClick
			case 33: // drop
				return { kind: 'preserve' };
			case 29: // composition
			case 30: // paste
				return textSelectionFor(rng, step, 'within-text');
			case 31: // cut
			case 32: // copy
				return textSelectionFor(rng, step, 'cross-text');
			case 34: // insertText
				return textSelectionFor(rng, step, 'collapsed');
			case 35: // extended move over node selections too
				return bool(rng, 0.4)
					? {
							kind: 'node',
							target: 'inline-or-block',
							index: uint32(rng),
							reversed: false
						}
					: textSelectionFor(rng, step, 'collapsed');
		}
	}
	if ([1, 2, 4, 7, 9, 11, 13].includes(forced)) return { kind: 'preserve' };
	if (forced === 6) return textSelectionFor(rng, step, 'collapsed');
	if (forced === 14) {
		return {
			kind: 'node',
			target: 'inline-or-block',
			index: uint32(rng),
			reversed: bool(rng, 0.3)
		};
	}
	if (forced === 15) {
		return { kind: 'block', index: uint32(rng), reversed: bool(rng, 0.3) };
	}
	if (forced === 16) {
		return {
			kind: 'root',
			startBlock: uint32(rng),
			endBlock: uint32(rng),
			reversed: bool(rng, 0.3)
		};
	}
	if (forced === 17) return { kind: 'document', reversed: bool(rng, 0.3) };
	return textSelectionFor(rng, step);
};

const pointerTarget = (
	rng: Rng
): Pick<Extract<DstAction, { kind: 'pointerClick' }>, 'target' | 'index' | 'edge'> => ({
	target: pick(rng, ['inline', 'blockText', 'padding'] as const),
	index: uint32(rng),
	edge: pick(rng, ['left', 'center', 'right'] as const)
});

const foreignMutationFor = (rng: Rng, forced: number): DstForeignMutation => {
	switch (forced) {
		case 36:
			return {
				kind: 'foreignAttribute',
				target: pick(rng, FOREIGN_MUTATION_TARGETS),
				index: uint32(rng),
				attribute: uint32(rng)
			};
		case 37:
			return {
				kind: 'managedAttribute',
				target: pick(rng, FOREIGN_MUTATION_TARGETS),
				index: uint32(rng),
				attribute: uint32(rng)
			};
		case 38:
			return bool(rng)
				? {
						kind: 'removeElement',
						target: pick(rng, ['text', 'mark', 'inlineBlock', 'block'] as const),
						index: uint32(rng)
					}
				: {
						kind: 'typeOver',
						index: uint32(rng),
						data: bool(rng, 0.6) ? null : pick(rng, INSERT_SAMPLES)
					};
		default: // 39
			return {
				kind: 'insertForeignElement',
				where: pick(rng, ['text', 'block', 'root'] as const),
				index: uint32(rng),
				text: pick(rng, FOREIGN_TEXT_SAMPLES)
			};
	}
};

const actionFor = (rng: Rng, step: number): DstAction => {
	const forced = step % DST_CYCLE_LENGTH;
	if (forced >= 36) {
		return { kind: 'foreignMutation', mutation: foreignMutationFor(rng, forced) };
	}
	if (forced >= 18) {
		switch (forced) {
			case 18:
				return { kind: 'move', key: 'ArrowUp', extend: bool(rng, 0.25) };
			case 19:
				return { kind: 'move', key: 'ArrowDown', extend: bool(rng, 0.25) };
			case 20:
				return {
					kind: 'move',
					key: pick(rng, ['Home', 'End'] as const),
					extend: bool(rng, 0.25)
				};
			case 21:
				return {
					kind: 'move',
					key: pick(rng, ['Alt+ArrowLeft', 'Alt+ArrowRight'] as const),
					extend: bool(rng, 0.25)
				};
			case 22: {
				// Schema v5 splits the delete units: ⌘⌫ is the darwin line
				// delete — a macOS-only native intent with no honest
				// cross-platform chord, so only darwin schedules it. One
				// draw either way keeps same-seed streams aligned across
				// platforms; off-darwin the slot stays a plain word delete.
				if (process.platform === 'darwin') {
					const unit = pick(rng, ['word-backward', 'word-forward', 'line-backward'] as const);
					return unit === 'line-backward'
						? { kind: 'lineDelete', direction: 'backward' }
						: {
								kind: 'wordDelete',
								direction: unit === 'word-backward' ? 'backward' : 'forward'
							};
				}
				return {
					kind: 'wordDelete',
					direction: pick(rng, ['backward', 'forward'] as const)
				};
			}
			case 23:
				return { kind: 'tab' };
			case 24:
				return { kind: 'shiftTab' };
			case 25:
				return { kind: 'pointerClick', ...pointerTarget(rng) };
			case 26:
				return { kind: 'pointerDrag', startBlock: uint32(rng), endBlock: uint32(rng) };
			case 27:
				return { kind: 'pointerDoubleClick', index: uint32(rng) };
			case 28:
				return { kind: 'shiftClick', ...pointerTarget(rng) };
			case 29: {
				const sample = pick(rng, COMPOSITION_SAMPLES);
				return {
					kind: 'composition',
					updates: [...sample.updates],
					commit: sample.commit,
					commitViaBeforeinput: bool(rng)
				};
			}
			case 30: {
				const sample = pick(rng, PASTE_SAMPLES);
				return {
					kind: 'paste',
					text: sample.text,
					html: sample.html,
					...(sample.fragment !== undefined ? { fragment: structuredClone(sample.fragment) } : {})
				};
			}
			case 31:
				return { kind: 'cut' };
			case 32:
				return { kind: 'copy' };
			case 33:
				return {
					kind: 'drop',
					index: uint32(rng),
					text: pick(rng, DROP_TEXT_SAMPLES)
				};
			case 34:
				return { kind: 'insertText', text: pick(rng, UNICODE_INSERT_SAMPLES) };
			default: // 35
				return { kind: 'move', key: pick(rng, MOVE_KEYS), extend: true };
		}
	}
	if (forced === 0) return { kind: 'type', text: pick(rng, INSERT_SAMPLES) };
	if (forced === 1) return { kind: 'undo' };
	if (forced === 2) return { kind: 'redo' };
	if (forced === 3) return { kind: 'insertText', text: pick(rng, UNICODE_INSERT_SAMPLES) };
	if (forced === 4) return { kind: 'backspace' };
	if (forced === 5) return { kind: 'delete' };
	if (forced === 6) return { kind: 'format', mark: pick(rng, ['bold', 'italic', 'underline']) };
	if (forced === 7) return { kind: 'type', text: pick(rng, INSERT_SAMPLES) };
	if (forced === 8) return { kind: 'enter' };
	if (forced === 9) return { kind: 'type', text: pick(rng, INSERT_SAMPLES) };
	if (forced === 10) return { kind: 'softBreak' };
	if (forced === 11) return { kind: 'type', text: pick(rng, INSERT_SAMPLES) };
	if (forced === 12) {
		return { kind: 'move', key: pick(rng, ['ArrowLeft', 'ArrowRight']), extend: false };
	}
	if (forced === 13) {
		return { kind: 'move', key: pick(rng, ['ArrowLeft', 'ArrowRight']), extend: true };
	}
	if (forced === 14) return { kind: 'backspace' };
	if (forced === 15) return { kind: 'format', mark: pick(rng, ['code', 'strike']) };
	if (forced === 16) return { kind: 'type', text: pick(rng, INSERT_SAMPLES) };
	if (forced === 17) return { kind: 'delete' };

	return pick(rng, [
		{ kind: 'type', text: alpha(rng, int(rng, 1, 3)) },
		{ kind: 'backspace' },
		{ kind: 'delete' },
		{ kind: 'format', mark: pick(rng, ['bold', 'italic', 'underline', 'code', 'strike']) },
		{ kind: 'move', key: pick(rng, ['ArrowLeft', 'ArrowRight']), extend: bool(rng) },
		{ kind: 'undo' },
		{ kind: 'redo' }
	] as DstAction[]);
};

export const generateDstSchedule = (seed: number, stepCount: number): DstSchedule => {
	const rng = mulberry32(seed);
	const { shape, document } = shapeDocument(seed, rng);
	const steps = Array.from({ length: stepCount }, (_, step) => ({
		selection: selectionFor(rng, step),
		action: actionFor(rng, step)
	}));
	return {
		schemaVersion: DST_SCHEMA_VERSION,
		seed,
		shape,
		document,
		steps
	};
};

export const parseSeedList = (raw: string | undefined): number[] => {
	if (!raw) return [1, 2, 3, 4, 5, 6, 7, 8];
	const seeds = new Set<number>();
	for (const segment of raw.split(',')) {
		const match = segment.trim().match(/^(\d+)(?:-(\d+))?$/);
		if (!match) throw new Error(`DST_SEEDS: invalid segment "${segment}"`);
		const start = Number(match[1]);
		const end = Number(match[2] ?? match[1]);
		if (end < start) throw new Error(`DST_SEEDS: descending range "${segment}"`);
		for (let seed = start; seed <= end; seed++) seeds.add(seed);
	}
	return [...seeds];
};
