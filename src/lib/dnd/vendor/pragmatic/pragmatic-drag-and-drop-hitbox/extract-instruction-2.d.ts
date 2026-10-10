import type { Instruction } from './list-item.js';
/**
 * Extract an instruction from the user data if it is available.
 *
 *
 * @example
 *
 * ```ts
 * monitorForElements({
 *  onDrop({location}) {
 *   const innerMost = location.current.dropTargets[0];
 *   if(!innerMost) {
 *     return;
 *   }
 *   const instruction: Instruction | null = extractInstruction(innerMost.data);
 *  }
 * });
 * ```
 */
export declare function extractInstruction(userData: Record<string | symbol, unknown>): Instruction | null;
