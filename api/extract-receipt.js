// /api/extract-receipt.js
//
// Vercel serverless function. Runs on Vercel's servers, never in the browser.
// The Gemini API key lives ONLY in an environment variable here — it is
// never sent to, or visible from, the client.
//
// Frontend calls this as: POST /api/extract-receipt  with JSON body { image: "<base64 jpeg, no data: prefix>" }
// Returns: the parsed receipt JSON (same shape the old client-side code produced).
//
// WHO MAY CALL IT (added for the free trial):
//   1. A signed-in MELEYA user: sends "Authorization: Bearer <supabase access token>".
//      The token is checked with Supabase. Signed-in users scan as normal.
//   2. A free-trial visitor (no account): sends x-guest-device / x-guest-fp / x-guest-batch
//      (and x-guest-retry: 1 on a silent re-read). The Supabase function claim_guest_scan()
//      allows ONE batch of up to 5 photos per visitor, and rejects everyone else.
//   3. Anyone else: rejected with 401 once the env var ENFORCE_AUTH is "true".
//      While ENFORCE_AUTH is not "true" such calls are still allowed, so that pages which
//      have not been updated to send a token yet (e.g. index.html) keep working.
//
// Environment variables (Vercel -> Project -> Settings -> Environment Variables):
//   GEMINI_API_KEY             (already set)
//   SUPABASE_SERVICE_ROLE_KEY  (new - Supabase -> Project Settings -> API -> service_role)
//   SUPABASE_URL               (optional - defaults to the MELEYA project below)
//   ENFORCE_AUTH               (optional - set to "true" once every page sends a token)

const GC_YEAR = new Date().getFullYear(); // used inside the prompt to explain Ethiopian vs Gregorian years

const RECEIPT_PROMPT = `You are reading a photo of an Ethiopian purchase document. The photo may be rotated sideways or upside down — read it the right way up in your mind. It will be ONE of six layouts — figure out which one you're looking at first and put its letter (A, B, C, D, E or W) in "layout":

LAYOUT A — fiscal cash register receipt (ERCA-compliant, usually thin white/thermal paper):
- The SELLER'S TIN is printed near the very top as "TIN: XXXXXXXXXX", immediately followed by the seller's business/owner name, then address/phone lines.
- A separate "Buyer's TIN" (sometimes "Buyer's T I N") line appears further down — that is the BUYER'S own TIN, not the seller's. Never use it for seller_tin (see buyer_tin below for what to do with it).
- The receipt number is printed as "FS No. XXXXXXXX".
- The date is printed as DD/MM/YYYY, always in the GREGORIAN calendar, day first — this receipt format never uses the Ethiopian calendar.
- Line items appear either as one line per item ("DESCRIPTION   QTY   PRICE   AMOUNT") or as two lines per item ("QTY x PRICE =" then "DESCRIPTION   *AMOUNT" on the next line).
- The taxable subtotal is labeled "TXBL1". The VAT amount is labeled "TAX1" or "TAX 1" (usually shown with "15.00%" or "15%") — this receipt format never prints the word "VAT" for this line. The grand total is labeled "TOTAL".
- A machine registration code is printed near the bottom as "ET" followed by a code like "FGB0005691" or "BEB0004862" — this is the MRC (machine registration certificate number). It is never labeled "MRC" directly.
- A separate VAT registration number is usually NOT printed on these receipts — only fill vat_reg_no if you actually see a distinct label like "VAT REG NO"; do not reuse the TIN for it.

LAYOUT B — manual "Sales Invoice" / "Value Added Tax Invoice (Cash Sales)" (a hand-filled carbon-copy form; the title is printed in Amharic and English, e.g. "Value Added Tax Cash Sales Invoice"). The ORIGINAL copy is white and the other copies are coloured (often YELLOW), so do not rely on paper colour — recognise it by the printed form, the pre-printed serial number and the hand-written ink. This form has two separate identity blocks and it is critical not to mix them up:
- A "Supplier" block (sometimes headed "Name of Supplier"/"From", "Supplier's TIN", "Supplier's VAT Reg. No.") is usually PRE-PRINTED/fixed at the top-left — this is whoever's invoice pad it is, i.e. the SELLER. Read seller_name, seller_tin, and vat_reg_no from THIS block.
- A "Customer"/"Buyer" block ("To", "Customer's TIN No.", "Customer's VAT Reg. No.") is hand-filled — this is the party who bought the goods. Read buyer_tin from THIS block (handwritten digits — read carefully, they can be cramped). Never swap the two blocks.
- Important: depending on whose invoice pad was photographed, either party could be "our" client — sometimes the pad belongs to the client's own business (client is the Supplier, this was a sale they made), sometimes it's a supplier's pad handed to the client as proof of a purchase (client is the Customer). Extract both seller_tin and buyer_tin faithfully exactly as printed/written; do not guess which one is "the client" — that comparison happens outside this extraction step.
- There is usually no separate MRC/machine code on this layout since it's hand-filled, not machine-printed — leave mrc null unless one is actually printed/stamped.
- The invoice number is a pre-printed serial (often in red ink) near "No." at the top — use it for receipt_no.
- The date field on this layout ("ቀን"/"Date") is filled in BY HAND and is almost always the ETHIOPIAN CALENDAR, written day/month/year with a 2-digit year, e.g. "28/10/17" means day 28, month 10, Ethiopian year 2017 (a 2-digit year here always means 20XX in the Ethiopian calendar — so "17" is 2017, "16" is 2016, etc.). Set date_calendar to "EC" and date_year to the full 4-digit Ethiopian year (2017, not 17) whenever you see this handwritten day/month/2-digit-year style. The year may ALSO be written in full, e.g. "4/11/2018" — that is STILL the Ethiopian calendar (Ethiopian 2018 is Gregorian 2025/2026). This year is ${GC_YEAR} in the Gregorian calendar, which is ${GC_YEAR - 8} or ${GC_YEAR - 7} in the Ethiopian calendar, so on this hand-filled layout a written year of ${GC_YEAR - 9}, ${GC_YEAR - 8} or ${GC_YEAR - 7} is Ethiopian: set date_calendar to "EC" and date_year exactly as written. Ethiopian months run 1 to 13 (13 = Pagume). Only use "GC" for this layout if the written year is ${GC_YEAR - 6} or later.
- Line items, VAT (15%) and totals follow the same general idea as layout A: read whatever subtotal, VAT, and total figures are filled in by hand, and the single largest line item for description/quantity/unit price, exactly as described below.
- On the "Value Added Tax Cash Sales Invoice" form the table columns are No., Description, Unit, Qty, Unit Price, Total Amount — read the hand-written Qty (for example 2) and the Unit Price. The totals box under the table is read top to bottom as: "Total" = before_vat (an empty "Service Charge" row above it is ignored), "VAT /15%/" = vat, and "Total Selling Price Including VAT" = total. The amount written in words next to it ("... only") is the total and can be used to double-check the digits. Handwriting can be cramped or the photo rotated, so verify Qty x Unit Price = Total Amount.

LAYOUT C — ERP "Cash Sales Voucher" / "Cash Sales Attachment" (a computer-printed A4 or half-A4 sheet, usually with a big grey diagonal watermark word such as "Attachment" across it; it is the itemised copy that accompanies a thermal fiscal receipt):
- The SELLER is the business name printed as the big heading at the top (sometimes repeated in a small box on the right). The seller's TIN is printed as "TIN: XXXXXXXXXX" near that heading — read seller_name and seller_tin from there. A "VAT: XXXXXXXXXX" beside it is the seller's VAT registration number (vat_reg_no).
- The box headed "To" / "Bill to" / "Customer" is the BUYER. Its "TIN No" / "TIN" value is buyer_tin. Never swap the two.
- "FS No." (the fiscal receipt number) and "MRC No." (a code like TDB0016030 or FGB0005691) are printed in that box: use the FS No. for receipt_no and the MRC No. for mrc. "Voucher No" / "Ref." is only the supplier's internal number — use it for receipt_no ONLY if no FS No. is printed.
- The item table has columns like SN, Code / Item Id / ID, Description, Qty, Unit, Unit Amount / Price, Total. A Description cell can sit on a slightly different row from its numbers (the numbers may appear staggered lower) — pair them by row ORDER. The Code (e.g. "Ele000000008") is NOT the description.
- Item prices and line totals here are BEFORE VAT. "Sub Total" = before_vat, "VAT(15%)" = vat, "Grand Total" = total. A number printed in the middle of the Sub Total / VAT row (the VAT base) is not an extra total — ignore it.
- The date is Gregorian, often with a time ("07-10-2026 11:42 AM" or "4/7/2026 16:00:35"). Different suppliers' systems print day-first or month-first, so copy the date exactly as printed into "date_raw" and give your best day/month reading in date_day/date_month (date_calendar "GC").
- Ignore the watermark letters and read the text underneath. "Prepared by", signatures, stamps and "INVALID WITHOUT FISCAL OR REFUND RECEIPT ATTACHED" are not items.

LAYOUT D — ethio telecom "CASH RECEIPT" (computer-printed, bilingual Amharic/English, with the "ethio telecom" logo at the top-left; it is a receipt for a telecom BILL payment, not a sale of goods, so it has no item table):
- SELLER = ethio telecom. Its details are in a small block of text at the top beside the logo ("VAT Reg. No", "TIN No", "VAT Reg Date", "Address", "Tel"). Read seller_name as "ethio telecom" (as printed), seller_tin from the "TIN No" in THAT top block, and vat_reg_no from its "VAT Reg. No".
- The "Customer Information" block lists Customer Name, Address, City, "TIN No", Service No, Account No and Customer Code. The "TIN No" there is the BUYER'S TIN (buyer_tin). Never swap it with the seller's TIN, and never use Account No or Customer Code as a TIN.
- receipt_no = the "Receipt No" printed at the top right (a long number such as 2290819115). The "Invoice No" inside the Payment Information table is the bill's own number — do not use it as receipt_no.
- The date is printed next to the Receipt No as DD/MM/YYYY followed by a time (for example "19/08/2026 09:51AM"). It is Gregorian and day first. The "Billing Month" (for example "Jul 2026") is the month the bill covers, NOT the receipt date.
- The "Payment Information" table lists: Invoice No, Billing Month, "Total Bill Payment (Inclusive VAT)", "5% Excise Tax", "Bill Payment (Excluding VAT)", "15% VAT", "5% National Disaster Risk Fund", "Advance Payment" and "Total Amount Received". Map them like this: before_vat = "Bill Payment (Excluding VAT)" (it already includes the excise tax and the disaster fund — do not subtract anything); vat = "15% VAT"; total = "Total Amount Received" (the same figure as "Total Bill Payment (Inclusive VAT)"). The "5% Excise Tax" and the "5% National Disaster Risk Fund" are NOT VAT. Before VAT + VAT can differ from the total by a cent or two because of the tiny "Advance Payment" line — that is normal, do not "repair" it. is_vat is true.
- There is no machine code (mrc = null) and no item table. Return exactly ONE item: description "ethio telecom bill - <Billing Month>" (for example "ethio telecom bill - Jul 2026"), quantity 1, measurement null, unit_price and amount both equal to before_vat.
- Ignore the round stamp, the signature, "Received By", the social-media icons and the "Thank you" note. A fold or the paper edge can cover part of the page — read around it.

LAYOUT E - computer-generated e-invoice "Cash Sales Invoice/VAT/Excise" (bilingual Amharic/English, a clean printed A4 page with a QR code at the top right, a long hex "IRN" line under the title, and "Business Management Suite by Marakisoft Technologies" in the footer; a variant such as "Credit Sales Invoice" has the same form):
- The box headed "From" is the SELLER: seller_name = the big company name at the top (repeated in the From box), seller_tin = "Seller's TIN" in the From box (for example 0000177986), vat_reg_no = "Seller's VAT Reg. No" (for example 18023). "Sub TIN" is a secondary field - ignore it.
- The box headed "To" is the BUYER: buyer_tin = "Buyer's TIN" (for example 0000390746). The "Code" line (for example P-100439) is the supplier's own customer code, NOT a TIN. "Buyer's VAT Reg. No" is often empty. Never swap seller and buyer.
- receipt_no = the number after "Doc. No:" at the top right (for example 1957; the Amharic label next to it means "receipt number"). The "Reference" (CSI-...), "Ref Note" (JA-...), "System Number" and the long IRN are internal system references - NOT the receipt number. The tiny line at the very top edge, like "e2eb6e41-18ac-4020-8928-b1a5c7ea6070 | 04.08.2026 11:23:10", is the system stamp: copy it into "doc_stamp".
- DATE: the top right prints TWO dates - an Ethiopian one after the Amharic "ቀን" (for example 28/11/2018) and a Gregorian one after "Date:" (for example 04/08/2026 11:23:05). Use the GREGORIAN "Date:" value, which is DAY first (DD/MM/YYYY): date_calendar "GC", copy it exactly into date_raw (04/08/2026 means day 4, month 8). Ignore the Ethiopian one.
- The item table columns are: No., Product/Service Description, Nature of Supply (Goods/Service), UoM, Tax Code, Quantity, Unit Price, Discount, Excise Tax, Total Amount. The description is the product name; a small code printed under it (for example 1499-01) is the item code and is not part of the name. UoM (for example PCS) is the measurement. Unit prices and line totals are BEFORE VAT.
- The totals box reads: "Total Amount", "Excise Tax", "Discount", "VAT15 Taxable Total" = before_vat, "VAT15 Tax (15%)" = vat, "Non Taxable Total", "Withheld Amount (3%)", "Total VAT Withheld Amount", then "Total Price Including Tax (ETB)" = total. Withheld amounts are NOT VAT. The amount in words ("... Cents Only") can be used to double-check the total.
- There is no machine code on this layout: mrc = null. is_vat is true. Ignore the QR code, "Prepared by", the "Remark" line (a payment reference such as CBE ...) and the payment method.

LAYOUT W - VAT WITHHOLDING RECEIPT ("Nagahee Kaffaltii Irraa Taaksii Dabalata Qabeenyaa Hir'ifamee Hafuuf Kennamu", in Amharic "ከክፍያ ላይ ለተቀነሰ የተጨማሪ እሴት ታክስ የተሰጠ ደረሰኝ"). A small printed pad form in Afaan Oromo and Amharic, filled in BY HAND, with a printed serial like "WAZF No. 013125". A government office or other withholding agent hands it to a SUPPLIER to prove that VAT was withheld from a payment. It has NO item table, no MRC and no VAT invoice figures.
- receipt_no = the printed serial next to "ደረሰኝ ቁጥር ... No." (for example 013125). Keep the leading zeros, digits only. The letters before "No." (for example WAZF) are just the pad's prefix.
- The date after "Guyyaa/ቀን" at the top is handwritten, ETHIOPIAN calendar, day/month/year (for example 14/10/2018): date_calendar "EC", date_year the full 4-digit year, copy it exactly into date_raw. Read the digits slowly: 1 and 4 and 7 look alike in handwriting. A small printed date near the bottom (for example 02/09/2014 or 0720/2014 next to "Printed by") is the press approval date, NOT the receipt date - ignore it.
- The block under "Maqaa Mana Hojii / የመስሪያ ቤቱ ስም" is the WITHHOLDING AGENT (the office that paid and withheld VAT): seller_name = its name (copy the Latin-script Afaan Oromo name if there is one, otherwise the Amharic), seller_tin = the TIN printed right under it, "Lakkoofsa Eenyummaa Kaffalaa Gibiraa (TIN)". This is the party that ISSUED the receipt.
- The block under "Maqaa Dhiyeessaa / የአቅራቢው ስም" is the SUPPLIER whose VAT was withheld (normally our client, handwritten): supplier_name = that name; buyer_tin = the handwritten TIN after "Dhiyeessaa (TIN)" / "የአቅራቢው የግብር ከፋይ መለያ ቁጥር" (this layout has no buyer, so buyer_tin carries the supplier's TIN); supplier_vat_no = the handwritten number after "(VAT) dhiyeessaa" / "የአቅራቢው የተጨማሪ እሴት ታክስ መለያ ቁጥር". Read handwritten digits carefully, TINs are 10 digits. vat_reg_no stays null. Never swap the agent and the supplier.
- The address box (Naannoo/Godina/Aanaa/Ganda/Lakkoofsa Manaa) is ignored.
- wh_amount_paid = the handwritten figure after "Hanga maallaqa kaffalamuu / የተከፈለ ገንዘብ መጠን" (the amount paid, which is the taxable transaction amount). wh_withheld = the handwritten figure after "Hanga maallaqa hir'ifamee lakkoofsaan (%15) / የተቀነሰው ገንዘብ ልክ (15%)" (the VAT withheld, in figures). The line below it, "... qubeen / በፊደል", is the same withheld amount WRITTEN IN WORDS in Amharic - use it only to double-check wh_withheld. The form prints (%15), but the agent withholds HALF of that 15%, so the withheld amount equals the amount paid x 15% / 2 = 7.5% (for example 583,044 paid gives 43,728 withheld). If the amount paid is overwritten, crossed out or unclear, return exactly what you can read (or null) and add "Taxable amount" to missing_fields; never replace it with a figure calculated from the other one.
- Also copy the same numbers into before_vat (= wh_amount_paid), vat (= wh_withheld) and total (= wh_amount_paid). is_vat is false. mrc is null. has_header and has_totals are true. items is an empty list. Ignore signatures, the two name-and-signature lines ("Kan qopheesse / Kan Mirkaneessee"), stamps, punched holes and the small print at the bottom.

MULTI-PAGE DOCUMENTS: a long sheet is photographed one page per photo. Page 1 usually has the header (seller, buyer, FS No., date) and the first lines; later pages may show only more lines; the LAST page has the Subtotal / VAT / Grand Total. Report only what is visible in THIS photo: set "has_header" to true only if the seller name/TIN block is visible, and "has_totals" to true only if a Subtotal/TXBL1, VAT/TAX1 or Grand Total/TOTAL amount is visible. If the footer says "Page 1 of 2" (or similar) fill "page_no" and "page_count" (numbers), otherwise null. Most ERP sheets also print a small faint "system stamp" line at the very top or bottom edge, like "001-01-0000033133 | 09.04.2026 13:40:55" (it can look like a ghost or duplicate print); copy it exactly into "doc_stamp" (it is the same on every page of one document), otherwise null. List ONLY the lines visible in this photo - a line hidden under a fold or finger must not be invented; if its description is hidden but its numbers are visible, use "" as the description.

FADED OR HARD-TO-READ PHOTOS: thermal paper fades, photos blur, and watermarks cover text. Read every character you reasonably can, including very pale ones. Then check yourself with arithmetic: quantity x unit price = line amount; the line amounts add up to the subtotal; subtotal x 15% = VAT; subtotal + VAT = total. If a single digit is unreadable, use these relationships to repair it. If you still cannot read a value with confidence, return null for it — never invent it.

Whichever layout it is, always try to extract BOTH seller_tin (from the Supplier block) and buyer_tin (from the Customer/Buyer block) when either is printed or written, even if one looks unused — both are needed to work out which side of the transaction belongs to our client, which is decided outside this extraction step, never by you.

Extract exactly these fields and return ONLY raw JSON, no markdown fences, no commentary:
{
  "layout": "A" or "B" or "C" or "D" or "E" or "W",
  "seller_name": string or null,
  "seller_tin": string or null,
  "vat_reg_no": string or null,
  "buyer_tin": string or null,
  "mrc": string or null,
  "supplier_name": string or null,
  "supplier_vat_no": string or null,
  "wh_amount_paid": number or null,
  "wh_withheld": number or null,
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
  "receipt_no": string or null,
  "is_vat": boolean,
  "before_vat": number or null,
  "vat": number or null,
  "total": number or null,
  "description": string or null,
  "measurement": string or null,
  "quantity": number or null,
  "unit_price": number or null,
  "items": [ { "description": string, "quantity": number or null, "measurement": string or null, "unit_price": number or null, "amount": number or null } ],
  "missing_fields": string[]
}

"items" lists EVERY line item visible in this photo, in order, in addition to the single-item fields above (do not skip, merge or summarise lines; do not include subtotal/VAT/total/payment lines). "description" copies the printed text exactly; "amount" is the line total as printed; "measurement" only if a unit is printed next to the line.

If there are multiple line items, pick only the SINGLE item with the largest amount and use its description, quantity, and unit_price — do not combine or list multiple items together in "description". Set "measurement" to "Lot", "quantity" to 1, and "unit_price" equal to "before_vat" ONLY if you cannot identify a clear largest item; otherwise use that one item's own measurement/quantity/unit_price as printed (measurement only if a unit like PCS/KG/M is actually printed next to it — this receipt format usually does not print one, so leave it null rather than guess). If there is exactly ONE line item, fill "description", "quantity", and "measurement" from that single item, but set "unit_price" equal to "before_vat" (the receipt's taxable subtotal) regardless of what is printed next to that item — with only one item, its line amount and the subtotal are the same thing. The ONE exception: if that single item's quantity is greater than 1 (for example quantity 2 at 121,739.13 each), keep "unit_price" as the printed per-unit price so that quantity x unit_price equals before_vat. "before_vat", "vat", and "total" should always be the receipt-wide totals from the TXBL1/TAX1/TOTAL lines, never a per-item figure. A separate VAT registration number is normal to be absent on this receipt format — never include "VAT reg no" in "missing_fields". In "missing_fields", only list fields from this set that you could not confidently read: "Seller name", "Seller TIN", "MRC". Never list "MRC" for layouts B, D, E or W — those layouts have no machine code.`;

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


// ---- Date reading for the printed ERP attachments (layout C) ----
// Suppliers' systems print 07-10-2026 (day first) or 4/7/2026 (month first).
// When both numbers are 12 or less we cannot know which is meant, so we keep
// the day-first reading, flag it, and return the swapped reading so the screen
// can offer a one-click switch.
function fixDate(parsed) {
    parsed.date_ambiguous = false;
    parsed.date_alt_day = null;
    parsed.date_alt_month = null;
    if (parsed.date_calendar !== 'GC' || (parsed.layout !== 'C' && parsed.layout !== 'D' && parsed.layout !== 'E')) return parsed;
    const m = String(parsed.date_raw || '').match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})/);
    if (!m) return parsed;
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    parsed.date_year = y;
    if (parsed.layout === 'D' || parsed.layout === 'E') { // ethio telecom and the Marakisoft e-invoice always print day first
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

// If the three money figures disagree, the photo was probably misread
// (faded digits are the usual reason) — tell the user to double-check.
function mathWarnings(parsed) {
    const w = [];
    if (parsed.layout === 'W') { // withheld VAT = half of 15% (7.5%) of the amount paid
        const b = parsed.before_vat, v = parsed.vat, f2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (b !== null && v !== null && Math.abs(v - b * VAT_RATE / 2) > 1.5) w.push('The VAT withheld (' + f2(v) + ') is not 7.5% (half of the printed 15%) of the amount paid (' + f2(b) + ' x 7.5% = ' + f2(b * VAT_RATE / 2) + '). The amount paid or the withheld amount may be misread - check both against the paper.');
        return w;
    }
    if (isPartialPage(parsed)) return w; // checked after the pages are combined
    const items = parsed.items || [];
    const sum = items.reduce((s, i) => s + (i.amount || 0), 0);
    const allAmounts = items.length && items.every((i) => i.amount !== null);
    if (parsed.is_vat && parsed.before_vat !== null && parsed.vat !== null && parsed.total !== null && Math.abs(parsed.before_vat + parsed.vat - parsed.total) > 1) {
        const explained = allAmounts && Math.abs(sum + parsed.vat - parsed.total) <= 1;
        if (!explained) w.push('Before VAT + VAT does not equal the total. One of the three amounts may be misread - check them against the paper.');
    }
    if (parsed.quantity && parsed.unit_price && parsed.before_vat && parsed.quantity * parsed.unit_price - parsed.before_vat > 1 && parsed.measurement !== 'Lot' && items.length <= 1) {
        w.push('Quantity x unit price is more than the subtotal. The quantity or price may be misread.');
    }
    return w;
}


// ---- VAT withholding receipts (layout W) ----
// The agent (seller_*) withheld VAT from a payment to the supplier (buyer_tin, normally our client).
// before_vat = the taxable amount paid, vat = the VAT withheld, total = the amount paid. It is a record, not a
// VAT invoice, so is_vat is false (no 15% repairs) and the single line is flagged as a service (never stock).
function fixWithholding(parsed) {
    if (parsed.layout !== 'W') return parsed;
    const paid = toNumOrNull(parsed.wh_amount_paid != null ? parsed.wh_amount_paid : parsed.before_vat);
    const withheld = toNumOrNull(parsed.wh_withheld != null ? parsed.wh_withheld : parsed.vat);
    parsed.is_vat = false;
    parsed.before_vat = paid; parsed.vat = withheld; parsed.total = paid;
    parsed.wh_amount_paid = paid; parsed.wh_withheld = withheld;
    parsed.mrc = null; parsed.vat_reg_no = null;
    parsed.receipt_no = parsed.receipt_no ? String(parsed.receipt_no).replace(/\s+/g, '').slice(0, 30) : null;
    parsed.supplier_name = parsed.supplier_name ? String(parsed.supplier_name).trim().slice(0, 120) : null;
    parsed.supplier_vat_no = parsed.supplier_vat_no ? String(parsed.supplier_vat_no).replace(/\s+/g, '').slice(0, 30) : null;
    parsed.description = 'VAT withholding receipt';
    parsed.measurement = null; parsed.quantity = paid === null ? null : 1; parsed.unit_price = paid;
    parsed.items = paid === null ? [] : [{ description: 'VAT withholding receipt', quantity: 1, measurement: null, unit_price: paid, amount: paid }];
    parsed.has_header = true;
    parsed.has_totals = paid !== null || withheld !== null;
    parsed.page_no = null; parsed.page_count = null;
    return parsed;
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

function cleanItems(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const it of raw.slice(0, 150)) {
        if (!it || typeof it !== 'object') continue;
        const description = String(it.description || '').trim();
        const q = toNumOrNull(it.quantity), p = toNumOrNull(it.unit_price);
        let amount = toNumOrNull(it.amount);
        if (!description && amount === null && q === null) continue;
        if (amount === null && q !== null && p !== null) amount = round2(q * p);
        out.push({ description, quantity: q, measurement: it.measurement ? String(it.measurement).trim() : null, unit_price: p, amount });
    }
    return out;
}

// ---- Hand-filled invoices (layout B): the date is Ethiopian even when the year is written in full ----
// "4/11/2018" looks Gregorian but is Ethiopian. The Gregorian year is 7 or 8 higher than the
// Ethiopian one, so on a hand-filled invoice a year this far behind today can only be Ethiopian.
function fixEthiopianYear(parsed) {
    if (parsed.layout !== 'B' && parsed.layout !== 'W') return parsed;
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

// ---- One line item with a quantity above 1 (e.g. 2 x 121,739.13 = 243,478.26) ----
// unit_price = before_vat only makes sense when the quantity is 1. With a larger quantity we
// keep the per-unit price so quantity x unit price still equals the subtotal.
function fixSingleItemUnitPrice(parsed) {
    if (!parsed.items || parsed.items.length !== 1) return parsed;
    const q = toNumOrNull(parsed.quantity) !== null ? toNumOrNull(parsed.quantity) : parsed.items[0].quantity;
    const base = toNumOrNull(parsed.before_vat);
    if (!q || q <= 1 || base === null) return parsed;
    const up = toNumOrNull(parsed.unit_price);
    if (up === null || Math.abs(up * q - base) > 1) parsed.unit_price = round2(base / q);
    return parsed;
}

// ---- Services (not stock) ----
// The ethio telecom bill (layout D) is a SERVICE, not goods: it must never be added to stock.
// The reading carries is_service: true (on the document and on its item) so the screen can skip it.
function markService(parsed) {
    parsed.is_service = parsed.layout === 'D' || parsed.layout === 'W';
    if (parsed.is_service) parsed.items = (parsed.items || []).map((it) => ({ ...it, is_service: true }));
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

// ---- Who is calling? (signed-in user, free-trial visitor, or neither) ----
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nwkrrcatdhppvlceuzwg.supabase.co';

function headerText(req, name, max) {
    const v = req.headers[name];
    const t = Array.isArray(v) ? v[0] : v;
    return (typeof t === 'string' ? t.trim() : '').slice(0, max || 120);
}

function callerIp(req) {
    const fwd = headerText(req, 'x-forwarded-for', 200);
    if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
    return (headerText(req, 'x-real-ip', 64) || (req.socket && req.socket.remoteAddress) || '').slice(0, 64);
}

// Asks Supabase whether this login token is real and still valid.
async function verifySupabaseUser(token, serviceKey) {
    try {
        const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
            headers: { Authorization: 'Bearer ' + token, apikey: serviceKey },
        });
        if (!r.ok) return null;
        const u = await r.json().catch(() => null);
        return u && u.id ? u : null;
    } catch (e) {
        return null;
    }
}

// Asks the database whether this free-trial visitor may scan one more photo.
// Returns { ok: true } or { ok: false, reason: 'trial_used' | 'busy' | 'bad_request' }.
// Throws if the database itself cannot be reached.
async function claimGuestScan(guest, serviceKey) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/claim_guest_scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
        body: JSON.stringify({ p_device: guest.device, p_fp: guest.fp, p_ip: guest.ip, p_batch: guest.batch, p_retry: guest.retry }),
    });
    if (!r.ok) throw new Error('claim_guest_scan failed (' + r.status + ')');
    const out = await r.json();
    return out && typeof out === 'object' ? out : { ok: false, reason: 'bad_request' };
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

    // ---- Gate: signed-in user, free-trial visitor, or (until ENFORCE_AUTH) legacy caller ----
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const authHeader = headerText(req, 'authorization', 4000);
    const bearer = /^Bearer\s+(.+)$/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, '') : '';
    const guestDevice = headerText(req, 'x-guest-device', 80);
    const guestBatch = headerText(req, 'x-guest-batch', 80);

    if (bearer) {
        if (!serviceKey) {
            res.status(500).json({ error: 'Server is not configured with SUPABASE_SERVICE_ROLE_KEY.' });
            return;
        }
        const user = await verifySupabaseUser(bearer, serviceKey);
        if (!user) {
            res.status(401).json({ code: 'auth_required', error: 'Your session has expired. Please sign in again.' });
            return;
        }
    } else if (guestDevice && guestBatch) {
        if (!serviceKey) {
            res.status(500).json({ error: 'Server is not configured with SUPABASE_SERVICE_ROLE_KEY.' });
            return;
        }
        let claim;
        try {
            claim = await claimGuestScan({
                device: guestDevice,
                batch: guestBatch,
                fp: headerText(req, 'x-guest-fp', 80),
                ip: callerIp(req),
                retry: headerText(req, 'x-guest-retry', 4) === '1',
            }, serviceKey);
        } catch (e) {
            res.status(503).json({ code: 'unavailable', error: 'The free trial is temporarily unavailable. Please try again in a few minutes.' });
            return;
        }
        if (!claim.ok) {
            if (claim.reason === 'busy') {
                res.status(429).json({ code: 'busy', error: 'The free trial is very busy right now. Create a free account to keep going, or try again later.' });
            } else if (claim.reason === 'trial_used') {
                res.status(403).json({ code: 'trial_used', error: 'You have already used your free trial. Create a free account to keep scanning.' });
            } else {
                res.status(400).json({ code: 'bad_request', error: 'Could not start the free trial.' });
            }
            return;
        }
    } else if (process.env.ENFORCE_AUTH === 'true') {
        res.status(401).json({ code: 'auth_required', error: 'Please sign in or start the free trial.' });
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
        parsed = fixWithholding(parsed);
        parsed = fillMissingVatFields(parsed);
        // Trust the model's own read of which calendar the date was written
        // in (layout A is always Gregorian; the manual yellow layout is
        // usually Ethiopian) — only fall back to Gregorian if it left this
        // blank or returned something unrecognized.
        parsed.date_calendar = parsed.date_calendar === 'EC' ? 'EC' : 'GC';
        parsed.layout = ['A', 'B', 'C', 'D', 'E', 'W'].includes(parsed.layout) ? parsed.layout : 'A';
        parsed = fixEthiopianYear(parsed);
        parsed = fixDate(parsed);
        parsed = cleanPageFields(parsed);
        parsed.items = cleanItems(parsed.items);
        parsed.before_vat = toNumOrNull(parsed.before_vat);
        parsed.vat = toNumOrNull(parsed.vat);
        parsed.total = toNumOrNull(parsed.total);
        parsed = fixTelecomItem(parsed);
        parsed = markService(parsed);
        parsed = fixSingleItemUnitPrice(parsed);
        if (parsed.layout === 'B' || parsed.layout === 'D' || parsed.layout === 'E' || parsed.layout === 'W') parsed.missing_fields = (Array.isArray(parsed.missing_fields) ? parsed.missing_fields : []).filter((f) => f !== 'MRC');
        parsed.warnings = mathWarnings(parsed);
        res.status(200).json(parsed);
    } catch (e) {
        res.status(502).json({ error: 'Model returned non-JSON output that could not be parsed.' });
    }
}
