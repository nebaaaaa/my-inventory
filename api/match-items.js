// /api/match-items.js  (NEW) - AI second opinion for sale-item names that the
// built-in rules could not match confidently. It only SUGGESTS; the user always confirms.
// Uses the same GEMINI_API_KEY env var. Sends names and prices only, never photos.
// POST { sales:[{i,name,price}], items:[{id,name,cost}] } -> { matches:[{i,item_id}] }
export const config = { maxDuration: 20 };
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const PROMPT = `You match shop sale-item names to purchase-receipt item names (Ethiopia; names may be abbreviated, misspelled, or mix English and Amharic).
For each sale item, pick the ONE candidate that is the same product, or null if none is clearly the same. Sizes/volumes/weights must agree (1L is not 5L). A selling price is normally 1x to 2x the cost; a far different ratio means a different pack size, so prefer null. Never guess.
Return ONLY raw JSON: {"matches":[{"i":number,"item_id":string or null}]}`;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Server is not configured with a Gemini API key.' });
    const { sales, items } = req.body || {};
    if (!Array.isArray(sales) || !Array.isArray(items) || !sales.length || !items.length) return res.status(400).json({ error: 'sales and items are required' });
    const s = sales.slice(0, 30).map(x => ({ i: x.i, name: String(x.name || '').slice(0, 120), price: Number(x.price) || null }));
    const c = items.slice(0, 200).map(x => ({ id: String(x.id), name: String(x.name || '').slice(0, 120), cost: Number(x.cost) || null }));
    const ids = new Set(c.map(x => x.id));
    for (const model of MODELS) {
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT + '\n\nSALES: ' + JSON.stringify(s) + '\nCANDIDATES: ' + JSON.stringify(c) }] }], generationConfig: { response_mime_type: 'application/json' } }),
            });
            const data = await r.json().catch(() => null);
            if (!r.ok) { if ([400, 401, 403].includes(r.status)) break; continue; }
            const text = (((data.candidates || [])[0] || {}).content || {}).parts || [];
            const parsed = JSON.parse(text.map(p => p.text || '').join('').trim().replace(/^```json\s*|```$/g, ''));
            const matches = (parsed.matches || []).filter(m => m && m.item_id && ids.has(String(m.item_id))).map(m => ({ i: m.i, item_id: String(m.item_id) }));
            return res.status(200).json({ matches });
        } catch (e) { /* try next model */ }
    }
    res.status(200).json({ matches: [] }); // AI is optional: the rules still work without it
}
