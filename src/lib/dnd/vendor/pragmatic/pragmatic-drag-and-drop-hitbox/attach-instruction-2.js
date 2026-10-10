import { stable } from './internal/stable.js';
import { axisLookup, reorder, uniqueKey } from './list-item.js';
function reorderAndCombine({
  client,
  borderBox,
  axis
}) {
  const quarterOfSize = borderBox[axis.size] / 4;

  // In the top 1/4: reorder-before
  // On the line: reorder-before to give a slight preference to reordering
  if (client[axis.point] <= borderBox[axis.start] + quarterOfSize) {
    return 'reorder-before';
  }
  // In the bottom 1/4: reorder-after
  // On the line: reorder-after to give a slight preference to reordering
  if (client[axis.point] >= borderBox[axis.end] - quarterOfSize) {
    return 'reorder-after';
  }
  return 'combine';
}

// Note: not using `memoize-one` as all we need is a cached value.
// We do not need to avoid executing an expensive function.
const memoizeInstruction = stable();
function isPossible(...values) {
  return values.every(value => value === 'available' || value === 'blocked');
}
function isNotAvailable(...values) {
  return values.every(value => value === 'not-available');
}

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
export function attachInstruction(userData, {
  operations,
  element,
  input,
  axis: axisValue = 'vertical'
}) {
  var _operations$combine, _operations$reorderB, _operations$reorderA;
  const client = {
    x: input.clientX,
    y: input.clientY
  };
  const borderBox = element.getBoundingClientRect();
  const axis = axisLookup[axisValue];
  const combine = (_operations$combine = operations.combine) !== null && _operations$combine !== void 0 ? _operations$combine : 'not-available';
  const reorderAbove = (_operations$reorderB = operations['reorder-before']) !== null && _operations$reorderB !== void 0 ? _operations$reorderB : 'not-available';
  const reorderBelow = (_operations$reorderA = operations['reorder-after']) !== null && _operations$reorderA !== void 0 ? _operations$reorderA : 'not-available';
  const operation = (() => {
    // Combining not possible
    if (!isPossible(combine)) {
      // can reorder above and below
      if (isPossible(reorderAbove, reorderBelow)) {
        return reorder({
          client,
          borderBox,
          axis
        });
      }

      // can only reorder above
      if (isPossible(reorderAbove)) {
        return 'reorder-before';
      }

      // can only reorder below
      if (isPossible(reorderBelow)) {
        return 'reorder-after';
      }

      // no `true` values - no Outcome available.
      return null;
    }

    // combining is available

    const result = reorderAndCombine({
      client,
      borderBox,
      axis
    });
    if (result === 'reorder-after') {
      return isNotAvailable(reorderBelow) ? 'combine' : result;
    }
    if (result === 'reorder-before') {
      return isNotAvailable(reorderAbove) ? 'combine' : result;
    }
    return result;
  })();

  // We cannot attach an instruction - all values passed where `false` or no values passed
  if (!operation) {
    return userData;
  }
  const instruction = {
    operation,
    blocked: operations[operation] === 'blocked',
    axis: axisValue
  };
  const memoized = memoizeInstruction(instruction);
  return {
    ...userData,
    [uniqueKey]: memoized
  };
}