// A local stand-in for an OpenAI-compatible /chat/completions endpoint. It records every request before any delay.
export interface RecordedRequest {
  path: string;
  auth: string | null;
  body: unknown;
  /** The user message parsed back to the labeler input object. */
  input: unknown;
  /** The raw assistant content the fake returned. */
  raw: string;
}

export interface FakeLabeler {
  url: string;
  requests: RecordedRequest[];
  /** Maps the labeler input to the assistant content. Default: an empty answer. */
  respond: (input: unknown) => string;
  /** Delay before responding, in ms. */
  delayMs: number;
  /** Non-200 status returned instead of an answer when set. */
  status: number;
  stop(): void;
}

/** Content of the first user message, or "" if the body is not a chat request. */
function userContent(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body)) return "";
  const msgs: unknown = body.messages;
  if (!Array.isArray(msgs)) return "";
  for (const m of msgs) {
    if (typeof m === "object" && m !== null && "role" in m && m.role === "user" && "content" in m) {
      if (typeof m.content === "string") return m.content;
    }
  }
  return "";
}

export function startFakeLabeler(): FakeLabeler {
  const fake: FakeLabeler = {
    url: "",
    requests: [],
    respond: () => JSON.stringify({ turns: [] }),
    delayMs: 0,
    status: 200,
    stop: () => {},
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body: unknown = await req.json();
      const text = userContent(body);
      const input: unknown = text === "" ? undefined : JSON.parse(text);
      const raw = fake.respond(input);
      fake.requests.push({ path: url.pathname, auth: req.headers.get("authorization"), body, input, raw });
      // Deliberate real delay: the latency test needs a labeler that is genuinely slow, which fake timers cannot model.
      if (fake.delayMs > 0) await Bun.sleep(fake.delayMs);
      if (fake.status !== 200) return new Response("boom", { status: fake.status });
      return Response.json({ choices: [{ message: { role: "assistant", content: raw } }] });
    },
  });

  fake.url = `http://127.0.0.1:${server.port}/v1`;
  fake.stop = () => {
    server.stop(true);
  };
  return fake;
}
