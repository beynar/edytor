import type { ElementDragType, CleanupFn } from '../../pragmatic-drag-and-drop/entry-point/types.js';
import type { ElementAutoScrollArgs, WindowAutoScrollArgs } from '../internal-types.js';
export declare const autoScrollForElements: (args: ElementAutoScrollArgs<ElementDragType>) => CleanupFn;
export declare const autoScrollWindowForElements: (args?: WindowAutoScrollArgs<ElementDragType>) => CleanupFn;
