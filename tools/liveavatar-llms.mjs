// One-time setup: registers each vendor API key as a LiveAvatar secret and creates an
// LLM configuration for it. Prints the "llms" block for lambda/session-token/config.json.
//
// Environment (set only the vendors you want; missing ones are skipped):
//   LIVEAVATAR_API_KEY   required
//   OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
//
// Run:  node tools/liveavatar-llms.mjs
// Re-running creates new secrets and configurations each time; delete extras in the dashboard.

const API = "https://api.liveavatar.com/v1";
const key = process.env.LIVEAVATAR_API_KEY;
if (!key) { console.error("LIVEAVATAR_API_KEY is not set"); process.exit(1); }

// base_url: each vendor's OpenAI-compatible root. LiveAvatar appends the /chat/completions route.
// secret_type is OPENAI_API_KEY for all three: the key is sent as a bearer token to base_url, so the
// vendor does not matter, and the API has no Anthropic type (accepted values are OPENAI_API_KEY,
// ELEVENLABS_API_KEY, GEMINI_API_KEY, FISH_API_KEY, CARTESIA_API_KEY).
const VENDORS = [
  { id: "openai", name: "Ask Ed OpenAI", env: "OPENAI_API_KEY",    model: "gpt-4o-mini",      base_url: "https://api.openai.com/v1" },
  { id: "claude", name: "Ask Ed Claude", env: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-6", base_url: "https://api.anthropic.com/v1" },
  { id: "gemini", name: "Ask Ed Gemini", env: "GEMINI_API_KEY",    model: "gemini-2.5-flash", base_url: "https://generativelanguage.googleapis.com/v1beta/openai" },
];

async function post(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "X-API-KEY": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return data.data ?? data; // responses may be wrapped in { code, data, message }
}

const llms = {};
for (const v of VENDORS) {
  const vendorKey = process.env[v.env];
  if (!vendorKey) { console.log(`${v.id}: ${v.env} not set, skipped`); continue; }
  const secret = await post("/secrets", { secret_type: "OPENAI_API_KEY", secret_name: v.name, secret_value: vendorKey });
  const cfg = await post("/llm-configurations", { display_name: v.name, model_name: v.model, secret_id: secret.id, base_url: v.base_url });
  llms[v.id] = { llm_configuration_id: cfg.id };
  console.log(`${v.id}: secret ${secret.id}, llm_configuration ${cfg.id}`);
}

console.log("\nPaste into lambda/session-token/config.json:\n");
console.log(JSON.stringify({ llms }, null, 2));
