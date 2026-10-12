// WU9 engine micro-benchmark: the two named vendored hot paths.
//   1. a delta applied to a fragmented long paragraph at distant positions (the
//      engine's own `applyDelta` for a baseline that still ships it, else the
//      test port over the fork's write cursor, UPSTREAM.md YP16) —
//      the cursor starts at _start every call, so each op costs O(position).
//   2. createAbsolutePositionFromRelativePosition() — resolves an anchor by
//      walking left from the bound item, summing visible length.
//   3. createRelativePositionFromTypeIndex() — index→item forward walk from _start.
//
// Usage: node bench/lib/engine-micro.mjs [quick]
//        ENGINE_DIR=bench/vendor-baseline/yjs node bench/lib/engine-micro.mjs [quick]
//   ENGINE_DIR points at an alternative vendored-src dir (e.g. the mk-baseline.sh
//   materialization) for before/after comparisons of the WU9 marker patch.
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = process.env.ENGINE_DIR ?? '../../src/lib/crdt/vendor/yjs/src';
const Y = await import(fileURLToPath(new URL(`${ENGINE_DIR}/index.js`, import.meta.url)));
const delta = await import('lib0-v14/delta');
const { applyDelta } = await import('../../src/tests/crdt/harness/delta.js');
console.log(`engine: ${ENGINE_DIR}`);

const QUICK = process.argv.includes('quick');
const ITEMS = QUICK ? 20000 : 100000;

const buildFragmentedText = (n) => {
	const doc = new Y.Doc();
	const text = doc.get('t');
	doc.transact(() => {
		// Build one fragmented paragraph in a SINGLE delta (one cursor walk):
		// alternating single-char items split by format markers so items cannot
		// merge (a marker between two same-client items blocks coalescing).
		const d = delta.create();
		for (let i = 0; i < n; i++) {
			d.insert('x', i % 2 === 0 ? { b: true } : { i: true });
		}
		applyDelta(text, d);
	});
	return { doc, text };
};

const bench = (name, f, iters) => {
	// warmup
	for (let i = 0; i < Math.min(200, iters / 10); i++) f(i);
	const t0 = performance.now();
	for (let i = 0; i < iters; i++) f(i);
	const ms = (performance.now() - t0) / iters;
	console.log(`${name.padEnd(52)} ${ms.toFixed(4)} ms/op  (${iters} iters)`);
	return ms;
};

const { doc, text } = buildFragmentedText(ITEMS);
console.log(`fragmented text built: length=${text.length} targetItems~${ITEMS}`);
// count actual list items
{
	let n = 0;
	for (let it = text._start; it !== null; it = it.right) n++;
	console.log(`list items: ${n}`);
}

// ── 1. distant applyDelta edits ──────────────────────────────────────
// retain to ~90% then insert — from-_start walk per call.
{
	const pos = Math.floor(text.length * 0.9);
	bench(
		`applyDelta retain(${pos})+insert (distant)`,
		() => {
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).insert('y'));
			});
			// undo the insert by deleting it again so the doc stays ~constant
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).delete(1));
			});
		},
		QUICK ? 300 : 1000
	);
}
// mid position
{
	const pos = Math.floor(text.length * 0.5);
	bench(
		`applyDelta retain(${pos})+insert (mid)`,
		() => {
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).insert('y'));
			});
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).delete(1));
			});
		},
		QUICK ? 300 : 1000
	);
}
// sequential typing — append a char at the END each op (advancing position,
// the real-world typing shape; each op is its own transaction).
{
	const beforeLen = text.length;
	bench(
		'applyDelta sequential append (typing)',
		() => {
			doc.transact(() => {
				applyDelta(text, delta.create().retain(text.length).insert('y'));
			});
		},
		QUICK ? 300 : 1000
	);
	// undo the appended run (warmup + iters) so later lanes see the same shape
	doc.transact(() => {
		applyDelta(
			text,
			delta
				.create()
				.retain(beforeLen)
				.delete(text.length - beforeLen)
		);
	});
}
// scattered distant edits — random positions each op (seed rarely adjacent to
// the target; the case where marker seeding shouldn't hurt but can't help).
{
	let seed = 99;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	bench(
		'applyDelta scattered distant insert+delete',
		() => {
			const pos = Math.floor(rand() * (text.length - 2)) + 1;
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).insert('y'));
			});
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).delete(1));
			});
		},
		QUICK ? 300 : 1000
	);
}
// near position for scale
{
	const pos = 10;
	bench(
		`applyDelta retain(${pos})+insert (near)`,
		() => {
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).insert('y'));
			});
			doc.transact(() => {
				applyDelta(text, delta.create().retain(pos).delete(1));
			});
		},
		QUICK ? 300 : 1000
	);
}

// ── 2. position resolution — multiple anchors (ids, fork patch YP19) ──
{
	// create anchors scattered across the text, then resolve each.
	const anchors = [];
	const N_ANCHORS = 200;
	for (let i = 0; i < N_ANCHORS; i++) {
		const idx = Math.floor(((i + 0.5) * text.length) / N_ANCHORS);
		anchors.push(Y.idAtIndex(text, idx, 0));
	}
	bench(
		`indexOfId ×${N_ANCHORS} (resolve all)`,
		() => {
			for (const a of anchors) {
				Y.indexOfId(doc, a);
			}
		},
		QUICK ? 100 : 400
	);
	// per-anchor cost for one distant anchor
	const far = anchors[N_ANCHORS - 1];
	bench(
		'indexOfId (single distant)',
		() => {
			Y.indexOfId(doc, far);
		},
		QUICK ? 2000 : 8000
	);
}

// ── 3. anchor creation — idAtIndex ──────────────────────────────────
{
	const pos = Math.floor(text.length * 0.9);
	bench(
		`idAtIndex(${pos}) (distant)`,
		() => {
			Y.idAtIndex(text, pos, 0);
		},
		QUICK ? 2000 : 8000
	);
}
