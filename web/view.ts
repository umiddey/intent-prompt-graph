import type { Intent, Kind, Label, Turn } from "../src/model";
import { chipPos, type Point, turnPos } from "./layout";

/** What the page knows, rebuilt from the SSE stream. Labels may name turns not yet received. */
export interface State {
  connected: boolean;
  labelerError?: string;
  turns: Turn[];
  intents: Map<string, Intent>;
  labels: Map<string, Label>;
  /** Intent in focus. When unset or without turns, the newest labelled turn's intent is used. */
  focus?: string;
  /** Selected turn. When unset, the newest labelled turn is used. */
  selected?: string;
  follow: boolean;
  /** Newest turn the owner has seen. A newer turn raises the toast while Follow is off. */
  seen?: string;
}

export interface Derived {
  intentOf: Map<string, string>;
  byIntent: Map<string, Turn[]>;
  unlabeled: Turn[];
  latest?: Turn;
  focus?: string;
}

export interface View {
  z: number;
  tx: number;
  ty: number;
}

export interface Els {
  viewport: HTMLElement;
  world: HTMLElement;
  edges: SVGSVGElement;
  nodes: HTMLElement;
  /** Node elements by key, reused across paints so CSS transitions run. */
  keyed: Map<string, HTMLElement>;
  intents: HTMLElement;
  panel: HTMLElement;
  banner: HTMLElement;
  toast: HTMLElement;
  follow: HTMLElement;
}

export interface Slot {
  key: string;
  p: Point;
  w: number;
  h: number;
  cls: string;
  html: string;
  data: Record<string, string>;
  fade: number;
  kind?: Kind;
  card: boolean;
}

const KIND_WORD: Record<Kind, string> = {
  asked: "ASKED",
  approved: "APPROVED",
  found: "FOUND",
  did: "DID",
  advises: "ADVISES",
};
const HUB = { w: 260, h: 120 };
const CARD = { w: 220, h: 90 };
const CHIP = { w: 200, h: 48 };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}

function ago(at: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr}h ago` : `${Math.floor(hr / 24)}d ago`;
}

const clock = (at: number): string => new Date(at).toLocaleString();

const UNSORTED = "unsorted";

function titleOf(s: State, id: string | undefined): string {
  if (id === UNSORTED) return "Unsorted turns";
  return (id === undefined ? undefined : s.intents.get(id)?.title) ?? "Untitled";
}

function headOf(t: Turn, label: Label | undefined): string {
  const who = t.author === "owner" ? "YOU" : "AGENT";
  return label ? `${who} ${KIND_WORD[label.kind]}` : who;
}

/** A turn's intent: its own label, else the label of the owner turn that opened it. */
function intentFor(s: State, t: Turn, byId: Map<string, Turn>): string | undefined {
  const seen = new Set<string>();
  let cur: Turn | undefined = t;
  while (cur && !seen.has(cur.id)) {
    const label = s.labels.get(cur.id);
    if (label && s.intents.has(label.intentId)) return label.intentId;
    seen.add(cur.id);
    cur = cur.openedBy === undefined ? undefined : byId.get(cur.openedBy);
  }
  return undefined;
}

export function derive(s: State): Derived {
  const byId = new Map(s.turns.map((t) => [t.id, t] as const));
  const intentOf = new Map<string, string>();
  const byIntent = new Map<string, Turn[]>();
  const unlabeled: Turn[] = [];
  let latest: Turn | undefined;
  for (const t of s.turns) {
    const id = intentFor(s, t, byId);
    if (id === undefined) {
      unlabeled.push(t);
      continue;
    }
    intentOf.set(t.id, id);
    const list = byIntent.get(id) ?? [];
    list.push(t);
    byIntent.set(id, list);
    latest = t;
  }
  // Nothing labelled yet (labeler off, failing or still working): show the turns instead of an empty page.
  if (byIntent.size === 0 && unlabeled.length > 0) {
    for (const t of unlabeled) intentOf.set(t.id, UNSORTED);
    byIntent.set(UNSORTED, unlabeled.splice(0));
    latest = byIntent.get(UNSORTED)?.at(-1);
  }
  const kept = s.focus !== undefined && byIntent.has(s.focus);
  const focus = kept ? s.focus : latest && intentOf.get(latest.id);
  return { intentOf, byIntent, unlabeled, latest, focus };
}

/** The selected turn, or the newest labelled turn when none is selected. */
export function selected(s: State, d: Derived): Turn | undefined {
  const id = s.selected ?? d.latest?.id;
  return s.turns.find((t) => t.id === id);
}

function cardHtml(t: Turn, label: Label | undefined, now: number): string {
  const guest = t.guest ? " · guest" : "";
  const step = t.actions.at(-1);
  const live = t.open ? `<div class="live">${esc(step ? `${step.tool}: ${step.summary}` : "working…")}</div>` : "";
  return (
    `<div class="kind">${esc(headOf(t, label))}${guest}<span class="when"> · ${esc(ago(t.at, now))}</span></div>` +
    `<div class="caption">${esc(label?.caption ?? t.text.slice(0, 120))}</div>${live}`
  );
}

/** Every node on the page with its position: the hub, the focused intent's turns, and the chips. */
export function slotsOf(s: State, d: Derived, now: number): Slot[] {
  const cards = (d.focus === undefined ? undefined : d.byIntent.get(d.focus)) ?? [];
  const n = cards.length;
  const order = new Map(s.turns.map((t, i) => [t.id, i] as const));
  const sel = selected(s, d)?.id;
  const last = cards.at(-1);
  const slots: Slot[] = [
    {
      key: "hub",
      p: { x: 0, y: 0 },
      w: HUB.w,
      h: HUB.h,
      cls: "node hub focus",
      html:
        d.focus === undefined
          ? `<div class="title">Waiting for turns</div><div class="meta">0 turns</div>`
          : `<div class="title">${esc(titleOf(s, d.focus))}</div><div class="meta">${n} turns · ${last ? esc(ago(last.at, now)) : "no activity"}</div>`,
      data: {},
      fade: 1,
      card: false,
    },
  ];
  cards.forEach((t, k) => {
    const label = s.labels.get(t.id);
    const rank = s.turns.length - 1 - (order.get(t.id) ?? 0);
    const cls = [
      "node",
      "card",
      label && `kind-${label.kind}`,
      t.open && "open",
      t.id === d.latest?.id && "latest",
      t.id === sel && "selected",
    ]
      .filter(Boolean)
      .join(" ");
    slots.push({
      key: `turn:${t.id}`,
      p: turnPos(k + 1),
      w: CARD.w,
      h: CARD.h,
      cls,
      html: cardHtml(t, label, now),
      data: { turn: t.id },
      fade: Math.max(0.35, 0.5 ** (rank / 15)),
      kind: label?.kind,
      card: true,
    });
  });
  const others = [...s.intents.keys()].filter((id) => id !== d.focus && d.byIntent.has(id));
  others.forEach((id, k) => {
    const turns = d.byIntent.get(id) ?? [];
    const kinds = new Set<Kind>();
    for (const t of turns) {
      const kind = s.labels.get(t.id)?.kind;
      if (kind) kinds.add(kind);
    }
    const dots = [...kinds].map((kind) => `<i class="dot kind-${kind}"></i>`).join("");
    slots.push({
      key: `intent:${id}`,
      p: chipPos(n, k + 1),
      w: CHIP.w,
      h: CHIP.h,
      cls: "node chip",
      html: `<div class="name">${esc(titleOf(s, id))}</div><div class="count">${turns.length} turns ${dots}</div>`,
      data: { intent: id },
      fade: 1,
      card: false,
    });
  });
  if (d.unlabeled.length > 0) {
    slots.push({
      key: "sorting",
      p: chipPos(n, others.length + 1),
      w: CHIP.w,
      h: CHIP.h,
      cls: `node chip sorting${s.labelerError ? " error" : ""}`,
      html: `<div class="name">Sorting…</div><div class="count">${d.unlabeled.length} unlabeled</div>`,
      data: { sorting: "1" },
      fade: 1,
      card: false,
    });
  }
  return slots;
}

function sidebarHtml(s: State, d: Derived): string {
  const rows = [...s.intents.values()].map((i) => ({ i, turns: d.byIntent.get(i.id) ?? [] }));
  rows.sort((a, b) => (b.turns.at(-1)?.at ?? b.i.createdAt) - (a.turns.at(-1)?.at ?? a.i.createdAt));
  return rows
    .map(
      ({ i, turns }) =>
        `<li data-intent="${esc(i.id)}" class="${i.id === d.focus ? "on" : ""}"><span>${esc(i.title)}</span><span>${turns.length}</span></li>`,
    )
    .join("");
}

function panelHtml(s: State, d: Derived, now: number): string {
  const t = selected(s, d);
  if (!t) return `<p class="meta">No turns yet.</p>`;
  const label = s.labels.get(t.id);
  const intentId = d.intentOf.get(t.id);
  const thread = intentId === undefined ? [] : (d.byIntent.get(intentId) ?? []);
  const actions =
    t.actions.length > 0
      ? `<h3>Actions</h3><ul class="actions">${t.actions.map((a) => `<li><b>${esc(a.tool)}</b> ${esc(a.summary)}</li>`).join("")}</ul>`
      : "";
  const items = thread
    .map((x) => {
      const cap = s.labels.get(x.id)?.caption ?? x.text.slice(0, 120);
      return `<li data-turn="${esc(x.id)}" class="${x.id === t.id ? "on" : ""}"><span class="when">${esc(clock(x.at))}</span>${esc(cap)}</li>`;
    })
    .join("");
  return (
    `<h2>${esc(headOf(t, label))}</h2>` +
    `<div class="meta">${esc(clock(t.at))} · ${esc(ago(t.at, now))} · in ${esc(titleOf(s, intentId))}${t.guest ? " · guest" : ""}</div>` +
    `<div class="text">${esc(t.text)}</div>${actions}<h3>Thread</h3><ol>${items}</ol>`
  );
}

function place(els: Els, sl: Slot): void {
  let el = els.keyed.get(sl.key);
  if (!el) {
    el = document.createElement("div");
    els.keyed.set(sl.key, el);
    els.nodes.append(el);
  }
  el.className = sl.cls;
  el.innerHTML = sl.html;
  el.style.left = `${sl.p.x}px`;
  el.style.top = `${sl.p.y}px`;
  el.style.setProperty("--fade", String(sl.fade));
  Object.assign(el.dataset, sl.data);
}

/** Redraws nodes, edges, sidebar and panel. Nodes are reused by key so their position transitions run. */
export function paint(s: State, d: Derived, els: Els, now: number): void {
  const slots = slotsOf(s, d, now);
  els.edges.innerHTML = slots
    .filter((sl) => sl.card)
    .map((sl) => {
      const { x, y } = sl.p;
      const cx = x / 2 - y * 0.15;
      const cy = y / 2 + x * 0.15;
      return `<path class="${sl.kind ? `kind-${sl.kind}` : ""}" d="M0 0 Q${cx} ${cy} ${x} ${y}" style="opacity:${sl.fade}"/>`;
    })
    .join("");
  for (const sl of slots) place(els, sl);
  const keep = new Set(slots.map((sl) => sl.key));
  for (const [key, el] of els.keyed) {
    if (keep.has(key)) continue;
    el.remove();
    els.keyed.delete(key);
  }
  els.intents.innerHTML = sidebarHtml(s, d);
  els.panel.innerHTML = panelHtml(s, d, now);
}

/** Banner, toast and the Follow button. */
export function chrome(s: State, d: Derived, els: Els): void {
  els.banner.hidden = s.connected && !s.labelerError;
  els.banner.textContent = s.connected ? `Labeler error: ${s.labelerError ?? ""}` : "Connection lost. Reconnecting…";
  const newest = s.turns.at(-1);
  const unseen = !s.follow && newest !== undefined && newest.id !== s.seen;
  els.toast.hidden = !unseen;
  if (newest && unseen) {
    const id = d.intentOf.get(newest.id);
    els.toast.textContent = `New turn in ${id === undefined ? "Sorting…" : titleOf(s, id)} — jump`;
    els.toast.dataset.jump = newest.id;
  }
  els.follow.textContent = `Follow latest: ${s.follow ? "on" : "off"}`;
  els.follow.setAttribute("aria-pressed", String(s.follow));
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function applyView(world: HTMLElement, v: View): void {
  world.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
}

/** The zoom and offset that centre the slots in a viewport of the given size. */
export function fitView(slots: Slot[], vw: number, vh: number): View {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const sl of slots) {
    x0 = Math.min(x0, sl.p.x - sl.w / 2);
    x1 = Math.max(x1, sl.p.x + sl.w / 2);
    y0 = Math.min(y0, sl.p.y - sl.h / 2);
    y1 = Math.max(y1, sl.p.y + sl.h / 2);
  }
  const pad = 40;
  const z = clampZoom(Math.min(vw / (x1 - x0 + 2 * pad), vh / (y1 - y0 + 2 * pad)));
  return { z, tx: (-z * (x0 + x1)) / 2, ty: (-z * (y0 + y1)) / 2 };
}
