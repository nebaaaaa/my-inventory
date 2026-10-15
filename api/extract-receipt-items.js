// /api/extract-receipt-items.js
//
// NEW endpoint for the Scanned Stock feature. Your existing
// /api/extract-receipt.js is NOT touched.
//
// Same safety pattern: runs on Vercel's server, the Gemini key lives only in
// the GEMINI_API_KEY environment variable and never reaches the browser.
//
// Frontend calls:  POST /api/extract-receipt-items   body: { image: "<base64 jpeg, no data: prefix>" }
// Returns:         { layout (A/B/C), buyer_tin, fs_no, mrc, voucher_no, date_raw, date_ambiguous, warnings, seller_name, seller_tin, receipt_no, date_*, is_vat, doc_title, receipt_time, header_lines, footer_lines,
//                    before_vat, vat, total, items: [ ... every line ... ], missing_fields }

export const config = { maxDuration: 30 };

const ITEMS_PROMPT = `You are reading a photo of an Ethiopian PURCHASE document (the shop bought goods from a supplier). It is ONE of three layouts - figure out which first and put the letter in "layout":

LAYOUT A - fiscal cash register receipt (thin thermal paper):
- The SELLER'S TIN is near the top as "TIN: XXXXXXXXXX", followed by the seller's business name. "Buyer's TIN" further down is the buyer, never the seller.
- Receipt number: "FS No. XXXXXXXX". Date: DD/MM/YYYY, Gregorian, day first.
- Items are either one line each ("DESCRIPTION  QTY  PRICE  AMOUNT") or two lines each ("QTY x PRICE =" then "DESCRIPTION  *AMOUNT").
- Taxable subtotal = "TXBL1". VAT = "TAX1"/"TAX 1" (15%). Grand total = "TOTAL".

LAYOUT B - manual yellow "Sales Invoice" (hand-filled carbon copy):
- Seller = the pre-printed "Supplier" block (top-left). Buyer = the hand-filled "Customer" block. Never swap them.
- Invoice number is the pre-printed (often red) serial near "No.".
- The date is handwritten and is almost always ETHIOPIAN calendar, day/month/2-digit-year (e.g. "28/10/17" = day 28, month 10, year 2017). Then date_calendar = "EC" and date_year = full 4-digit year.

LAYOUT C - ERP "Cash Sales Voucher" / "Cash Sales Attachment" (computer-printed A4 or half-A4 sheet, usually with a big grey diagonal watermark word such as "Attachment" across the page; it is the itemised copy that goes with a thermal fiscal receipt):
- SELLER = the business name printed as the big heading at the top (sometimes also repeated inside a small box on the right). The seller's TIN is printed as "TIN: XXXXXXXXXX" near that heading. A "VAT: XXXXXXXXXX" next to it is the seller's VAT registration number.
- The box headed "To" / "Bill to" / "Customer" is the BUYER. Its "TIN No" / "TIN" is buyer_tin. Never swap seller and buyer.
- "FS No." (fiscal receipt number) and "MRC No." (machine code, like TDB0016030 or FGB0005691) are printed in that box. "Voucher No" / "Ref." is the supplier's own internal number (voucher_no).
- The item table has columns like SN, Code / Item Id / ID, Description, Qty, Unit, Unit Amount / Price, Total. The Description cell can sit on a slightly different row from its numbers (the numbers may appear staggered lower); pair each description with its numbers by row ORDER. The Code (for example "Ele000000008" or "IT-00494-") is NOT the description. If the description is very short (for example "10W"), copy it exactly as printed anyway.
- Item prices and line totals on this layout are BEFORE VAT. "Sub Total" = before_vat, "VAT(15%)" = vat, "Grand Total" = total. A number printed in the middle of the Sub Total / VAT row (the VAT base) is not an extra total - ignore it.
- The date is Gregorian, often with a time: "07-10-2026 11:42 AM" or "4/7/2026 16:00:35". Different suppliers print day-first or month-first, so copy it exactly as printed into "date_raw" and give your best day/month reading. A "Prepared on ..." date or a printed stamp elsewhere on the page can help you decide the order.
- Ignore the watermark letters; read the text underneath them. Ignore "Prepared by", signatures, stamps and "INVALID WITHOUT FISCAL OR REFUND RECEIPT ATTACHED" as items.

FADED OR HARD-TO-READ PHOTOS: thermal paper fades, photos blur, and watermarks cover text. Read every character you reasonably can, including very pale ones. Then use arithmetic to check yourself: quantity x unit price = line amount; the line amounts add up to the subtotal; subtotal x 15% = VAT; subtotal + VAT = total. If one digit is unreadable, use these relationships to repair it. If you still cannot read a value with confidence, return null for it and never invent it.

TASK: extract EVERY line item on the document. Do not skip, merge, or summarise lines. Do not include subtotal, VAT, total, discount, or payment lines as items.

Return ONLY raw JSON, no markdown fences, no commentary:
{
  "layout": "A" or "B" or "C",
  "seller_name": string or null,
  "seller_tin": string or null,
  "buyer_tin": string or null,
  "vat_reg_no": string or null,
  "receipt_no": string or null,
  "fs_no": string or null,
  "mrc": string or null,
  "voucher_no": string or null,
  "date_calendar": "GC" or "EC",
  "date_year": number or null,
  "date_month": number or null,
  "date_day": number or null,
  "date_raw": string or null,
  "is_vat": boolean,
  "doc_title": string or null,
  "receipt_time": string or null,
  "header_lines": string[],
  "footer_lines": string[],
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
- "measurement": only a unit that is actually printed next to the item (PCS, KG, M, MT, L, BOX, PK...). Otherwise null - never guess.
- "pack_hint": only if the description itself states a pack size, for example "12PCS/BOX", "carton of 24", "1x10". Copy that text; otherwise null.
- "before_vat", "vat", "total" are always the receipt-wide totals, never per-item figures.
- "receipt_no": for layout A use the FS No.; for layout B the invoice serial; for layout C use the FS No. if one is printed, otherwise the Voucher No.
- "doc_title": the banner/title line printed on the document, copied exactly (for example "CASH INVOICE", "Sales Invoice", "Cash Sales Attachment"). Otherwise null.
- "receipt_time": the time printed next to the date (HH:MM, 24-hour; if AM/PM is printed, convert it). Otherwise null.
- "header_lines": every OTHER text line printed at the top, in order, copied exactly (address, phone, VAT registration number, branch, etc.). Do not repeat the seller name, the TIN line, the receipt number, the date or the title. Use [] if none.
- "footer_lines": every text line printed BELOW the totals, in order, copied exactly (payment method, amount in words, item count, fiscal/ET device number, cashier, thank-you note, etc.). Do not repeat any totals. Use [] if none.
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

// Short, clean text lines for the receipt look-alike (header/footer text).
function cleanLines(v) {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x == null ? '' : x).trim().slice(0, 90)).filter(Boolean).slice(0, 14);
}


// ---- Date reading for the printed ERP attachments (layout C) ----
// Different suppliers' systems print 07-10-2026 (day first) or 4/7/2026 (month
// first). When both numbers are 12 or less we cannot know which is meant, so we
// keep the day-first reading, flag it, and hand back the swapped reading so the
// screen can offer a one-click switch.
function fixDate(parsed) {
    parsed.date_ambiguous = false;
    parsed.date_alt_day = null;
    parsed.date_alt_month = null;
    if (parsed.date_calendar !== 'GC' || parsed.layout !== 'C') return parsed;
    const m = String(parsed.date_raw || '').match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})/);
    if (!m) return parsed;
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    parsed.date_year = y;
    if (a > 12 && b <= 12) { parsed.date_day = a; parsed.date_month = b; }
    else if (b > 12 && a <= 12) { parsed.date_day = b; parsed.date_month = a; }
    else if (a === b) { parsed.date_day = a; parsed.date_month = b; }
    else if (a <= 12 && b <= 12) {
        parsed.date_day = a; parsed.date_month = b; // day-first by default
        parsed.date_ambiguous = true;
        parsed.date_alt_day = b; parsed.date_alt_month = a;
    }
    return parsed;
}

// Quick arithmetic check. If the numbers do not agree the photo was probably
// misread (faded digits are the usual reason), so we tell the user to check.
function mathWarnings(parsed) {
    const w = [];
    const items = parsed.items || [];
    const sum = items.reduce((s, i) => s + (i.amount || 0), 0);
    const base = (parsed.before_vat !== null && parsed.before_vat !== undefined) ? parsed.before_vat : parsed.total;
    if (items.length && base !== null && base !== undefined && items.every((i) => i.amount !== null) && Math.abs(sum - base) > 1) {
        w.push('The item amounts add up to ' + round2(sum).toLocaleString('en-US') + ' but the receipt subtotal is ' + round2(base).toLocaleString('en-US') + '. A digit may be misread or a line missing - check every line against the paper.');
    }
    if (parsed.is_vat && parsed.before_vat !== null && parsed.vat !== null && parsed.total !== null && Math.abs(parsed.before_vat + parsed.vat - parsed.total) > 1) {
        w.push('Before VAT + VAT does not equal the total. One of the three amounts may be misread.');
    }
    items.forEach((i) => {
        if (i.quantity && i.unit_price && i.amount && Math.abs(i.quantity * i.unit_price - i.amount) > Math.max(1, i.amount * 0.005)) {
            w.push('"' + i.description.slice(0, 30) + '": quantity x price does not match the line amount.');
        }
    });
    return w.slice(0, 5);
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
        parsed.layout = ['A', 'B', 'C'].includes(parsed.layout) ? parsed.layout : 'A';
        // The attachment's own voucher number is internal; the FS No. is what ties it to the fiscal receipt.
        if (parsed.layout === 'C' && parsed.fs_no) parsed.receipt_no = String(parsed.fs_no).trim();
        parsed = fixDate(parsed);
        parsed.items = cleanItems(parsed.items);
        parsed.header_lines = cleanLines(parsed.header_lines);
        parsed.footer_lines = cleanLines(parsed.footer_lines);
        parsed.doc_title = parsed.doc_title ? String(parsed.doc_title).trim().slice(0, 60) : null;
        parsed.receipt_time = /^\d{1,2}[:.]\d{2}/.test(String(parsed.receipt_time || '').trim()) ? String(parsed.receipt_time).trim().slice(0, 10) : null;
        parsed.missing_fields = Array.isArray(parsed.missing_fields) ? parsed.missing_fields : [];
        if (!parsed.items.length && !parsed.missing_fields.includes('Items')) parsed.missing_fields.push('Items');
        parsed.before_vat = toNumOrNull(parsed.before_vat);
        parsed.vat = toNumOrNull(parsed.vat);
        parsed.total = toNumOrNull(parsed.total);
        parsed.warnings = mathWarnings(parsed);
        res.status(200).json(parsed);
    } catch (e) {
        res.status(502).json({ error: 'Model returned non-JSON output that could not be parsed.' });
    }
}
