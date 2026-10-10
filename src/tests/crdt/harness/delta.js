/**
 * Test-only delta reader and writer over the vendored engine (UPSTREAM.md YP16).
 *
 * The fork ships no delta layer: `toDelta`, `applyDelta`, `YEvent#delta`/`getDelta`,
 * `YNode.from` and the maintained `node.delta` are gone from `edytor/crdt`. The
 * tests that compare the engine's state or changes as lib0 deltas (the upstream
 * suite, the marker differentials, the range-cursor oracle) read and write through
 * these ports instead — the engine's own code, renderer-free, as it stood before
 * YP16, built on the engine's internal helpers. Never imported by `src/lib`.
 */
import * as delta from 'lib0-v14/delta';
import * as map from 'lib0-v14/map';
import * as set from 'lib0-v14/set';
import * as object from 'lib0-v14/object';
import * as error from 'lib0-v14/error';

import {
	YNode,
	ItemTextListPosition,
	insertContent,
	insertContentHelper,
	deleteText,
	nodeMapSet,
	nodeMapDelete,
	cursorAt,
	plantMarker,
	equalFormats
} from '../../../lib/crdt/vendor/yjs/src/ynode.js';
import {
	ContentFormat,
	ContentString,
	ContentType
} from '../../../lib/crdt/vendor/yjs/src/structs/Item.js';
import { transact } from '../../../lib/crdt/vendor/yjs/src/utils/Transaction.js';
import {
	liveLength,
	findIndexSS
} from '../../../lib/crdt/vendor/yjs/src/utils/transaction-helpers.js';
import { diffIdSet, mergeIdSets } from '../../../lib/crdt/vendor/yjs/src/utils/ids.js';
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
					const rslice = itemsToRender.slice(item.id.client, item.id.clock, item.length);
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
				const rslice = itemsToRender.slice(item.id.client, item.id.clock, item.length);
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

/**
 * Apply a lib0 delta to `node` — the engine's `applyDelta` as it stood before YP16, without the
 * renderer: one cursor walks the ops (a leading plain retain seeds it from a search marker); the
 * attrs follow. A detached node takes the delta through its own writes (it composes them the way
 * the pre-integration delta did).
 *
 * @param {YNode} node
 * @param {any} d
 */
export const applyDelta = (node, d) => {
	if (typeof node.applyDelta === 'function') return node.applyDelta(d); // an engine that still ships the delta layer (the pristine upstream baseline)
	if (d.isEmpty()) return;
	if (node.doc == null) {
		applyToDetached(node, d);
		return;
	}
	if (node._item !== null && node._item.deleted) return;
	transact(node.doc, (transaction) => {
		const ops = [...d.children];
		let k = 0;
		/** @type {ItemTextListPosition} */
		let currPos;
		const op0 = ops[0];
		if (
			op0 !== undefined &&
			delta.$retainOp.check(op0) &&
			op0.retain > 0 &&
			op0.format == null &&
			op0.attribution == null
		) {
			currPos = cursorAt(transaction, node, op0.retain);
			k = 1;
		} else {
			currPos = new ItemTextListPosition(null, node._start, 0, new Map());
		}
		for (; k < ops.length; k++) {
			const op = ops[k];
			if (delta.$textOp.check(op)) {
				insertContent(transaction, node, currPos, new ContentString(op.insert), op.format || {});
			} else if (delta.$insertOp.check(op)) {
				insertContentHelper(transaction, node, currPos, nodesOf(op.insert), op.format || {});
			} else if (delta.$retainOp.check(op)) {
				currPos.formatText(transaction, node, op.retain, op.format || {});
				plantMarker(node, currPos);
			} else if (delta.$deleteOp.check(op)) {
				deleteText(transaction, currPos, op.delete);
			} else if (delta.$modifyOp.check(op)) {
				let item = currPos.right;
				while (item !== null && liveLength(item) === 0) {
					item = item.right;
				}
				if (item == null || item.content.constructor !== ContentType) {
					error.unexpectedCase();
				}
				applyDelta(/** @type {ContentType} */ (item.content).type, op.value);
				currPos.formatText(transaction, node, 1, op.format || {});
			} else {
				error.unexpectedCase();
			}
		}
		plantMarker(node, currPos);
		for (const op of d.attrs) {
			if (delta.$setAttrOp.check(op)) {
				nodeMapSet(transaction, node, op.key, op.value);
			} else if (delta.$deleteAttrOp.check(op)) {
				nodeMapDelete(transaction, node, op.key);
			} else {
				const mapItem = node._map.get(op.key);
				const sub =
					mapItem === undefined || mapItem.deleted
						? undefined
						: mapItem.content.getContent()[mapItem.length - 1];
				if (!(sub instanceof YNode)) {
					error.unexpectedCase();
				}
				applyDelta(sub, op.value);
			}
		}
	});
};

/**
 * @param {YNode} node
 * @param {any} d
 */
const applyToDetached = (node, d) => {
	let index = 0;
	for (const op of d.children) {
		if (delta.$textOp.check(op)) {
			node.insert(index, op.insert, op.format ?? undefined);
			index += op.insert.length;
		} else if (delta.$insertOp.check(op)) {
			node.insert(index, nodesOf(op.insert), op.format ?? undefined);
			index += op.insert.length;
		} else if (delta.$retainOp.check(op)) {
			if (op.format !== undefined) node.format(index, op.retain, op.format);
			index += op.retain;
		} else if (delta.$deleteOp.check(op)) {
			node.delete(index, op.delete);
		} else if (delta.$modifyOp.check(op)) {
			applyDelta(
				node._prelim?.runs.flatMap((/** @type {any} */ r) =>
					typeof r.insert === 'string' ? [...r.insert] : r.insert
				)[index],
				op.value
			);
			index += 1;
		} else {
			error.unexpectedCase();
		}
	}
	for (const op of d.attrs) {
		if (delta.$setAttrOp.check(op)) {
			node.setAttr(op.key, op.value);
		} else if (delta.$deleteAttrOp.check(op)) {
			node.deleteAttr(op.key);
		} else {
			const sub = node._prelim?.attrs[op.key]?.value;
			if (!(sub instanceof YNode)) error.unexpectedCase();
			applyDelta(sub, op.value);
		}
	}
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
