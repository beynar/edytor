/**
 * Whether `o` is a `Doc` — read from a tag on `Doc.prototype` (`Doc.js`), which stays sound
 * across duplicate installs of the engine (unlike `instanceof`). YP15: replaces the `$doc`
 * schema.
 *
 * @param {any} o
 * @return {boolean}
 */
export const isDoc = o => o != null && o._isDoc === true
