const baseConfig = {
  startHitboxAtPercentageRemainingOfElement: {
    top: 0.25,
    right: 0.25,
    bottom: 0.25,
    left: 0.25
  },
  maxScrollAtPercentageRemainingOfHitbox: {
    top: 0.5,
    right: 0.5,
    bottom: 0.5,
    left: 0.5
  },
  timeDampeningDurationMs: 400,
  // Too big and it's too easy to trigger auto scrolling
  // Too small and it's too hard 😅
  maxMainAxisHitboxSize: 180
};

// edytor: no element sets `getConfiguration`: the standard speed only.
export const internalConfig = {
  ...baseConfig,
  maxPixelScrollPerSecond: 15 * 60
};
