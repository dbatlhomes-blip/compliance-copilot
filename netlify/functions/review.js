// Listing Compliance Co-Pilot -- secure backend
// Runs on Netlify Functions (Node 18+). The AI API key lives ONLY here,
// as an environment variable, and is never sent to the browser.

const SYSTEM_PROMPT = `You are a real estate advertising compliance reviewer. You audit listing
copy against the NAR Code of Ethics, Article 12 (truthful advertising):
"REALTORS shall be honest and truthful in their real estate communications and
shall present a true picture in their advertising, marketing, and other representations."

Review the listing the user provides and identify every claim that is exaggerated,
unsubstantiated, misleading, or otherwise not a "true picture."

Check for each of these:
1. Unsubstantiated superlatives / puffery stated as fact ("best","lowest","largest","finest","priced to sell","a steal").
2. Comparative claims of fact with no verifiable source (lot size, HOA fees, taxes, square footage, "top-rated schools").
3. "Free"/bonus/incentive language without ALL terms disclosed at the same time -> Standard of Practice 12-1.
4. Seller's terms, price, or negotiating position not clearly authorized ("motivated seller","bring all offers") -> SOP 12-4.
5. Missing brokerage FIRM NAME (must be readily apparent) -> SOP 12-5.
6. "Sold" claims by anyone not the listing/cooperating broker -> SOP 12-7.
7. Out-of-date / misleading / unverifiable statements (schools, distances, "walking distance","minutes from everything").
8. ALSO flag Fair Housing risks (describing the ideal buyer: "perfect for families","great for retirees") and label the rule as "Fair Housing / Art. 10" (NOT Article 12).

For each flag choose a "rule" label that is one of: a Standard of Practice like "SOP 12-1",
or "Article 12 . True Picture", or "Fair Housing / Art. 10".
For each flag choose "risk" as exactly one of: "high", "med", "low".

Then produce ONE clean, ready-to-publish compliant rewrite that keeps the marketing energy
but uses only verifiable statements. Where a fact must be confirmed, insert a clearly marked
placeholder like [VERIFY lot size] or [FIRM NAME]. Keep the rewrite in the SAME LANGUAGE as
the original listing (English or Spanish). Do NOT invent facts.

Respond with STRICT JSON ONLY (no markdown, no commentary) in exactly this shape:
{
"flags": [
{"quote":"the exact phrase from the listing","problem":"why it is a problem","rule":"SOP 12-1","risk":"high","fix":"the compliant fix"}
],
"rewrite":"the full compliant rewrite as one string",
"verify":"one short sentence listing the facts the agent must verify before posting"
}
If nothing is problematic, return "flags": [] and still provide a polished rewrite.`;

function json(statusCode, obj) {
return {
statusCode,
headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
body: JSON.stringify(obj),
};
}

exports.handler = async (event) => {
const requiresCode = !!process.env.ACCESS_CODE;

// Lightweight probe so the page knows whether to show the access-code box.
if (event.httpMethod === "GET") {
  if (event.queryStringParameters && event.queryStringParameters.debug === "models") { const dk = process.env.ANTHROPIC_API_KEY; if (!dk) return json(500, { error: "no key" }); const dr = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": dk, "anthropic-version": "2023-06-01" } }); const dt = await dr.text(); return json(dr.status, { status: dr.status, body: dt.slice(0,3000) }); }
return json(200, { ok: true, requiresCode });
}
if (event.httpMethod !== "POST") {
return json(405, { error: "Method not allowed." });
}

let data;
try { data = JSON.parse(event.body || "{}"); }
catch (e) { return json(400, { error: "Bad request." }); }

const listing = (data.listing || "").toString().trim();
const code = (data.code || "").toString().trim();

// Optional shared access code to protect your API budget from bots.
if (requiresCode && code !== process.env.ACCESS_CODE) {
return json(401, { error: "Incorrect or missing access code. Ask your instructor for today's code." });
}

if (listing.length < 20) return json(400, { error: "Please paste a longer listing description." });
if (listing.length > 6000) return json(400, { error: "That listing is too long (max 6000 characters)." });

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) return json(500, { error: "The reviewer isn't configured yet (missing API key)." });

const model = process.env.MODEL || "claude-3-haiku-20240307";

try {
const resp = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: {
"content-type": "application/json",
"x-api-key": apiKey,
"anthropic-version": "2023-06-01",
},
body: JSON.stringify({
model,
max_tokens: 2000,
system: SYSTEM_PROMPT,
messages: [{ role: "user", content: "Review this listing description:\n\n" + listing }],
}),
});

if (!resp.ok) {
const t = await resp.text();
console.error("Anthropic error", resp.status, t);
let msg = "The AI reviewer returned an error. Please try again in a moment.";
if (resp.status === 401) msg = "The AI key is invalid -- check the API key setting.";
if (resp.status === 429) msg = "Too many requests right now -- please wait a few seconds and try again.";
return json(502, { error: msg });
}

const out = await resp.json();
let text = "";
if (out && Array.isArray(out.content)) {
text = out.content.map((c) => (c && c.text) ? c.text : "").join("");
}

// Extract the JSON object even if the model wrapped it in stray text/fences.
let parsed = null;
try { parsed = JSON.parse(text); }
catch (e) {
const m = text.match(/\{[\s\S]*\}/);
if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
}
if (!parsed) {
console.error("Could not parse model output:", text.slice(0, 500));
return json(502, { error: "The reviewer returned an unexpected format. Please try again." });
}

// Normalize shape defensively.
const flags = Array.isArray(parsed.flags) ? parsed.flags.map((f) => ({
quote: (f.quote || "").toString(),
problem: (f.problem || "").toString(),
rule: (f.rule || "Article 12 . True Picture").toString(),
risk: (["high", "med", "low"].includes((f.risk || "").toLowerCase()) ? f.risk.toLowerCase() : "med"),
fix: (f.fix || "").toString(),
})) : [];

return json(200, {
flags,
rewrite: (parsed.rewrite || "").toString(),
verify: (parsed.verify || "").toString(),
});
} catch (err) {
console.error("Function error", err);
return json(500, { error: "Unexpected error. Please try again." });
}
};
