import type { Easing } from '@euclid/dsl'

/** u in [0,1] → eased [0,1]. 'smooth' is the 3b1b smootherstep (zero 1st+2nd derivative at ends). */
export const easings: Record<Easing, (u: number) => number> = {
  linear: (u) => u,
  easeIn: (u) => u * u * u,
  easeOut: (u) => 1 - Math.pow(1 - u, 3),
  easeInOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  smooth: (u) => u * u * u * (u * (6 * u - 15) + 10),
}

export function clamp01(u: number): number {
  return u < 0 ? 0 : u > 1 ? 1 : u
}
