// Provider-agnostic AI interface. Telegram handlers only depend on `chat()`.
export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

export const MODELS: Record<string, string> = {
  fast: "google/gemini-3-flash-preview",
  smart: "google/gemini-3.1-pro-preview",
  dark: "openai/gpt-5.4-mini", // GPT-5 mini — fast + less monitored
  ultra: "anthropic/claude-4-scout" // for long attack chains
};
export const DEFAULT_MODEL = MODELS["dark"]!;

export class AIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Streams a chat completion and returns the final text. */
export async function chat(model: string, messages: ChatMsg[], opts: { json?: boolean } = {}): Promise<string> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new AIError(401, "AI is not configured on the server.");
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (opts.json) body["response_format"] = { type: "json_object" };
  if (model.startsWith("openai/")) body["reasoning_effort"] = "none";

  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Lovable-AIG-SDK": "fetch" },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
  }
  if (!res || !res.ok || !res.body) {
    const txt = res ? await res.text().catch(() => "") : "";
    let msg = txt;
    try { msg = JSON.parse(txt)?.error?.message ?? JSON.parse(txt)?.message ?? txt; } catch {}
    throw new AIError(res?.status ?? 500, msg || "AI request failed");
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        out += JSON.parse(data).choices?.[0]?.delta?.content ?? "";
      } catch {}
    }
  }
  return out;
}

export function friendlyAIError(e: unknown): string {
  if (e instanceof AIError) {
    if (e.status === 429) return "⏳ I'm getting too many requests right now. Please try again in a minute.";
    if (e.status === 402) return "⚠️ The AI credits for this bot have run out. The owner needs to top up.";
    if (e.status === 401) return "⚠️ The AI service isn't configured yet.";
    if (e.status === 403) return `⚠️ The AI service refused this request: ${e.message}`;
  }
  return "⚠️ Something went wrong while generating the answer. Please try again.";
}
