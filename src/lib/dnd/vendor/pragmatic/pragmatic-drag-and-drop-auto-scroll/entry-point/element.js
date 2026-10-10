import { monitorForElements } from '../../pragmatic-drag-and-drop/adapter/element-adapter.js';
import { makeApi } from '../over-element/make-api.js';
const api = makeApi({
  monitor: monitorForElements
});
export const autoScrollForElements = api.autoScroll;
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export const autoScrollWindowForElements = api.autoScrollWindow;