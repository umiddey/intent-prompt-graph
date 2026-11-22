import { expect, test } from "bun:test";
import type { Turn } from "../src/model";
import { derive, slotsOf, type State } from "../web/view";

const turn = (i: number): Turn => ({ id: `t${i}`, author: "owner", at: 1000 + i, text: `turn ${i}`, actions: [], open: false });

const state = (n: number): State => ({
  connected: true,
  turns: Array.from({ length: n }, (_, i) => turn(i)),
  intents: new Map(),
  labels: new Map(),
  follow: true,
});

test("with no labels, only the newest turns are drawn and the hub says how many exist", () => {
  const s = state(150);
  const slots = slotsOf(s, derive(s), 5000);
  const cards = slots.filter((x) => x.card);
  expect(cards).toHaveLength(12);
  expect(cards.at(-1)?.key).toBe("turn:t149");
  expect(slots[0]?.html).toContain("newest 12 of 150 turns");
});

test("a short unlabelled session shows every turn", () => {
  const s = state(5);
  expect(slotsOf(s, derive(s), 5000).filter((x) => x.card)).toHaveLength(5);
});
