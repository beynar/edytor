/**
 * The four U02 §10 workloads. Each returns a plain-data measurement record —
 * no engine objects leak into the JSON output.
 */
import * as Y13 from 'yjs';
import * as Y14 from '../../src/lib/crdt/vendor/yjs/src/index.js';
import { measure, statsOf } from './stats.js';
import {
	ROOT,
	newDoc13,
	newDoc14,
	insertBlock13,
	insertBlock14,
	moveByCopy13,
	moveByPlacement14,
	newPlacementDoc14,
	insertModelBlock14,
	moveByModel14,
	splitModelBlock14,
	mergeModelBlocks14,
	splitByCopy13,
	mergeByCopy13,
	blockAt14,
	captureUpdateBytes
} from './models.js';

const WARMUP = 3;
const SAMPLES = 40;

// ── 1. typing burst ─────────────────────────────────────────────────────────
// One-character inserts at the end of a paragraph's content — the hot path of
// collaborative typing. Measures local op latency AND the remote peer's
// applyUpdate latency for the emitted update.

const typingBurst = (engine) => {
	const is14 = engine === 'v14';
	const Y = is14 ? Y14 : Y13;
	const local = is14 ? newDoc14() : newDoc13();
	const remote = is14 ? newDoc14() : newDoc13();
	Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
	if (is14) insertBlock14(local, null, 0, { id: 'p1', content: [{ text: 'seed ' }] });
	else insertBlock13(local, 0, { id: 'p1', content: [{ text: 'seed ' }] });
	Y.applyUpdate(remote, Y.encodeStateAsUpdate(local, Y.encodeStateVector(remote)));
	const textNode = is14
		? blockAt14(local, 0).getAttr('content')
		: local.getArray(ROOT).get(0).get('content');
	let last = null;
	local.on('update', (u) => (last = u));
	const localMs = [];
	const remoteMs = [];
	const iter = () => {
		const t0 = performance.now();
		local.transact(() => textNode.insert(textNode.length, 'x'));
		localMs.push(performance.now() - t0);
		const t1 = performance.now();
		Y.applyUpdate(remote, last);
		remoteMs.push(performance.now() - t1);
	};
	for (let i = 0; i < WARMUP; i++) iter();
	localMs.length = 0;
	remoteMs.length = 0;
	for (let i = 0; i < SAMPLES; i++) iter();
	return {
		local: statsOf(localMs, { warmup: WARMUP }),
		remote: statsOf(remoteMs, { warmup: WARMUP })
	};
};

export const typing = () => ({
	v14: typingBurst('v14'),
	v13: typingBurst('v13'),
	unit: 'ms per single-char insert; `remote` = applyUpdate on a synced replica'
});

// ── 2. copy-move vs placement-attribute ─────────────────────────────────────
// Headline: moving a text-bearing block must not re-encode the payload.

const moveOnce = (engine, payloadChars) => {
	const N = 20;
	const FROM = 4;
	const TO = 14;
	if (engine === 'v14') {
		const doc = newDoc14();
		doc.transact(() => {
			for (let i = 0; i < N; i++) {
				insertBlock14(doc, null, i, {
					id: `b${i}`,
					content: [{ text: i === FROM ? 'y'.repeat(payloadChars) : 'small' }]
				});
			}
		});
		const block = blockAt14(doc, FROM);
		const updateBytes = captureUpdateBytes(doc, () =>
			moveByPlacement14(doc, block, { parent: null, index: TO })
		);
		return { updateBytes };
	}
	const doc = newDoc13();
	doc.transact(() => {
		for (let i = 0; i < N; i++) {
			insertBlock13(doc, i, {
				id: `b${i}`,
				content: [{ text: i === FROM ? 'y'.repeat(payloadChars) : 'small' }]
			});
		}
	});
	const updateBytes = captureUpdateBytes(doc, () => moveByCopy13(doc, FROM, TO));
	return { updateBytes };
};

/**
 * Real U03 placement-model move (registry + `at` candidate record). Wire
 * cost of one `moveBlock` = ONE `{p, r}` attr write (+ top-2 tombstones) —
 * payload never re-encoded, regardless of block size.
 */
const modelMoveOnce = (payloadChars) => {
	const N = 20;
	const doc = newPlacementDoc14();
	doc.transact(() => {
		for (let i = 0; i < N; i++) {
			insertModelBlock14(doc, {
				id: `b${i}`,
				rank: `a${String(i).padStart(2, '0')}`,
				content: [{ text: i === 4 ? 'y'.repeat(payloadChars) : 'small' }]
			});
		}
	});
	const updateBytes = captureUpdateBytes(doc, () =>
		moveByModel14(doc, 'b4', { parent: null }, 'a145')
	);
	return { updateBytes };
};

/** Amortized per-move bytes across 500 sequential moves of the same block. */
const modelMoveAmortized = () => {
	const doc = newPlacementDoc14();
	doc.transact(() => {
		for (let i = 0; i < 5; i++) {
			insertModelBlock14(doc, {
				id: `b${i}`,
				rank: `a${i}`,
				content: [{ text: 'small' }]
			});
		}
	});
	let bytes = 0;
	doc.on('update', (u) => (bytes += u.byteLength));
	for (let i = 0; i < 500; i++) {
		moveByModel14(doc, 'b0', { parent: null }, `z${String(i).padStart(4, '0')}`);
	}
	return { moves: 500, totalBytes: bytes, bytesPerMove: Math.round(bytes / 500) };
};

export const move = () => {
	const big = {
		v14: moveOnce('v14', 100_000),
		v14model: modelMoveOnce(100_000),
		v13: moveOnce('v13', 100_000)
	};
	const timed = {
		v14: measure(() => moveOnce('v14', 500).updateBytes, { warmup: 1, samples: 20 }),
		v13: measure(() => moveOnce('v13', 500).updateBytes, { warmup: 1, samples: 20 })
	};
	return {
		'100k-payload': {
			...big,
			note: 'v13 copy-move re-encodes the moved payload and loses concurrent edits to it — NOT correctness-equivalent. v14model = real U03 placement record (one {p,r} attr write + top-2 compaction).'
		},
		'small-payload': {
			v14model: modelMoveOnce(5),
			v13: moveOnce('v13', 5)
		},
		'amortized-500-sequential-moves': modelMoveAmortized(),
		'timed-500-char-op': {
			v14: timed.v14,
			v13: timed.v13,
			unit: 'ms per move (rebuild + op), 20-block doc'
		}
	};
};

// ── 3. load / materialization ────────────────────────────────────────────────
// 1,000 blocks: encoded update size, applyUpdate-into-fresh-doc load time, and
// materializing the visible tree.

const buildLoadDoc14 = () => {
	const doc = newDoc14();
	doc.transact(() => {
		for (let i = 0; i < 1000; i++) {
			insertBlock14(doc, null, i, {
				id: `b${i}`,
				type: i % 5 === 0 ? 'quote' : 'paragraph',
				content: [{ text: `block ${i} — some realistic paragraph text.` }]
			});
		}
	});
	return doc;
};

const buildLoadDoc13 = () => {
	const doc = newDoc13();
	doc.transact(() => {
		for (let i = 0; i < 1000; i++) {
			insertBlock13(doc, i, {
				id: `b${i}`,
				type: i % 5 === 0 ? 'quote' : 'paragraph',
				content: [{ text: `block ${i} — some realistic paragraph text.` }]
			});
		}
	});
	return doc;
};

/** Walk the v14 node tree and count blocks/chars (the projection read path). */
const materialize14 = (doc) => {
	let blocks = 0;
	let chars = 0;
	const walk = (container) => {
		container.forEach((child) => {
			if (!(child instanceof Y14.Node)) return;
			blocks++;
			const content = child.getAttr('content');
			if (content instanceof Y14.Node) {
				for (const op of content.delta.toJSON().children ?? []) {
					if (op.type === 'insert' && typeof op.insert === 'string') {
						chars += op.insert.length;
					}
				}
			}
			const children = child.getAttr('children');
			if (children instanceof Y14.Node) walk(children);
		});
	};
	walk(doc.get(ROOT));
	return { blocks, chars };
};

export const load = () => {
	const src14 = buildLoadDoc14();
	const update14 = Y14.encodeStateAsUpdate(src14);
	const src13 = buildLoadDoc13();
	const update13 = Y13.encodeStateAsUpdate(src13);

	const loadTime14 = measure(
		() => {
			const fresh = newDoc14();
			Y14.applyUpdate(fresh, update14);
		},
		{ warmup: 2, samples: 15 }
	);
	const loadTime13 = measure(
		() => {
			const fresh = newDoc13();
			Y13.applyUpdate(fresh, update13);
		},
		{ warmup: 2, samples: 15 }
	);
	const materializeTime14 = measure(() => materialize14(src14), { warmup: 2, samples: 25 });
	const materializeTime13 = measure(() => src13.getArray(ROOT).toJSON(), {
		warmup: 2,
		samples: 25
	});
	return {
		blocks: 1000,
		updateBytes: { v14: update14.byteLength, v13: update13.byteLength },
		loadMs: { v14: loadTime14, v13: loadTime13 },
		materializeMs: { v14: materializeTime14, v13: materializeTime13 },
		note: 'load = applyUpdate into a fresh doc; materialize = walk the node tree (v14) vs Y.Array.toJSON() (v13)'
	};
};

// ── 4. dense-formatting delta ────────────────────────────────────────────────
// A paragraph with 128 alternating format runs; measure delta computation.

const RUNS = 128;

const buildDense14 = () => {
	const doc = newDoc14();
	insertBlock14(doc, null, 0, { id: 'dense', content: [] });
	const content = blockAt14(doc, 0).getAttr('content');
	doc.transact(() => {
		for (let i = 0; i < RUNS; i++) {
			const marks =
				i % 4 === 0
					? { bold: true }
					: i % 4 === 1
						? { italic: true }
						: i % 4 === 2
							? { bold: true, italic: true }
							: undefined;
			content.insert(content.length, `run-${i}-text `, marks);
		}
	});
	return content;
};

const buildDense13 = () => {
	const doc = newDoc13();
	const text = new Y13.Text();
	doc.getArray(ROOT).insert(0, [text]);
	doc.transact(() => {
		for (let i = 0; i < RUNS; i++) {
			const marks =
				i % 4 === 0
					? { bold: true }
					: i % 4 === 1
						? { italic: true }
						: i % 4 === 2
							? { bold: true, italic: true }
							: undefined;
			text.insert(text.length, `run-${i}-text `, marks);
		}
	});
	return text;
};

export const delta = () => {
	const content14 = buildDense14();
	const text13 = buildDense13();
	const v14 = measure(() => content14.toDelta(), { warmup: WARMUP, samples: SAMPLES });
	const v13 = measure(() => text13.toDelta(), { warmup: WARMUP, samples: SAMPLES });
	return {
		runs: RUNS,
		v14,
		v13,
		unit: 'ms per toDelta() of a 128-format-run paragraph'
	};
};

// ── 5. U04 text ownership — split/merge wire bytes ──────────────────────────
// The plan's headline for U04: split/merge encode ONLY ownership records —
// retained characters are never re-encoded, so update size is O(record size),
// not O(text size). v13 has no ownership concept: copy-split/copy-merge
// re-encode the moved text (and silently lose concurrent edits to it — NOT
// correctness-equivalent, included to quantify the cost of the old model).

const buildTextDoc14 = (payloadChars) => {
	const doc = newPlacementDoc14();
	doc.transact(() => {
		insertModelBlock14(doc, {
			id: 'b1',
			rank: 'a00',
			content: [{ text: 'x'.repeat(payloadChars) }]
		});
		insertModelBlock14(doc, {
			id: 'b2',
			rank: 'a01',
			content: [{ text: 'y'.repeat(payloadChars) }]
		});
	});
	return doc;
};

const buildTextDoc13 = (payloadChars) => {
	const doc = newDoc13();
	doc.transact(() => {
		insertBlock13(doc, 0, { id: 'b1', content: [{ text: 'x'.repeat(payloadChars) }] });
		insertBlock13(doc, 1, { id: 'b2', content: [{ text: 'y'.repeat(payloadChars) }] });
	});
	return doc;
};

const splitOnce14 = (payloadChars) => {
	const doc = buildTextDoc14(payloadChars);
	return {
		updateBytes: captureUpdateBytes(doc, () => splitModelBlock14(doc, 'b1', payloadChars / 2, 's1'))
	};
};

const splitOnce13 = (payloadChars) => {
	const doc = buildTextDoc13(payloadChars);
	return {
		updateBytes: captureUpdateBytes(doc, () => splitByCopy13(doc, 0, payloadChars / 2, 's1'))
	};
};

const mergeOnce14 = (payloadChars) => {
	const doc = buildTextDoc14(payloadChars);
	return { updateBytes: captureUpdateBytes(doc, () => mergeModelBlocks14(doc, 'b2', 'b1')) };
};

const mergeOnce13 = (payloadChars) => {
	const doc = buildTextDoc13(payloadChars);
	return { updateBytes: captureUpdateBytes(doc, () => mergeByCopy13(doc, 1, 0)) };
};

/**
 * Scaling series: split update bytes as the block's text grows. Flat for the
 * ownership model (records are anchor pairs + ids), linear for copy-split.
 */
const splitScaling = () =>
	[1_000, 10_000, 100_000].map((payloadChars) => ({
		payloadChars,
		v14model: splitOnce14(payloadChars).updateBytes,
		v13copy: splitOnce13(payloadChars).updateBytes
	}));

export const textOwnership = () => ({
	'split-100k': {
		v14model: splitOnce14(100_000),
		v13copy: splitOnce13(100_000),
		note: 'v13 copy-split re-encodes the moved tail and loses concurrent edits to it — NOT correctness-equivalent.'
	},
	'merge-100k': {
		v14model: mergeOnce14(100_000),
		v13copy: mergeOnce13(100_000),
		note: 'v14 merge = one {m} claim item; v13 copy-merge re-encodes the moved text.'
	},
	'split-scaling': splitScaling(),
	unit: 'bytes emitted on the update channel for one split/merge op'
});
