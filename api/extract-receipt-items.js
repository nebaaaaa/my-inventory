// /api/extract-receipt-items.js
//
// NEW endpoint for the Scanned Stock feature. Your existing
// /api/extract-receipt.js is NOT touched.
//
// Same safety pattern: runs on Vercel's server, the Gemini key lives only in
// the GEMINI_API_KEY environment variable and never reaches the browser.
//
// Frontend calls:  POST /api/extract-receipt-items   body: { image: "<base64 jpeg, no data: prefix>" }
// Returns:         { seller_name, seller_tin, receipt_no, date_*, is_vat,
//                    before_vat, vat, total, items: [ ... every line ... ], missing_fields }

export const config = { maxDuration: 30 };

const ITEMS_PROMPT = `You are reading a photo of an Ethiopian PURCHASE document (the shop bought goods from a supplier). It is ONE of two layouts — figure out which first:

LAYOUT A — fiscal cash register receipt (thin thermal paper):
- The SELLER'S TIN is near the top as "TIN: XXXXXXXXXX", followed by the seller's business name. "Buyer's TIN" further down is the buyer, never the seller.
- Receipt number: "FS No. XXXXXXXX". Date: DD/MM/YYYY, Gregorian, day first.
- Items are either one line each ("DESCRIPTION  QTY  PRICE  AMOUNT") or two lines each ("QTY x PRICE =" then "DESCRIPTION  *AMOUNT").
- Taxable subtotal = "TXBL1". VAT = "TAX1"/"TAX 1" (15%). Grand total = "TOTAL".

LAYOUT B — manual yellow "Sales Invoice" (hand-filled carbon copy):
- Seller = the pre-printed "Supplier" block (top-left). Buyer = the hand-filled "Customer" block. Never swap them.
- Invoice number is the pre-printed (often red) serial near "No.".
- The date is handwritten and is almost always ETHIOPIAN calendar, day/month/2-digit-year (e.g. "28/10/17" = day 28, month 10, year 2017). Then date_calendar = "EC" and date_year = full 4-digit year.

TASK: extract EVERY line item on the document. Do not skip, merge, or summarise lines. Do not include subtotal, VAT, total, discount, or payment lines as items.

Return ONLY raw JSON, no markdown fences, no commentary:
{
  "seller_name": string or null,
  "seller_tin": string or null,
  "receipt_no": string or null,
  "date_calendar": "GC" or "EC",
  "date_year": number or null,
  "date_month": number or null,
  "date_day": number or null,
  "is_vat": boolean,
  "before_vat": number or null,
  "vat": number or null,
  "total": number or null,
  "items": [
    {
      "description": string,
      "quantity": number or null,
      "measurement": string or null,
      "unit_price": number or null,
      "amount": number or null,
      "pack_hint": string or null
    }
  ],
  "missing_fields": string[]
}

Rules for each item:
- "description": copy the item text exactly as printed/written. Do not translate, correct, or expand it.
- "quantity" and "unit_price": as printed. If only the line amount is printed, leave the missing one null (do not guess).
- "amount": the line total as printed.
- "measurement": only a unit that is actually printed next to the item (PCS, KG, M, L, BOX, PK...). Otherwise null — never guess.
- "pack_hint": only if the description itself states a pack size, for example "12PCS/BOX", "carton of 24", "1x10". Copy that text; otherwise null.
- "before_vat", "vat", "total" are always the receipt-wide totals, never per-item figures.
- "missing_fields": only from this set, and only if you could not confidently read it: "Seller name", "Seller TIN", "Items", "Total".`;

const VAT_RATE = 0.15;
function toNumOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }

// Same idea as extract-receipt.js: if a photo cuts off one of the three
// money totals, work it out from the others (flat 15% VAT).
function fillMissingVatFields(parsed) {
    if (!parsed.is_vat) return parsed;
    let beforeVat = toNumOrNull(parsed.before_vat);
    let vat = toNumOrNull(parsed.vat);
    let total = toNumOrNull(parsed.total);

    if (beforeVat !== null && vat === null && total === null) {
        vat = round2(beforeVat * VAT_RATE); total = round2(beforeVat + vat);
    } else if (beforeVat !== null && vat !== null && total === null) {
        total = round2(beforeVat + vat);
    } else if (beforeVat !== null && vat === null && total !== null) {
        vat = round2(total - beforeVat);
    } else if (beforeVat === null && vat !== null && total !== null) {
        beforeVat = round2(total - vat);
    } else if (beforeVat === null && vat !== null && total === null) {
        beforeVat = round2(vat / VAT_RATE); total = round2(beforeVat + vat);
    } else if (beforeVat === null && vat === null && total !== null) {
        beforeVat = round2(total / (1 + VAT_RATE)); vat = round2(total - beforeVat);
    }
    parsed.before_vat = beforeVat;
    parsed.vat = vat;
    parsed.total = total;
    return parsed;
}

// Clean up the item list the model returned: real numbers, no empty rows,
// and fill the obvious gap (amount = qty x price, or price = amount / qty).
function cleanItems(rawItems) {
    if (!Array.isArray(rawItems)) return [];
    const out = [];
    for (const it of rawItems.slice(0, 150)) {
        if (!it || typeof it !== 'object') continue;
        const description = String(it.description || '').trim();
        if (!description) continue;
        let quantity = toNumOrNull(it.quantity);
        let unitPrice = toNumOrNull(it.unit_price);
        let amount = toNumOrNull(it.amount);
        if (amount === null && quantity !== null && unitPrice !== null) amount = round2(quantity * unitPrice);
        if (unitPrice === null && quantity && amount !== null) unitPrice = round2(amount / quantity);
        if (quantity === null && unitPrice && amount !== null) quantity = round2(amount / unitPrice);
        out.push({
            description,
            quantity,
            measurement: it.measurement ? String(it.measurement).trim() : null,
            unit_price: unitPrice,
            amount,
            pack_hint: it.pack_hint ? String(it.pack_hint).trim() : null,
        });
    }
    return out;
}

// Tried in order. 429/503 (busy) -> try the next model.
// 400/401/403 (bad key or bad request) -> stop at once, every model would fail the same way.
const OCR_MODEL_FALLBACKS = [
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
];

async function callGeminiOnce(model, base64, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [
                    { text: ITEMS_PROMPT },
                    { inline_data: { mime_type: 'image/jpeg', data: base64 } },
                ],
            }],
            generationConfig: { response_mime_type: 'application/json' },
        }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const msg = (data && data.error && data.error.message) || `Gemini request failed (${res.status})`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    const text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
        .map((p) => p.text || '')
        .join('');
    if (!text.trim()) throw new Error('No result returned from the AI model');
    return text;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        res.status(500).json({ error: 'Server is not configured with a Gemini API key.' });
        return;
    }

    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
        res.status(400).json({ error: 'Request body must include an "image" field (base64 JPEG, no data: prefix).' });
        return;
    }

    let text = null;
    let lastErr = null;
    for (const model of OCR_MODEL_FALLBACKS) {
        try {
            text = await callGeminiOnce(model, image, apiKey);
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            if (err.status === 400 || err.status === 401 || err.status === 403) {
                res.status(502).json({ error: 'Gemini rejected the request (' + err.status + '). Check that the server-side GEMINI_API_KEY env var in Vercel is correct.' });
                return;
            }
        }
    }

    if (text === null) {
        res.status(502).json({ error: (lastErr && lastErr.message) || 'All OCR models failed.' });
        return;
    }

    try {
        const cleaned = text.trim().replace(/^```json\s*|```$/g, '');
        let parsed = JSON.parse(cleaned);
        parsed = fillMissingVatFields(parsed);
        parsed.date_calendar = parsed.date_calendar === 'EC' ? 'EC' : 'GC';
        parsed.items = cleanItems(parsed.items);
        parsed.missing_fields = Array.isArray(parsed.missing_fields) ? parsed.missing_fields : [];
        if (!parsed.items.length && !parsed.missing_fields.includes('Items')) parsed.missing_fields.push('Items');
        res.status(200).json(parsed);
    } catch (e) {
        res.status(502).json({ error: 'Model returned non-JSON output that could not be parsed.' });
    }
}
