export type Author = "owner" | "agent";
export type Kind = "asked" | "found" | "did" | "approved" | "advises";

export interface Action {
  tool: string;
  summary: string;
}

export type Trigger = { from: "owner"; text: string } | { from: "agent"; type: string };

export interface Turn {
  id: string;
  author: Author;
  at: number;
  text: string;
  actions: Action[];
  openedBy?: string;
  trigger?: Trigger;
  guest?: true;
  open: boolean;
}

export interface Intent {
  id: string;
  title: string;
  createdAt: number;
}

export interface Label {
  turnId: string;
  intentId: string;
  kind: Kind;
  caption: string;
}

export type ServerEvent =
  | { type: "snapshot"; session: string; turns: Turn[]; intents: Intent[]; labels: Label[]; labelerError?: string }
  | { type: "turn"; turn: Turn }
  | { type: "intent"; intent: Intent }
  | { type: "label"; label: Label }
  | { type: "labeler"; error?: string }
  | { type: "reset" };
