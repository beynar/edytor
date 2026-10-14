import type { ExternalDragType, CleanupFn } from '../../pragmatic-drag-and-drop/entry-point/types.js';
import type { ElementAutoScrollArgs, WindowAutoScrollArgs } from '../internal-types.js';
export declare const autoScrollForExternal: (args: ElementAutoScrollArgs<ExternalDragType>) => CleanupFn;
export declare const autoScrollWindowForExternal: (args?: WindowAutoScrollArgs<ExternalDragType>) => CleanupFn;
