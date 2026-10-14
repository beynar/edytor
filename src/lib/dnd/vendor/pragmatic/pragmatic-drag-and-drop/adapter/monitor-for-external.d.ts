import { type CleanupFn } from '../internal-types.js';
import { adapter } from './external-adapter.js';
import type { StripEventsForMonitors } from './external-adapter-types.js';
export declare function monitorForExternal(args: StripEventsForMonitors<Parameters<typeof adapter.monitor>[0]>): CleanupFn;
