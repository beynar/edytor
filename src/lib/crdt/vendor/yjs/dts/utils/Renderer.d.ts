/**
 * Renders content with attributions, given a single `attributions` {@link ContentMap} of how to
 * attribute content and an optional `renderedContent` {@link IdSet} of what renders.
 *
 * - `attributions` (inserts ∪ deletes) is merged into a single `renderAs` map; content it covers
 *   always renders, carrying its attribution.
 * - `renderedContent` defines the content that renders *normally* — even if the item is marked
 *   deleted in the doc (a "restore"). It defaults to the doc's alive content (`inserts − deletes`),
 *   applied implicitly (a piece is in the default set ⟺ its item is not `deleted`), so the common
 *   "pure attribution overlay" case does no extra work. When a custom set is supplied it is
 *   authoritative: alive content omitted from it (and unattributed) is hidden.
 *
 * Restoring deleted content requires `gc: false` on the doc (the renderer does not rehydrate
 * garbage-collected content, unlike {@link DiffRenderer}).
 *
 * @implements AbstractRenderer
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class AttributionsRenderer extends ObservableV2<{
    change: (idset: IdSet, origin: any, local: boolean) => void;
}> implements AbstractRenderer {
    /**
     * @param {ContentMap} attributions - how to attribute content (`{ inserts, deletes }` IdMaps)
     * @param {Object} [options]
     * @param {IdSet?} [options.renderedContent] - content that renders normally; defaults to the
     * doc's alive content (`inserts − deletes`), applied implicitly.
     */
    constructor(attributions: ContentMap, { renderedContent }?: {
        renderedContent?: import("./ids.js").IdSet | null | undefined;
    });
    /**
     * The two attribution maps merged into one — `readContent` consults this for how to attribute
     * a piece.
     * @type {IdMap<any>}
     */
    renderAs: IdMap<any>;
    /**
     * Coverage of `renderAs` (ids that carry attributions). The small set `hasItem` checks. May
     * over-approximate what actually renders — `readContent` remains authoritative. See
     * {@link AbstractRenderer#attributed}.
     * @type {IdSet}
     */
    attributed: IdSet;
    /**
     * Custom "content that renders normally" set, or `null` to use the implicit default
     * (alive ⟺ `!item.deleted`).
     * @type {IdSet?}
     */
    renderedContent: IdSet | null;
    /**
     * Union of `renderedContent` and `attributed` — the single cheap "does this produce visible
     * output?" set. Only materialized when a custom `renderedContent` is supplied.
     * @type {IdSet?}
     */
    rendered: IdSet | null;
    get $type(): import("lib0-v14/schema").Schema<import("./renderer-helpers.js").AbstractRenderer>;
    /**
     * @param {Item} item
     * @return {boolean}
     */
    hasItem(item: Item): boolean;
    /**
     * @param {Array<AttributedContent<any>>} contents - where to write the result
     * @param {number} client
     * @param {number} clock
     * @param {boolean} deleted
     * @param {AbstractContent} content
     * @param {0|1|2|3} shouldRender - whether this should render or just result in a `retain` operation (see AbstractRenderer#readContent)
     */
    readContent(contents: Array<AttributedContent<any>>, client: number, clock: number, deleted: boolean, content: AbstractContent, shouldRender: 0 | 1 | 2 | 3): void;
    /**
     * @param {Item} item
     * @return {number}
     */
    contentLength(item: Item): number;
}
export function createAttributionsRenderer(attributions: ContentMap, options?: {
    renderedContent?: import("./ids.js").IdSet | null | undefined;
}): AttributionsRenderer;
/**
 * @implements AbstractRenderer
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class DiffRenderer extends ObservableV2<{
    change: (idset: IdSet, origin: any, local: boolean) => void;
}> implements AbstractRenderer {
    /**
     * @param {Doc} prevDoc
     * @param {Doc} nextDoc
     * @param {Object} [options] - options for the renderer
     * @param {ContentMap?} [options.attributions] - the attributions to apply to the diff
     */
    constructor(prevDoc: Doc, nextDoc: Doc, { attributions }?: {
        attributions?: import("./ids.js").ContentMap | null | undefined;
    });
    inserts: import("./ids.js").IdMap<any>;
    deletes: import("./ids.js").IdMap<any>;
    /**
     * Raw coverage of `inserts` ∪ `deletes`, maintained alongside them. Over-approximates the
     * actually-rendered set (e.g. it keeps suggested-inserts that were deleted later) —
     * `readContent` remains authoritative. See {@link AbstractRenderer#attributed}.
     * @type {IdSet}
     */
    attributed: IdSet;
    _prevDoc: import("./Doc.js").Doc;
    _prevDocStore: import("./StructStore.js").StructStore;
    _nextDoc: import("./Doc.js").Doc;
    _nextBOH: (arg0: Transaction, arg1: import("./Doc.js").Doc) => void;
    _prevBOH: (arg0: Transaction, arg1: import("./Doc.js").Doc) => void;
    _prevUpdateListener: (arg0: Uint8Array<ArrayBuffer>, arg1: any, arg2: import("./Doc.js").Doc, arg3: Transaction) => void;
    _ndUpdateListener: (arg0: Uint8Array<ArrayBuffer>, arg1: any, arg2: import("./Doc.js").Doc, arg3: Transaction) => void;
    _afterTrListener: (arg0: Transaction, arg1: import("./Doc.js").Doc) => void;
    suggestionMode: boolean;
    /**
     * Optionally limit origins that may sync changes to the main doc if suggestion-mode is
     * disabled.
     *
     * @type {Array<any>?}
     */
    suggestionOrigins: Array<any> | null;
    _destroyHandler: (arg0: import("./Doc.js").Doc) => void;
    get $type(): import("lib0-v14/schema").Schema<import("./renderer-helpers.js").AbstractRenderer>;
    /**
     * @param {Item} item
     * @return {boolean}
     */
    hasItem(item: Item): boolean;
    acceptAllChanges(): void;
    rejectAllChanges(): void;
    /**
     * @param {ID} start
     * @param {ID} end
     */
    acceptChanges(start: ID, end?: ID): void;
    /**
     * @param {ID} start
     * @param {ID} end
     */
    rejectChanges(start: ID, end?: ID): void;
    /**
     * @param {Array<AttributedContent<any>>} contents - where to write the result
     * @param {number} client
     * @param {number} clock
     * @param {boolean} deleted
     * @param {AbstractContent} _content
     * @param {0|1|2|3} shouldRender - whether this should render or just result in a `retain` operation (see AbstractRenderer#readContent)
     */
    readContent(contents: Array<AttributedContent<any>>, client: number, clock: number, deleted: boolean, _content: AbstractContent, shouldRender: 0 | 1 | 2 | 3): void;
    /**
     * @param {Item} item
     * @return {number}
     */
    contentLength(item: Item): number;
}
export function createDiffRenderer(prevDoc: Doc, nextDoc: Doc, options?: {
    attributions?: import("./ids.js").ContentMap | null | undefined;
}): DiffRenderer;
/**
 * Intended for projects that used the v13 snapshot feature. With this renderer you can
 * read content similar to the previous snapshot api. Requires that `ydoc.gc` is turned off.
 *
 * @implements AbstractRenderer
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class SnapshotRenderer extends ObservableV2<{
    change: (idset: IdSet, origin: any, local: boolean) => void;
}> implements AbstractRenderer {
    /**
     * @param {Snapshot} prevSnapshot
     * @param {Snapshot} nextSnapshot
     * @param {Object} [options] - options for the renderer
     * @param {Array<ContentAttribute>} [options.attrs] - the attributes to apply to the diff
     */
    constructor(prevSnapshot: Snapshot, nextSnapshot: Snapshot);
    prevSnapshot: import("./Snapshot.js").Snapshot;
    nextSnapshot: import("./Snapshot.js").Snapshot;
    attrs: import("./ids.js").IdMap<any>;
    /**
     * Coverage of `attrs` (everything up to `nextSnapshot`). Content *after* the snapshot must be
     * hidden rather than rendered normally, which a finite set cannot express — `hasItem`
     * additionally claims all future content. See {@link AbstractRenderer#attributed}.
     * @type {IdSet}
     */
    attributed: IdSet;
    get $type(): import("lib0-v14/schema").Schema<import("./renderer-helpers.js").AbstractRenderer>;
    /**
     * @param {Item} item
     * @return {boolean}
     */
    hasItem(item: Item): boolean;
    /**
     * @param {Array<AttributedContent<any>>} contents - where to write the result
     * @param {number} client
     * @param {number} clock
     * @param {boolean} _deleted
     * @param {AbstractContent} content
     * @param {0|1|2|3} shouldRender - whether this should render or just result in a `retain` operation (see AbstractRenderer#readContent)
     */
    readContent(contents: Array<AttributedContent<any>>, client: number, clock: number, _deleted: boolean, content: AbstractContent, shouldRender: 0 | 1 | 2 | 3): void;
    /**
     * @param {Item} item
     * @return {number}
     */
    contentLength(item: Item): number;
}
export function createSnapshotRenderer(prevSnapshot: Snapshot, nextSnapshot?: Snapshot): SnapshotRenderer;
import { ObservableV2 } from 'lib0-v14/observable';
import { AttributedContent } from './renderer-helpers.js';
export { AbstractRenderer, rendererContentLength, $renderer } from "./renderer-helpers.js";
