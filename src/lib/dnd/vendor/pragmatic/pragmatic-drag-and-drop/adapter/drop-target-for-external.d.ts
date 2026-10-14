import { type CleanupFn } from '../internal-types.js';
import { adapter } from './external-adapter.js';
import type { StripEventsForDropTargets } from './external-adapter-types.js';
export declare function dropTargetForExternal(args: StripEventsForDropTargets<Parameters<typeof adapter.dropTarget>[0]>): CleanupFn;
