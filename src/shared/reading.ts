// Hands-free reading in the browser: the page scrolls itself at a steady pace while the user
// reads (docs/mockups/reading-scroll.html). The speed maths lives here because main runs the
// scroll and the toolbar's slider sets it, and both must agree on what a speed means.

/** Pixels a second at 1×, an unhurried read of an article column. */
export const READING_BASE = 30
export const READING_MIN = 0.25
export const READING_MAX = 8
/** Round speeds the slider clicks onto as it passes them. */
export const READING_SNAPS = [0.5, 1, 2, 4]
/** The slider runs 0 to this, on a log scale. */
export const READING_SLIDER_MAX = 1000
/** How close (in slider steps) a drag must come to a round speed to land on it. */
const SNAP_REACH = 22

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1
  return Math.min(READING_MAX, Math.max(READING_MIN, speed))
}

// A log scale gives the slow end as much of the slider as the fast end: ¼× to ½× takes the same
// travel as 4× to 8×.
export function speedToSlider(speed: number): number {
  return READING_SLIDER_MAX * Math.log(clampSpeed(speed) / READING_MIN) / Math.log(READING_MAX / READING_MIN)
}

export function sliderToSpeed(value: number): number {
  const at = Math.min(READING_SLIDER_MAX, Math.max(0, value)) / READING_SLIDER_MAX
  return clampSpeed(READING_MIN * (READING_MAX / READING_MIN) ** at)
}

/** The speed a slider position stands for, landing on a round speed when it is close to one. */
export function snapSpeed(value: number): number {
  const near = READING_SNAPS.find((round) => Math.abs(speedToSlider(round) - value) < SNAP_REACH)
  return near ?? Math.round(sliderToSpeed(value) * 100) / 100
}

/** One step of the Alt+↑/↓ keys and the wheel over the control: about a tenth either way. */
export function nudgeSpeed(speed: number, by: number): number {
  return Math.round(clampSpeed(speed * 1.1 ** by) * 100) / 100
}

export function speedLabel(speed: number): string {
  if (speed === 0.25) return '¼×'
  if (speed === 0.5) return '½×'
  return `${Math.round(speed * 10) / 10}×`
}

/** How long the rest of the page takes at this pace, as the control shows it. */
export function timeLeftLabel(seconds: number): string {
  if (!(seconds >= 1)) return 'Done'
  if (seconds < 60) return `${Math.ceil(seconds)} s left`
  return `${Math.round(seconds / 60)} min left`
}
