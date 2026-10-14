import { canScrollOnEdge } from '../shared/can-scroll-on-edge.js';
import { edges } from '../shared/edges.js';
import { getOverElementHitbox } from '../shared/get-over-element-hitbox.js';
import { getScrollChange } from '../shared/get-scroll-change.js';
import { isWithin } from '../shared/is-within.js';
function getRectDefault(element) {
  return element.getBoundingClientRect();
}
export function getScrollBy({
  element,
  input,
  timeSinceLastFrame,
  engagement,
  config,
  getRect = getRectDefault
}) {
  const client = {
    x: input.clientX,
    y: input.clientY
  };
  const clientRect = getRect(element);
  const scrollableEdges = edges.reduce((map, edge) => {
    const hitbox = getOverElementHitbox[edge]({
      clientRect,
      config
    });
    if (!isWithin({
      client,
      clientRect: hitbox
    })) {
      return map;
    }
    if (!canScrollOnEdge[edge](element)) {
      return map;
    }
    map.set(edge, {
      edge,
      hitbox
    });
    return map;
  }, new Map());
  // edytor: one change per axis, the first of its edges the pointer is over.
  const change = (axis, first, second) => {
    const entry = scrollableEdges.get(first) ?? scrollableEdges.get(second);
    return entry ? getScrollChange({
      client,
      edge: entry.edge,
      hitbox: entry.hitbox,
      axis,
      timeSinceLastFrame,
      engagement,
      config
    }) : 0;
  };
  const left = change('horizontal', 'left', 'right');
  const top = change('vertical', 'bottom', 'top');
  return {
    left,
    top
  };
}