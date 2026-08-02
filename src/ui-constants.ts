// Shared UI dimensions that participate in LOGIC (clamping/positioning math),
// not just styling - so the TSX math and the inline styles agree by
// construction. The CSS side cannot import these: .aya-recent-menu's
// `width: 280px` in overrides.css must be kept in sync by hand (the constants
// here are the source of truth; the clamp silently mis-positions if CSS
// drifts).

/** Fixed width of the .aya-recent-menu dropdown - used both as the rendered
 *  width and in the off-screen clamp math. */
export const RECENT_MENU_WIDTH_PX = 280;
/** Minimum gap between a dropdown menu and the viewport edge. */
export const MENU_VIEWPORT_EDGE_PX = 6;
/** Vertical gap between a menu and its anchor button. Same value as the edge
 *  gap today, but a distinct knob - anchoring and viewport clamping are
 *  independent decisions. */
export const MENU_ANCHOR_GAP_PX = 6;
