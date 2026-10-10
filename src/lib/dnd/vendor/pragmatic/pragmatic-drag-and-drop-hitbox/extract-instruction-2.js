import { uniqueKey } from './list-item.js';
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
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export function extractInstruction(userData) {
  var _ref;
  return (_ref = userData[uniqueKey]) !== null && _ref !== void 0 ? _ref : null;
}