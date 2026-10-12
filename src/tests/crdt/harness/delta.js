/**
 * Test-only delta reader and writer over the vendored engine (UPSTREAM.md YP16).
 *
 * The fork ships no delta layer: `toDelta`, `applyDelta`, `YEvent#delta`/`getDelta`,
 * `YNode.from` and the maintained `node.delta` are gone from `edytor/crdt`. The
 * tests that compare the engine's state or changes as lib0 deltas (the upstream
 * suite, the marker differentials, the range-cursor oracle) read and write through
 * these ports instead — the engine's own code, renderer-free, as it stood before
 * YP16, built on the engine's internal helpers. Never imported by `src/lib`.
 *
 * Since YP19 the engine writes no plain format: `applyDelta` writes a
 * formatted op as paired mark operations (`node.mark`), and the reader renders
 * the paired marks (and any plain format item an older engine wrote).
 */
import * as delta from 'lib0-v14/delta';
import * as map from 'lib0-v14/map';
import * as set from 'lib0-v14/set';
import * as object from 'lib0-v14/object';
import * as error from 'lib0-v14/error';

import { YNode } from '../../../lib/crdt/vendor/yjs/src/ynode.js';
import { transact } from '../../../lib/crdt/vendor/yjs/src/utils/Transaction.js';
import { findIndexSS } from '../../../lib/crdt/vendor/yjs/src/utils/transaction-helpers.js';
import {
	diffIdSet,
	mergeIdSets,
	findRangeStartInIdRanges
} from '../../../lib/crdt/vendor/yjs/src/utils/ids.js';
import {
	foldPaired,
	formatValue,
	pairedRole
} from '../../../lib/crdt/vendor/yjs/src/utils/marks.js';

// Content refs (`getRef`) and a node test by shape: the reader serves any copy of the fork
// engine (the YP7/YP11 differentials load stripped copies), not only this module graph.
const REF_DELETED = 1;
const REF_STRING = 4;
const REF_FORMAT = 6;
const REF_TYPE = 7;
/** @param {any} v */
const isNode = (v) => v != null && typeof v === 'object' && v._map instanceof Map && '_start' in v;

/**
 * @param {any} a
 * @param {any} b
 * @return {boolean}
 */
const equalFormats = (a, b) =>
	a === b || (typeof a === 'object' && typeof b === 'object' && a && b && object.equalFlat(a, b));

/**
 * The pieces of `[clock, clock + len)` of `client`, each in `ids` or not
 * (the engine's `IdSet#slice` before YP19).
 *
 * @param {any} ids
 * @param {number} client
 * @param {number} clock
 * @param {number} len
 * @return {Array<{ clock: number, len: number, exists: boolean }>}
 */
const idSlice = (ids, client, clock, len) => {
	const res = [];
	const dr = ids.clients.get(client);
	if (dr) {
		const ranges = dr.getIds();
		let index = findRangeStartInIdRanges(ranges, clock);
		if (index !== null) {
			let prevEnd = clock;
			for (; index < ranges.length; index++) {
				const r = ranges[index];
				const from = Math.max(r.clock, clock);
				const to = Math.min(r.clock + r.len, clock + len);
				if (to <= from) break;
				if (prevEnd < from) res.push({ clock: prevEnd, len: from - prevEnd, exists: false });
				res.push({ clock: from, len: to - from, exists: true });
				prevEnd = to;
			}
		}
	}
	const last = res[res.length - 1];
	const end = last ? last.clock + last.len : clock;
	if (end < clock + len) res.push({ clock: end, len: clock + len - end, exists: false });
	return res;
};

/**
 * Every struct `ids` mentions, without splitting any (the engine's helper went with YP16).
 *
 * @param {any} store
 * @param {any} ids
 * @param {(struct: any) => void} f
 */
const forEachStruct = (store, ids, f) =>
	ids.clients.forEach((/** @type {any} */ idRanges, /** @type {number} */ client) => {
		const structs = store.clients.get(client);
		if (structs == null) return;
		const last = structs[structs.length - 1];
		const next = last.id.clock + last.length;
		for (const range of idRanges.getIds()) {
			if (range.clock >= next || range.len === 0) continue;
			const end = range.clock + range.len;
			for (
				let i = findIndexSS(structs, range.clock);
				i < structs.length && structs[i].id.clock < end;
				i++
			)
				f(structs[i]);
		}
	});

/**
 * @param {any} store
 * @param {any} items
 */
const computeModifiedFromItems = (store, items) => {
	/** @type {Map<YNode,Set<null|string>>} */
	const modified = new Map();
	forEachStruct(
		store,
		items,
		/** @param {any} item */ (item) => {
			while (item != null && item.content !== undefined) {
				const parent = /** @type {YNode} */ (item.parent);
				const conf = map.setIfUndefined(modified, parent, set.create);
				if (conf.has(item.parentSub)) break; // has already been marked as modified
				conf.add(item.parentSub);
				item = parent._item;
			}
		}
	);
	return modified;
};

/**
 * A node's attrs as delta attr ops (renderer-free `nodeMapGetDelta`).
 *
 * @param {any} d
 * @param {YNode} parent
 * @param {Set<string|null>?} attrsToRender
 * @param {boolean} deep
 * @param {Map<YNode,any>|null} modified
 * @param {any} itemsToRender
 * @param {any} optsAll
 */
const nodeMapGetDelta = (d, parent, attrsToRender, deep, modified, itemsToRender, optsAll) => {
	/**
	 * @param {Item} item
	 * @param {string} key
	 */
	const renderAttrs = (item, key) => {
		const content = item.content.getContent();
		let c = content[content.length - 1];
		if (item.deleted) {
			if (itemsToRender != null && itemsToRender.hasId(item.lastId)) d.deleteAttr(key);
		} else if (deep && isNode(c) && modified?.has(c)) {
			d.modifyAttr(key, toDelta(c, optsAll));
		} else {
			if (deep && isNode(c)) c = toDelta(c, optsAll);
			d.setAttr(key, c);
		}
	};
	if (attrsToRender == null) {
		parent._map.forEach(renderAttrs);
	} else {
		attrsToRender.forEach(
			(key) => key != null && renderAttrs(/** @type {Item} */ (parent._map.get(key)), key)
		);
	}
};

/**
 * The node's content (or a change of it) as a lib0 delta — the engine's `toDelta` as it stood
 * before YP16, without the renderer.
 *
 * @param {YNode} node
 * @param {{ itemsToRender?: any, retainInserts?: boolean, retainDeletes?: boolean, insertedItems?: any, modified?: Map<YNode,Set<string|null>>|null, deep?: boolean }} [opts]
 * @return {any}
 */
export const toDelta = (node, opts = {}) => {
	if (typeof node.toDelta === 'function') return node.toDelta(opts); // an engine that still ships the delta layer (the pristine upstream baseline)
	const {
		itemsToRender = null,
		retainInserts = false,
		retainDeletes = false,
		insertedItems = null,
		deep = false
	} = opts;
	const {
		modified = deep && itemsToRender
			? computeModifiedFromItems(/** @type {any} */ (node.doc).store, itemsToRender)
			: null
	} = opts;
	const renderAttrs = modified?.get(node) || null;
	const renderChildren =
		modified == null ||
		!modified.has(node) ||
		/** @type {Set<string|null>} */ (modified.get(node)).has(null);
	const d = /** @type {any} */ (delta.create(node.name));
	const optsAll = object.assign({}, opts, { modified });
	nodeMapGetDelta(d, node, renderAttrs, deep, modified, itemsToRender, optsAll);
	if (renderChildren) {
		/** @type {Object<string,any>} */
		let currentFormats = {};
		/** YP13: the open paired mark operations, by mark. @type {Map<string,any>} */
		const pairedFormats = new Map();
		let usingCurrentFormats = false;
		/** @type {Object<string,any>} */
		let changedFormats = {};
		let usingChangedFormats = false;
		/** @type {Object<string,any>} */
		const previousFormats = {};
		/**
		 * A format item's effect on the format state (`render`: the item is part of this render).
		 *
		 * @param {ContentFormat} content
		 * @param {boolean} deleted
		 * @param {boolean} render
		 */
		const processFormat = (content, deleted, render) => {
			const renderContent = render && !deleted;
			const renderDelete = render && deleted;
			const retainContent = !render && !deleted;
			let { key, value } = content;
			if (pairedRole(content) >= 0) {
				if (deleted) return;
				foldPaired(pairedFormats, content);
				key = key.slice(1);
				value = formatValue(pairedFormats.get(key) ?? null);
			}
			if (renderContent || renderDelete) {
				if (usingCurrentFormats) {
					currentFormats = object.assign({}, currentFormats);
					usingCurrentFormats = false;
				}
				if (usingChangedFormats) {
					usingChangedFormats = false;
					changedFormats = object.assign({}, changedFormats);
				}
				if (deleted) {
					if (itemsToRender !== null && !retainInserts) previousFormats[key] = value;
				} else {
					if (retainInserts) previousFormats[key] = value;
					if (value == null) {
						delete currentFormats[key];
					} else {
						currentFormats[key] = value;
					}
				}
				if (equalFormats(currentFormats[key] ?? null, previousFormats[key] ?? null)) {
					delete changedFormats[key];
				} else {
					changedFormats[key] = currentFormats[key] ?? null;
				}
			} else if (retainContent) {
				if (usingCurrentFormats) {
					currentFormats = object.assign({}, currentFormats);
					usingCurrentFormats = false;
				}
				if (usingChangedFormats && changedFormats[key] !== undefined) {
					usingChangedFormats = false;
					changedFormats = object.assign({}, changedFormats);
				}
				if (value == null) {
					delete currentFormats[key];
				} else {
					currentFormats[key] = value;
				}
				delete changedFormats[key];
				previousFormats[key] = value;
			}
		};
		for (let item = node._start; item !== null; item = item.right) {
			const content = item.content;
			if (itemsToRender === null && !retainInserts) {
				// current-state render
				if (content.getRef() === REF_FORMAT) {
					processFormat(/** @type {ContentFormat} */ (content), item.deleted, !item.deleted);
				} else if (!item.deleted) {
					d.useFormats(currentFormats);
					usingCurrentFormats = true;
					if (content.getRef() === REF_STRING) {
						d.insert(/** @type {ContentString} */ (content).str);
					} else if (deep && content.getRef() === REF_TYPE) {
						d.insert([toDelta(/** @type {ContentType} */ (content).type, optsAll)]);
					} else {
						d.insert(content.getContent());
					}
				}
				continue;
			}
			if (content.getRef() === REF_FORMAT) {
				processFormat(
					/** @type {ContentFormat} */ (content),
					item.deleted,
					itemsToRender == null ? !item.deleted : itemsToRender.has(item.id.client, item.id.clock)
				);
			} else if (item.deleted) {
				// in a change render, the ranges deleted by this change emit `delete` ops
				if (
					itemsToRender !== null &&
					itemsToRender.intersects(item.id.client, item.id.clock, item.length)
				) {
					const rslice = idSlice(itemsToRender, item.id.client, item.id.clock, item.length);
					for (let ir = 0; ir < rslice.length; ir++) {
						const idrange = rslice[ir];
						if (idrange.exists) {
							d.delete(
								content.getRef() === REF_STRING || content.getRef() === REF_DELETED
									? idrange.len
									: 1
							);
						}
					}
				}
			} else if (itemsToRender == null) {
				// retainInserts without a change set: existing content is retained
				d.useFormats(changedFormats);
				usingChangedFormats = true;
				d.retain(
					content.getLength(),
					undefined,
					d.usedAttribution == null
						? null
						: { insert: null, insertAt: null, delete: null, deleteAt: null }
				);
			} else {
				// change render on alive content: inserted ranges become inserts, everything else retains
				const rslice = idSlice(itemsToRender, item.id.client, item.id.clock, item.length);
				let itemContent = rslice.length > 1 ? content.copy() : content;
				for (let ir = 0; ir < rslice.length; ir++) {
					const idrange = rslice[ir];
					const c = itemContent;
					if (ir !== rslice.length - 1) {
						itemContent = itemContent.splice(idrange.len);
					}
					if (!idrange.exists) {
						if (
							content.getRef() === REF_TYPE &&
							modified?.has(/** @type {ContentType} */ (content).type)
						) {
							d.modify(toDelta(/** @type {ContentType} */ (content).type, optsAll));
						} else {
							d.useFormats(changedFormats);
							usingChangedFormats = true;
							d.retain(content.getRef() === REF_STRING ? idrange.len : 1);
						}
					} else if (retainInserts) {
						if (
							content.getRef() === REF_TYPE &&
							modified?.has(/** @type {ContentType} */ (content).type)
						) {
							d.modify(
								toDelta(/** @type {ContentType} */ (content).type, optsAll),
								undefined,
								d.usedAttribution == null
									? null
									: { insert: null, insertAt: null, delete: null, deleteAt: null }
							);
						} else {
							d.useFormats(changedFormats);
							usingChangedFormats = true;
							d.retain(
								idrange.len,
								undefined,
								d.usedAttribution == null
									? null
									: { insert: null, insertAt: null, delete: null, deleteAt: null }
							);
						}
					} else {
						d.useFormats(currentFormats);
						usingCurrentFormats = true;
						if (deep && content.getRef() === REF_TYPE) {
							d.insert([toDelta(/** @type {ContentType} */ (content).type, optsAll)]);
						} else if (content.getRef() === REF_STRING) {
							d.insert(/** @type {ContentString} */ (c).str);
						} else {
							d.insert(c.getContent());
						}
					}
				}
			}
		}
	}
	return d.done(false);
};

/**
 * @param {YNode} node
 * @param {Object} [opts]
 */
export const toDeltaDeep = (node, opts = {}) => toDelta(node, { ...opts, deep: true });

/** @type {WeakMap<any, { delta?: any, deltaDeep?: any }>} */
const eventDeltas = new WeakMap();

/**
 * What a `YEvent` changed, as a lib0 delta (the engine's `YEvent#getDelta` before YP16).
 *
 * @param {any} event
 * @param {{ deep?: boolean }} [opts]
 * @return {any}
 */
export const getDelta = (event, { deep = false } = {}) => {
	const insertSet = event.transaction.insertSet;
	const deleteSet = event.transaction.deleteSet;
	const itemsToRender = mergeIdSets([
		diffIdSet(insertSet, deleteSet),
		diffIdSet(deleteSet, insertSet)
	]);
	/** @type {Map<YNode,Set<string|null>>} */
	let modified = event.transaction.changed;
	if (deep) {
		const dchanged = new Map();
		modified.forEach((attrs, type) => {
			dchanged.set(type, new Set(attrs));
		});
		for (let m of modified.keys()) {
			while (m._item != null) {
				const item = m._item;
				const ms = map.setIfUndefined(dchanged, item?.parent, set.create);
				if (item && !ms.has(item.parentSub)) {
					ms.add(item.parentSub);
					m = /** @type {any} */ (item.parent);
				} else {
					break;
				}
			}
		}
		modified = dchanged;
	}
	return toDelta(event.target, {
		itemsToRender,
		retainDeletes: true,
		insertedItems: insertSet,
		deep,
		modified
	});
};

/**
 * `event.delta` before YP16 (computed once per event).
 *
 * @param {any} event
 */
export const eventDelta = (event) => {
	const cached = map.setIfUndefined(eventDeltas, event, () => ({}));
	return cached.delta ?? (cached.delta = getDelta(event).done());
};

/**
 * `event.deltaDeep` before YP16 (computed once per event).
 *
 * @param {any} event
 */
export const eventDeltaDeep = (event) => {
	const cached = map.setIfUndefined(eventDeltas, event, () => ({}));
	return cached.deltaDeep ?? (cached.deltaDeep = getDelta(event, { deep: true }));
};

/**
 * Elements of an insert: a delta becomes a node (`YNode.from` before YP16).
 *
 * @param {Array<any>} insert
 */
const nodesOf = (insert) =>
	insert.map((ins) => (delta.$deltaAny.check(ins) ? fromDelta(ins) : ins));

/**
 * A detached node holding `d` (`YNode.from` before YP16).
 *
 * @param {any} d
 * @return {YNode}
 */
export const fromDelta = (d) => {
	const node = new YNode(d.name);
	applyDelta(node, d);
	return node;
};

/** The formats (marks) shown at live index `index` of `node` (`{}`: none). */
const formatsAt = (node, index) => {
	for (const op of toDelta(node).children) {
		const len = op.insert?.length ?? 0;
		if (index < len) return op.format ?? {};
		index -= len;
	}
	return {};
};

/**
 * The marks a detached node's formatted ops ask for, written once it
 * integrates (a mark is an operation on integrated text, YP19).
 *
 * @type {WeakMap<any, Array<[number, number, Object<string, any>, boolean]>>}
 */
const pendingMarks = new WeakMap();

/**
 * Give `[index, index + length)` of `node` the formats `format`: one paired
 * mark operation per key (YP19: the engine's only formats). `exact`: the
 * keys `format` does not name are removed too (an insert's formats are
 * exactly its own, as the engine's formatted insert made them).
 *
 * @param {any} node
 * @param {number} index
 * @param {number} length
 * @param {Object<string, any>|null|undefined} format
 * @param {boolean} exact
 */
const markRange = (node, index, length, format, exact) => {
	if (length <= 0 || (format == null && !exact)) return;
	if (node.doc == null) {
		const pending = pendingMarks.get(node) ?? [];
		pendingMarks.set(node, [...pending, [index, length, format ?? {}, exact]]);
		return;
	}
	const want = format ?? {};
	const have = exact ? formatsAt(node, index) : {};
	for (const key of new Set([...Object.keys(have), ...Object.keys(want)])) {
		const value = want[key] === undefined ? null : want[key];
		if (key in want || !equalFormats(have[key] ?? null, value))
			node.mark(index, length, key, value, 0, 0);
	}
};

/**
 * Write the pending marks of `node`'s subtree (it is integrated now).
 *
 * @param {any} node
 */
const writePendingMarks = (node) => {
	if (!isNode(node) || node.doc == null) return;
	for (const [index, length, format, exact] of pendingMarks.get(node) ?? [])
		markRange(node, index, length, format, exact);
	pendingMarks.delete(node);
	node._map.forEach((/** @type {any} */ item) => {
		if (!item.deleted) writePendingMarks(item.content.getContent()[item.length - 1]);
	});
	for (let item = node._start; item !== null; item = item.right)
		if (!item.deleted && item.countable) item.content.getContent().forEach(writePendingMarks);
};

/**
 * The element at live index `index` of `node` (a detached node's from its pending content).
 *
 * @param {any} node
 * @param {number} index
 */
const childAt = (node, index) => {
	if (node.doc == null)
		return node._prelim?.runs.flatMap((/** @type {any} */ r) =>
			typeof r === 'string' ? [...r] : r
		)[index];
	for (let item = node._start; item !== null; item = item.right) {
		if (item.deleted || !item.countable) continue;
		if (index < item.length) return item.content.getContent()[index];
		index -= item.length;
	}
	error.unexpectedCase();
};

/**
 * Apply a lib0 delta to `node` through its writes (YP19): inserts, retains
 * and deletes by live index, a formatted op as paired mark operations (an
 * insert takes exactly its formats, a retain sets the keys it names), then
 * the attrs.
 *
 * @param {YNode} node
 * @param {any} d
 */
export const applyDelta = (node, d) => {
	if (typeof node.applyDelta === 'function') return node.applyDelta(d); // an engine that still ships the delta layer (the pristine upstream baseline)
	if (d.isEmpty()) return;
	const write = () => {
		let index = 0;
		for (const op of d.children) {
			if (delta.$textOp.check(op) || delta.$insertOp.check(op)) {
				const inserted = typeof op.insert === 'string' ? op.insert : nodesOf(op.insert);
				node.insert(index, inserted);
				if (typeof inserted !== 'string') inserted.forEach(writePendingMarks);
				markRange(node, index, op.insert.length, op.format, true);
				index += op.insert.length;
			} else if (delta.$retainOp.check(op)) {
				markRange(node, index, op.retain, op.format, false);
				index += op.retain;
			} else if (delta.$deleteOp.check(op)) {
				node.delete(index, op.delete);
			} else if (delta.$modifyOp.check(op)) {
				const child = childAt(node, index);
				if (!(child instanceof YNode)) error.unexpectedCase();
				applyDelta(child, op.value);
				markRange(node, index, 1, op.format, false);
				index += 1;
			} else {
				error.unexpectedCase();
			}
		}
		for (const op of d.attrs) {
			if (delta.$setAttrOp.check(op)) {
				node.setAttr(op.key, op.value);
				writePendingMarks(op.value);
			} else if (delta.$deleteAttrOp.check(op)) {
				node.deleteAttr(op.key);
			} else {
				const sub = node.doc == null ? node._prelim?.attrs[op.key]?.value : node.getAttr(op.key);
				if (!(sub instanceof YNode)) error.unexpectedCase();
				applyDelta(sub, op.value);
			}
		}
	};
	if (node.doc == null) return write();
	if (node._item !== null && node._item.deleted) return;
	transact(node.doc, write);
};

/**
 * The items of `node`'s list, tombstones and format items included.
 *
 * @param {any} node
 * @return {Array<any>}
 */
export const nodeItems = (node) => {
	const out = [];
	for (let s = node._start; s !== null; s = s.right) out.push(s);
	return out;
};
