import { canScrollOnEdge } from '../shared/can-scroll-on-edge.js';
import { edgeAxisLookup, edges } from '../shared/edges.js';
import { getOverElementHitbox } from '../shared/get-over-element-hitbox.js';
import { getScrollChange } from '../shared/get-scroll-change.js';
import { isAxisAllowed } from '../shared/is-axis-allowed.js';
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
  allowedAxis,
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
    const axis = edgeAxisLookup[edge];

    // Note: changing the allowed axis during a drag will not
    // reset time dampening. It was decided it would be too
    // complex to implement initially, and we can add it
    // later if needed.
    if (!isAxisAllowed(axis, allowedAxis)) {
      return map;
    }
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
  const left = (() => {
    const axis = 'horizontal';
    const leftEdge = scrollableEdges.get('left');
    if (leftEdge) {
      return getScrollChange({
        client,
        edge: leftEdge.edge,
        hitbox: leftEdge.hitbox,
        axis,
        timeSinceLastFrame,
        engagement,
        isDistanceDampeningEnabled: true,
        config
      });
    }
    const rightEdge = scrollableEdges.get('right');
    if (rightEdge) {
      return getScrollChange({
        client,
        edge: rightEdge.edge,
        hitbox: rightEdge.hitbox,
        axis,
        timeSinceLastFrame,
        engagement,
        isDistanceDampeningEnabled: true,
        config
      });
    }
    return 0;
  })();
  const top = (() => {
    const axis = 'vertical';
    const bottomEdge = scrollableEdges.get('bottom');
    if (bottomEdge) {
      return getScrollChange({
        client,
        edge: bottomEdge.edge,
        hitbox: bottomEdge.hitbox,
        axis,
        timeSinceLastFrame,
        engagement,
        isDistanceDampeningEnabled: true,
        config
      });
    }
    const topEdge = scrollableEdges.get('top');
    if (topEdge) {
      return getScrollChange({
        client,
        edge: topEdge.edge,
        hitbox: topEdge.hitbox,
        axis,
        timeSinceLastFrame,
        engagement,
        isDistanceDampeningEnabled: true,
        config
      });
    }
    return 0;
  })();
  return {
    left,
    top
  };
}