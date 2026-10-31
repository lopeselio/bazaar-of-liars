// Checks NEARAI_API_KEY works and shows which models are available. Never prints the key.
// Usage: pnpm check:nearai
const key = process.env.NEARAI_API_KEY;
const base = process.env.NEARAI_BASE_URL ?? "https://cloud-api.near.ai/v1";
const wanted = process.env.NEARAI_MODEL;

if (!key) {
  console.error("✗ NEARAI_API_KEY is empty. Put it in .env (copy of .env.example) and retry.");
  process.exit(1);
}

const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error(`✗ /models returned HTTP ${res.status}. Check the key on cloud.near.ai.`);
  process.exit(1);
}
const body = await res.json();
const ids = (body.data ?? []).map((m) => m.id).sort();
console.log(`✓ Key works. ${ids.length} models available:`);
for (const id of ids) console.log(`  ${id === wanted ? "→" : " "} ${id}`);

// A one-line completion proves billing/credits are set up too.
const chat = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: wanted,
    messages: [{ role: "user", content: "Reply with exactly: the bazaar is open" }],
    max_tokens: 20,
  }),
});
if (!chat.ok) {
  console.error(`✗ Completion with ${wanted} failed: HTTP ${chat.status} ${(await chat.text()).slice(0, 200)}`);
  process.exit(1);
}
const out = await chat.json();
console.log(`✓ ${wanted} replied: "${out.choices?.[0]?.message?.content?.trim()}" (chat id ${out.id})`);
