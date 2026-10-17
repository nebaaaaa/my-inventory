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

const GC_YEAR = new Date().getFullYear(); // used inside the prompt to explain Ethiopian vs Gregorian years

const ITEMS_PROMPT = `You are reading a photo of an Ethiopian PURCHASE document (the shop bought goods from a supplier). The photo may be rotated sideways or upside down - read it the right way up in your mind. It is ONE of four layouts - figure out which first and put the letter in "layout":

LAYOUT A - fiscal cash register receipt (thin thermal paper):
- The SELLER'S TIN is near the top as "TIN: XXXXXXXXXX", followed by the seller's business name. "Buyer's TIN" further down is the buyer, never the seller.
- Receipt number: "FS No. XXXXXXXX". Date: DD/MM/YYYY, Gregorian, day first.
- Items are either one line each ("DESCRIPTION  QTY  PRICE  AMOUNT") or two lines each ("QTY x PRICE =" then "DESCRIPTION  *AMOUNT").
- Taxable subtotal = "TXBL1". VAT = "TAX1"/"TAX 1" (15%). Grand total = "TOTAL".

LAYOUT B - manual "Sales Invoice" / "Value Added Tax Invoice (Cash Sales)" (hand-filled carbon copy; the title is printed in Amharic and English, e.g. "Value Added Tax Cash Sales Invoice"). The ORIGINAL copy is white and the other copies are coloured (often yellow), so do not rely on paper colour - recognise it by the printed form, the pre-printed serial and the hand-written ink:
- Seller = the pre-printed "Supplier" block (top-left). Buyer = the hand-filled "Customer" block. Never swap them.
- Invoice number is the pre-printed (often red) serial near "No.".
- The date is handwritten and is almost always ETHIOPIAN calendar, day/month/2-digit-year (e.g. "28/10/17" = day 28, month 10, year 2017). Then date_calendar = "EC" and date_year = full 4-digit year.
- The year may ALSO be written in full, e.g. "4/11/2018" - that is STILL the Ethiopian calendar (Ethiopian 2018 is Gregorian 2025/2026). This year is ${GC_YEAR} in the Gregorian calendar, which is ${GC_YEAR - 8} or ${GC_YEAR - 7} in the Ethiopian calendar, so on this hand-filled layout a written year of ${GC_YEAR - 9}, ${GC_YEAR - 8} or ${GC_YEAR - 7} is Ethiopian: date_calendar = "EC", date_year as written. Ethiopian months run 1 to 13 (13 = Pagume). Only use "GC" here if the written year is ${GC_YEAR - 6} or later.
- On the "Value Added Tax Cash Sales Invoice" form the table columns are No., Description, Unit, Qty, Unit Price, Total Amount - read the hand-written Qty (for example 2) and the Unit Price. The totals box under the table reads top to bottom: "Total" = before_vat (an empty "Service Charge" row above it is ignored), "VAT /15%/" = vat, "Total Selling Price Including VAT" = total. The amount in words ("... only") is the total and can be used to double-check the digits. Verify Qty x Unit Price = Total Amount for each line.

LAYOUT C - ERP "Cash Sales Voucher" / "Cash Sales Attachment" (computer-printed A4 or half-A4 sheet, usually with a big grey diagonal watermark word such as "Attachment" across the page; it is the itemised copy that goes with a thermal fiscal receipt):
- SELLER = the business name printed as the big heading at the top (sometimes also repeated inside a small box on the right). The seller's TIN is printed as "TIN: XXXXXXXXXX" near that heading. A "VAT: XXXXXXXXXX" next to it is the seller's VAT registration number.
- The box headed "To" / "Bill to" / "Customer" is the BUYER. Its "TIN No" / "TIN" is buyer_tin. Never swap seller and buyer.
- "FS No." (fiscal receipt number) and "MRC No." (machine code, like TDB0016030 or FGB0005691) are printed in that box. "Voucher No" / "Ref." is the supplier's own internal number (voucher_no).
- The item table has columns like SN, Code / Item Id / ID, Description, Qty, Unit, Unit Amount / Price, Total. The Description cell can sit on a slightly different row from its numbers (the numbers may appear staggered lower); pair each description with its numbers by row ORDER. The Code (for example "Ele000000008" or "IT-00494-") is NOT the description. If the description is very short (for example "10W"), copy it exactly as printed anyway.
- Item prices and line totals on this layout are BEFORE VAT. "Sub Total" = before_vat, "VAT(15%)" = vat, "Grand Total" = total. A number printed in the middle of the Sub Total / VAT row (the VAT base) is not an extra total - ignore it.
- The date is Gregorian, often with a time: "07-10-2026 11:42 AM" or "4/7/2026 16:00:35". Different suppliers print day-first or month-first, so copy it exactly as printed into "date_raw" and give your best day/month reading. A "Prepared on ..." date or a printed stamp elsewhere on the page can help you decide the order.
- Ignore the watermark letters; read the text underneath them. Ignore "Prepared by", signatures, stamps and "INVALID WITHOUT FISCAL OR REFUND RECEIPT ATTACHED" as items.

LAYOUT D - ethio telecom "CASH RECEIPT" (computer-printed, bilingual Amharic/English, "ethio telecom" logo at the top-left; a receipt for a telecom BILL payment, not a sale of goods, so there is no item table):
- SELLER = ethio telecom. Its details are in a small block of text at the top beside the logo ("VAT Reg. No", "TIN No", "VAT Reg Date", "Address", "Tel"). seller_name = "ethio telecom" (as printed), seller_tin = the "TIN No" in THAT top block, vat_reg_no = its "VAT Reg. No".
- The "Customer Information" block lists Customer Name, Address, City, "TIN No", Service No, Account No and Customer Code. The "TIN No" there is the BUYER'S TIN (buyer_tin). Never swap it with the seller's TIN, and never use Account No or Customer Code as a TIN.
- receipt_no = the "Receipt No" at the top right (a long number such as 2290819115). voucher_no = the "Invoice No" inside the Payment Information table (the bill's own number). fs_no and mrc are null.
- The date is printed next to the Receipt No as DD/MM/YYYY followed by a time (for example "19/08/2026 09:51AM"): Gregorian, day first. The "Billing Month" (for example "Jul 2026") is the month the bill covers, NOT the receipt date.
- The "Payment Information" table lists: Invoice No, Billing Month, "Total Bill Payment (Inclusive VAT)", "5% Excise Tax", "Bill Payment (Excluding VAT)", "15% VAT", "5% National Disaster Risk Fund", "Advance Payment", "Total Amount Received". Map: before_vat = "Bill Payment (Excluding VAT)" (it already includes the excise tax and the disaster fund - subtract nothing); vat = "15% VAT"; total = "Total Amount Received". The excise tax and the disaster fund are NOT VAT. Before VAT + VAT can differ from the total by a cent or two because of the tiny "Advance Payment" line - that is normal, do not "repair" it. is_vat is true.
- Return exactly ONE item: description "ethio telecom bill - <Billing Month>" (for example "ethio telecom bill - Jul 2026"), quantity 1, measurement null, unit_price and amount both equal to before_vat.
- doc_title = "CASH RECEIPT" as printed. header_lines = the remaining small-print lines of the seller block (VAT Reg. No, address, tel) followed by the customer lines as "Label: value" (Customer Name, Address, City, Service No, Account No, Customer Code). footer_lines = the payment lines that are not items, as "Label: value" (5% Excise Tax, 5% National Disaster Risk Fund, Advance Payment, Payment Mode, Payment Reason, Service Center, the amount in words, Received By).
- Ignore the round stamp, the signature, the social-media icons and the "Thank you" note. A fold or the paper edge can cover part of the page - read around it.

MULTI-PAGE DOCUMENTS: a long sheet is photographed one page per photo. Page 1 usually has the header (seller, buyer, FS No., date) and the first lines; later pages may show only more lines; the LAST page has the Subtotal / VAT / Grand Total. Report only what is visible in THIS photo: set "has_header" to true only if the seller name/TIN block is visible, and "has_totals" to true only if a Subtotal/TXBL1, VAT/TAX1 or Grand Total/TOTAL amount is visible. If the footer says "Page 1 of 2" (or similar) fill "page_no" and "page_count" (numbers), otherwise null. Most ERP sheets also print a small faint "system stamp" line at the very top or bottom edge, like "001-01-0000033133 | 09.04.2026 13:40:55" (it can look like a ghost or duplicate print); copy it exactly into "doc_stamp" (it is the same on every page of one document), otherwise null. List ONLY the lines visible in this photo - a line hidden under a fold or finger must not be invented; if its description is hidden but its numbers are visible, use "" as the description.

FADED OR HARD-TO-READ PHOTOS: thermal paper fades, photos blur, and watermarks cover text. Read every character you reasonably can, including very pale ones. Then use arithmetic to check yourself: quantity x unit price = line amount; the line amounts add up to the subtotal; subtotal x 15% = VAT; subtotal + VAT = total. If one digit is unreadable, use these relationships to repair it. If you still cannot read a value with confidence, return null for it and never invent it.

TASK: extract EVERY line item on the document. Do not skip, merge, or summarise lines. Do not include subtotal, VAT, total, discount, or payment lines as items.

Return ONLY raw JSON, no markdown fences, no commentary:
{
  "layout": "A" or "B" or "C" or "D",
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
  "page_no": number or null,
  "page_count": number or null,
  "doc_stamp": string or null,
  "has_header": boolean,
  "has_totals": boolean,
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
- "receipt_no": for layout A use the FS No.; for layout B the invoice serial; for layout C use the FS No. if one is printed, otherwise the Voucher No; for layout D use the "Receipt No" at the top right (not the Invoice No in the payment table).
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
        if (!description && it.amount == null && it.quantity == null) continue;
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
    if (parsed.date_calendar !== 'GC' || (parsed.layout !== 'C' && parsed.layout !== 'D')) return parsed;
    const m = String(parsed.date_raw || '').match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})/);
    if (!m) return parsed;
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    parsed.date_year = y;
    if (parsed.layout === 'D') { // ethio telecom always prints day first
        if (b > 12 && a <= 12) { parsed.date_day = b; parsed.date_month = a; } else { parsed.date_day = a; parsed.date_month = b; }
        return parsed;
    }
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
    if (isPartialPage(parsed)) return w; // checked after the pages are combined
    const allAmounts = items.length && items.every((i) => i.amount !== null);
    const sum = items.reduce((s, i) => s + (i.amount || 0), 0);
    const base = (parsed.before_vat !== null && parsed.before_vat !== undefined) ? parsed.before_vat : parsed.total;
    // Lines may legitimately add up to MORE than the VAT base (some lines have no VAT),
    // so only flag a mismatch when the lines also fail to explain the grand total.
    if (allAmounts && base !== null && base !== undefined && Math.abs(sum - base) > 1) {
        const explained = parsed.is_vat && parsed.vat !== null && parsed.total !== null && Math.abs(sum + parsed.vat - parsed.total) <= 1;
        if (!explained) w.push('The item amounts add up to ' + round2(sum).toLocaleString('en-US') + ' but the receipt subtotal is ' + round2(base).toLocaleString('en-US') + '. A digit may be misread or a line missing - check every line against the paper.');
    }
    if (parsed.is_vat && parsed.before_vat !== null && parsed.vat !== null && parsed.total !== null && Math.abs(parsed.before_vat + parsed.vat - parsed.total) > 1) {
        const explained = allAmounts && Math.abs(sum + parsed.vat - parsed.total) <= 1;
        if (!explained) w.push('Before VAT + VAT does not equal the total. One of the three amounts may be misread.');
    }
    items.forEach((i) => {
        if (i.quantity && i.unit_price && i.amount && Math.abs(i.quantity * i.unit_price - i.amount) > Math.max(1, i.amount * 0.005)) {
            w.push('"' + i.description.slice(0, 30) + '": quantity x price does not match the line amount.');
        }
    });
    return w.slice(0, 5);
}

// ---- Page information (for documents photographed as several pages) ----
function cleanPageFields(parsed) {
    const toInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 100 ? n : null; };
    parsed.page_no = toInt(parsed.page_no);
    parsed.page_count = toInt(parsed.page_count);
    parsed.doc_stamp = parsed.doc_stamp ? String(parsed.doc_stamp).trim().slice(0, 80) : null;
    const hasHeaderGuess = !!(parsed.seller_tin || parsed.seller_name);
    const hasTotalsGuess = [parsed.before_vat, parsed.vat, parsed.total].some((v) => v !== null && v !== undefined && v !== '');
    parsed.has_header = typeof parsed.has_header === 'boolean' ? parsed.has_header : hasHeaderGuess;
    parsed.has_totals = typeof parsed.has_totals === 'boolean' ? parsed.has_totals : hasTotalsGuess;
    return parsed;
}
// A photo that shows only part of a document cannot be checked on its own: the combined
// document is checked later (in /api/merge-receipt-pages).
function isPartialPage(parsed) {
    return (parsed.page_count && parsed.page_count > 1) || parsed.has_header === false || parsed.has_totals === false;
}

// ---- Hand-filled invoices (layout B): the date is Ethiopian even when the year is written in full ----
// "4/11/2018" looks Gregorian but is Ethiopian. The Gregorian year is 7 or 8 higher than the
// Ethiopian one, so on a hand-filled invoice a year this far behind today can only be Ethiopian.
function fixEthiopianYear(parsed) {
    if (parsed.layout !== 'B') return parsed;
    let y = toNumOrNull(parsed.date_year);
    if (y === null) return parsed;
    if (y < 100) { y += 2000; parsed.date_year = y; parsed.date_calendar = 'EC'; }
    if (y >= 2000 && y <= new Date().getFullYear() - 7) parsed.date_calendar = 'EC';
    return parsed;
}

// ---- ethio telecom receipts (layout D) have no item table ----
// If the model left the item list empty, make the single "bill" item from the totals.
function fixTelecomItem(parsed) {
    const base = toNumOrNull(parsed.before_vat);
    if (parsed.layout !== 'D' || (parsed.items && parsed.items.length) || base === null) return parsed;
    const label = 'ethio telecom bill';
    parsed.items = [{ description: label, quantity: 1, measurement: null, unit_price: base, amount: base, pack_hint: null }];
    return parsed;
}

// ---- Services (not stock) ----
// The ethio telecom bill (layout D) is a SERVICE, not goods: it must never be added to stock.
// The reading carries is_service: true (on the document and on its item) so the screen can skip it.
function markService(parsed) {
    parsed.is_service = parsed.layout === 'D';
    if (parsed.is_service) parsed.items = (parsed.items || []).map((it) => ({ ...it, is_service: true }));
    return parsed;
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
        parsed.layout = ['A', 'B', 'C', 'D'].includes(parsed.layout) ? parsed.layout : 'A';
        // The attachment's own voucher number is internal; the FS No. is what ties it to the fiscal receipt.
        if (parsed.layout === 'C' && parsed.fs_no) parsed.receipt_no = String(parsed.fs_no).trim();
        parsed = fixEthiopianYear(parsed);
        parsed = fixDate(parsed);
        parsed = cleanPageFields(parsed);
        parsed.items = cleanItems(parsed.items);
        parsed = fixTelecomItem(parsed);
        parsed = markService(parsed);
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
