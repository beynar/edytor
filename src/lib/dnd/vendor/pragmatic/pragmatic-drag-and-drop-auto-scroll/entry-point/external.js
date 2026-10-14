import { monitorForExternal } from '../../pragmatic-drag-and-drop/adapter/monitor-for-external.js';
import { makeApi } from '../over-element/make-api.js';
const api = makeApi({
  monitor: monitorForExternal
});
export const autoScrollForExternal = api.autoScroll;
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export const autoScrollWindowForExternal = api.autoScrollWindow;