import type { Input } from '../pragmatic-drag-and-drop/entry-point/types.js';
import type { Availability, Axis, Operation } from './list-item.js';
/**
 * Calculate the `Instruction` for a drag operation based on the users input
 * and the available operations.
 *
 * Notes:
 *
 * - `attachInstruction` can attach an `Instruction | null`. `null` will be attached if all `operations` provided are `"not-available"`.
 * - Use `extractInstruction` to obtain the `Instruction | null`
 *
 * @example
 *
 * ```ts
 * dropTargetForElements({
 * 	element: myElement,
 *  getData({input, element}) {
 *    // The data I want to attach to the drop target
 * 		const myData = {type: 'card', cardId: 'A'};
 *
 *    // Add an instruction to myData
 *    return attachInstruction(myData, {
 * 			input,
 * 			element,
 * 			operations: {
 * 				'reorder-before': 'available',
 * 				'reorder-after': 'available',
 * 				combine: 'available',
 * 			}
 *    });
 *  }
 * });
 * ```
 */
export declare function attachInstruction(userData: Record<string | symbol, unknown>, { operations, element, input, axis: axisValue, }: {
    /**
     * All operations are optional, and their default value is `"not-available"`.
     * The hitbox will automatically adjust to account for which options are `"available"` or `"blocked"`.
     */
    operations: {
        [TKey in Operation]?: Availability;
    };
    element: Element;
    input: Input;
    axis?: Axis;
}): Record<string | symbol, unknown>;
