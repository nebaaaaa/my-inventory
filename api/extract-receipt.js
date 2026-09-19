// /api/extract-receipt.js
//
// Vercel serverless function. Runs on Vercel's servers, never in the browser.
// The Gemini API key lives ONLY in an environment variable here — it is
// never sent to, or visible from, the client.
//
// Frontend calls this as: POST /api/extract-receipt  with JSON body { image: "<base64 jpeg, no data: prefix>" }
// Returns: the parsed receipt JSON (same shape the old client-side code produced).

const RECEIPT_PROMPT = `You are reading a photo of an Ethiopian purchase document. It will be ONE of two layouts — figure out which one you're looking at first:

LAYOUT A — fiscal cash register receipt (ERCA-compliant, usually thin white/thermal paper):
- The SELLER'S TIN is printed near the very top as "TIN: XXXXXXXXXX", immediately followed by the seller's business/owner name, then address/phone lines.
- A separate "Buyer's TIN" (sometimes "Buyer's T I N") line appears further down — that is the BUYER'S own TIN, not the seller's. Never use it for seller_tin (see buyer_tin below for what to do with it).
- The receipt number is printed as "FS No. XXXXXXXX".
- The date is printed as DD/MM/YYYY, always in the GREGORIAN calendar, day first — this receipt format never uses the Ethiopian calendar.
- Line items appear either as one line per item ("DESCRIPTION   QTY   PRICE   AMOUNT") or as two lines per item ("QTY x PRICE =" then "DESCRIPTION   *AMOUNT" on the next line).
- The taxable subtotal is labeled "TXBL1". The VAT amount is labeled "TAX1" or "TAX 1" (usually shown with "15.00%" or "15%") — this receipt format never prints the word "VAT" for this line. The grand total is labeled "TOTAL".
- A machine registration code is printed near the bottom as "ET" followed by a code like "FGB0005691" or "BEB0004862" — this is the MRC (machine registration certificate number). It is never labeled "MRC" directly.
- A separate VAT registration number is usually NOT printed on these receipts — only fill vat_reg_no if you actually see a distinct label like "VAT REG NO"; do not reuse the TIN for it.

LAYOUT B — manual "Sales Invoice" (a hand-filled carbon-copy form, easy to recognize because the paper itself is YELLOW). This form has two separate identity blocks and it is critical not to mix them up:
- A "Supplier" block (sometimes headed "Name of Supplier"/"From", "Supplier's TIN", "Supplier's VAT Reg. No.") is usually PRE-PRINTED/fixed at the top-left — this is whoever's invoice pad it is, i.e. the SELLER. Read seller_name, seller_tin, and vat_reg_no from THIS block.
- A "Customer"/"Buyer" block ("To", "Customer's TIN No.", "Customer's VAT Reg. No.") is hand-filled — this is the party who bought the goods. Read buyer_tin from THIS block (handwritten digits — read carefully, they can be cramped). Never swap the two blocks.
- Important: depending on whose invoice pad was photographed, either party could be "our" client — sometimes the pad belongs to the client's own business (client is the Supplier, this was a sale they made), sometimes it's a supplier's pad handed to the client as proof of a purchase (client is the Customer). Extract both seller_tin and buyer_tin faithfully exactly as printed/written; do not guess which one is "the client" — that comparison happens outside this extraction step.
- There is usually no separate MRC/machine code on this layout since it's hand-filled, not machine-printed — leave mrc null unless one is actually printed/stamped.
- The invoice number is a pre-printed serial (often in red ink) near "No." at the top — use it for receipt_no.
- The date field on this layout ("ቀን"/"Date") is filled in BY HAND and is almost always the ETHIOPIAN CALENDAR, written day/month/year with a 2-digit year, e.g. "28/10/17" means day 28, month 10, Ethiopian year 2017 (a 2-digit year here always means 20XX in the Ethiopian calendar — so "17" is 2017, "16" is 2016, etc.). Set date_calendar to "EC" and date_year to the full 4-digit Ethiopian year (2017, not 17) whenever you see this handwritten day/month/2-digit-year style. Only use "GC" for this layout if a clearly 4-digit Gregorian year is written instead.
- Line items, VAT (15%) and totals follow the same general idea as layout A: read whatever subtotal, VAT, and total figures are filled in by hand, and the single largest line item for description/quantity/unit price, exactly as described below.

Whichever layout it is, always try to extract BOTH seller_tin (from the Supplier block) and buyer_tin (from the Customer/Buyer block) when either is printed or written, even if one looks unused — both are needed to work out which side of the transaction belongs to our client, which is decided outside this extraction step, never by you.

Extract exactly these fields and return ONLY raw JSON, no markdown fences, no commentary:
{
  "seller_name": string or null,
  "seller_tin": string or null,
  "vat_reg_no": string or null,
  "buyer_tin": string or null,
  "mrc": string or null,
  "date_calendar": "GC" or "EC",
  "date_year": number or null,
  "date_month": number or null,
  "date_day": number or null,
  "receipt_no": string or null,
  "is_vat": boolean,
  "before_vat": number or null,
  "vat": number or null,
  "total": number or null,
  "description": string or null,
  "measurement": string or null,
  "quantity": number or null,
  "unit_price": number or null,
  "missing_fields": string[]
}

If there are multiple line items, pick only the SINGLE item with the largest amount and use its description, quantity, and unit_price — do not combine or list multiple items together in "description". Set "measurement" to "Lot", "quantity" to 1, and "unit_price" equal to "before_vat" ONLY if you cannot identify a clear largest item; otherwise use that one item's own measurement/quantity/unit_price as printed (measurement only if a unit like PCS/KG/M is actually printed next to it — this receipt format usually does not print one, so leave it null rather than guess). If there is exactly ONE line item, fill "description", "quantity", and "measurement" from that single item, but set "unit_price" equal to "before_vat" (the receipt's taxable subtotal) regardless of what is printed next to that item — with only one item, its line amount and the subtotal are the same thing. "before_vat", "vat", and "total" should always be the receipt-wide totals from the TXBL1/TAX1/TOTAL lines, never a per-item figure. A separate VAT registration number is normal to be absent on this receipt format — never include "VAT reg no" in "missing_fields". In "missing_fields", only list fields from this set that you could not confidently read: "Seller name", "Seller TIN", "MRC".`;

// Ethiopian VAT-registered receipts charge a flat 15% VAT rate. Photos
// sometimes cut off or blur one of the three money fields (before-VAT
// subtotal, VAT amount, total) — if we have any two of them, or even just
// one, we can work out the rest instead of leaving the field blank.
const VAT_RATE = 0.15;
function toNumOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }
function fillMissingVatFields(parsed) {
    if (!parsed.is_vat) return parsed; // non-VAT receipts don't get a computed VAT amount
    let beforeVat = toNumOrNull(parsed.before_vat);
    let vat = toNumOrNull(parsed.vat);
    let total = toNumOrNull(parsed.total);

    if (beforeVat !== null && vat === null && total === null) {
        vat = round2(beforeVat * VAT_RATE);
        total = round2(beforeVat + vat);
    } else if (beforeVat !== null && vat !== null && total === null) {
        total = round2(beforeVat + vat);
    } else if (beforeVat !== null && vat === null && total !== null) {
        vat = round2(total - beforeVat);
    } else if (beforeVat === null && vat !== null && total !== null) {
        beforeVat = round2(total - vat);
    } else if (beforeVat === null && vat !== null && total === null) {
        beforeVat = round2(vat / VAT_RATE);
        total = round2(beforeVat + vat);
    } else if (beforeVat === null && vat === null && total !== null) {
        beforeVat = round2(total / (1 + VAT_RATE));
        vat = round2(total - beforeVat);
    }
    // If none of the three were readable, or all three already were, this
    // leaves them as-is (all null, or all already filled in).

    parsed.before_vat = beforeVat;
    parsed.vat = vat;
    parsed.total = total;
    return parsed;
}

// Tried in order. First one that succeeds wins. If a model is overloaded
// (429/503) we move to the next one. A 400/401/403 means the API key or
// request itself is bad — that fails every model identically, so we stop
// immediately instead of burning the rest of the list.
const OCR_MODEL_FALLBACKS = [
    'gemini-3.6-flash',      // current stable flagship flash model
    'gemini-3.5-flash-lite', // cheaper/faster backup if 3.6-flash is overloaded
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
                    { text: RECEIPT_PROMPT },
                    { inline_data: { mime_type: 'image/jpeg', data: base64 } },
                ],
            }],
            generationConfig: {
                response_mime_type: 'application/json',
            },
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
        // This means the Vercel env var isn't set — a deploy/config problem, not a client problem.
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
    for (let i = 0; i < OCR_MODEL_FALLBACKS.length; i++) {
        const model = OCR_MODEL_FALLBACKS[i];
        try {
            text = await callGeminiOnce(model, image, apiKey);
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            if (err.status === 400 || err.status === 401 || err.status === 403) {
                // Bad/revoked key or malformed request — every model fails the same way.
                res.status(502).json({ error: 'Gemini rejected the request (' + err.status + '). Check that the server-side GEMINI_API_KEY env var in Vercel is correct — this is not a client/model problem.' });
                return;
            }
            // Otherwise (429 rate limited, 503 overloaded, etc.) try the next model.
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
        // Trust the model's own read of which calendar the date was written
        // in (layout A is always Gregorian; the manual yellow layout is
        // usually Ethiopian) — only fall back to Gregorian if it left this
        // blank or returned something unrecognized.
        parsed.date_calendar = parsed.date_calendar === 'EC' ? 'EC' : 'GC';
        res.status(200).json(parsed);
    } catch (e) {
        res.status(502).json({ error: 'Model returned non-JSON output that could not be parsed.' });
    }
}
