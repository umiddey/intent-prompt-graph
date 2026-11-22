/** Pure geometry for the graph view. Coordinates are px relative to the hub centre. */

export interface Point {
  x: number;
  y: number;
}

/** Golden angle in degrees: successive turns and chips sit this far apart around the hub. */
export const GOLDEN_DEG = 137.508;
/** Inner radius of the focused cluster before any turn is placed. */
export const r0 = 300;
/** Radial growth of the turn spiral: turn i sits at r0 + c*sqrt(i). */
export const c = 128;
/** Radial growth of the chip spiral: chip j sits at Rcl(n) + GAP + cChip*sqrt(j). */
export const cChip = 75;
/** Clearance between the focused cluster and the first chip ring. */
export const GAP = 55;
/** Half the card diagonal (ceil of hypot(110, 45)); the cluster radius adds this to the outermost card. */
export const CARD_HALF_DIAG = 119;

const angle = (k: number): number => (k * GOLDEN_DEG * Math.PI) / 180;

/** Centre of turn i (1-based) of the focused intent. */
export function turnPos(i: number): Point {
  const r = r0 + c * Math.sqrt(i);
  return { x: r * Math.cos(angle(i)), y: r * Math.sin(angle(i)) };
}

/** Bounding radius of the focused cluster when it holds n turns: Rcl(n). */
export function clusterRadius(n: number): number {
  return r0 + c * Math.sqrt(n) + CARD_HALF_DIAG;
}

/** Centre of the chip for intent ordinal j (1-based, focused intent skipped) when the focused intent holds n turns. */
export function chipPos(n: number, j: number): Point {
  const r = clusterRadius(n) + GAP + cChip * Math.sqrt(j);
  return { x: r * Math.cos(angle(j)), y: r * Math.sin(angle(j)) };
}
