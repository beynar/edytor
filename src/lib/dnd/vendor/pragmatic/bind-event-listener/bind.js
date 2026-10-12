export function bind(target, { type, listener, options }) {
  target.addEventListener(type, listener, options);

  return function unbind() {
    target.removeEventListener(type, listener, options);
  };
}
