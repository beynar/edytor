/**
 * Corrected CRDT-v14 performance baseline — WU5.
 *
 * This is the measurement layer the U11 numbers were missing. It answers:
 *
 *   "what does ONE operation actually cost, split by stage, on an
 *    INDEPENDENT but equivalent fixture, with the byte stream reported as
 *    bytes and each cost bucket attributed?"
 *
 * Corrections vs the U11 artifacts (see docs/crdt-v14-benchmarks.md):
 *
 * 1. updateBytes are bytes, never timing — every op records `updateBytes`
 *    under a bytes unit, separate from all `*Ms` fields.
 * 2. Per-stage attribution — each op record splits:
 *      `writeMs`    inside-transaction model+engine write (item create,
 *                   integrate, claim computation — the "engine" hot path)
 *      `commitMs`   transaction machinery + update ENCODE + 'update'-event
 *                   dispatch (runs observer marking, onChange snapshot/diff,
 *                   listeners) = transact-total − writeMs
 *      `facadeMs`   the whole facade op (write+commit+facade bookkeeping)
 *      `collectMs`  registry collection from scratch (the test oracle's
 *                   `collectBlocks` — since arch-v2 D9 no read pays it;
 *                   kept as the rebuild reference)
 *      `ownMs`      ownership computation (`T.computeOwnership`)
 *      `placeMs`    placement resolution (`M.resolvePlacements`)
 *      `runsMs`     maintained-runs reconcile for the touched block
 *      `changeMs`   onChange subscriber cost (differential lane — the
 *                   per-commit skeleton snapshot + diff + callback)
 * 3. Bundle bytes stay bundle bytes — see bench/bundle.js + the packed
 *    consumer lane in bench/run.js.
 * 4. Seam inserts are measured separately from caret-advance typing.
 *
 * Fixture discipline: every SAMPLE builds a fresh doc through the same
 * deterministic generator (independent but equivalent — no sample inherits
 * history a previous measurement left behind). Warmup happens on separate
 * throwaway docs (JIT warm, data-cold samples).
 *
 * Facade imports go through jiti (resolved from vitest's tree) so the bench
 * measures the WORKING-TREE TypeScript, not a stale `dist/` build.
 */
import * as Y14 from '../../src/lib/crdt/vendor/yjs/src/index.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { statsOf } from './stats.js';

const req = createRequire(import.meta.url);
const vitestDir = req.resolve('vitest/package.json').replace(/\/package\.json$/, '');
const { createJiti } = await import(req.resolve('jiti', { paths: [vitestDir] }));
const jiti = createJiti(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));
const { bindEdytorDoc } = await jiti.import(`${here}../../src/lib/crdt/edytor-doc.ts`);
const { bindSync } = await jiti.import(`${here}../../src/lib/crdt/protocols/sync.ts`);
// arch-v2 D9: production has no fresh collect (the doc's index is the owner);
// the from-scratch stages below measure the test oracle's rebuild.
const { collectBlocks } = await jiti.import(`${here}../../src/tests/oracles/fresh-view.ts`);

const E = bindEdytorDoc(Y14);
const S = bindSync(Y14);
const M = E.model;
const T = E.text;

const WARMUP = 3;
const SAMPLES = 30;

// ── deterministic fixtures ────────────────────────────────────────────────

/** mulberry32 — deterministic op selection where a lane needs randomness. */
const rng = (seed) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const textOf = (chars) => 'x'.repeat(chars);

/**
 * Bounded interior offset — every fixture paragraph carries ≥60 chars, so
 * `caret(5+i)` stays well inside the text for all sample counts.
 */
const caret = (i) => 5 + (i % 20);

/**
 * N flat paragraphs (`b0`…`bN-1`), each with `chars` of text — the canonical
 * block-count fixture. `target` names the paragraph ops edit.
 */
const flatSpec = (n, chars = 60) => ({
	content: Array.from({ length: n }, (_, i) => ({
		id: `b${i}`,
		type: 'paragraph',
		content: [{ kind: 'text', text: `block-${i} ` + textOf(Math.max(1, chars - 7)) }]
	}))
});

/** Depth-d nested chain: block → children → block → … → leaf paragraph. */
const nestedSpec = (depth, chars = 40) => {
	let leaf = {
		id: 'leaf',
		type: 'paragraph',
		content: [{ kind: 'text', text: textOf(chars) }]
	};
	for (let d = depth - 1; d >= 0; d--) {
		leaf = { id: `d${d}`, type: 'section', content: [], children: [leaf] };
	}
	return { content: [leaf] };
};

/**
 * One paragraph whose backing text carries `claims` claim boundaries —
 * produced by merging `claims` sibling paragraphs into `b0` during fixture
 * construction (each merge writes an {m} claim record). Text stays constant;
 * only the ownership-record count varies.
 */
const claimsDoc = (chars, claims) => {
	const doc = new Y14.Doc();
	E.init(doc, {
		content: Array.from({ length: claims + 1 }, (_, i) => ({
			id: `b${i}`,
			type: 'paragraph',
			content: [{ kind: 'text', text: textOf(Math.floor(chars / (claims + 1))) }]
		}))
	});
	const ed = E.create(doc);
	for (let i = 1; i <= claims; i++) ed.mergeBlocks(`b${i}`, 'b0');
	return { doc, ed, targetId: 'b0' };
};

/** One paragraph with `runs` alternating-mark text runs (dense formatting). */
const denseSpec = (runs) => ({
	content: [
		{
			id: 'dense',
			type: 'paragraph',
			content: Array.from({ length: runs }, (_, i) => ({
				kind: 'text',
				text: `run-${i}-text `,
				marks:
					i % 4 === 0
						? { bold: true }
						: i % 4 === 1
							? { italic: true }
							: i % 4 === 2
								? { bold: true, italic: true }
								: undefined
			}))
		}
	]
});

/** One paragraph with `k` inline atoms, text-separated (model invariant). */
const inlineSpec = (k) => ({
	content: [
		{
			id: 'inl',
			type: 'paragraph',
			content: [
				{ kind: 'text', text: 'a' },
				...Array.from({ length: k }, (_, i) => [
					{ kind: 'inline', id: `m${i}`, type: 'mention', data: { i } },
					{ kind: 'text', text: 'a' }
				]).flat()
			]
		}
	]
});

/**
 * Heavily edited/fragmented history: `n` blocks plus `cycles` rounds of
 * insert+delete churn (deterministic pattern) — tombstones + fragmented
 * item space vs the fresh-history baseline.
 */
const fragmentedDoc = (n, cycles) => {
	const doc = new Y14.Doc();
	E.init(doc, flatSpec(n));
	const ed = E.create(doc);
	const r = rng(1234);
	for (let c = 0; c < cycles; c++) {
		const id = `b${Math.floor(r() * n)}`;
		ed.insertText(id, 0, textOf(20));
		ed.deleteText(id, 0, 20);
		if (c % 4 === 0) {
			ed.insertBlock({ parent: null, index: 0 }, { id: `tmp${c}`, type: 'paragraph' });
			ed.deleteBlock(`tmp${c}`);
		}
	}
	return { doc, ed, targetId: 'b0' };
};

const flatDoc = (n, chars) => {
	const doc = new Y14.Doc();
	E.init(doc, flatSpec(n, chars));
	const ed = E.create(doc);
	return { doc, ed, targetId: `b${Math.floor(n / 2)}` };
};

const nestedDoc = (depth, chars) => {
	const doc = new Y14.Doc();
	E.init(doc, nestedSpec(depth, chars));
	const ed = E.create(doc);
	return { doc, ed, targetId: 'leaf' };
};

const specDoc = (spec) => {
	const doc = new Y14.Doc();
	E.init(doc, spec);
	const ed = E.create(doc);
	return { doc, ed };
};

// ── instrumented op measurement ───────────────────────────────────────────

/**
 * Run `fn` once on `doc`/`ed`, splitting cost across stages. Returns a
 * plain-data record — see the file header for the field semantics.
 *
 * `doc.transact` is wrapped to separate `writeMs` (inside the transaction
 * body — model logic + item create/integrate) from `commitMs` (transaction
 * machinery + update encode + 'update' event dispatch: runs observer
 * dirty-marking, onChange snapshot/diff, subscriber callbacks).
 */
const instrumentOp = (doc, ed, fn, { runsId, useEvents = false } = {}) => {
	let updateEvents = 0;
	let updateBytes = 0;
	const onUpdate = (u) => {
		updateEvents++;
		updateBytes += u.byteLength;
	};
	doc.on('update', onUpdate);
	ed.runsView.debug.reset();
	let transactMs = 0;
	let writeMs = 0;
	let restoreTx;
	if (useEvents) {
		// WU9: paths that bypass `doc.transact` (UndoManager calls the module-
		// level `transact()` directly) are invisible to the method wrap — this
		// event pair covers ANY transaction. `beforeTransaction` → body start,
		// `beforeObserverCalls` → body done (write boundary),
		// `afterAllTransactions` → cleanup+encode+dispatch done (commit end).
		// Valid for single top-level transactions (the undo lane); nested
		// transactions would double-count overlapping spans.
		let tB = 0;
		const onBefore = () => {
			tB = performance.now();
		};
		const onObs = () => {
			writeMs += performance.now() - tB;
		};
		const onAll = () => {
			transactMs += performance.now() - tB;
		};
		doc.on('beforeTransaction', onBefore);
		doc.on('beforeObserverCalls', onObs);
		doc.on('afterAllTransactions', onAll);
		restoreTx = () => {
			doc.off('beforeTransaction', onBefore);
			doc.off('beforeObserverCalls', onObs);
			doc.off('afterAllTransactions', onAll);
		};
	} else {
		const orig = doc.transact.bind(doc);
		doc.transact = (inner, origin) => {
			const t0 = performance.now();
			const r = orig((tr) => {
				const f0 = performance.now();
				const out = inner(tr);
				writeMs += performance.now() - f0;
				return out;
			}, origin);
			transactMs += performance.now() - t0;
			return r;
		};
		restoreTx = () => {
			doc.transact = orig;
		};
	}
	const t0 = performance.now();
	const out = fn();
	const facadeMs = performance.now() - t0;
	restoreTx();
	doc.off('update', onUpdate);

	// Post-write view re-collect — the cost the next read pays (the write
	// invalidated the memoized view). Split into the three ownView stages.
	const c0 = performance.now();
	const blocks = collectBlocks(doc);
	const collectMs = performance.now() - c0;
	const o0 = performance.now();
	const own = T.computeOwnership(doc, blocks);
	const ownMs = performance.now() - o0;
	const p0 = performance.now();
	M.resolvePlacements(blocks, own.ownerOf);
	const placeMs = performance.now() - p0;

	// WU7 counter: the shared model-state read the next command/anchor/
	// render actually pays — `M.view()` returns the doc's maintained ctx
	// (block records, ownership, placements, children index) in ~O(1)
	// instead of the collectMs+ownMs+placeMs trio above, which is now the
	// no-shared-state fallback this replaces.
	const v0 = performance.now();
	M.view(doc);
	const viewMs = performance.now() - v0;

	// Maintained-runs reconcile for the touched block (lazy — the first
	// read after the write pays it).
	let runsMs = null;
	let runsRecomputed = 0;
	if (runsId != null) {
		const r0 = performance.now();
		ed.runsView.runs(runsId);
		runsMs = performance.now() - r0;
		runsRecomputed = ed.runsView.debug.recomputed.size;
	}

	// Ownership counters (arch-v2 D12, R2): `ownershipPositions` is the total
	// stream count across all backing texts; `claimsVisited` the merge claims
	// the claim graph walked.
	let ownershipPositions = 0;
	let claimsVisited = 0;
	for (const rec of blocks.values()) {
		ownershipPositions += own.streamsIn(rec.id).length;
		claimsVisited += rec.claims.length;
	}
	return {
		out,
		facadeMs,
		writeMs,
		commitMs: transactMs - writeMs,
		collectMs,
		ownMs,
		placeMs,
		viewMs,
		runsMs,
		updateBytes,
		updateEvents,
		blocksCollected: blocks.length,
		ownershipPositions,
		claimsVisited,
		runsRecomputed
	};
};

/**
 * Aggregate per-field stats over op records. Numeric fields → statsOf;
 * `updateBytes` keeps the bytes unit; `out` is dropped (non-numeric).
 */
const aggOps = (records) => {
	const fields = Object.keys(records[0]).filter((k) => k !== 'out');
	const out = {};
	for (const f of fields) {
		const vals = records.map((r) => r[f]).filter((v) => typeof v === 'number');
		if (vals.length === 0) continue;
		out[f] = statsOf(vals, { warmup: WARMUP, unit: f.endsWith('Bytes') ? 'bytes' : 'ms' });
	}
	return out;
};

/**
 * `samples` independent-equivalent runs of `op` on fixtures from `fixture()`.
 *
 * The generator builds ONE doc; its state is snapshotted and every sample
 * restores a fresh doc from the encoded update — identical shape and
 * history, no shared-object inheritance, and ~100× cheaper than re-running
 * `E.init` per sample (7.8ms restore vs ~820ms init at 1,000 blocks).
 * Warmup restores are discarded (JIT warm, data-cold samples).
 */
const lane = (fixture, op, { samples = SAMPLES, warmup = WARMUP, runsId } = {}) => {
	const built = fixture(-1);
	const snapshot = Y14.encodeStateAsUpdate(built.doc);
	const targetId = built.targetId;
	built.doc.destroy();
	const restore = () => {
		const doc = new Y14.Doc();
		Y14.applyUpdate(doc, snapshot);
		return { doc, ed: E.create(doc) };
	};
	for (let i = 0; i < warmup; i++) {
		const { doc, ed } = restore();
		op(ed, targetId, i);
		doc.destroy();
	}
	const records = [];
	for (let i = 0; i < samples; i++) {
		const { doc, ed } = restore();
		const r = instrumentOp(doc, ed, () => op(ed, targetId, i), {
			runsId: typeof runsId === 'function' ? runsId(targetId) : (runsId ?? targetId)
		});
		records.push(r);
		doc.destroy();
	}
	return aggOps(records);
};

/** Snapshot helper for lanes that drive their own sample loops. */
const snap = (built) => {
	const snapshot = Y14.encodeStateAsUpdate(built.doc);
	built.doc.destroy();
	return {
		snapshot,
		targetId: built.targetId,
		restore: () => {
			const doc = new Y14.Doc();
			Y14.applyUpdate(doc, snapshot);
			return { doc, ed: E.create(doc) };
		}
	};
};

// ── lanes ─────────────────────────────────────────────────────────────────

/**
 * Local typing: one-char insert at the end of the SAME paragraph, while the
 * doc scales 100 → 1,000 → 5,000 blocks. The corrected U11 "keystroke".
 */
const keystroke = () => {
	const out = {};
	for (const n of [100, 1000, 5000]) {
		out[`blocks-${n}`] = lane(
			() => flatDoc(n),
			(ed, id, i) => ed.insertText(id, caret(i), 'x'),
			{
				samples: n >= 5000 ? 15 : SAMPLES,
				warmup: n >= 5000 ? 2 : WARMUP
			}
		);
	}
	return {
		...out,
		note: 'one-char insert at paragraph end; fixture = N flat paragraphs, same paragraph edited. writeMs = in-transaction model+integrate; commitMs = encode+event dispatch; collectMs/ownMs/placeMs = ownView stages the next read pays; runsMs = maintained-runs reconcile.'
	};
};

/** Depth scaling: the same keystroke in a paragraph nested `depth` deep. */
const depth = () => ({
	'depth-100': lane(
		() => nestedDoc(100),
		(ed, id, i) => ed.insertText(id, caret(i), 'x')
	),
	note: 'leaf paragraph under 100 nested sections — same op, deep tree.'
});

/**
 * Text-length scaling at a fixed small claim count (8 boundaries): one-char
 * insert into a paragraph whose backing text is 1k/10k/100k UTF-16 units.
 */
const textLength = () => {
	const out = {};
	for (const len of [1_000, 10_000, 100_000]) {
		out[`units-${len}`] = lane(
			() => {
				const d = claimsDoc(len, 8);
				return { doc: d.doc, ed: d.ed, targetId: 'b0' };
			},
			(ed, id, i) => ed.insertText(id, Math.floor(len / 2) + i, 'x'),
			{ samples: 20, warmup: 2 }
		);
	}
	return {
		...out,
		note: 'backing text length at 8 fixed claim boundaries; insert at mid-text.'
	};
};

/** Fixed 10k text, growing claim/slice record counts. */
const claimsScaling = () => {
	const out = {};
	for (const c of [0, 8, 32, 128]) {
		out[`claims-${c}`] = lane(
			() => {
				const d = claimsDoc(10_000, c);
				return { doc: d.doc, ed: d.ed, targetId: 'b0' };
			},
			(ed, id, i) => ed.insertText(id, 5000 + i, 'x'),
			{ samples: 20, warmup: 2 }
		);
	}
	return {
		...out,
		note: 'constant 10k text; only the claim-record count grows (merge history).'
	};
};

/** Dense-mark paragraph typing + run maintenance. */
const denseMarks = () => ({
	'runs-128': lane(
		() => {
			const { doc, ed } = specDoc(denseSpec(128));
			return { doc, ed, targetId: 'dense' };
		},
		(ed, id, i) => ed.insertText(id, 10 + i, 'x')
	),
	note: 'one-char insert into a 128-format-run paragraph.'
});

/** 250-inline-block paragraph — typing at an inline boundary. */
const inline250 = () => ({
	'inline-250': lane(
		() => {
			const { doc, ed } = specDoc(inlineSpec(250));
			return { doc, ed, targetId: 'inl' };
		},
		(ed, id, i) => ed.insertText(id, 100 + i, 'x')
	),
	note: 'one-char insert between inline atoms in a 250-inline paragraph.'
});

/**
 * Seam vs caret typing — the byte+time difference U11 collapsed into a
 * single "70B" figure. `caret` appends at the end of an owned run (same-atom
 * growth); `seam` inserts at the claim boundary between two ownership
 * segments (fresh atom + fresh ownership record).
 */
const seamVsCaret = () => {
	// 8-claim fixture: merge boundaries inside b0's text are the seams.
	const mid = Math.floor(10_000 / (8 + 1)); // first claim boundary ~1111
	return {
		caret: lane(
			() => {
				const d = claimsDoc(10_000, 8);
				return { doc: d.doc, ed: d.ed, targetId: 'b0' };
			},
			(ed, id, i) => ed.insertText(id, mid - 40 + i, 'x'),
			{ samples: 20, warmup: 2 }
		),
		seam: lane(
			() => {
				const d = claimsDoc(10_000, 8);
				return { doc: d.doc, ed: d.ed, targetId: 'b0' };
			},
			(ed, id, i) => ed.insertText(id, mid + i, 'x'),
			{ samples: 20, warmup: 2 }
		),
		note: 'caret = inside an owned run (mid-segment); seam = at a claim boundary. Same 10k text, same op position family — only the ownership-boundary alignment differs.'
	};
};

/** Other editing operations on the 1,000-block fixture. */
const ops = () => {
	const f = () => flatDoc(1000);
	return {
		delete: lane(f, (ed, id) => ed.deleteText(id, 10, 8)),
		'paste-text': lane(f, (ed, id) => ed.insertText(id, 10, textOf(500))),
		'paste-subtree': lane(f, (ed, id) =>
			ed.insertBlock(
				{ parent: null, index: 0 },
				{
					id: 'paste',
					type: 'section',
					children: Array.from({ length: 5 }, (_, i) => ({
						id: `paste-${i}`,
						type: 'paragraph',
						content: [{ kind: 'text', text: textOf(80) }]
					}))
				}
			)
		),
		format: lane(f, (ed, id) => ed.formatRange(id, 5, 25, { bold: true })),
		note: 'single ops on a 1,000-block doc; delete removes 8 chars, paste-text inserts 500, paste-subtree a 6-block section, format bolds 20 chars.'
	};
};

/** Movement: same-parent move, 5-block group move, deep reparent. */
const moves = () => {
	const groupSpec = (n = 100) => flatSpec(n);
	return {
		'same-parent': lane(
			() => {
				const { doc, ed } = specDoc(groupSpec(100));
				return { doc, ed, targetId: 'b10' };
			},
			(ed, id) => ed.moveBlock(id, { parent: null, index: 60 })
		),
		'group-5': lane(
			() => {
				const { doc, ed } = specDoc(groupSpec(100));
				return { doc, ed, targetId: 'b10' };
			},
			(ed) => ed.moveBlocks(['b10', 'b11', 'b12', 'b13', 'b14'], { parent: null, index: 60 })
		),
		reparent: lane(
			() => {
				const { doc, ed } = specDoc({
					content: [
						...flatSpec(50).content,
						{
							id: 'nest',
							type: 'section',
							children: nestedSpec(20).content[0].children
						}
					]
				});
				return { doc, ed, targetId: 'b10' };
			},
			// WU9 fixture fix: the original target 'd0' was never attached —
			// `children` takes only nestedSpec's INNER chain (d1…d19 > leaf), so
			// the move resolved against a missing parent and recorded 0 bytes.
			// 'd19' is the deepest attached section (nest>d1>…>d19>leaf).
			(ed, id) => ed.moveBlock(id, { parent: 'd19', index: 0 })
		),
		note: 'placement-attribute moves; reparent drops a root block into the deepest section of a 20-deep chain.'
	};
};

/** Repeated split/merge cycles — engine cost + wire bytes. */
const splitMerge = () => {
	const f = () => {
		const { doc, ed } = specDoc(flatSpec(200));
		return { doc, ed, targetId: 'b100' };
	};
	return {
		split: lane(f, (ed, id, i) => ed.splitBlock(id, 15, `sp${i}`)),
		merge: lane(
			() => {
				const { doc, ed } = specDoc(flatSpec(200));
				ed.splitBlock('b100', 15, 'pre');
				return { doc, ed, targetId: 'pre' };
			},
			(ed, id) => ed.mergeBlocks(id, 'b100')
		),
		note: 'split writes slice records; merge writes a claim — bytes, not re-encoded text.'
	};
};

/**
 * Anchor create + resolve after an edit — the U09 caret-anchor path the
 * selection layer pays per remote/local change.
 */
const anchors = () => {
	// Measure resolveAnchor on an anchor created pre-op, resolved post-op.
	const f = snap(flatDoc(1000));
	const samples = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc, ed } = f.restore();
		const targetId = f.targetId;
		const anchor = ed.anchorAt(targetId, 20, 'left');
		const r = instrumentOp(doc, ed, () => ed.insertText(targetId, caret(i), 'x'), {
			runsId: targetId
		});
		const a0 = performance.now();
		const resolved = ed.resolveAnchor(anchor);
		r.resolveAnchorMs = performance.now() - a0;
		r.anchorResolved = resolved !== null ? 1 : 0;
		const c0 = performance.now();
		ed.anchorAt(targetId, 21, 'right');
		r.createAnchorMs = performance.now() - c0;
		if (i >= WARMUP) samples.push(r);
		doc.destroy();
	}
	return {
		'anchor-cycle': aggOps(samples),
		note: 'anchorAt pre-op, insertText, resolveAnchor post-op on a 1,000-block doc.'
	};
};

/**
 * Selective undo — Y.UndoManager over the registry scope. Per sample: seed
 * a doc, perform K tracked ops, undo the LAST one (selective = the undo
 * step rewrites exactly that transaction's items, not a replay).
 */
const undo = () => {
	const K = 10;
	const f = snap(flatDoc(1000));
	const samples = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc, ed } = f.restore();
		const targetId = f.targetId;
		const um = new Y14.UndoManager(doc.get('blocks'), { captureTimeout: 0 });
		for (let k = 0; k < K; k++) ed.insertText(targetId, caret(k), 'y');
		// useEvents: um.undo() calls module-level transact() — the doc.transact
		// method wrap can't see it (this was the zero write/commit attribution).
		const r = instrumentOp(doc, ed, () => um.undo(), { runsId: targetId, useEvents: true });
		if (i >= WARMUP) samples.push(r);
		doc.destroy();
	}
	return {
		[`undo-last-of-${K}`]: aggOps(samples),
		note: 'UndoManager scoped to the blocks registry, captureTimeout 0 → one undo step per op; write/commit timed via beforeTransaction→beforeObserverCalls→afterAllTransactions.'
	};
};

/**
 * Remote collaboration: a burst of K single-keystroke updates applied via
 * applyUpdateStaged (the provider path — now the WU5 fast path), plus an
 * offline-reconnect SyncStep2-style diff (peer edits while away, applies
 * as one payload on return).
 */
const remote = () => {
	const K = 50;
	const f = snap(flatDoc(1000));
	// ── burst: K remote keystroke updates through the staged boundary ──
	const burstSamples = [];
	let stagedCount = 0;
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc } = f.restore();
		const targetId = f.targetId;
		const peer = new Y14.Doc({ guid: doc.guid });
		Y14.applyUpdate(peer, f.snapshot);
		const peerEd = E.create(peer);
		const updates = [];
		peer.on('update', (u) => updates.push(u));
		for (let k = 0; k < K; k++) peerEd.insertText(targetId, caret(k), 'z');
		const t0 = performance.now();
		for (const u of updates) {
			const t1 = performance.now();
			const res = { staged: false, ...S.applyRemote(doc, u, 'bench') };
			if (i >= WARMUP) {
				burstSamples.push({
					applyMs: performance.now() - t1,
					staged: res.staged ? 1 : 0,
					updateBytes: u.byteLength,
					applied: res.applied ? 1 : 0
				});
				if (res.staged) stagedCount++;
			}
		}
		if (i >= WARMUP) burstSamples.push({ batchMs: performance.now() - t0 });
		doc.destroy();
	}
	// ── reconnect: peer accumulates K edits offline → one diff update ──
	const reconSamples = [];
	let reconStaged = 0;
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc } = f.restore();
		const targetId = f.targetId;
		const peer = new Y14.Doc({ guid: doc.guid });
		Y14.applyUpdate(peer, f.snapshot);
		const peerEd = E.create(peer);
		for (let k = 0; k < K; k++) peerEd.insertText(targetId, caret(k), 'z');
		const diff = Y14.encodeStateAsUpdate(peer, Y14.encodeStateVector(doc));
		const t0 = performance.now();
		const res = { staged: false, ...S.applyRemote(doc, diff, 'bench') };
		const applyMs = performance.now() - t0;
		if (i >= WARMUP) {
			reconSamples.push({
				applyMs,
				diffBytes: diff.byteLength,
				staged: res.staged ? 1 : 0,
				applied: res.applied ? 1 : 0
			});
			if (res.staged) reconStaged++;
		}
		doc.destroy();
	}
	return {
		[`burst-${K}-keystrokes`]: {
			...aggOps(burstSamples),
			stagedTotal: stagedCount,
			note: 'per-update applyUpdateStaged ms + staged flag; stagedTotal counts updates that hit the scratch path across all samples (expect 0 for pure content updates).'
		},
		[`reconnect-${K}-edits`]: {
			...aggOps(reconSamples),
			stagedTotal: reconStaged,
			note: 'one diff update per sample — peer K edits while offline → applyUpdateStaged on return (a content diff → fast path).'
		}
	};
};

/**
 * The staging boundary itself — before/after evidence for the WU5 fast
 * path. `after` = applyUpdateStaged per remote keystroke; `before` = the
 * same update applied through a manual scratch-doc merge (the pre-WU5
 * staging algorithm, reproduced to keep the honest comparison).
 */
const staging = () => {
	const K = 50;
	const f = snap(flatDoc(1000));
	const after = [];
	const before = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc } = f.restore();
		const doc2 = f.restore().doc; // independent equivalent for `before`
		const peer = new Y14.Doc({ guid: doc.guid });
		Y14.applyUpdate(peer, f.snapshot);
		const peerEd = E.create(peer);
		const updates = [];
		peer.on('update', (u) => updates.push(u));
		for (let k = 0; k < K; k++) peerEd.insertText(`b${500 + (k % 10)}`, caret(k), 'z');
		for (const u of updates) {
			const t0 = performance.now();
			({ staged: false, ...S.applyRemote(doc, u, 'bench') });
			const afterMs = performance.now() - t0;
			// The pre-WU5 algorithm: scratch ← live state + update → verdict.
			const t1 = performance.now();
			const scratch = new Y14.Doc();
			Y14.applyUpdate(scratch, Y14.encodeStateAsUpdate(doc2));
			Y14.applyUpdate(scratch, u);
			const stagedMs = performance.now() - t1;
			Y14.applyUpdate(doc2, u);
			if (i >= WARMUP) {
				after.push(afterMs);
				before.push(stagedMs);
			}
		}
		doc.destroy();
		doc2.destroy();
	}
	return {
		'applyUpdateStaged-1k': statsOf(after, { warmup: WARMUP }),
		'manual-scratch-merge-1k': statsOf(before, { warmup: WARMUP }),
		note: 'after = WU5 fast path (decode-scan + direct apply); before = the pre-WU5 scratch-doc merge reproduced manually on an independent-equivalent doc.'
	};
};

/**
 * Full-document serialization — reported separately from op cost, per the
 * correction: `childrenIds` full-tree walk + runsView contentJSON per block
 * + encodeStateAsUpdate size/time.
 */
const serialization = () => {
	const f = snap(flatDoc(1000));
	const samples = [];
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc, ed } = f.restore();
		if (i >= WARMUP) {
			const r = {};
			const t0 = performance.now();
			const ids = ed.childrenIds(null);
			r.treeWalkMs = performance.now() - t0;
			const t1 = performance.now();
			let items = 0;
			for (const id of ids) items += ed.runsView.contentJSON(id).length;
			r.contentJSONMs = performance.now() - t1;
			r.items = items;
			const t2 = performance.now();
			const u = Y14.encodeStateAsUpdate(doc);
			r.encodeMs = performance.now() - t2;
			r.updateBytes = u.byteLength;
			samples.push(r);
		}
		doc.destroy();
	}
	return {
		'full-doc-1k': {
			...aggOps(samples),
			note: 'childrenIds walk + contentJSON per block + encodeStateAsUpdate — the whole-doc export path, NOT per-op cost.'
		}
	};
};

/**
 * Change-callback cost — differential lane: identical keystrokes on two
 * equivalent docs, one with an `onChange` subscriber (pays the per-commit
 * skeleton snapshot + diff + callback), one without. The delta is the
 * callback pipeline cost, separated from the write itself.
 */
const changeCallbacks = () => {
	const withSub = [];
	const withoutSub = [];
	const f = snap(flatDoc(1000));
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc, ed } = f.restore();
		const targetId = f.targetId;
		let fired = 0;
		const unsub = ed.onChange(() => fired++);
		const t0 = performance.now();
		ed.insertText(targetId, caret(i), 'x');
		const ms = performance.now() - t0;
		unsub();
		if (i >= WARMUP) withSub.push({ facadeMs: ms, fired });
		doc.destroy();
	}
	for (let i = 0; i < WARMUP + SAMPLES; i++) {
		const { doc, ed } = f.restore();
		const t0 = performance.now();
		ed.insertText(f.targetId, caret(i), 'x');
		const ms = performance.now() - t0;
		if (i >= WARMUP) withoutSub.push({ facadeMs: ms });
		doc.destroy();
	}
	const w = statsOf(
		withSub.map((r) => r.facadeMs),
		{ warmup: WARMUP }
	);
	const wo = statsOf(
		withoutSub.map((r) => r.facadeMs),
		{ warmup: WARMUP }
	);
	return {
		'with-subscriber': w,
		'no-subscriber': wo,
		'callback-cost-est': {
			mean: +(w.mean - wo.mean).toFixed(4),
			p50: +(w.p50 - wo.p50).toFixed(4),
			note: 'differential (subscriber − none); includes skeleton snapshot + diff + callback dispatch.'
		},
		firedPerOp: statsOf(
			withSub.map((r) => r.fired),
			{ warmup: WARMUP, unit: 'count' }
		)
	};
};

/**
 * WU8 — repeated small formatted-range reads of one long backing text.
 *
 * The motivating defect: `itemsOfRange` used to render the WHOLE backing
 * text via `toDelta().toJSON()` and clip, so N small slices of one 100k
 * text cost N×O(text). Now the maintained view keeps a per-text
 * checkpoint index (`{pos, item, formats}` every ≤64 walked items) and a
 * range read steps only the intra-gap prefix + its own span.
 *
 * Fixture: one 100k-char paragraph with a format boundary every 200
 * chars (alternating bold/italic — ~500 string items + ~1000 format
 * markers in the sequence), split into 50 sibling blocks — each block's
 * cold `runs()` read is one ~2k-char range read of the shared backing
 * text (the split-owned shape from the WU8 plan). Per sample:
 *
 * - `firstReadMs` — the first block's read, which pays the cold
 *   marker-pool warm-up all subsequent reads share (the vendored
 *   `RangeCursor` plants sparse format-aware `_searchMarker` checkpoints
 *   behind its walk — the U3 successor of WU8's Edytor-side index build).
 * - `readMs` / `items` / `markers` — every other block's read, seeded by
 *   the marker pool: time + sequence items stepped + format markers
 *   applied.
 * - `toDeltaRefMs` — one `toDelta().toJSON()` render of the same text:
 *   what EVERY read paid pre-WU8 (the reproduce-the-old-path reference,
 *   same methodology as the staging lane).
 * - `searchMarkers` — the engine-owned checkpoint pool the reads left
 *   behind: proves the prefix work happens once, not per read (U3).
 */
const rangeReads = () => {
	const LEN = 100_000;
	const SLICES = 50;
	const RUN_CHARS = 200;
	const built = () => {
		const doc = new Y14.Doc();
		E.init(doc, {
			content: [
				{
					id: 'b0',
					type: 'paragraph',
					content: Array.from({ length: LEN / RUN_CHARS }, (_, i) => ({
						kind: 'text',
						text: textOf(RUN_CHARS),
						marks:
							i % 4 === 0
								? { bold: true }
								: i % 4 === 1
									? { italic: true }
									: i % 4 === 2
										? { bold: true, italic: true }
										: undefined
					}))
				}
			]
		});
		const ed = E.create(doc);
		let head = 'b0';
		for (let s = 1; s < SLICES; s++) {
			ed.splitBlock(head, LEN / SLICES, `sp${s}`);
			head = `sp${s}`;
		}
		return { doc, ed };
	};
	const f = snap(built());
	const readMs = [];
	const readItems = [];
	const readMarkers = [];
	const firstReadMs = [];
	const toDeltaRefMs = [];
	let searchMarkers = 0;
	const S = 10;
	for (let i = 0; i < WARMUP + S; i++) {
		const { doc, ed } = f.restore();
		const ids = ed.childrenIds(null);
		ed.runsView.debug.reset();
		const text = M.view(doc).blocks.get('b0').content;
		// First read pays the checkpoint-index build + its own range.
		const t0 = performance.now();
		ed.runsView.runs(ids[0]);
		const first = performance.now() - t0;
		for (const id of ids.slice(1)) {
			const items0 = ed.runsView.debug.itemsWalked;
			const markers0 = ed.runsView.debug.markersWalked;
			const r0 = performance.now();
			ed.runsView.runs(id);
			const ms = performance.now() - r0;
			if (i >= WARMUP) {
				readMs.push(ms);
				readItems.push(ed.runsView.debug.itemsWalked - items0);
				readMarkers.push(ed.runsView.debug.markersWalked - markers0);
			}
		}
		if (i >= WARMUP) {
			firstReadMs.push(first);
			searchMarkers += text._searchMarker?.length ?? 0;
			// Pre-WU8 reference: each of those reads materialized the whole
			// 100k backing text through toDelta().toJSON() — once per slice.
			const d0 = performance.now();
			text.toDelta().toJSON();
			toDeltaRefMs.push(performance.now() - d0);
		}
		doc.destroy();
	}
	return {
		[`${SLICES}x2k-slices-of-100k`]: {
			warmReadMs: statsOf(readMs, { warmup: 0 }),
			itemsWalkedPerRead: statsOf(readItems, { warmup: 0, unit: 'count' }),
			markersWalkedPerRead: statsOf(readMarkers, { warmup: 0, unit: 'count' }),
			firstReadMs: statsOf(firstReadMs, { warmup: 0 }),
			preWU8ToDeltaMs: statsOf(toDeltaRefMs, { warmup: 0 }),
			searchMarkers,
			note: `each of ${SLICES} sibling blocks reads its own ~2k range of one shared 100k formatted text; firstReadMs includes the cold marker-pool warm-up (U3: vendored RangeCursor checkpoints); preWU8ToDeltaMs = what every single read cost before (full render + clip).`
		}
	};
};

/**
 * Retained memory — post-GC `heapUsed` for equivalent docs at 100/1k/5k
 * blocks, and after an edit+undo lifecycle. Requires `node --expose-gc`
 * (the bench:crdt script sets it); when the flag is absent the lane reports
 * gc:false instead of silently producing uncollected-heap numbers.
 */
const memory = async () => {
	const gc = globalThis.gc;
	if (typeof gc !== 'function') {
		return {
			gc: false,
			note: 'global.gc unavailable — rerun with node --expose-gc for retained-heap lanes.'
		};
	}
	const heap = () => {
		gc();
		gc();
		return process.memoryUsage().heapUsed;
	};
	/**
	 * WU9: `heapUsed` measured in the same frame that built/destroyed objects is
	 * inflated by conservative stack roots — dead locals' pointers still sit in
	 * live stack slots and pin the structures they referenced (this is what
	 * made the old lane read +120MB). A `setImmediate` await suspends this
	 * frame; only its live state is restored on resume, so measurements taken
	 * after the tick see a clean stack.
	 */
	const tick = () => new Promise((r) => setImmediate(r));
	const base = heap();
	const out = { gc: true, baselineHeapBytes: base };
	// Held-doc loop in its own async frame — when it returns, every iteration
	// local dies with the frame. (Inline, the last iteration's destroyed docs
	// stay pinned in `memory()`'s suspended state — the same conservative-
	// stack effect, now applied to the lane's own temporaries.)
	await (async () => {
		for (const n of [100, 1000, 5000]) {
			await tick(); // release prior iteration's pinned dead refs before measuring
			const f = snap(flatDoc(n));
			const docs = [];
			for (let i = 0; i < 3; i++) docs.push(f.restore());
			const withDocs = heap();
			out[`retained-${n}-blocks`] = {
				heapBytes: withDocs,
				deltaBytes: withDocs - base,
				docsHeld: docs.length
			};
			for (const d of docs) d.doc.destroy();
		}
	})();
	// Lifecycle: edit+undo churn on the 1k doc. Run in a nested async frame so
	// the held-vs-teardown split can be measured cleanly — the IIFE's locals
	// die when it returns, and the following tick drops them off the stack.
	const liveDelta = await (async () => {
		const { doc, ed } = snap(flatDoc(1000)).restore();
		const um = new Y14.UndoManager(doc.get('blocks'), { captureTimeout: 0 });
		for (let k = 0; k < 200; k++) {
			ed.insertText('b500', 10, 'q');
			if (k % 2) um.undo();
		}
		await tick(); // dead churn temporaries release; doc/ed/um stay live
		const d = heap() - base;
		um.destroy();
		ed.dispose();
		doc.destroy();
		return d;
	})();
	await tick(); // the IIFE's refs unwind; destroyed doc is truly unreachable
	const tornDelta = heap() - base;
	out['post-edit-undo-lifecycle-1k'] = {
		heapBytes: base + liveDelta,
		deltaBytes: liveDelta,
		postTeardownDeltaBytes: tornDelta,
		note: 'deltaBytes = heap with {doc, facade, UndoManager} still held after 200-edit churn (the lane figure). postTeardownDeltaBytes = residual after um.destroy + ed.dispose + doc.destroy — WU9 verdict: teardown releases ~everything; the historical +120MB was mostly conservative-stack-pinned dead objects, not a leak.'
	};
	return out;
};

// ── steady state on editor-built documents (CRDT study 2026-10: P1, P3) ────

/**
 * Steady-state costs on documents built the way an editor builds them: each
 * doc is warmed by reads, then K operations are timed one by one on the SAME
 * doc (no sample pays the first-read index build). Model only — the facade,
 * no view subscribed.
 *
 * - `enterBuiltKeystroke`: type a line, Enter at its end, N times (every
 *   block shares the first block's backing text), then a one-char insert in
 *   the middle block — P1's quadratic case (1.1 / 3.9 / 15.3 ms at
 *   500 / 1k / 2k blocks before P1).
 * - `splitLineage`: one paragraph split N times (each tail split again),
 *   then one-char inserts spread over the split-born blocks: `perSplitMs`
 *   the mean split, `keystroke` the inserts.
 * - `structural`: Enter (a split), a move to the end and a block delete on
 *   N flat paragraphs — P3's case (46 / 11 / 16 ms at 20k before P3).
 */
const steadyState = () => {
	const timed = (n, f) => {
		const out = [];
		for (let i = 0; i < n; i++) {
			const t0 = performance.now();
			f(i);
			out.push(performance.now() - t0);
		}
		return statsOf(out, { warmup: 0 });
	};
	const enterBuiltKeystroke = {};
	for (const n of [500, 1000, 2000]) {
		const doc = new Y14.Doc();
		E.init(doc, { content: [{ id: 'b0', type: 'paragraph', content: [] }] });
		const ed = E.create(doc);
		let last = 'b0';
		for (let b = 1; b < n; b++) {
			ed.insertText(last, 0, textOf(60));
			ed.splitBlock(last, 60, `b${b}`);
			last = `b${b}`;
		}
		const mid = `b${n >> 1}`;
		for (let k = 0; k < 20; k++) ed.insertText(mid, 30, 'w');
		enterBuiltKeystroke[`blocks-${n}`] = timed(200, () => ed.insertText(mid, 30, 'y'));
		doc.destroy();
	}
	const splitLineage = {};
	for (const n of [1000, 5000]) {
		const text = Array.from({ length: n }, (_, i) => `line ${i} `).join('');
		const parts = text.split(/(?<= )(?=line)/);
		const doc = new Y14.Doc();
		E.init(doc, { content: [{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text }] }] });
		const ed = E.create(doc);
		const ids = [];
		let rest = 'a';
		const t0 = performance.now();
		for (let i = 0; i < n - 1; i++) {
			ed.splitBlock(rest, parts[i].length, `s${i}`);
			rest = `s${i}`;
			ids.push(rest);
		}
		const perSplitMs = +((performance.now() - t0) / (n - 1)).toFixed(4);
		for (let k = 0; k < 20; k++) ed.insertText(ids[(k * 37) % ids.length], 1, 'w');
		splitLineage[`splits-${n}`] = {
			perSplitMs,
			keystroke: timed(200, (k) => ed.insertText(ids[(k * 37) % ids.length], 1, 'x'))
		};
		doc.destroy();
	}
	const structural = {};
	for (const n of [1000, 5000, 20000]) {
		const doc = new Y14.Doc();
		E.init(doc, flatSpec(n));
		const ed = E.create(doc);
		ed.insertText('b5', 2, 'y');
		ed.toJSON();
		const reps = n >= 20000 ? 20 : 40;
		const mid = `b${n >> 1}`;
		structural[`blocks-${n}`] = {
			keystroke: timed(reps, (k) => ed.insertText(mid, caret(k), 'x')),
			enter: timed(reps, (k) => ed.splitBlock(mid, 5, `e${k}`)),
			move: timed(reps, (k) => ed.moveBlocks([`b${k + 10}`], { parent: null, index: n - 2 })),
			delete: timed(reps, (k) => ed.deleteBlock(`b${k + 100}`))
		};
		doc.destroy();
	}
	return {
		enterBuiltKeystroke,
		splitLineage,
		structural,
		note: 'steady state on one warmed doc per size; model only (facade, no view). See the lane comment for the pre-fix numbers.'
	};
};

// ── suite ─────────────────────────────────────────────────────────────────

/** Run the whole corrected baseline. Plain-data record for the artifact. */
export const baseline = async () => ({
	steadyState: steadyState(),
	keystroke: keystroke(),
	depth: depth(),
	textLength: textLength(),
	claimsScaling: claimsScaling(),
	denseMarks: denseMarks(),
	inline250: inline250(),
	seamVsCaret: seamVsCaret(),
	history: {
		fresh: lane(
			() => flatDoc(1000),
			(ed, id, i) => ed.insertText(id, caret(i), 'x')
		),
		fragmented: lane(
			() => fragmentedDoc(1000, 200),
			(ed, id, i) => ed.insertText(id, caret(i), 'x'),
			{ samples: 20, warmup: 2 }
		),
		note: 'same op; fragmented carries 200 rounds of insert+delete churn (tombstones, fragmented item space).'
	},
	ops: ops(),
	moves: moves(),
	splitMerge: splitMerge(),
	anchors: anchors(),
	undo: undo(),
	remote: remote(),
	staging: staging(),
	serialization: serialization(),
	changeCallbacks: changeCallbacks(),
	rangeReads: rangeReads(),
	memory: await memory()
});
