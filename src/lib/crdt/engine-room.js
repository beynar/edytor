/**
 * The engine calls only the room makes (a re-seed's cut and rebase,
 * `crdt/reseed.ts`): apart from the engine object (`engine.js`), which every
 * app keeps whole, so an app's bundle holds none of them.
 */
export { clipUpdate, diffUpdate } from './vendor/yjs/src/index.js';
