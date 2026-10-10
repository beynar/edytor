// using a symbol so we can guarantee a key with a unique value
export const uniqueKey = Symbol('list-item-instruction');
export const axisLookup = {
  vertical: {
    start: 'top',
    end: 'bottom',
    size: 'height',
    point: 'y'
  },
  horizontal: {
    start: 'left',
    end: 'right',
    size: 'width',
    point: 'x'
  }
};
export function reorder({
  client,
  borderBox,
  axis
}) {
  const halfSize = borderBox[axis.size] / 2;

  // In the top 1/2: reorder-before
  // On the line: reorder-after to give a slight preference to moving forward
  if (client[axis.point] < borderBox[axis.start] + halfSize) {
    return 'reorder-before';
  }
  return 'reorder-after';
}
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-re-exports -- Disabled via Volt Codemod. Do not add more exports to this file.
export { attachInstruction } from './attach-instruction-2.js';
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-re-exports -- Disabled via Volt Codemod. Do not add more exports to this file.
export { extractInstruction } from './extract-instruction-2.js';