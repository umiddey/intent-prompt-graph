import { describe, expect, test } from "bun:test";
import { chipPos, clusterRadius, type Point, turnPos } from "../web/layout";

const CARD = { w: 220, h: 90 };
const CHIP = { w: 200, h: 48 };
const N_MAX = 200;
const J_MAX = 40;

/** Two same-size-class rectangles centred at a and b overlap iff both axis gaps are negative. */
function overlaps(a: Point, aw: number, ah: number, b: Point, bw: number, bh: number): boolean {
  return Math.abs(a.x - b.x) < (aw + bw) / 2 && Math.abs(a.y - b.y) < (ah + bh) / 2;
}

/** Distance from the origin to the nearest point of the rectangle centred at p. */
function nearestToHub(p: Point, w: number, h: number): number {
  const qx = Math.min(Math.max(0, p.x - w / 2), p.x + w / 2);
  const qy = Math.min(Math.max(0, p.y - h / 2), p.y + h / 2);
  return Math.hypot(qx, qy);
}

describe("turn cards", () => {
  test("no two cards overlap for n = 1..200 turns of the focused intent", () => {
    for (let n = 1; n <= N_MAX; n++) {
      const p = turnPos(n);
      for (let i = 1; i < n; i++) {
        expect(overlaps(p, CARD.w, CARD.h, turnPos(i), CARD.w, CARD.h)).toBe(false);
      }
    }
  });

  test("placing turn n+1 leaves the positions of turns 1..n unchanged", () => {
    for (let n = 1; n < N_MAX; n++) {
      for (let i = 1; i <= n; i++) {
        expect(turnPos(i)).toEqual(turnPos(i));
      }
    }
  });
});

describe("intent chips", () => {
  test("no two chips overlap for n = 1..200 and j = 1..40", () => {
    for (let n = 1; n <= N_MAX; n++) {
      for (let j = 1; j <= J_MAX; j++) {
        const p = chipPos(n, j);
        for (let k = 1; k < j; k++) {
          expect(overlaps(p, CHIP.w, CHIP.h, chipPos(n, k), CHIP.w, CHIP.h)).toBe(false);
        }
      }
    }
  });

  test("every chip stays outside the focused cluster's bounding radius Rcl(n)", () => {
    for (let n = 1; n <= N_MAX; n++) {
      for (let j = 1; j <= J_MAX; j++) {
        expect(nearestToHub(chipPos(n, j), CHIP.w, CHIP.h)).toBeGreaterThanOrEqual(clusterRadius(n));
      }
    }
  });
});
