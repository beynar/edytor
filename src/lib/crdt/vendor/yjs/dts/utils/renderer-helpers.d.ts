export const attributionJsonSchema: s.Schema<{
    insert?: string[] | undefined;
    insertAt?: number | undefined;
    delete?: string[] | undefined;
    deleteAt?: number | undefined;
    format?: {
        [x: string]: string[];
    } | undefined;
    formatAt?: number | undefined;
}>;
/**
 * @todo rename this to `insertBy`, `insertAt`, ..
 *
 * @typedef {s.Unwrap<typeof attributionJsonSchema>} Attribution
 */
/**
 * @template T
 */
export class AttributedContent<T> {
    /**
     * @param {AbstractContent} content
     * @param {number} clock
     * @param {boolean} deleted
     * @param {Array<ContentAttribute<T>> | null} attrs
     * @param {0|1|2|3} renderBehavior
     */
    constructor(content: AbstractContent, clock: number, deleted: boolean, attrs: Array<ContentAttribute<T>> | null, renderBehavior: 0 | 1 | 2 | 3);
    content: import("../structs/Item.js").AbstractContent;
    clock: number;
    deleted: boolean;
    attrs: import("./ids.js").ContentAttribute<T>[] | null;
    render: boolean;
    /**
     * Fresh content that was deleted in the same transaction (mode `3`): even in a
     * `retainDeletes` render it must produce an *insert* — the consuming state (e.g. the
     * maintained `delta` cache) has never seen this content, so there is nothing to retain.
     */
    fresh: boolean;
}
/**
 * Abstract base class for renderers. A renderer renders Content (with Attributions) to a delta.
 *
 * Should fire an event when the attributions changed _after_ the original change happens. This
 * Event will be used to update the attribution on the current content.
 *
 * Only items claimed via {@link AbstractRenderer#hasItem} reach the renderer — everything else is
 * rendered by the generic fast path (as-is, without attributions, deleted content invisible).
 *
 * @extends {ObservableV2<{change:(idset:IdSet,origin:any,local:boolean)=>void}>}
 */
export class AbstractRenderer extends ObservableV2<{
    change: (idset: IdSet, origin: any, local: boolean) => void;
}> {
    constructor();
    /**
     * Ids of the content this renderer may render non-normally (attributed, restored, hidden, …).
     * May over-approximate — {@link AbstractRenderer#readContent} remains authoritative for what
     * is actually rendered. Content outside this set is rendered by the generic fast path without
     * consulting the renderer.
     *
     * @type {IdSet}
     */
    attributed: IdSet;
    /**
     * Whether `item` (any part of its id range) must be rendered by this renderer. Items for which
     * this returns `false` are rendered by the generic fast path.
     *
     * @param {Item} item
     * @return {boolean}
     */
    hasItem(item: Item): boolean;
    /**
     * @param {Array<AttributedContent<any>>} _contents - where to write the result
     * @param {number} _client
     * @param {number} _clock
     * @param {boolean} _deleted
     * @param {AbstractContent} _content
     * @param {0|1|2|3} _shouldRender - 0: if undeleted or attributed, render as a retain operation. 1: render only if undeleted or attributed. 2: render as insert operation (if unattributed and deleted, render as delete). 3: fresh content deleted in the same transaction, marked {@link AttributedContent#fresh} — render as insert where attributed (it must insert even in a `retainDeletes` render: the consuming state has never seen it), as *nothing* where unattributed (invisible; a delete op would misapply).
     */
    readContent(_contents: Array<AttributedContent<any>>, _client: number, _clock: number, _deleted: boolean, _content: AbstractContent, _shouldRender: 0 | 1 | 2 | 3): void;
    /**
     * Calculate the length of the attributed content. This is used by iterators that walk through the
     * content.
     *
     * If the content is not countable, it should return 0.
     *
     * @param {Item} _item
     * @return {number}
     */
    contentLength(_item: Item): number;
    $type: s.Schema<AbstractRenderer>;
}
export const $renderer: s.Schema<AbstractRenderer>;
export function rendererContentLength(renderer: AbstractRenderer | null, item: Item): number;
export type Attribution = s.Unwrap<typeof attributionJsonSchema>;
import * as s from 'lib0-v14/schema';
import { ObservableV2 } from 'lib0-v14/observable';
