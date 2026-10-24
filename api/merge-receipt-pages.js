// /api/merge-receipt-pages.js
//
// NEW endpoint. No AI is involved here - it is pure arithmetic, so it is fast,
// free and gives the same answer every time.
//
// The browser reads every photo with the existing extract endpoints, then sends
// all the readings here:   POST { pages: [ <reading>, <reading>, ... ] }
// Each reading is exactly what /api/extract-receipt-items (or /api/extract-receipt)
// returned.
//
// This endpoint does two jobs:
//
//  1. GROUPING. A long attachment is photographed as several pages. Pages are
//     linked first by things printed on every page (the system stamp line, the
//     FS No., the voucher number) and then by ARITHMETIC: a set of pages belongs
//     together when the lines on all of them add up to the Subtotal / VAT printed
//     on the totals page.
//
//  2. TAXABLE vs NON-VAT LINES. When a receipt mixes taxable and non-taxable goods,
//     the VAT amount tells us the taxable base (VAT / 15%). Whatever the lines add
//     up to beyond that base must be the non-VAT lines, so we search for the lines
//     whose amounts add up to the difference.
//
// Returns { documents: [ merged reading, ... ] }. Each merged reading has the
// same shape as a normal reading plus:
//   items[].taxable, non_vat_total, taxable_total, split {status,...},
//   source_idx (which input pages went into it), warnings[], infos[].

export const config = { maxDuration: 15 };

const VAT_RATE = 0.15;
const OK_STATUSES = ['none', 'inclusive', 'solved', 'approx', 'ambiguous'];

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};
const cents = (n) => Math.round(Number(n) * 100);
const r2 = (n) => Math.round(n * 100) / 100;
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const alnum = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function lineCents(it) {
    const a = num(it.amount);
    if (a !== null) return cents(a);
    const q = num(it.quantity), p = num(it.unit_price);
    if (q !== null && p !== null) return cents(q * p);
    return null;
}

// ---------------------------------------------------------------------------
// Subset search: which lines add up to D (within tol cents)? Returns the
// solutions that use the FEWEST lines (a receipt rarely has many exempt lines).
// ---------------------------------------------------------------------------
function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }

function meetInTheMiddle(vals, D, tol) {
    const n = vals.length, h = n >> 1;
    const enumerate = (arr) => {
        const out = [{ s: 0, m: 0 }];
        arr.forEach((v, i) => { const len = out.length; for (let j = 0; j < len; j++) out.push({ s: out[j].s + v, m: out[j].m | (1 << i) }); });
        return out;
    };
    const L = enumerate(vals.slice(0, h)).sort((a, b) => a.s - b.s);
    const R = enumerate(vals.slice(h));
    let bestK = Infinity, sols = [];
    for (const r of R) {
        const lo = D - tol - r.s, hi = D + tol - r.s;
        let a = 0, b = L.length;
        while (a < b) { const mid = (a + b) >> 1; if (L[mid].s < lo) a = mid + 1; else b = mid; }
        for (let i = a; i < L.length && L[i].s <= hi; i++) {
            const k = popcount(L[i].m) + popcount(r.m);
            if (k === 0) continue;
            if (k < bestK) { bestK = k; sols = []; }
            if (k === bestK && sols.length < 300) sols.push({ lm: L[i].m, rm: r.m });
        }
    }
    return sols.map((s) => {
        const idx = [];
        for (let i = 0; i < h; i++) if (s.lm & (1 << i)) idx.push(i);
        for (let i = 0; i < n - h; i++) if (s.rm & (1 << i)) idx.push(h + i);
        return idx;
    });
}

function depthFirst(vals, D, tol) {
    // For long receipts: look for up to 4 non-VAT lines, biggest amounts first.
    const order = vals.map((v, i) => i).sort((a, b) => vals[b] - vals[a]);
    let nodes = 0;
    for (let k = 1; k <= 4; k++) {
        const sols = [];
        const walk = (start, left, sum, chosen) => {
            if (nodes++ > 400000 || sols.length >= 300) return;
            if (left === 0) { if (Math.abs(sum - D) <= tol) sols.push(chosen.slice()); return; }
            for (let p = start; p < order.length; p++) {
                const v = vals[order[p]];
                if (sum + v > D + tol) continue;
                chosen.push(order[p]);
                walk(p + 1, left - 1, sum + v, chosen);
                chosen.pop();
            }
        };
        walk(0, k, 0, []);
        if (sols.length) return sols;
        if (nodes > 400000) break;
    }
    return [];
}

function subsetSearch(vals, D, tol) {
    if (vals.length === 0) return [];
    if (vals.length <= 30) return meetInTheMiddle(vals, D, tol);
    if (vals.length <= 150) return depthFirst(vals, D, tol);
    return [];
}

// ---------------------------------------------------------------------------
// Evaluate a set of lines against the printed totals.
//   none      lines add up exactly to the taxable base - everything is taxable
//   inclusive lines already include VAT (they add up to the grand total)
//   solved    some lines have no VAT; exactly one answer found
//   approx    same, but only within a small rounding difference
//   ambiguous several different combinations fit - the person must pick
//   short     lines add up to LESS than expected - a page/line is missing
//   unsolved  lines add up to more, but no combination of lines explains it
//   unknown   some lines have no amount, cannot check
// ---------------------------------------------------------------------------
function evaluate(items, t) {
    const amts = items.map(lineCents);
    if (!items.length || amts.some((a) => a === null)) return { status: 'unknown', nonVat: [] };
    const S = amts.reduce((s, a) => s + a, 0);
    // A service bill (ethio telecom) has taxes outside the VAT base (excise, disaster fund), so the
    // taxable/non-VAT line search does not apply: the single bill line is the whole receipt.
    if (t.is_service) return { status: 'none', sum: S, nonVat: [] };
    const V = num(t.vat), G = num(t.total), B = num(t.before_vat);

    if (!t.is_vat || V === null || V <= 0) {
        const target = B !== null ? cents(B) : (G !== null ? cents(G) : null);
        if (target === null || Math.abs(S - target) <= 5) return { status: 'none', sum: S, nonVat: [] };
        return { status: S < target ? 'short' : 'unsolved', sum: S, target, missing: target - S, nonVat: [] };
    }

    const T = V / VAT_RATE * 100; // taxable base in cents (float)
    if (Math.abs(S - T) <= 6) return { status: 'none', sum: S, nonVat: [] };
    if (G !== null && Math.abs(S - cents(G)) <= 5) return { status: 'inclusive', sum: S, nonVat: [] };
    if (S < T) return { status: 'short', sum: S, target: Math.round(T), missing: Math.round(T - S), nonVat: [] };

    const D = S - T;
    const idx = amts.map((a, i) => i).filter((i) => amts[i] > 0);
    const vals = idx.map((i) => amts[i]);
    let tolUsed = 6;
    let sols = subsetSearch(vals, D, tolUsed);
    if (!sols.length) {
        tolUsed = Math.min(100, Math.max(12, Math.round(3.4 * items.length)));
        sols = subsetSearch(vals, D, tolUsed);
    }
    if (!sols.length) return { status: 'unsolved', sum: S, diff: Math.round(D), nonVat: [] };

    const keyOf = (sol) => sol.map((p) => `${String(items[idx[p]].description || '').trim().toLowerCase()}|${amts[idx[p]]}`).sort().join(';');
    const unique = new Map();
    sols.forEach((sol) => { const k = keyOf(sol); if (!unique.has(k)) unique.set(k, sol); });
    const candidates = Array.from(unique.values()).slice(0, 6).map((sol) => sol.map((p) => idx[p]).sort((a, b) => a - b));
    const status = unique.size > 1 ? 'ambiguous' : (tolUsed === 6 ? 'solved' : 'approx');
    return { status, sum: S, nonVat: candidates[0], candidates, diff: Math.round(D) };
}


// Faded line totals: if a line's printed total disagrees with qty x price, and using
// qty x price makes the whole sheet add up, trust the multiplication.
function evaluateWithRepair(items, t) {
    let ev = evaluate(items, t);
    const repaired = [];
    if (OK_STATUSES.includes(ev.status) || ev.status === 'unknown') return { ev, items, repaired };
    const fixed = items.map((it) => {
        const q = num(it.quantity), p = num(it.unit_price), a = num(it.amount);
        if (q !== null && p !== null && a !== null && Math.abs(q * p - a) > Math.max(0.5, a * 0.002)) { repaired.push(String(it.description || '').slice(0, 30)); return { ...it, amount: r2(q * p) }; }
        return it;
    });
    if (repaired.length) {
        const ev2 = evaluate(fixed, t);
        if (OK_STATUSES.includes(ev2.status)) return { ev: ev2, items: fixed, repaired };
    }
    return { ev, items, repaired: [] };
}

// ---------------------------------------------------------------------------
// Page bookkeeping
// ---------------------------------------------------------------------------
function describePage(p, i) {
    const stampRaw = String(p.doc_stamp || '').split('|')[0];
    const stampAl = alnum(stampRaw);
    const items = Array.isArray(p.items) ? p.items : [];
    const tin = digits(p.seller_tin);
    return {
        i, p, items,
        stamp: stampAl.length >= 8 && digits(stampAl).length >= 6 ? stampAl : '',
        fs: digits(p.fs_no || p.receipt_no).length >= 4 ? digits(p.fs_no || p.receipt_no) : '',
        vch: alnum(p.voucher_no).length >= 4 ? alnum(p.voucher_no) : '',
        tin: tin.length >= 6 ? tin : '',
        hasTotals: num(p.before_vat) !== null || num(p.vat) !== null || num(p.total) !== null,
        hasHeader: typeof p.has_header === 'boolean' ? p.has_header : !!(tin || p.seller_name),
        pageNo: Number.isInteger(num(p.page_no)) ? num(p.page_no) : null,
        pageCount: Number.isInteger(num(p.page_count)) ? num(p.page_count) : null,
    };
}

function conflict(a, b) {
    if (a.tin && b.tin && a.tin !== b.tin) return true;
    if (a.fs && b.fs && a.fs !== b.fs) return true;
    return false;
}
function strongLink(a, b) {
    if (conflict(a, b)) return false;
    if (a.stamp && a.stamp === b.stamp) return true;
    if (a.fs && a.fs === b.fs) return true;
    if (a.vch && a.vch === b.vch) return true;
    return false;
}

function itemsSignature(d) {
    // description left out on purpose: two photos of the same page often read a blurry name differently
    return d.items.map((it) => `${num(it.quantity)}|${num(it.amount)}`).join(';');
}

// the group's combined lines and printed totals, used to test the arithmetic
function pseudoDoc(members) {
    const items = [];
    members.forEach((m) => m.items.forEach((it) => items.push(it)));
    const totalsPage = members.filter((m) => m.hasTotals).slice(-1)[0];
    const tp = totalsPage ? totalsPage.p : {};
    return {
        items,
        is_vat: members.some((m) => m.p.is_vat),
        is_service: members.some((m) => m.p.is_service || m.p.layout === 'D'),
        before_vat: tp.before_vat, vat: tp.vat, total: tp.total,
    };
}

function evalMembers(members) {
    const d = pseudoDoc(members);
    return evaluateWithRepair(d.items, d).ev;
}
const statusScore = (s) => ({ none: 3, inclusive: 3, solved: 2, approx: 1, ambiguous: 1 }[s] || 0);

function combos(arr, k, cb) {
    const pick = [];
    const go = (start) => {
        if (pick.length === k) { cb(pick.slice()); return; }
        for (let i = start; i < arr.length; i++) { pick.push(arr[i]); go(i + 1); pick.pop(); }
    };
    go(0);
}

export function groupPages(pages) {
    const infos = pages.map((p, i) => describePage(p, i));
    // --- 1. link pages that share an identity (stamp / FS No. / voucher no.)
    const parent = infos.map((_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let a = 0; a < infos.length; a++) for (let b = a + 1; b < infos.length; b++) {
        if (strongLink(infos[a], infos[b])) parent[find(a)] = find(b);
    }
    const buckets = new Map();
    infos.forEach((d, i) => { const r = find(i); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(d); });

    let groups = Array.from(buckets.values()).map((members) => {
        // drop duplicate photos of the very same page
        const seen = new Set(), kept = [], dupes = [];
        members.forEach((m) => {
            const sig = itemsSignature(m) + '#' + (m.pageNo || '') + '#' + (num(m.p.total) || '');
            if (m.items.length && seen.has(sig)) dupes.push(m); else { seen.add(sig); kept.push(m); }
        });
        return { members: kept, dupes, notes: [], linkedBy: kept.length > 1 ? 'stamp' : null };
    });

    // --- 2. arithmetic: attach page-groups that have no totals to the group
    //        whose printed totals they complete
    const hasTot = (g) => g.members.some((m) => m.hasTotals);
    const needsMore = (g) => {
        if (!hasTot(g)) return false;
        const hasHead = g.members.some((m) => m.hasHeader);
        const ev = evalMembers(g.members);
        return !hasHead || !OK_STATUSES.includes(ev.status);
    };
    let guard = 0;
    while (guard++ < 20) {
        const orphans = groups.filter((g) => !hasTot(g));
        const anchors = groups.filter((g) => needsMore(g));
        if (!orphans.length || !anchors.length || orphans.length > 14) break;
        let best = null;
        anchors.forEach((anchor) => {
            for (let k = 1; k <= Math.min(5, orphans.length); k++) {
                combos(orphans, k, (set) => {
                    const members = anchor.members.concat(...set.map((g) => g.members));
                    // never join pages that disagree about who the seller is
                    for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) if (conflict(members[x], members[y])) return;
                    const ev = evalMembers(members);
                    if (!OK_STATUSES.includes(ev.status)) return;
                    const sc = statusScore(ev.status) * 10 - k + (members.some((m) => m.hasHeader) ? 1 : 0);
                    if (!best || sc > best.sc) best = { anchor, set, sc, ties: 0, k };
                    else if (sc === best.sc && best.anchor === anchor) best.ties++;
                });
                if (best && best.anchor === anchor && best.k === k) break; // fewest extra pages wins
            }
        });
        if (!best) break;
        best.anchor.members = best.anchor.members.concat(...best.set.map((g) => g.members));
        best.anchor.dupes = best.anchor.dupes.concat(...best.set.map((g) => g.dupes));
        best.anchor.linkedBy = 'arithmetic';
        if (best.ties > 0) best.anchor.notes.push('lowConfidence');
        groups = groups.filter((g) => !best.set.includes(g));
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Merge one group into a single reading
// ---------------------------------------------------------------------------
function firstOf(members, key) {
    for (const m of members) { const v = m.p[key]; if (v !== null && v !== undefined && v !== '') return v; }
    return null;
}

export function mergeGroup(group) {
    let members = group.members.slice();
    const allNumbered = members.every((m) => m.pageNo !== null);
    members.sort((a, b) => {
        if (allNumbered) return a.pageNo - b.pageNo;
        const ra = a.hasHeader ? 0 : (a.hasTotals ? 2 : 1), rb = b.hasHeader ? 0 : (b.hasTotals ? 2 : 1);
        return ra - rb || a.i - b.i;
    });
    const headFirst = members.slice().sort((a, b) => (b.hasHeader ? 1 : 0) - (a.hasHeader ? 1 : 0));
    const pick = (key) => firstOf(headFirst, key);
    const infos = [], warns = [];

    const doc = {
        layout: pick('layout') || 'A',
        seller_name: pick('seller_name'), seller_tin: pick('seller_tin'), buyer_tin: pick('buyer_tin'),
        vat_reg_no: pick('vat_reg_no'), receipt_no: pick('receipt_no'), fs_no: pick('fs_no'), mrc: pick('mrc'),
        voucher_no: pick('voucher_no'), doc_stamp: pick('doc_stamp'),
        supplier_name: pick('supplier_name'), supplier_vat_no: pick('supplier_vat_no'),
        date_calendar: pick('date_calendar') || 'GC',
        date_year: null, date_month: null, date_day: null, date_raw: null,
        date_ambiguous: false, date_alt_day: null, date_alt_month: null,
        is_vat: members.some((m) => m.p.is_vat),
        is_service: members.some((m) => m.p.is_service || m.p.layout === 'D'),
        doc_title: pick('doc_title'), receipt_time: pick('receipt_time'),
        header_lines: (headFirst.find((m) => m.hasHeader) || members[0]).p.header_lines || [],
        footer_lines: (members.slice().reverse().find((m) => m.hasTotals) || members[0]).p.footer_lines || [],
    };
    const datePage = headFirst.find((m) => m.p.date_year && m.p.date_month && m.p.date_day) || headFirst[0];
    ['date_year', 'date_month', 'date_day', 'date_raw', 'date_ambiguous', 'date_alt_day', 'date_alt_month', 'date_calendar'].forEach((k) => { if (datePage.p[k] !== undefined) doc[k] = datePage.p[k]; });
    doc.date_ambiguous = !!doc.date_ambiguous;

    // Date order tie-break: the small system stamp line (09.04.2026 13:40:55) is always day.month.year.
    if (doc.date_ambiguous && doc.date_alt_day && doc.date_alt_month) {
        const stamps = members.map((m) => String(m.p.doc_stamp || '')).join(' ');
        const sm = stamps.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (sm && Number(sm[3]) === Number(doc.date_year)) {
            const sd = Number(sm[1]), smo = Number(sm[2]);
            if (sd === Number(doc.date_day) && smo === Number(doc.date_month)) { doc.date_ambiguous = false; infos.push('Date confirmed from the page stamp (' + sm[0] + ').'); }
            else if (sd === Number(doc.date_alt_day) && smo === Number(doc.date_alt_month)) {
                doc.date_day = sd; doc.date_month = smo; doc.date_ambiguous = false; infos.push('Date read as day ' + sd + ' / month ' + smo + ' because the page stamp says ' + sm[0] + '.');
            }
        }
        if (!doc.date_ambiguous) { doc.date_alt_day = null; doc.date_alt_month = null; }
    }

    // totals from the page that has them
    const totalsPage = members.slice().reverse().find((m) => m.hasTotals);
    const tp = totalsPage ? totalsPage.p : {};
    doc.before_vat = num(tp.before_vat); doc.vat = num(tp.vat); doc.total = num(tp.total);

    // lines, in page order
    let items = [];
    members.forEach((m) => m.items.forEach((it) => items.push({ ...it })));
    const tt = { is_vat: doc.is_vat, is_service: doc.is_service, vat: doc.vat, total: doc.total, before_vat: doc.before_vat };
    const evr = evaluateWithRepair(items, tt);
    let ev = evr.ev;
    items = evr.items;
    const repaired = evr.repaired;
    if (repaired.length) infos.push('A printed line total was hard to read on ' + repaired.length + ' line(s); used quantity x price, and the sheet now adds up (' + repaired.map((d) => '"' + d + '"').join(', ') + ').');

    const nonVatSet = new Set(ev.nonVat || []);
    items = items.map((it, i) => ({ ...it, taxable: !nonVatSet.has(i) }));
    const amtC = (it) => { const c = lineCents(it); return c === null ? 0 : c; };
    const nonVatC = items.filter((it) => !it.taxable).reduce((s, it) => s + amtC(it), 0);
    const taxableC = items.filter((it) => it.taxable).reduce((s, it) => s + amtC(it), 0);
    doc.items = items;
    doc.non_vat_total = r2(nonVatC / 100);
    doc.taxable_total = r2(taxableC / 100);
    if (nonVatSet.size) doc.before_vat = doc.taxable_total; // VAT base = taxable lines only
    // The lines agree with the VAT and the grand total, so a different printed/read subtotal is a misread.
    if (ev.status === 'none' && doc.is_vat && ev.sum !== undefined && doc.vat !== null && doc.vat > 0) {
        const fromLines = r2(ev.sum / 100);
        if (doc.before_vat === null) doc.before_vat = fromLines;
        else if (Math.abs(doc.before_vat - fromLines) > 0.06) { infos.push('The subtotal (' + fmt(doc.before_vat) + ') looked misread; used the total of the lines (' + fmt(fromLines) + '), which matches the VAT amount.'); doc.before_vat = fromLines; }
    }
    doc.split = { status: ev.status, candidates: ev.candidates || [], missing: ev.missing ? r2(ev.missing / 100) : 0 };

    // largest TAXABLE line stands in as the receipt's single description (same rule as before)
    const taxableItems = items.filter((it) => it.taxable);
    const pool = taxableItems.length ? taxableItems : items;
    if (pool.length) {
        const top = pool.slice().sort((a, b) => amtC(b) - amtC(a))[0];
        doc.description = top.description;
        doc.measurement = top.measurement || null;
        doc.quantity = num(top.quantity);
        doc.unit_price = taxableItems.length === 1 && doc.before_vat !== null ? doc.before_vat : num(top.unit_price);
    } else {
        doc.description = pick('description'); doc.measurement = pick('measurement');
        doc.quantity = num(pick('quantity')); doc.unit_price = num(pick('unit_price'));
    }

    // ---- notes for the person ----
    if (members.length > 1) {
        const nos = members.map((m) => m.pageNo).filter((x) => x !== null);
        infos.push('Combined ' + members.length + ' photos into one receipt' + (nos.length === members.length ? ' (pages ' + nos.join(', ') + ')' : '') + (group.linkedBy === 'arithmetic' ? ': the lines on these pages add up to the totals printed on the last page.' : '.'));
    }
    if (group.dupes && group.dupes.length) infos.push('Ignored ' + group.dupes.length + ' duplicate photo' + (group.dupes.length > 1 ? 's' : '') + ' of a page already scanned.');
    if (group.notes.includes('lowConfidence')) warns.push('Another page could fit just as well. Check that all pages really belong to this receipt.');
    const declared = Math.max(0, ...members.map((m) => m.pageCount || 0));
    if (declared > members.length) warns.push('This document has ' + declared + ' pages but only ' + members.length + ' photo' + (members.length > 1 ? 's were' : ' was') + ' found. Scan the missing page' + (declared - members.length > 1 ? 's' : '') + ' too.');

    // VAT withholding receipt (layout W): the withheld VAT must be 15% of the amount paid
    if (doc.layout === 'W' && doc.before_vat !== null && doc.vat !== null && Math.abs(doc.vat - doc.before_vat * VAT_RATE) > 1.5) warns.push('The VAT withheld (' + fmt(doc.vat) + ') is not 15% of the amount paid (' + fmt(doc.before_vat) + ' x 15% = ' + fmt(doc.before_vat * VAT_RATE) + '). The amount paid or the withheld amount may be misread - check both against the paper.');

    const nv = items.filter((it) => !it.taxable);
    if (ev.status === 'solved') infos.push(nv.length + ' line' + (nv.length > 1 ? 's' : '') + ' worth ' + fmt(doc.non_vat_total) + ' have no VAT (worked out from the VAT amount). They are kept separate from the taxable lines.');
    if (ev.status === 'approx') warns.push(nv.length + ' non-VAT line' + (nv.length > 1 ? 's' : '') + ' found (' + fmt(doc.non_vat_total) + '), but with a small rounding difference. Check the Non-VAT ticks.');
    if (ev.status === 'ambiguous') warns.push('Several different sets of lines could be the non-VAT ones. One is ticked - check it against the paper.');
    if (ev.status === 'unsolved') warns.push('The VAT amount does not match the lines, so some lines probably have no VAT, but no combination of lines explains it. Tick the non-VAT lines yourself, or check for a misread number.');
    if (ev.status === 'short') warns.push('The lines add up to ' + fmt((ev.sum || 0) / 100) + ' but the printed VAT/total means about ' + fmt((ev.target || 0) / 100) + '. About ' + fmt((ev.missing || 0) / 100) + ' of lines are missing: a page may not have been scanned, or a line was misread.');
    if (doc.is_vat && doc.vat !== null && doc.total !== null && ev.sum !== undefined && ev.status !== 'inclusive' && ev.status !== 'short' && ev.status !== 'unknown') {
        if (Math.abs(doc.total - (ev.sum / 100 + doc.vat)) > 0.06) warns.push('Lines + VAT do not equal the printed total. One amount may be misread.');
    }
    if (!repaired.length) items.forEach((it) => {
        const q = num(it.quantity), p = num(it.unit_price), a = num(it.amount);
        if (q !== null && p !== null && a !== null && Math.abs(q * p - a) > Math.max(1, a * 0.005) && warns.length < 5) warns.push('"' + String(it.description || '').slice(0, 30) + '": quantity x price does not match the line amount.');
    });

    // fields still missing after combining the pages
    const wanted = new Set();
    members.forEach((m) => (Array.isArray(m.p.missing_fields) ? m.p.missing_fields : []).forEach((f) => wanted.add(f)));
    ['Seller name', 'Seller TIN', 'Items', 'Total'].forEach((f) => wanted.add(f));
    doc.missing_fields = Array.from(wanted).filter((f) => {
        if (f === 'Seller name') return !doc.seller_name;
        if (f === 'Seller TIN') return !doc.seller_tin;
        if (f === 'MRC') return !doc.mrc;
        if (f === 'Items') return !items.length;
        if (f === 'Total') return doc.total === null;
        return false;
    });
    if (doc.layout === 'W') { // no item table and no VAT invoice totals on this layout
        doc.missing_fields = doc.missing_fields.filter((f) => f !== 'Items' && f !== 'Total');
        if (doc.before_vat === null && !doc.missing_fields.includes('Taxable amount')) doc.missing_fields.push('Taxable amount');
    }
    doc.warnings = warns.slice(0, 6);
    doc.infos = infos;
    doc.source_idx = members.map((m) => m.i).concat((group.dupes || []).map((m) => m.i));
    doc.page_count = members.length;
    return doc;
}

export function mergePages(pages) {
    return groupPages(pages).map(mergeGroup);
}

export default async function handler(req, res) {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const pages = req.body && req.body.pages;
    if (!Array.isArray(pages) || !pages.length || pages.length > 40) { res.status(400).json({ error: 'Body must be { pages: [ ... ] } with 1 to 40 readings.' }); return; }
    try {
        const clean = pages.map((p) => (p && typeof p === 'object' ? p : {}));
        res.status(200).json({ documents: mergePages(clean) });
    } catch (e) {
        res.status(500).json({ error: 'Could not combine the pages.' });
    }
}
