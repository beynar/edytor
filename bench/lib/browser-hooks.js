/**
 * U0 — in-page instrumentation for `bench/browser.js`. Every export is a
 * SELF-CONTAINED function: Playwright/`addInitScript` serialize the function
 * body into the page, so nothing here may close over module state.
 *
 * Design contract (the U0 repair):
 *  - Product code is NEVER modified. All observation is consumer-side:
 *    `doc.emit`/`doc.transact` instance wraps, DOM listeners, a
 *    MutationObserver, `facade.onChange`, and (diag pages only) DOM-API
 *    prototype wraps installed by an init script.
 *  - Every engine transaction is its own record (`rec.txs[]`), keyed by the
 *    Transaction object, with per-event begin/end marks and an explicit
 *    parent link when the transaction was opened inside another
 *    transaction's event emit (pre-U2 the attribution follow-up was born
 *    inside the committing transaction's `beforeObserverCalls` emit;
 *    post-U2 a keystroke commits exactly one transaction).
 *  - Missing endpoints stay `null` — never clamped to 0, never invented.
 *  - `marks.*` are `performance.now()` ms on the page clock. All marks of
 *    one record share the same clock and the same keystroke identity.
 *  - rAF marks frame-callback scheduling only — never paint.
 */

/**
 * Init script (every page): navigation/mount milestones + a document-level
 * MutationObserver that records when editor DOM first appears. `window.gc`
 * is enabled by the driver via `--js-flags=--expose-gc` so post-GC retained
 * heap can be measured without CDP round-trip variance.
 */
export const MOUNT_INIT = () => {
	const M = (window.__BENCH_MOUNT__ = {
		t0: performance.now(),
		dcl: null,
		mainStart: null,
		mountReturn: null,
		appScript: null,
		benchHandle: null,
		firstEdytor: null,
		firstBlock: null,
		allBlocksSeen: null,
		blocksAtMountReturn: null,
		domAtMountReturn: null,
		moBatches: []
	});
	const stampDcl = () => {
		const nav = performance.getEntriesByType('navigation')[0];
		M.dcl = nav ? nav.domContentLoadedEventEnd : performance.now();
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', stampDcl, { once: true });
	} else {
		stampDcl();
	}
	const params = new URLSearchParams(location.search);
	const target = params.get('fixture') === 'shared' ? 1 : Number(params.get('blocks')) || 0;
	const mo = new MutationObserver((recs) => {
		if (M.done === true) return;
		const now = performance.now();
		let added = 0;
		for (const r of recs) added += r.addedNodes.length;
		if (M.firstEdytor === null && document.querySelector('[data-edytor]')) M.firstEdytor = now;
		const blocks = document.querySelectorAll('[data-edytor-block="true"]').length;
		if (blocks > 0 && M.firstBlock === null) M.firstBlock = now;
		if (target > 0 && blocks >= target && M.allBlocksSeen === null) M.allBlocksSeen = now;
		if (M.moBatches.length < 80)
			M.moBatches.push({
				t: +now.toFixed(3),
				records: recs.length,
				added,
				blocks
			});
		if (M.allBlocksSeen !== null) {
			M.done = true;
			mo.disconnect();
		}
	});
	mo.observe(document, { childList: true, subtree: true });
	// Driver-side escape hatch — stop observing after mount completes even
	// when the block target was never known (shared fixture, error paths).
	M.stop = () => {
		M.done = true;
		mo.disconnect();
	};
};

/**
 * Init script (DIAGNOSTIC pages only — never on timing lanes): prototype
 * wraps that count DOM scans, selection reads, geometry/layout reads,
 * MutationObserver executions, timer/rAF scheduling and per-listener time.
 * Attribution: when `__BENCH_H__.active` is set the counter lands on that
 * record (`rec.diag`), otherwise on `__BENCH_DIAG__.totals` (mount-time and
 * deferred work that fires after a record resolves).
 */
export const DIAG_INIT = () => {
	const now = () => performance.now();
	const D = (window.__BENCH_DIAG__ = { initAt: now(), totals: {} });
	const bump = (bucket, name, ms = 0, n = 1) => {
		// A live record owns its bucket — `??` on `.diag` would leak record-
		// time counters into totals whenever the record hasn't bumped yet.
		const a = window.__BENCH_H__?.active;
		const s = a ? (a.diag ??= {}) : D.totals;
		const b = (s[bucket] ??= {});
		const e = (b[name] ??= { n: 0, ms: 0 });
		e.n += n;
		e.ms += ms;
	};
	const wrapFn = (proto, key, bucket, name, countNodes = false) => {
		if (!proto) return;
		const orig = proto[key];
		if (typeof orig !== 'function' || orig.__benchW) return;
		const w = function (...a) {
			const t = now();
			try {
				const r = orig.apply(this, a);
				if (countNodes && r && typeof r.length === 'number')
					bump(bucket, name + '#nodes', 0, r.length);
				return r;
			} finally {
				bump(bucket, name, now() - t);
			}
		};
		w.__benchW = true;
		Object.defineProperty(proto, key, {
			value: w,
			writable: true,
			configurable: true
		});
	};
	const wrapGet = (proto, key, bucket, name) => {
		if (!proto) return;
		const d = Object.getOwnPropertyDescriptor(proto, key);
		if (!d?.get || d.get.__benchW) return;
		const g = function () {
			const t = now();
			try {
				return d.get.call(this);
			} finally {
				bump(bucket, name, now() - t);
			}
		};
		g.__benchW = true;
		Object.defineProperty(proto, key, { ...d, get: g });
	};

	// DOM scans
	for (const P of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
		wrapFn(P, 'querySelectorAll', 'dom', 'querySelectorAll', true);
		wrapFn(P, 'querySelector', 'dom', 'querySelector');
	}
	wrapFn(Element.prototype, 'closest', 'dom', 'closest');
	wrapFn(Element.prototype, 'matches', 'dom', 'matches');
	wrapFn(Document.prototype, 'getElementById', 'dom', 'getElementById');
	wrapFn(Document.prototype, 'createTreeWalker', 'dom', 'createTreeWalker');
	wrapFn(Document.prototype, 'createNodeIterator', 'dom', 'createNodeIterator');
	wrapFn(Document.prototype, 'createRange', 'dom', 'createRange');
	if (typeof TreeWalker !== 'undefined') {
		wrapFn(TreeWalker.prototype, 'nextNode', 'dom', 'treeWalker.nextNode');
		wrapFn(TreeWalker.prototype, 'previousNode', 'dom', 'treeWalker.prevNode');
	}

	// Selection reads/writes
	if (typeof Selection !== 'undefined') {
		for (const k of [
			'addRange',
			'removeAllRanges',
			'collapse',
			'collapseToStart',
			'collapseToEnd',
			'setBaseAndExtent',
			'extend',
			'getRangeAt',
			'containsNode',
			'selectAllChildren'
		])
			wrapFn(Selection.prototype, k, 'selection', 'sel.' + k);
		for (const k of [
			'anchorNode',
			'focusNode',
			'anchorOffset',
			'focusOffset',
			'isCollapsed',
			'rangeCount'
		])
			wrapGet(Selection.prototype, k, 'selection', 'sel.' + k);
	}
	wrapFn(Window.prototype, 'getSelection', 'selection', 'getSelection');
	wrapFn(Document.prototype, 'getSelection', 'selection', 'doc.getSelection');

	// Forced layout / geometry reads
	for (const P of [Element.prototype, Range.prototype]) {
		wrapFn(P, 'getBoundingClientRect', 'geom', 'getBoundingClientRect');
		wrapFn(P, 'getClientRects', 'geom', 'getClientRects');
	}
	wrapFn(Window.prototype, 'getComputedStyle', 'geom', 'getComputedStyle');
	if (typeof HTMLElement !== 'undefined') {
		for (const k of [
			'offsetWidth',
			'offsetHeight',
			'offsetTop',
			'offsetLeft',
			'clientWidth',
			'clientHeight',
			'scrollWidth',
			'scrollHeight',
			'innerText'
		])
			wrapGet(HTMLElement.prototype, k, 'geom', 'html.' + k);
	}
	wrapFn(Element.prototype, 'scrollIntoView', 'geom', 'scrollIntoView');

	// U8a — serialization: awareness presence encodes (JSON.stringify per
	// broadcast) and full-value exports both serialize on the hot path.
	// `JSON.stringify` is an own writable property of the JSON namespace —
	// wrapping it counts every in-page serialize (product + consumers).
	if (typeof JSON !== 'undefined' && !JSON.stringify.__benchW) {
		const origStringify = JSON.stringify;
		const w = function (...a) {
			const t = now();
			try {
				return origStringify.apply(this, a);
			} finally {
				bump('serialize', 'JSON.stringify', now() - t);
			}
		};
		w.__benchW = true;
		JSON.stringify = w;
	}

	// MutationObserver — callback executions + delivered records. Harness
	// observers tag their callback `__benchHarness` and are not counted.
	const OrigMO = window.MutationObserver;
	if (OrigMO && !OrigMO.__benchW) {
		const WrappedMO = class extends OrigMO {
			constructor(cb) {
				const harness = cb && cb.__benchHarness === true;
				super((m, o) => {
					if (harness) return cb(m, o);
					const t = now();
					try {
						return cb(m, o);
					} finally {
						bump('mo', 'callback', now() - t);
						bump('mo', 'records', 0, m?.length ?? 0);
					}
				});
			}
		};
		WrappedMO.__benchW = true;
		window.MutationObserver = WrappedMO;
	}

	// Timers / frame scheduling — scheduled vs fired (fired lands on the
	// record active at fire time, or totals for deferred/post-record work).
	for (const key of ['setTimeout', 'queueMicrotask', 'requestAnimationFrame']) {
		const orig = window[key];
		if (typeof orig !== 'function' || orig.__benchW) continue;
		const w = function (cb, ...a) {
			const harness = typeof cb === 'function' && cb.__benchHarness === true;
			if (!harness) bump('timers', key + '.scheduled', 0);
			const wrapped =
				typeof cb === 'function'
					? function (...args) {
							if (cb.__benchHarness) return cb.apply(this, args);
							const t = now();
							try {
								return cb.apply(this, args);
							} finally {
								bump('timers', key + '.fired', now() - t);
							}
						}
					: cb;
			return orig.call(this, wrapped, ...a);
		};
		w.__benchW = true;
		window[key] = w;
	}

	// Per-listener time — every listener registered after this init is
	// timed. Async listeners additionally record settle latency (#asyncMs).
	const origAdd = EventTarget.prototype.addEventListener;
	const origRem = EventTarget.prototype.removeEventListener;
	if (!origAdd.__benchW) {
		const wrappedMap = new WeakMap(); // listener → Map<key, wrapped>
		const keyOf = (type, options) =>
			type + '|' + (typeof options === 'boolean' ? options : options?.capture ? 1 : 0);
		const addW = function (type, listener, options) {
			if (!listener || listener.__benchHarness === true)
				return origAdd.call(this, type, listener, options);
			const isFn = typeof listener === 'function';
			const isObj = !isFn && typeof listener.handleEvent === 'function';
			if (!isFn && !isObj) return origAdd.call(this, type, listener, options);
			const key = keyOf(type, options);
			let m = wrappedMap.get(listener);
			if (!m) wrappedMap.set(listener, (m = new Map()));
			if (m.has(key)) return origAdd.call(this, type, listener, options);
			const w = function (ev) {
				const t = now();
				const r = isFn ? listener.call(this, ev) : listener.handleEvent(ev);
				const ms = now() - t;
				bump('listeners', type, ms);
				if (r && typeof r.then === 'function') {
					bump('listeners', type + '#asyncN', 0);
					const settle = () => bump('listeners', type + '#asyncMs', now() - t);
					r.then(settle, settle);
				}
				return r;
			};
			m.set(key, w);
			return origAdd.call(this, type, w, options);
		};
		const remW = function (type, listener, options) {
			const key = keyOf(type, options);
			const w = wrappedMap.get(listener)?.get(key);
			return origRem.call(this, type, w ?? listener, options);
		};
		addW.__benchW = true;
		remW.__benchW = true;
		EventTarget.prototype.addEventListener = addW;
		EventTarget.prototype.removeEventListener = remW;
	}
};

/**
 * The per-record pipeline. One active record at a time; `arm()` for real
 * keystrokes, `runOp()` for synchronous facade ops, `beginCapture()` for
 * driver-bracketed spans (remote apply bursts).
 *
 * Transaction tracking: `doc.emit` is instance-wrapped to bracket every
 * engine lifecycle event (`beforeTransaction`, `beforeObserverCalls`,
 * `afterTransaction`, `afterTransactionCleanup`, `update`, `updateV2`,
 * `beforeAllTransactions`, `afterAllTransactions`). A `beforeTransaction`
 * emitted while another transaction's event emit is on the stack records
 * `{parent: {tx, event}}` — the attribution follow-up's parent is the
 * content transaction, event `beforeObserverCalls`.
 *
 * `doc.transact` is instance-wrapped to time transaction BODIES (`f(tr)`).
 * Transactions opened through the engine's internal module-level
 * `transact` (applyUpdate, cleanupYTextAfterTransaction) never pass
 * through `doc.transact` — their `bodyMs` stays null; `preCleanupMs`
 * (`btE → bocS`) still bounds the body+return for every transaction.
 */
export const INSTALL_HOOKS = () => {
	const { edytor: ed, Y, E, S } = window.__BENCH__;
	const doc = ed.doc;
	const root = document.querySelector('[data-testid="editable-root"] [data-edytor]');
	const now = () => performance.now();
	if (!ed || !doc || !root) return 'missing:' + (!ed ? 'edytor' : !doc ? 'doc' : 'editable-root');

	// ── origin classification — by shape, no product internals ─────────
	const txCtor = ed.transaction?.constructor;
	const rotCtor = ed.remoteOnlyTransaction?.constructor;
	const docTx = ed.document?.transaction;
	const UmCtor = Y.UndoManager;
	const classify = (origin, local) => {
		if (local === false) return 'remote-apply';
		if (origin === null || origin === undefined) return 'local-untyped';
		if (typeof origin === 'symbol') {
			const d = origin.description ?? '';
			if (d === 'edytor.attribution') return 'attribution-record';
			if (d === 'edytor.undo-ownership-repair') return 'undo-repair';
			return 'symbol:' + (d || 'anonymous');
		}
		if (UmCtor && origin instanceof UmCtor) return 'undo-manager';
		if (origin === ed.transaction) return 'view-command';
		if (origin === docTx) return 'document-command';
		if (txCtor && origin instanceof txCtor) return 'view-command';
		if (rotCtor && origin instanceof rotCtor) return 'remote-only-view';
		if (typeof origin === 'string') return 'remote-apply:' + origin;
		return 'object:' + (origin?.constructor?.name ?? typeof origin);
	};
	const originDesc = (o) => {
		if (o === null) return 'null';
		if (o === undefined) return 'undefined';
		if (typeof o === 'symbol') return `Symbol(${o.description ?? ''})`;
		if (typeof o === 'string') return JSON.stringify(o);
		return o?.constructor?.name ?? typeof o;
	};

	const dbg = () => {
		const d = ed.facade.runsView?.debug;
		if (!d) return null;
		const ci = ed.facade.runsView?.commitInfo?.();
		return {
			recomputes: d.recomputes ?? null,
			recomputedBlocks: d.recomputed?.size ?? null,
			recomputedIds: [...(d.recomputed ?? [])].slice(0, 16),
			itemsWalked: d.itemsWalked ?? null,
			markersWalked: d.markersWalked ?? null,
			readIndexBuilds: d.readIndexBuilds ?? null,
			commitFast: ci?.fast ?? null,
			commitSeq: ci?.seq ?? null,
			commitContentBlocks: ci?.content?.size ?? null,
			commitMetaKeys: ci?.meta?.size ?? null
		};
	};

	const H = (window.__BENCH_H__ = {
		root,
		active: null,
		diag: !!window.__BENCH_DIAG__,
		wrapMisses: [],
		m(k) {
			const r = H.active;
			if (r && r.marks[k] === undefined) r.marks[k] = now();
		},
		ml(k) {
			const r = H.active;
			if (r) r.marks[k] = now();
		},
		newRec() {
			return {
				marks: {},
				txs: [],
				updateBytes: 0,
				txCount: 0,
				changeEmits: 0,
				emittedUpdates: 0,
				inputType: null,
				timedOut: null,
				debug: null,
				counters: {},
				diag: undefined
			};
		},
		_observe(rec, resolve) {
			const cb = (muts) => {
				if (rec.marks.dom === undefined) {
					rec.marks.dom = now();
					rec.marks.domMutations = muts.length;
				}
				mo.disconnect();
				const rafCb = (t) => {
					// `t` = the FRAME's timestamp (vsync-aligned; can precede the
					// `dom` mark when the frame was already in flight — spans off
					// `raf` may legitimately invert and report null). `rafCb` =
					// when this callback actually ran.
					rec.marks.raf = t;
					rec.marks.rafCb = now();
					clearTimeout(rec.timer);
					if (H.active === rec) H.active = null;
					rec.debug = dbg();
					resolve(rec);
				};
				rafCb.__benchHarness = true;
				requestAnimationFrame(rafCb);
			};
			cb.__benchHarness = true;
			const mo = new MutationObserver(cb);
			const tcb = () => {
				rec.timedOut = rec.marks.dom === undefined ? 'dom-mutation' : 'raf';
				mo.disconnect();
				if (H.active === rec) H.active = null;
				rec.debug = dbg();
				resolve(rec);
			};
			tcb.__benchHarness = true;
			rec.timer = setTimeout(tcb, rec.timeoutMs);
			mo.observe(root, { subtree: true, childList: true, characterData: true });
			H.active = rec;
		},
		arm(timeoutMs) {
			return new Promise((resolve) => {
				const rec = H.newRec();
				rec.timeoutMs = timeoutMs;
				ed.facade.runsView?.debug?.reset?.();
				H._observe(rec, resolve);
			});
		},
		runOp(fn, timeoutMs) {
			return new Promise((resolve) => {
				const rec = H.newRec();
				rec.timeoutMs = timeoutMs;
				ed.facade.runsView?.debug?.reset?.();
				H._observe(rec, resolve);
				rec.marks.t0 = now();
				fn();
				rec.marks.handlerDone = now();
			});
		},
		/** Bracketed capture for driver-level spans (remote apply bursts). */
		beginCapture(timeoutMs) {
			const rec = H.newRec();
			rec.timeoutMs = timeoutMs;
			ed.facade.runsView?.debug?.reset?.();
			H.active = rec;
			return rec;
		},
		endCapture(rec) {
			if (H.active === rec) H.active = null;
			rec.debug = dbg();
		}
	});

	// ── entry marks (harness listeners — tagged so diag skips them) ────
	const keydownL = () => H.m('keydown');
	keydownL.__benchHarness = true;
	document.addEventListener('keydown', keydownL, true);
	const biCap = (e) => {
		const r = H.active;
		if (r) {
			H.m('beforeinput');
			r.inputType = e.inputType ?? null;
		}
	};
	biCap.__benchHarness = true;
	document.addEventListener('beforeinput', biCap, true);
	// The editor's beforeinput listener is a node-level bubble listener —
	// this document-level bubble listener fires when dispatch completes
	// (all node listeners returned AND inter-listener microtask
	// checkpoints drained — the async handler continuation lands inside
	// that window).
	const biDone = () => H.m('handlerDone');
	biDone.__benchHarness = true;
	document.addEventListener('beforeinput', biDone, false);
	const inputDone = () => H.m('inputDone');
	inputDone.__benchHarness = true;
	document.addEventListener('input', inputDone, false);

	// ── per-transaction records via emit/transact wraps ────────────────
	const TX_EVENTS = {
		beforeAllTransactions: 'bat',
		beforeTransaction: 'bt',
		beforeObserverCalls: 'boc',
		afterTransaction: 'at',
		afterTransactionCleanup: 'atc',
		update: 'upd',
		updateV2: 'upd2',
		afterAllTransactions: 'aat'
	};
	let txSeq = 0;
	const txRecs = new WeakMap(); // engine Transaction → record entry
	const emitStack = []; // [{name, txr}]
	const txOf = (name, args) => {
		if (name === 'update' || name === 'updateV2') return args?.[3];
		if (name === 'afterAllTransactions' || name === 'beforeAllTransactions') return null;
		return args?.[0];
	};
	/** Deterministic content summary — IdSet: clients→ranges→total len. */
	const idSetSummary = (set) => {
		let clients = 0,
			ranges = 0,
			len = 0;
		set?.clients?.forEach?.((r) => {
			clients++;
			const ids = r.getIds?.() ?? [];
			ranges += ids.length;
			for (const id of ids) len += id.len ?? 0;
		});
		return { clients, ranges, len };
	};
	const newTx = (tr) => {
		const r = H.active;
		const parentEntry = emitStack.length ? emitStack[emitStack.length - 1] : null;
		const e = {
			gid: txSeq++,
			id: r ? r.txs.length : -1,
			originCat: classify(tr?.origin, tr?.local),
			originDesc: originDesc(tr?.origin),
			local: tr?.local ?? null,
			parent:
				parentEntry && parentEntry.txr
					? { tx: parentEntry.txr.gid, event: parentEntry.name }
					: null,
			begin: null,
			end: null,
			bodyMs: null,
			bodyCalls: 0,
			marks: {},
			updateBytes: null,
			updateEmitted: null,
			missing: []
		};
		txRecs.set(tr, e);
		if (r) r.txs.push(e);
		return e;
	};
	if (!doc.emit.__benchW) {
		const origEmit = doc.emit.bind(doc);
		const emitW = function (name, args) {
			const tag = TX_EVENTS[name];
			if (!tag) return origEmit(name, args);
			const t = now();
			const tr = txOf(name, args);
			let txr = tr ? txRecs.get(tr) : null;
			const r = H.active;
			if (name === 'beforeTransaction' && tr) {
				txr = newTx(tr);
				txr.begin = t;
				if (r) {
					r.txCount = r.txs.length;
					H.m('tx');
				}
			} else if (tr && !txr && r) {
				// Event for a transaction whose begin predates this record —
				// keep it as an explicit partial row.
				txr = newTx(tr);
				txr.missing.push('beforeTransaction');
			}
			const entry = { name, txr };
			emitStack.push(entry);
			if (txr) txr.marks[tag + 'S'] = t;
			if (name === 'beforeAllTransactions' && r) H.m('bat');
			if (name === 'afterAllTransactions' && r) H.m('commitDone');
			try {
				return origEmit(name, args);
			} finally {
				const t2 = now();
				emitStack.pop();
				if (txr) {
					txr.marks[tag + 'E'] = t2;
					txr[tag + 'Ms'] = t2 - t;
					if (name === 'update') {
						const bytes = args?.[0]?.byteLength ?? null;
						txr.updateBytes = bytes;
						txr.updateEmitted = true;
						txr.end = t2;
						if (r) {
							r.updateBytes += bytes ?? 0;
							r.emittedUpdates += 1;
						}
					} else if (name === 'afterTransactionCleanup' || name === 'afterTransaction') {
						// Terminal marks — overwritten by the update-exit stamp when
						// this transaction does emit an update (cleanup precedes it).
						txr.end = t2;
						if (name === 'afterTransactionCleanup') {
							txr.updateEmitted ??= false;
							// IdSets are populated by now — deterministic content summary.
							txr.insert ??= idSetSummary(tr?.insertSet);
							txr.delete ??= idSetSummary(tr?.deleteSet);
							txr.changedTypes ??= tr?.changed?.size ?? null;
						}
					}
				}
			}
		};
		emitW.__benchW = true;
		doc.emit = emitW;
	}
	const txBodyDepth = new WeakMap(); // Transaction → open wrapF frames
	if (!doc.transact.__benchW) {
		const origTransact = doc.transact.bind(doc);
		const transactW = function (f, origin = null, local = true) {
			const wrapF =
				typeof f === 'function'
					? (tr) => {
							const txr = tr ? txRecs.get(tr) : null;
							const s = now();
							// doc.transact calls JOIN an open transaction — nested
							// wrapF frames would double-count the body. bodyMs
							// accumulates only the outermost call's wall time.
							const depth = txr ? (txBodyDepth.get(tr) ?? 0) + 1 : 0;
							if (txr) {
								txBodyDepth.set(tr, depth);
								txr.bodyCalls++;
								if (depth === 1) txr.marks.bodyS ??= s;
							}
							try {
								return f(tr);
							} finally {
								const e = now();
								if (txr) {
									txBodyDepth.set(tr, depth - 1);
									if (depth === 1) {
										txr.bodyMs = (txr.bodyMs ?? 0) + (e - s);
										txr.marks.bodyE = e;
									}
								}
							}
						}
					: f;
			return origTransact(wrapF, origin, local);
		};
		transactW.__benchW = true;
		doc.transact = transactW;
	}

	// ── publication mark — subscriber added LAST, fires after the editor's
	// own onChange (which already ran flushMirror + presence refresh). ────
	ed.facade.onChange(() => {
		const r = H.active;
		if (r) {
			r.changeEmits += 1;
			H.m('published');
		}
	});

	// ── method-call counters — wrapped instance methods, per-record ────
	// `time:false` counts calls only (hot paths called O(blocks) per commit
	// — the counter itself must not perturb the timing it measures).
	const wrapCall = (obj, key, { time = true, mark = null } = {}) => {
		const name = key;
		if (!obj) {
			H.wrapMisses.push(name);
			return false;
		}
		const orig = obj[key];
		if (typeof orig !== 'function' || orig.__benchW) {
			H.wrapMisses.push(name);
			return false;
		}
		const w = function (...a) {
			const r = H.active;
			if (!r) return orig.apply(this, a);
			const t = time || mark ? now() : 0;
			if (mark) r.marks[mark + 'S'] ??= t;
			const c = (r.counters[name] ??= { n: 0, ms: 0 });
			c.n++;
			let res;
			try {
				res = orig.apply(this, a);
			} finally {
				const e = now();
				if (time) c.ms += e - t;
				if (mark) r.marks[mark + 'E'] = e;
			}
			if (res && typeof res.then === 'function') {
				return res.then(
					(v) => {
						if (time) {
							const c2 = (r.counters[name + '#async'] ??= { n: 0, ms: 0 });
							c2.n++;
							c2.ms += now() - t;
						}
						return v;
					},
					(err) => {
						throw err;
					}
				);
			}
			return res;
		};
		w.__benchW = true;
		obj[key] = w;
		return true;
	};

	// Coarse paths — count + time.
	wrapCall(ed.facade, 'project');
	wrapCall(ed.facade, 'positionOf');
	wrapCall(ed.facade, 'pathOf');
	wrapCall(ed.facade, 'parentOf');
	wrapCall(ed.facade, 'listBlockIds');
	wrapCall(ed, '_projectedTree');
	wrapCall(ed, 'projectedChildren');
	wrapCall(ed, 'applyMirrorChange');
	wrapCall(ed, 'getTextNode');
	wrapCall(ed, 'refreshRemotePresence');
	wrapCall(ed, 'transact');
	wrapCall(ed, 'flushMirror', { mark: 'mirror' });
	if (ed.selection) {
		wrapCall(ed.selection, 'setAtTextOffset');
		wrapCall(ed.selection, 'setAtRange');
		wrapCall(ed.selection, 'setAtTextsRange');
		wrapCall(ed.selection, 'setAtNodeOffset');
		wrapCall(ed.selection, 'setAtBlockRange');
		wrapCall(ed.selection, 'applySelectionSnapshot');
		wrapCall(ed.selection, 'findTextNode');
		wrapCall(ed.selection, 'restoreRelativePosition');
		// U8a — restore + emit fanout: restoreRangeSelectionSnapshot is the
		// undo/redo restore loop; emitSelectionChange carries the publish +
		// consumer notify (dedupe should shrink this to ~1/selection change).
		wrapCall(ed.selection, 'restoreRangeSelectionSnapshot');
		wrapCall(ed.selection, 'emitSelectionChange');
		wrapCall(ed.selection, 'resolveTextAnchor');
	}
	// Hot paths — count only.
	wrapCall(ed.facade, 'contentItems', { time: false });
	wrapCall(ed.facade, 'runs', { time: false });
	wrapCall(ed.facade, 'contentJSON', { time: false });
	wrapCall(ed.facade, 'snapshot', { time: false });
	wrapCall(ed, 'projectedBlock', { time: false });
	wrapCall(ed, 'isVisibleBlockId', { time: false });
	// U8a — scoped selection/facade reads: anchor resolution was the ~25ms
	// selection-restore tail at 5k (project() ×2 per restore).
	wrapCall(ed.facade, 'resolveAnchor');
	wrapCall(ed.facade, 'anchorAt');
	wrapCall(ed.facade, 'isVisibleBlock', { time: false });
	if (ed.facade.runsView) {
		wrapCall(ed.facade.runsView, 'runs', { time: false });
		wrapCall(ed.facade.runsView, 'contentItems', { time: false });
		wrapCall(ed.facade.runsView, 'contentJSON', { time: false });
		wrapCall(ed.facade.runsView, 'snapshot', { time: false });
	}

	// ── U8a — awareness fanout: setLocalState calls + per-event emit ──
	// counts (each 'update'/'change' re-runs every subscriber — the
	// publish dedupe + subscription coalescing should shrink both).
	const awareness = ed.awareness;
	if (awareness) {
		wrapCall(awareness, 'setLocalState');
		const origAEmit = awareness.emit;
		if (typeof origAEmit === 'function' && !origAEmit.__benchW) {
			const emitW = function (name, args) {
				const r = H.active;
				const t = now();
				try {
					return origAEmit.call(this, name, args);
				} finally {
					if (r) {
						const ms = now() - t;
						for (const key of ['awareness.emit', 'awareness.emit:' + String(name)]) {
							const c = (r.counters[key] ??= { n: 0, ms: 0 });
							c.n++;
							c.ms += ms;
						}
					}
				}
			};
			emitW.__benchW = true;
			awareness.emit = emitW;
		}
	}

	// ── U8a — `value` getter: every read bumps `ed.value` (the memoized
	// full-document export); a separate `ed.value#miss` counter records
	// the reads that actually recomputed (returned object identity change
	// approximates a memo miss — same identity = cache hit).
	const valueDesc =
		Object.getOwnPropertyDescriptor(ed, 'value') ??
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ed), 'value');
	if (valueDesc?.get && !valueDesc.get.__benchW) {
		let lastValue = undefined;
		const g = function () {
			const r = H.active;
			const t = now();
			let v;
			try {
				v = valueDesc.get.call(this);
				return v;
			} finally {
				if (r) {
					const ms = now() - t;
					const c = (r.counters['ed.value'] ??= { n: 0, ms: 0 });
					c.n++;
					c.ms += ms;
					if (v !== lastValue) {
						lastValue = v;
						const m = (r.counters['ed.value#miss'] ??= { n: 0, ms: 0 });
						m.n++;
						m.ms += ms;
					}
				}
			}
		};
		g.__benchW = true;
		Object.defineProperty(ed, 'value', {
			configurable: true,
			enumerable: valueDesc.enumerable ?? false,
			get: g,
			set: valueDesc.set
		});
	}
	// flushMirror is counted above; re-wrap is unnecessary — the `mark`
	// option on its wrapCall already stamps mirrorS/mirrorE.

	// Named ops for the facade lanes.
	window.__BENCH_OPS__ = {
		insertText: (a) => ed.facade.insertText(a[0], a[1], a[2]),
		deleteText: (a) => ed.facade.deleteText(a[0], a[1], a[2]),
		formatRange: (a) => ed.facade.formatRange(a[0], a[1], a[2], a[3]),
		setMark: (a) => ed.facade.setMark(a[0], a[1], a[2], a[3], a[4]),
		splitBlock: (a) => ed.facade.splitBlock(a[0], a[1], a[2]),
		undo: () => ed.undoManager.undo(),
		redo: () => ed.undoManager.redo()
	};
	window.__BENCH_ENGINE__ = { Y, E, S, doc };
	return 'installed';
};

/**
 * Post-mount render verification. `blocks`/`chars` come from the fixture
 * spec; text is verified by JOINING every serialized `[data-edytor-text]`
 * part per block — mark boundaries split logical text into multiple
 * elements. Returns honest counts, never throws.
 */
export const VERIFY_RENDERED = ({ blocks, chars, fixture }) => {
	const els = [...document.querySelectorAll('[data-edytor-block="true"]')];
	let joinedChars = 0;
	let blocksWithText = 0;
	const samples = [];
	for (const b of els) {
		// Strip U+200B zero-width space placeholders from rendered text.
		const joined = [...b.querySelectorAll('[data-edytor-text="true"]')]
			.map((el) => (el.textContent ?? '').replace(/\u200B/g, ''))
			.join('');
		joinedChars += joined.length;
		if (joined.length > 0) blocksWithText++;
		if (samples.length < 4)
			samples.push({ id: b.getAttribute('data-edytor-id'), chars: joined.length });
	}
	// Flat fixture: every block holds a `chars`-length text run. Shared
	// fixture: a single block holding the whole `chars`-length run.
	const expectedChars = blocks * chars;
	return {
		blocksFound: els.length,
		blocksExpected: blocks,
		blocksWithText,
		joinedChars,
		expectedChars,
		samples
	};
};

/**
 * Headless document lifecycle — separable from the mounted path: how long
 * `createDocument({value})` / `encode()` / `loadDocument()` take on this
 * page with the same fixture, without a view. `transact` calls on the
 * engine Doc prototype are counted during each call only (a call joins an
 * open transaction without creating one — count only real transactions).
 */
export const HEADLESS_DOC_RUN = () => {
	const { D, Y, seed } = window.__BENCH__ ?? {};
	if (!D?.createDocument || !seed) return { skipped: 'no bindDocument/seed on __BENCH__' };
	const now = () => performance.now();
	const countTxs = (fn) => {
		let txs = 0;
		const proto = Y.Doc.prototype;
		const orig = proto.transact;
		proto.transact = function (f, o, l) {
			// `_transaction === null` at entry = a real new transaction;
			// nested calls join the open one (not counted).
			if (this._transaction === null) txs++;
			return orig.call(this, f, o, l);
		};
		try {
			return { out: fn(), txs };
		} finally {
			proto.transact = orig;
		}
	};
	const c = countTxs(() => {
		const t = now();
		const d = D.createDocument({ value: seed });
		return { d, ms: now() - t };
	});
	const d1 = c.out.d;
	let e;
	try {
		e = countTxs(() => {
			const t = now();
			const bytes = d1.encode();
			return { bytes, ms: now() - t };
		});
	} catch (err) {
		d1.destroy();
		return { skipped: 'encode failed: ' + String(err), createMs: c.out.ms };
	}
	let l;
	try {
		l = countTxs(() => {
			const t = now();
			const d = D.loadDocument(e.out.bytes);
			return { d, ms: now() - t };
		});
	} catch (err) {
		d1.destroy();
		return {
			skipped: 'loadDocument failed: ' + String(err),
			createMs: c.out.ms,
			encodeBytes: e.out.bytes.byteLength
		};
	}
	const d2 = l.out.d;
	const out = {
		createMs: +c.out.ms.toFixed(3),
		createTxs: c.txs,
		encodeMs: +e.out.ms.toFixed(3),
		encodeBytes: e.out.bytes.byteLength,
		loadMs: +l.out.ms.toFixed(3),
		loadTxs: l.txs,
		createdBlocks: d1.facade.listBlockIds().length,
		loadedBlocks: d2.facade.listBlockIds().length,
		note: 'post-mount headless measurement on the same page; createTxs/loadTxs = real transactions opened during the call'
	};
	d2.destroy();
	d1.destroy();
	return out;
};

/**
 * DIAGNOSTIC peer lanes only — inject a synthetic remote presence entry
 * (a peer caret on `textId`) directly into `awareness.states` and emit a
 * 'change'. From then on every local commit re-runs
 * `getRenderedRemoteSelections` (doc 'update' → RemoteSelections refresh)
 * so the remote-geometry path is exercised per keystroke — measured via
 * the diag `geom.*`/`dom.createRange` buckets and the `awareness.emit*`
 * counters. The entry is a faithful wire shape (legacy `selection` mirror
 * + per-view `selections` map, `t` publish sequence), NOT a networked
 * client — no provider/sync machinery is involved.
 */
export const SEED_REMOTE_PEER = ({ blockId, yStart = 2, yEnd = 10 }) => {
	const ed = window.__BENCH__?.edytor;
	const awareness = ed?.awareness;
	if (!ed || !awareness) return { skipped: 'no edytor/awareness' };
	const textId = ed.idToBlock?.get(blockId)?.firstText?.id;
	if (!textId) return { skipped: `no text for block ${blockId}` };
	let peerId = 1;
	while (peerId === ed.doc.clientID || awareness.states.has(peerId)) peerId++;
	const entry = {
		start: null,
		end: null,
		startTextId: textId,
		endTextId: textId,
		yStart,
		yEnd,
		isCollapsed: false,
		isReversed: false,
		t: 1
	};
	awareness.states.set(peerId, {
		user: { name: 'BenchPeer', color: '#e11d48' },
		selection: { ...entry },
		selections: { 'view-peer': { ...entry } }
	});
	awareness.emit('change', [{ added: [peerId], updated: [], removed: [] }, 'bench-peer-seed']);
	return { peerId, clientID: ed.doc.clientID };
};

/**
 * DIAGNOSTIC pages only — per-instance method wraps on every existing
 * block/text wrapper (reconcile paths, per-text model refreshes). Runs
 * after mount so the full wrapper set exists. Wrapped work lands in
 * `rec.counters` / `rec.diag` via the same `wrapCall` machinery.
 */
export const DIAG_WRAP_WRAPPERS = () => {
	const { edytor: ed } = window.__BENCH__ ?? {};
	const H = window.__BENCH_H__;
	if (!ed || !H) return { skipped: 'no __BENCH__/__BENCH_H__' };
	const now = () => performance.now();
	const bump = (name, ms) => {
		const s = H.active ? (H.active.diag ??= {}) : window.__BENCH_DIAG__?.totals;
		if (!s) return;
		const b = (s.wrappers ??= {});
		const e = (b[name] ??= { n: 0, ms: 0 });
		e.n++;
		e.ms += ms;
	};
	const wrap = (obj, key, name) => {
		const orig = obj?.[key];
		if (typeof orig !== 'function' || orig.__benchW) return false;
		const w = function (...a) {
			const t = now();
			try {
				return orig.apply(this, a);
			} finally {
				bump(name, now() - t);
			}
		};
		w.__benchW = true;
		obj[key] = w;
		return true;
	};
	let n = 0;
	for (const b of ed.idToBlock?.values?.() ?? []) {
		for (const k of ['reconcileChildren', 'reconcileContent', '_reconcile', '_bind', '_drop'])
			if (wrap(b, k, 'Block.' + k)) n++;
	}
	for (const t of ed.idToText?.values?.() ?? []) {
		for (const k of [
			'refreshFromModel',
			'syncFromModel',
			'refreshFromProject',
			'_setItems',
			'syncDerived',
			'_bind',
			'_bindRun',
			'_kill'
		])
			if (wrap(t, k, 'Text.' + k)) n++;
	}
	return { wrapped: n, blocks: ed.idToBlock?.size ?? 0, texts: ed.idToText?.size ?? 0 };
};
