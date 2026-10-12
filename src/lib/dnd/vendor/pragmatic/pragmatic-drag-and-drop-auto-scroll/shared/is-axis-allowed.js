export function isAxisAllowed(axis, allowedAxis) {
  return allowedAxis === 'all' || axis === allowedAxis;
}