// verticals/restaurant.js
//
// Only fetched for tenants with business_type === 'restaurant' (see
// business-types.config.js -> loadVerticalModule).
//
// Phase 1: floor map, tabs, kitchen / bar screen, bill and close.
// Phase 2: recipes, ingredient units, stock deducted once when an item is
//          marked Ready (server function), real cost of goods on each bill,
//          recipe cost / margin and sales reports. Switches on by itself
//          once restaurant-phase2.sql has been run.
// Phase 3: stock counts (open bottles in tenths), variance report, waste log,
//          voids after Ready logged as waste. Switches on once restaurant-phase3.sql has run.
//
// Order alarm: a new kitchen / bar item sounds a loud siren, repeating until the ticket is tapped, on every device that has the
// kitchen screen permission and is set to that station (Kitchen, Bar or Both).
// It rings on any Restaurant screen, and also while the app is on another page
// (a small realtime listener starts at login). Phones only allow sound after one
// tap, so the Kitchen screen shows a "tap once" banner until sound is unlocked.
//
// ONLINE ONLY (decision for this version): every read and write goes
// straight to Supabase. There is no offline queue here. If the phone has
// no connection the waiter sees "No connection. Nothing was sent." and
// nothing is half-saved.
//
// The only thing that still uses the app's own write queue is recording
// the finished sale (sales_log + journal_entries) when a bill is paid, so
// accounting, VAT and reports keep working exactly as for any other sale.
//
// Data lives in the rest_* tables (see restaurant-phase1.sql). Realtime
// updates come from Supabase realtime plus a 20 second fallback refresh.
//
// index.html is a classic script, so its top-level functions are on
// `window` and its top-level `let`/`const` (state, currentUsername ...)
// are reachable by bare name from this module.

const css = `
.rs{font-family:inherit;color:var(--text);max-width:1100px}
.rs *{box-sizing:border-box}
.rs button{font-family:inherit;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.rs-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.rs-tab{flex:1 1 auto;min-width:90px;padding:11px 12px;border:1px solid var(--border);background:var(--surface);border-radius:8px;font-size:14px;cursor:pointer;color:var(--text)}
.rs-tab.on{background:var(--primary,#1d4d4f);color:#fff;border-color:transparent}
.rs-offline{background:#FCEEDD;color:#8a4b0f;border:1px solid #e8c99a;padding:8px 12px;border-radius:8px;margin-bottom:10px;font-size:13px}
.rs-err{background:#FAECE7;color:#8d2b1c;border:1px solid #e9b8ad;padding:12px;border-radius:8px;font-size:13px}
.rs-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px}
.rs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rs-sp{flex:1}
.rs-btn{padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:14px;cursor:pointer;min-height:42px}
.rs-btn.pri{background:var(--primary,#1d4d4f);color:#fff;border-color:transparent}
.rs-btn.dan{background:#B23A2E;color:#fff;border-color:transparent}
.rs-btn.sm{padding:6px 10px;min-height:32px;font-size:12px}
.rs-btn[disabled]{opacity:.5}
.rs input,.rs select,.rs textarea{padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text);max-width:100%}
.rs-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin:8px 0}
.rs-chip{flex:0 0 auto;padding:7px 13px;border-radius:20px;border:1px solid var(--border);background:var(--surface);font-size:13px;cursor:pointer;color:var(--text)}
.rs-chip.on{background:var(--primary,#1d4d4f);color:#fff;border-color:transparent}
.rs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.rs-item{padding:12px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);text-align:left;cursor:pointer;min-height:72px;display:flex;flex-direction:column;justify-content:space-between;color:var(--text)}
.rs-item b{font-size:14px;font-weight:600}
.rs-item span{font-size:12px;color:var(--text-light)}
.rs-item .q{align-self:flex-end;background:var(--accent,#C97A22);color:#fff;border-radius:12px;padding:0 8px;font-size:12px}
.rs-cart{position:sticky;bottom:0;margin-top:14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px;box-shadow:0 -2px 10px rgba(0,0,0,.08)}
.rs-line{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px}
.rs-line .n{flex:1;min-width:0}
.rs-qty{display:flex;align-items:center;gap:6px}
.rs-qty button{width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--surface);font-size:16px;cursor:pointer;color:var(--text)}
.rs-mapwrap{border:1px solid var(--border);border-radius:10px;background:var(--bg);overflow:hidden;touch-action:none;overscroll-behavior:contain}
.rs-map{width:100%;height:58vh;min-height:320px;display:block;touch-action:none;user-select:none;-webkit-user-select:none}
.rs-t ellipse{stroke-width:2}
.rs-t text{font-size:15px;font-weight:600;text-anchor:middle;dominant-baseline:middle;pointer-events:none;fill:#222}
.rs-t text.s{font-size:11px;font-weight:400}
.rs-t.free ellipse{fill:#EDF0EC;stroke:#b9c2b8}
.rs-t.seated ellipse,.rs-t.served ellipse{fill:#E6EEF7;stroke:#7f9cc0}
.rs-t.ordered ellipse{fill:#FCEEDD;stroke:#C97A22}
.rs-t.ready ellipse{fill:#DDF1E6;stroke:#3E9B78}
.rs-t.bill ellipse{fill:#E6E3F7;stroke:#6a5fc0}
.rs-t.sel ellipse{stroke:#d33;stroke-dasharray:6 3}
.rs-t.held ellipse{stroke:#d33;stroke-width:4}
.rs-t.held{will-change:transform}
.rs-t.magnet ellipse{stroke:#2a9d6f;stroke-width:4}
.rs-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--text-light);margin:8px 0}
.rs-dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.rs-ov{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2000;display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .3s}
.rs-ov.on{opacity:1}
.rs-sheet{background:var(--surface);width:100%;max-width:560px;max-height:88vh;overflow-y:auto;border-radius:24px 24px 0 0;padding:14px 16px calc(16px + env(safe-area-inset-bottom));color:var(--text);transform:translateY(105%);transition:transform .32s cubic-bezier(.2,.8,.2,1);box-shadow:0 -8px 30px rgba(0,0,0,.25);overscroll-behavior:contain}
.rs-ov.on .rs-sheet{transform:translateY(0)}
.rs-grab{width:40px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 12px}
.rs-btn.busy{opacity:.55;pointer-events:none}
.rs-sheet h3{margin:0 0 8px;font-size:17px}
.rs-st{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;background:#eee;color:#555}
.rs-st.new{background:#FCEEDD;color:#8a4b0f}.rs-st.ready{background:#DDF1E6;color:#1f6b4c}.rs-st.void{background:#FAECE7;color:#8d2b1c}
.rs-kt{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:12px;margin-bottom:10px}
.rs-kt.late{border-color:#B23A2E}
.rs-kt.alarm{border:3px solid #B23A2E;animation:rsflash .7s infinite;cursor:pointer}
.rs-ackhint{font-weight:700;color:#B23A2E;font-size:15px;margin-bottom:6px}
@keyframes rsflash{0%,100%{background:var(--surface)}50%{background:#F9CFC8}}
.rs-alarm{position:fixed;left:0;right:0;top:0;z-index:4000;background:#B23A2E;color:#fff;padding:calc(16px + env(safe-area-inset-top)) 16px 16px;font-size:18px;font-weight:700;text-align:center;cursor:pointer;animation:rsbanner .7s infinite;box-shadow:0 4px 16px rgba(0,0,0,.4)}
@keyframes rsbanner{0%,100%{background:#B23A2E}50%{background:#E0402F}}
.rs-kitem{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--border)}
.rs-kitem .n{flex:1;font-size:16px}
.rs-kitem .rs-btn{min-width:96px;min-height:48px;font-size:15px}
.rs-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#222;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;z-index:3000;max-width:90vw}
.rs-toast.bad{background:#B23A2E}
.rs-muted{color:var(--text-light);font-size:12px}
.rs-tbl{width:100%;border-collapse:collapse;font-size:13px}
.rs-tbl td,.rs-tbl th{padding:7px 6px;border-bottom:1px solid var(--border);text-align:left}
`;

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
let ctx = null;
let root = null;

const sb = () => ctx.supabaseClient;
const S = () => (typeof state !== 'undefined' ? state : ctx.state);
const perm = k => (typeof window.hasPerm === 'function') && window.hasPerm(k);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const todayISO = () => new Date().toISOString().split('T')[0];
const mins = ts => Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000));
const username = () => (typeof currentUsername !== 'undefined' && currentUsername) || '';
function branch() {
    const b = (typeof writeBranchId !== 'undefined' && writeBranchId) || (typeof currentBranchId !== 'undefined' && currentBranchId !== 'all' ? currentBranchId : null);
    return b || null;
}
const okBranch = r => {
    const view = typeof currentBranchId !== 'undefined' ? currentBranchId : null;
    if (!view || view === 'all') return true;
    return !r.branch_id || r.branch_id === view;
};

function toast(msg, bad) {
    const el = document.createElement('div');
    el.className = 'rs-toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), bad ? 4500 : 2200);
}

// Every write goes through here: refuses cleanly when offline, and shows
// the database's message if it says no.
async function db(query) {
    if (!navigator.onLine) { toast('No connection. Nothing was sent.', true); throw new Error('offline'); }
    let r;
    try { r = await query; } catch (e) { toast('No connection. Nothing was sent.', true); throw e; }
    if (r.error) { toast('Could not save: ' + r.error.message, true); throw r.error; }
    return r.data;
}

// ---------------------------------------------------------------
// Order bell
// ---------------------------------------------------------------
// One shared audio engine for the whole app. Browsers keep it muted until the
// person has tapped the screen once, so we unlock it on the first tap anywhere.
let AC = null;
const RUNG = new Set();          // item ids that have already rung (or were already waiting when we started)

function audio() {
    if (!AC) { try { const C = window.AudioContext || window.webkitAudioContext; if (C) AC = new C(); } catch (e) { } }
    return AC;
}
function unlockAudio() {
    const a = audio();
    if (!a) return;
    try { if (a.state !== 'running') a.resume().catch(() => { }); } catch (e) { }
    // iPhones want a sound started inside the tap itself, so play one silent sample.
    try { const b = a.createBuffer(1, 1, 22050), src = a.createBufferSource(); src.buffer = b; src.connect(a.destination); src.start(0); } catch (e) { }
}
const soundOn = () => UI.sound !== false;
const soundLocked = () => soundOn() && !(AC && AC.state === 'running');
function setSound(on) {
    UI.sound = !!on;
    try { localStorage.setItem('rs_sound_' + ctx.tenantId, on ? 'on' : 'off'); } catch (e) { }
}
function setStation(st) {
    UI.station = st;
    try { localStorage.setItem('rs_station_' + ctx.tenantId, st); } catch (e) { }
}

// ALARM. Loud two-tone siren (square wave through a limiter). Kitchen and Bar use different pitches.
// It repeats until somebody taps the order's ticket on this device. UI.pending holds the items still waiting.
const ALARM_NOTES = { kitchen: [880, 1175], bar: [1319, 1760] };
function alarmBurst(a, station, delay) {
    const [f1, f2] = ALARM_NOTES[station === 'bar' ? 'bar' : 'kitchen'];
    const comp = a.createDynamicsCompressor();
    try { comp.threshold.value = -18; comp.ratio.value = 12; comp.attack.value = 0.002; comp.release.value = 0.08; } catch (e) { }
    const out = a.createGain(); out.gain.value = 1.0;
    comp.connect(out); out.connect(a.destination);
    const t0 = a.currentTime + 0.05 + (delay || 0), step = 0.16;
    for (let k = 0; k < 8; k++) {                       // 8 alternating beeps = about 1.3 s
        const t = t0 + k * step, o = a.createOscillator(), g = a.createGain();
        o.type = 'square'; o.frequency.value = k % 2 ? f2 : f1;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.9, t + 0.008);
        g.gain.setValueAtTime(0.9, t + step - 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + step - 0.004);
        o.connect(g); g.connect(comp);
        o.start(t); o.stop(t + step);
    }
}
const BURST = 1.35;   // seconds one burst lasts (8 x 0.16 plus a little)

// Should this device raise the alarm for an item at this station?
const wantsRing = st => canKitchen() && soundOn() && (UI.station === 'all' || UI.station === (st === 'bar' ? 'bar' : 'kitchen'));

function raise(id, tab, station) {
    if (UI.pending.has(id)) return;
    UI.pending.set(id, { tab, station: station === 'bar' ? 'bar' : 'kitchen', at: Date.now() });
    startAlarm();
    syncAlarmUI();
}
function stationsPending() { return [...new Set([...UI.pending.values()].map(p => p.station))]; }
function alarmTick() {
    UI.alarmT = null;
    if (!UI.pending.size || !soundOn()) { stopAlarm(); return; }
    const sts = stationsPending();
    try { if (navigator.vibrate) navigator.vibrate([400, 150, 400]); } catch (e) { }
    const a = audio();
    if (a) {
        if (a.state === 'running') sts.forEach((s, k) => alarmBurst(a, s, k * BURST));
        else { try { a.resume().catch(() => { }); } catch (e) { } }   // still locked: the tap banner / next tap unlocks it
    }
    syncAlarmUI();
    UI.alarmT = setTimeout(alarmTick, (sts.length * BURST + 0.6) * 1000);
}
function startAlarm() { if (!UI.alarmT) alarmTick(); }
function alarmNow() { clearTimeout(UI.alarmT); UI.alarmT = null; if (UI.pending.size) alarmTick(); }
function stopAlarm() {
    clearTimeout(UI.alarmT); UI.alarmT = null;
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) { }
    syncAlarmUI();
}
// Someone tapped a ticket (or its Ready button): that order is seen, stop its part of the alarm.
function ackTab(tabId) {
    let any = false;
    for (const [id, p] of UI.pending) if (p.tab === tabId) { UI.pending.delete(id); any = true; }
    if (!any) return false;
    if (!UI.pending.size) stopAlarm();
    syncAlarmUI();
    return true;
}
function prunePending(loadStartedAt) {
    for (const [id, p] of UI.pending) {
        const it = D.items.find(i => i.id === id);
        // gone from "new" (made ready / voided somewhere else), but only judge items the load could already see
        if ((it && it.status !== 'new') || (!it && p.at < loadStartedAt)) UI.pending.delete(id);
        else if (!wantsRing(p.station)) UI.pending.delete(id);   // station or sound setting changed on this device
    }
    if (!UI.pending.size) stopAlarm(); else syncAlarmUI();
}

// Red banner over the whole app when an order is waiting and the Kitchen screen is not what is showing.
function onKitchenScreen() { return !!(UI.view === 'kitchen' && root && root.offsetParent !== null); }
function syncAlarmUI() {
    let el = document.getElementById('rs-alarm');
    const show = UI.pending.size > 0 && !onKitchenScreen();
    if (!show) { if (el) el.remove(); return; }
    const sts = stationsPending().map(s => s === 'bar' ? 'BAR' : 'KITCHEN').join(' + ');
    if (!el) {
        el = document.createElement('div'); el.id = 'rs-alarm'; el.className = 'rs-alarm';
        el.addEventListener('click', openKitchen);
        document.body.appendChild(el);
    }
    el.textContent = 'NEW ORDER · ' + sts + ' · tap to open';
}
function openKitchen() {
    UI.view = 'kitchen';
    if (typeof window.switchView === 'function' && !(root && root.offsetParent !== null)) window.switchView('restaurant');
    else if (root) render();
}

// Called after every full load (covers the 20 second fallback refresh too).
function checkNewOrders(loadStartedAt) {
    const first = !UI.ringReady;
    D.items.forEach(i => {
        if (i.status !== 'new' || RUNG.has(i.id)) return;
        if (D.menu.find(m => m.id === i.menu_item_id)?.no_prep) return;
        RUNG.add(i.id);
        if (!first && wantsRing(i.station)) raise(i.id, i.tab_id, i.station);
    });
    UI.ringReady = true;
    prunePending(loadStartedAt);
}

// Small listener that starts at login, so the alarm works on any page of the app,
// not only after someone has opened the Restaurant page.
async function onNewItemRow(row) {
    if (!row || row.status !== 'new' || RUNG.has(row.id)) return;
    RUNG.add(row.id);
    if (!wantsRing(row.station)) return;
    let ok = true;
    const tab = tabById(row.tab_id);
    if (tab) ok = okBranch(tab);
    else {
        try { const r = await sb().from('rest_tabs').select('branch_id').eq('id', row.tab_id).maybeSingle(); if (r && r.data) ok = okBranch(r.data); } catch (e) { }
    }
    if (ok) raise(row.id, row.tab_id, row.station);
}
function startOrderWatch() {
    if (UI.watch || !ctx || !ctx.supabaseClient) return;
    const tid = ctx.tenantId;
    UI.watch = sb().channel('rest_ring_' + tid)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rest_tab_items', filter: 'tenant_id=eq.' + tid }, p => { onNewItemRow(p.new); })
        .subscribe();
}

// ---------------------------------------------------------------
// Data
// ---------------------------------------------------------------
const D = { zones: [], tables: [], menu: [], tabs: [], tabTables: [], items: [], recipes: [], units: [] };
const UI = {
    view: null, zoneId: null, cat: 'All', q: '', cart: [], pickTarget: null,
    sheet: null, edit: false, sel: null, list: false, join: null, station: 'kitchen',
    vb: null, error: null, count: { loc: 'Bar', q: '', vals: {} }, counts: [], waste: [], varSel: { open: '', close: '' }, variance: null, chan: null, ringReady: false, pending: new Map() /* item id -> { tab, station, at } */, alarmT: null, sound: true, mutedTablesUntil: 0, undo: null, dirty: false, booted: false, loadedOnce: false
};

async function load() {
    const loadStartedAt = Date.now();
    const tid = ctx.tenantId;
    const q = t => sb().from(t).select('*').eq('tenant_id', tid);
    const [z, t, m, tb, tt] = await Promise.all([
        q('rest_zones').eq('active', true).order('sort'),
        q('rest_tables').eq('active', true),
        q('rest_menu_items').order('sort'),
        q('rest_tabs').eq('status', 'open'),
        q('rest_tab_tables')
    ]);
    const bad = [z, t, m, tb, tt].find(r => r.error);
    if (bad) { UI.error = bad.error.message || 'Could not load.'; return; }
    UI.error = null;
    if (UI.joinCol === undefined) { const pr = await sb().from('rest_tables').select('join_group').limit(1); UI.joinCol = !pr.error; }
    if (!UI.p3) { const pr3 = await sb().from('rest_waste_log').select('id').limit(1); UI.p3 = !pr3.error; }
    // Phase 2 tables are optional: if they are not there yet, Phase 2 stays off.
    const [rc, un] = await Promise.all([q('rest_recipe_lines'), q('rest_stock_units')]);
    UI.p2 = !(rc.error || un.error);
    D.recipes = rc.error ? [] : rc.data;
    D.units = un.error ? [] : un.data;
    D.zones = z.data.filter(okBranch);
    D.tables = t.data.filter(okBranch);
    D.menu = m.data;
    D.tabs = tb.data.filter(okBranch);
    const open = new Set(D.tabs.map(x => x.id));
    D.tabTables = tt.data.filter(x => open.has(x.tab_id));
    if (open.size) {
        const it = await sb().from('rest_tab_items').select('*').eq('tenant_id', tid).in('tab_id', [...open]);
        D.items = it.error ? [] : it.data;
    } else D.items = [];

    checkNewOrders(loadStartedAt);
    UI.loadedOnce = true;
}

let loadTimer = null;
function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(async () => {
        if (!root || !document.body.contains(root)) return;
        if (UI.drag) { scheduleLoad(); return; }      // a table is being dragged: wait until it is dropped
        await load();
        if (UI.drag) return;                          // a drag started while loading: the drop will redraw
        // Don't wipe a form someone is typing in
        const a = document.activeElement;
        if (a && root.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { UI.dirty = true; return; }
        render();
    }, 250);
}

function subscribe() {
    if (UI.chan) return;
    const tid = ctx.tenantId;
    let ch = sb().channel('rest_live_' + tid);
    ['rest_zones', 'rest_tables', 'rest_menu_items', 'rest_tabs', 'rest_tab_tables', 'rest_tab_items'].forEach(t => {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'tenant_id=eq.' + tid }, () => {
            if (t === 'rest_tables' && Date.now() < UI.mutedTablesUntil) return;   // that is just our own drag coming back
            scheduleLoad();
        });
    });
    ch.subscribe(st => { UI.live = (st === 'SUBSCRIBED'); });
    UI.chan = ch;
    setInterval(() => { if (root && document.body.contains(root) && root.offsetParent !== null && navigator.onLine) scheduleLoad(); }, 20000);
    window.addEventListener('online', () => { scheduleLoad(); render(); });
    window.addEventListener('offline', () => render());
}

// Lookups
const menuById = id => D.menu.find(m => m.id === id);
const tableById = id => D.tables.find(t => t.id === id);
const tabById = id => D.tabs.find(t => t.id === id);
const itemsOf = tabId => D.items.filter(i => i.tab_id === tabId);
const liveItems = tabId => itemsOf(tabId).filter(i => i.status !== 'void');
const tablesOfTab = tabId => D.tabTables.filter(x => x.tab_id === tabId).map(x => tableById(x.table_id)).filter(Boolean);
function tabForTable(tableId) {
    const ms = membersOf(tableId);
    const link = D.tabTables.find(x => ms.some(m => m.id === x.table_id));
    return link ? tabById(link.tab_id) : null;
}
function tabLabel(tab) {
    const ts = tablesOfTab(tab.id);
    return ts.length ? ts.map(t => t.label).join(' + ') : (tab.label || 'Tab');
}
const unpaidItems = tabId => liveItems(tabId).filter(i => !i.paid);
const tabAmount = tabId => unpaidItems(tabId).reduce((s, i) => s + i.qty * Number(i.unit_price), 0);
function tableStatus(t) {
    const tab = tabForTable(t.id);
    if (!tab) return 'free';
    const its = liveItems(tab.id);
    if (tab.bill_requested) return 'bill';
    if (its.some(i => i.status === 'ready')) return 'ready';
    if (its.some(i => i.status === 'new')) return 'ordered';
    return its.length ? 'served' : 'seated';
}
const canOrder = () => perm('restaurant.take_orders');
const canKitchen = () => perm('restaurant.kitchen_screen');
const canMenu = () => perm('restaurant.manage_menu');
const canLayout = () => perm('restaurant.manage_tables');
const canJoin = () => perm('restaurant.join_tables') || canLayout();
const canVoidSent = () => perm('restaurant.void_sent');
const canCosts = () => perm('restaurant.view_costs');
const canCount = () => perm('restaurant.stock_count');
const canWaste = () => perm('restaurant.waste_log');
const REASONS = { spilled_broken: 'Spilled / broken', expired: 'Expired', over_pour: 'Over-pour', free_drink: 'Free drink for a customer', staff_drink: 'Staff drink', void_after_ready: 'Void after Ready' };

// Phase 2 helpers
const unitText = u => ({ ml: 'ml', g: 'g', piece: 'pcs' }[u] || 'units');
const invItems = () => (S().inventory || []).slice().sort((a, b) => String(a.desc).localeCompare(String(b.desc)));
const invById = id => (S().inventory || []).find(i => i.id === id);
const invName = id => { const i = invById(id); return i ? i.desc : 'Unknown item'; };
const unitRow = id => D.units.find(u => u.stock_item_id === id);
const unitOf = id => unitText((unitRow(id) || {}).base_unit);
const recipeLines = menuId => D.recipes.filter(r => r.menu_item_id === menuId);
// Cost of using `qty` units of a stock item, oldest stock first (FIFO), at this branch.
// If the shelf holds less than needed, the rest is priced at the newest known cost.
function fifoCost(id, qty) {
    const it = invById(id);
    if (!it || !(qty > 0)) return 0;
    const b = (typeof writeBranchId !== 'undefined' && writeBranchId) || null;
    let lots = (it.lots || []).filter(l => !b || l.branchId === b);
    if (typeof window.sortLotsFifo === 'function') lots = window.sortLotsFifo(lots);
    let need = qty, cost = 0, last = 0;
    for (const l of lots) {
        last = Number(l.cost) || last;
        if (need <= 0) break;
        if (!(l.qty > 0)) continue;
        const take = Math.min(need, l.qty);
        cost += take * Number(l.cost);
        need -= take;
    }
    return cost + (need > 0 ? need * last : 0);
}
// cost of the next serving; null when the item has no recipe or link
function recipeCost(m) {
    const lines = recipeLines(m.id);
    if (lines.length) return lines.reduce((s, r) => s + fifoCost(r.stock_item_id, r.qty), 0);
    if (m.stock_item_id) return fifoCost(m.stock_item_id, 1);
    return null;
}
const pct = (profit, price) => (price > 0 ? Math.round(profit / price * 100) + '%' : '');
function matchStock(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return '';
    const hit = invItems().find(x => String(x.desc).toLowerCase() === n || `[${x.category}] ${x.desc}`.toLowerCase() === n);
    return hit ? hit.id : '';
}
function createIngredient(name) {
    const st = S(), cat = 'Ingredients';
    if (st.categories && !st.categories.includes(cat)) { st.categories.push(cat); window.queueWrite({ kind: 'tenant_update', patch: { categories: st.categories } }); }
    const item = { id: uid(), category: cat, desc: name.trim(), sellingPrice: 0, lots: [], history: [] };
    st.inventory.push(item);
    window.queueWrite({ kind: 'insert', table: 'inventory_items', row: window.toDbInventoryItem(item) });
    ['syncTransactionalProductDropdownOptions', 'renderInventoryTable'].forEach(fn => { if (typeof window[fn] === 'function') { try { window[fn](); } catch (e) { } } });
    return item;
}
function lastPurchase(id) {
    const it = invById(id);
    if (!it) return null;
    const comp = `[${it.category}] ${it.desc}`;
    const rows = (S().purchaseLog || []).filter(p => p.desc === comp);
    return rows.length ? rows[rows.length - 1] : null;
}
const waitingForStock = i => UI.p2 && i.status === 'new' && !!(menuById(i.menu_item_id) || {}).uses_stock;
function showShort(res) {
    const sh = res && res.short;
    if (sh && sh.length) toast('Low stock: ' + sh.map(x => `${x.name} short by ${x.qty}`).join(', ') + '. The order went through.', true);
}

function availableViews() {
    const v = [];
    if (canOrder()) { v.push(['order', 'Menu']); v.push(['floor', 'Tables']); }
    if (canKitchen()) v.push(['kitchen', 'Kitchen / Bar']);
    if (UI.p3 && (canCount() || canWaste())) v.push(['stock', 'Stock']);
    if (canCosts() && UI.p2) v.push(['reports', 'Reports']);
    if (canMenu() || canLayout()) v.push(['manage', 'Manage']);
    return v;
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
function scrollSpots() {
    const out = [];
    try {
        let el = root;
        while (el && el !== document.body) {
            const cs = getComputedStyle(el);
            if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) out.push([el, el.scrollTop]);
            el = el.parentElement;
        }
        if (document.scrollingElement) out.push([document.scrollingElement, document.scrollingElement.scrollTop]);
    } catch (e) { }
    return out;
}
function restoreScroll(spots) {
    const go = () => spots.forEach(([el, y]) => { if (el.scrollTop !== y) el.scrollTop = y; });
    go();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
}
const hasRealDom = () => root && root.children !== undefined;

function render() {
    if (!root) return;
    UI.dirty = false;
    if (hasRealDom() && !root.querySelector('#rs-page')) root.innerHTML = '<div id="rs-page"></div><div id="rs-host"></div>';
    renderPage();
    renderSheet();
    syncAlarmUI();
}

function pageHtml() {
    if (UI.error) {
        const missing = /rest_|relation|schema cache/i.test(UI.error);
        return `<div class="rs"><div class="rs-err">${missing
            ? 'The restaurant tables are not in the database yet. Run <b>restaurant-phase1.sql</b> in the Supabase SQL editor, then reload.'
            : 'Could not load: ' + esc(UI.error)}</div></div>`;
    }
    const views = availableViews();
    if (!views.length) return '<div class="rs"><div class="rs-card">Your role does not have restaurant access. Ask the owner to turn it on under Roles.</div></div>';
    if (!UI.view || !views.some(v => v[0] === UI.view)) UI.view = views[0][0];
    if (!UI.zoneId || !D.zones.some(z => z.id === UI.zoneId)) UI.zoneId = D.zones[0]?.id || null;
    const body = UI.view === 'order' ? orderView() : UI.view === 'floor' ? floorView() : UI.view === 'kitchen' ? kitchenView() : UI.view === 'stock' ? stockView() : UI.view === 'reports' ? reportView() : manageView();
    const nav = views.map(([k, l]) => `<button class="rs-tab ${UI.view === k ? 'on' : ''}" data-act="view" data-v="${k}">${l}${k === 'order' && UI.cart.length ? ` (${UI.cart.reduce((s, c) => s + c.qty, 0)})` : ''}</button>`).join('');
    const off = navigator.onLine ? '' : '<div class="rs-offline">No connection. Orders cannot be sent until the internet is back.</div>';
    return `<div class="rs"><div class="rs-bar">${nav}</div>${off}${body}</div>`;
}
function renderPage() {
    const el = hasRealDom() ? root.querySelector('#rs-page') : null;
    const html = pageHtml();
    if (!el) { root.innerHTML = html + (UI.sheet ? `<div class="rs-ov on" data-act="closesheet"><div class="rs-sheet rs">${sheetInner()}</div></div>` : ''); afterRender(); return; }
    const spots = scrollSpots();
    el.innerHTML = html;
    restoreScroll(spots);
    afterRender();
}

// Bottom sheet: slides up, follows the finger when swiped down (same feel as the plan card).
function renderSheet() {
    const host = hasRealDom() ? root.querySelector('#rs-host') : null;
    if (!host) return;
    let ov = host.firstElementChild;
    if (UI.sheet) {
        clearTimeout(UI.closeT);
        const key = UI.sheet.type + ':' + (UI.sheet.id || UI.sheet.tabId || UI.sheet.tableId || '');
        let fresh = false;
        if (!ov) {
            host.innerHTML = '<div class="rs-ov" data-act="closesheet"><div class="rs-sheet rs"><div class="rs-grab"></div><div class="rs-in"></div></div></div>';
            ov = host.firstElementChild; fresh = true;
            setTimeout(() => ov.classList.add('on'), 20);
            bindSheetDrag(ov.querySelector('.rs-sheet'), ov);
        } else ov.classList.add('on');
        const sh = ov.querySelector('.rs-sheet'), inner = ov.querySelector('.rs-in');
        const keep = sh.scrollTop;
        inner.innerHTML = sheetInner();
        sh.scrollTop = (fresh || UI.sheetKey !== key) ? 0 : keep;
        UI.sheetKey = key;
        wireMap();
    } else if (ov) {
        ov.classList.remove('on');
        UI.sheetKey = null;
        UI.closeT = setTimeout(() => { if (!UI.sheet) host.innerHTML = ''; }, 340);
    }
}
function bindSheetDrag(sh, ov) {
    let sy = 0, sx = 0, st = 0, mode = 0;
    sh.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) { mode = -1; return; }
        sy = e.touches[0].clientY; sx = e.touches[0].clientX; st = Date.now();
        const blocked = e.target.closest && e.target.closest('svg.rs-map,input,textarea,select');
        mode = (!blocked && sh.scrollTop <= 0) ? 0 : -1;
    }, { passive: true });
    sh.addEventListener('touchmove', e => {
        if (mode === -1) return;
        const dy = e.touches[0].clientY - sy, dx = e.touches[0].clientX - sx;
        if (mode === 0) {
            if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
            if (dy > 0 && Math.abs(dy) > Math.abs(dx)) { mode = 1; sh.style.transition = 'none'; } else { mode = -1; return; }
        }
        e.preventDefault(); e.stopPropagation();
        const d = Math.max(dy, 0);
        sh.style.transform = 'translateY(' + d + 'px)';
        ov.style.transition = 'none'; ov.style.opacity = String(Math.max(0, 1 - d / Math.max(sh.offsetHeight, 1)));
    }, { passive: false });
    const end = (e, cancelled) => {
        if (mode !== 1) { mode = 0; return; }
        mode = 0;
        const dy = cancelled ? 0 : Math.max(e.changedTouches[0].clientY - sy, 0), v = dy / Math.max(Date.now() - st, 1);
        sh.style.transition = ''; sh.style.transform = ''; ov.style.transition = ''; ov.style.opacity = '';
        if (dy > sh.offsetHeight * 0.3 || (v > 0.5 && dy > 40)) { UI.sheet = null; UI.join = null; render(); }
    };
    sh.addEventListener('touchend', e => end(e, false), { passive: true });
    sh.addEventListener('touchcancel', e => end(e, true), { passive: true });
}

function afterRender() {
    wireMap();
}

// ---------------------------------------------------------------
// Menu / order screen (waiter step 1: pick what they want)
// ---------------------------------------------------------------
function categories() {
    const act = D.menu.filter(m => m.active);
    const cs = [...new Set(act.map(m => m.category || 'General'))].sort();
    return ['All', ...(act.some(m => m.favourite) ? ['Favourites'] : []), ...cs];
}
function filteredMenu() {
    const q = UI.q.trim().toLowerCase();
    return D.menu.filter(m => m.active
        && (UI.cat === 'All' || (UI.cat === 'Favourites' ? m.favourite : (m.category || 'General') === UI.cat))
        && (!q || m.name.toLowerCase().includes(q)))
        .sort((a, b) => (b.favourite ? 1 : 0) - (a.favourite ? 1 : 0) || (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
}
function gridHtml() {
    const list = filteredMenu();
    if (!D.menu.length) return `<div class="rs-card rs-muted">No menu items yet. ${canMenu() ? 'Add them under Manage.' : 'Ask a manager to add the menu.'}</div>`;
    if (!list.length) return '<div class="rs-muted">Nothing matches.</div>';
    return `<div class="rs-grid">${list.map(m => {
        const q = UI.cart.filter(c => c.id === m.id).reduce((s, c) => s + c.qty, 0);
        return `<button class="rs-item" data-act="add" data-id="${m.id}"><b>${esc(m.name)}</b><span>${fmt(m.price)}</span>${q ? `<i class="q" style="font-style:normal">${q}</i>` : ''}</button>`;
    }).join('')}</div>`;
}
function cartHtml() {
    const target = UI.pickTarget;
    let tl = '';
    if (target) {
        const t = target.tableId ? tableById(target.tableId) : null;
        const tab = target.tabId ? tabById(target.tabId) : null;
        tl = `<div class="rs-row" style="margin-bottom:6px"><b>Adding to ${esc(tab ? tabLabel(tab) : t ? t.label : 'table')}</b><span class="rs-sp"></span><button class="rs-btn sm" data-act="clearpick">Change</button></div>`;
    }
    if (!UI.cart.length) return tl ? `<div class="rs-cart">${tl}<div class="rs-muted">Tap items to add them.</div></div>` : '';
    const total = UI.cart.reduce((s, c) => s + c.qty * c.price, 0);
    const lines = UI.cart.map((c, i) => `<div class="rs-line"><div class="n"><b>${esc(c.name)}</b>${c.note ? `<div class="rs-muted">${esc(c.note)}</div>` : ''}</div>
        <div class="rs-qty"><button data-act="dec" data-i="${i}">−</button><span>${c.qty}</span><button data-act="inc" data-i="${i}">+</button></div>
        <button class="rs-btn sm" data-act="cartnote" data-i="${i}">Note</button></div>`).join('');
    return `<div class="rs-cart">${tl}${lines}
        <div class="rs-row" style="margin-top:8px"><b>${fmt(total)}</b><span class="rs-sp"></span>
        <button class="rs-btn" data-act="clearcart">Clear</button>
        <button class="rs-btn pri" data-act="send">${UI.pickTarget ? 'Send' : 'Choose table'}</button></div></div>`;
}
function orderView() {
    const chips = categories().map(c => `<button class="rs-chip ${UI.cat === c ? 'on' : ''}" data-act="cat" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    return `<input data-bind="q" value="${esc(UI.q)}" placeholder="Search the menu" style="width:100%">
        <div class="rs-chips">${chips}</div>
        <div id="rs-grid">${gridHtml()}</div>
        <div id="rs-cart">${cartHtml()}</div>`;
}
function updateOrderParts() {
    const g = root.querySelector('#rs-grid'), c = root.querySelector('#rs-cart');
    if (g) g.innerHTML = gridHtml();
    if (c) c.innerHTML = cartHtml();
    const tab = root.querySelector('.rs-tab[data-v="order"]');
    if (tab) tab.textContent = 'Menu' + (UI.cart.length ? ` (${UI.cart.reduce((s, x) => s + x.qty, 0)})` : '');
}

// ---------------------------------------------------------------
// Floor map (SVG, no library). Pinch / wheel to zoom, drag to pan.
// Service mode: tap only. Edit layout (managers): drag tables.
// ---------------------------------------------------------------
// Tables are round. A table can be joined to its neighbours (magnet), and the joined
// tables are drawn as one longer ellipse with every table number on it.
const DIAM = 80;
const tw = x => Number(x.width) || DIAM;
const th = x => Number(x.height) || DIAM;
const clampScale = s => Math.min(5, Math.max(0.2, s));

function membersOf(tableId) {
    const t = tableById(tableId);
    if (!t) return [];
    if (!t.join_group) return [t];
    return D.tables.filter(x => x.join_group === t.join_group);
}
const unitKeyOf = ms => ms.map(m => m.id).sort()[0];
function unitLabelOf(ms) {
    return ms.slice().sort((a, b) => a.x - b.x || a.y - b.y).map(m => m.label).join(' + ');
}
function layoutUnits(zoneId) {
    const seen = new Set(), out = [];
    D.tables.filter(t => t.zone_id === zoneId).forEach(t => {
        if (seen.has(t.id)) return;
        const ms = membersOf(t.id).filter(m => m.zone_id === zoneId);
        ms.forEach(m => seen.add(m.id));
        const x0 = Math.min(...ms.map(m => m.x)), y0 = Math.min(...ms.map(m => m.y));
        const x1 = Math.max(...ms.map(m => m.x + tw(m))), y1 = Math.max(...ms.map(m => m.y + th(m)));
        out.push({ key: unitKeyOf(ms), ms, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, label: unitLabelOf(ms) });
    });
    return out;
}
const unitByKey = (zoneId, key) => layoutUnits(zoneId).find(u => u.key === key);
function allUnits() {
    const out = [];
    D.zones.forEach(z => layoutUnits(z.id).forEach(u => out.push(u)));
    return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

// ----- camera: screen = world * s + (x, y). Pan and zoom are exact, anchored on the fingers.
function fitCam(zoneId, W, H) {
    const us = layoutUnits(zoneId);
    if (!us.length) return { s: 1, x: W / 2 - 150, y: H / 2 };
    const x0 = Math.min(...us.map(u => u.x0)) - 50, y0 = Math.min(...us.map(u => u.y0)) - 50;
    const x1 = Math.max(...us.map(u => u.x1)) + 50, y1 = Math.max(...us.map(u => u.y1)) + 50;
    const bw = x1 - x0, bh = y1 - y0;
    const s = Math.min(1.6, clampScale(Math.min(W / bw, H / bh)));
    return { s, x: (W - bw * s) / 2 - x0 * s, y: (H - bh * s) / 2 - y0 * s };
}
function getCam(zoneId) {
    if (UI.cam && UI.camZone === zoneId) return UI.cam;
    let c = null;
    try { c = JSON.parse(localStorage.getItem(`rs_cam_${ctx.tenantId}_${zoneId}`) || 'null'); } catch (e) { }
    UI.camAuto = !(c && c.s);
    UI.cam = c && c.s ? c : fitCam(zoneId, 360, 420);
    UI.camZone = zoneId;
    return UI.cam;
}
function saveCam() { try { localStorage.setItem(`rs_cam_${ctx.tenantId}_${UI.camZone}`, JSON.stringify(UI.cam)); } catch (e) { } }

function mapInner(zoneId) {
    const us = layoutUnits(zoneId), cam = UI.cam || getCam(zoneId);
    if (!us.length) return '<text x="150" y="0" text-anchor="middle" fill="#888" font-size="16">No tables in this zone yet</text>';
    const detail = cam.s > 1.2;
    return us.map(u => {
        const t = u.ms[0], st = tableStatus(t), tab = tabForTable(t.id);
        const cls = [st];
        if ((UI.edit && UI.sel === u.key) || (UI.join && tab && tab.id === UI.join.tabId)) cls.push('sel');
        if (UI.drag && UI.drag.key === u.key) cls.push('held');
        if (UI.magnet === u.key) cls.push('magnet');
        const sub = detail && tab ? `<text class="s" x="${u.cx}" y="${u.cy + 16}">${fmt(tabAmount(tab.id))} · ${mins(tab.opened_at)}m</text>` : '';
        let label;
        if (u.ms.length > 1 && u.h > u.w * 1.25) {
            const ls = u.ms.slice().sort((a, b) => a.y - b.y || a.x - b.x).map(m => m.label);
            const y0 = u.cy - (ls.length - 1) * 10;
            label = ls.map((l, k) => `<text x="${u.cx}" y="${y0 + k * 20}">${esc(l)}</text>`).join('');
        } else label = `<text x="${u.cx}" y="${detail && tab ? u.cy - 6 : u.cy}">${esc(u.label)}</text>`;
        return `<g class="rs-t ${cls.join(' ')}" data-uid="${u.key}"><ellipse cx="${u.cx}" cy="${u.cy}" rx="${u.w / 2}" ry="${u.h / 2}"/>${label}${sub}</g>`;
    }).join('');
}
function camAttr(c) { return `translate(${c.x} ${c.y}) scale(${c.s})`; }
function mapHtml(zoneId) {
    const c = getCam(zoneId);
    return `<div class="rs-mapwrap"><svg class="rs-map" data-zone="${zoneId}"><g class="rs-cam" transform="${camAttr(c)}">${mapInner(zoneId)}</g></svg></div>`;
}
const LEGEND = `<div class="rs-legend"><span><i class="rs-dot" style="background:#EDF0EC;border:1px solid #b9c2b8"></i>Free</span><span><i class="rs-dot" style="background:#FCEEDD;border:1px solid #C97A22"></i>Ordered</span><span><i class="rs-dot" style="background:#DDF1E6;border:1px solid #3E9B78"></i>Food ready</span><span><i class="rs-dot" style="background:#E6E3F7;border:1px solid #6a5fc0"></i>Bill requested</span></div>`;

// Magnet: while a table (or joined group) is dragged, snap it flush against a neighbour
// (so it can join) or line it up straight with the others.
function magnetSnap(zoneId, key) {
    const us = layoutUnits(zoneId), me = us.find(u => u.key === key);
    if (!me) return { dx: 0, dy: 0, join: null };
    const others = us.filter(u => u.key !== key), s = UI.cam.s;
    const JOIN = 26 / s, ALIGN = 14 / s;
    let best = null;
    const offer = (d, dx, dy, join) => { if (!best || d < best.d) best = { d, dx, dy, join }; };
    for (const o of others) {
        const dyc = o.cy - me.cy, dxc = o.cx - me.cx;
        if (Math.abs(dyc) < Math.max(me.h, o.h) * 0.45) {
            const gR = o.x0 - me.x1, gL = me.x0 - o.x1;
            if (Math.abs(gR) <= JOIN) offer(Math.abs(gR) + Math.abs(dyc) * 0.5, gR, dyc, o.key);
            if (Math.abs(gL) <= JOIN) offer(Math.abs(gL) + Math.abs(dyc) * 0.5, -gL, dyc, o.key);
        }
        if (Math.abs(dxc) < Math.max(me.w, o.w) * 0.45) {
            const gB = o.y0 - me.y1, gT = me.y0 - o.y1;
            if (Math.abs(gB) <= JOIN) offer(Math.abs(gB) + Math.abs(dxc) * 0.5, dxc, gB, o.key);
            if (Math.abs(gT) <= JOIN) offer(Math.abs(gT) + Math.abs(dxc) * 0.5, dxc, -gT, o.key);
        }
    }
    if (best) return { dx: best.dx, dy: best.dy, join: best.join };
    let dx = 0, dy = 0, bx = ALIGN, by = ALIGN;
    for (const o of others) {
        for (const a of [o.cx - me.cx, o.x0 - me.x0, o.x1 - me.x1]) if (Math.abs(a) < bx) { bx = Math.abs(a); dx = a; }
        for (const b of [o.cy - me.cy, o.y0 - me.y0, o.y1 - me.y1]) if (Math.abs(b) < by) { by = Math.abs(b); dy = b; }
    }
    return { dx, dy, join: null };
}

function wireMap() {
    root.querySelectorAll('svg.rs-map').forEach(svg => { if (!svg._rsWired) { svg._rsWired = true; wireOne(svg); } });
}
function wireOne(svg) {
    const zoneId = svg.dataset.zone;
    const g = svg.querySelector('.rs-cam');
    const apply = () => g.setAttribute('transform', camAttr(UI.cam));
    const redraw = () => { g.innerHTML = mapInner(zoneId); };
    if (UI.camAuto && svg.clientWidth) { UI.cam = fitCam(zoneId, svg.clientWidth, svg.clientHeight); apply(); redraw(); }
    const local = e => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const unitAt = e => { const el = e.target.closest && e.target.closest('[data-uid]'); return el ? el.dataset.uid : null; };
    const zoomAt = (p, factor) => {
        const wx = (p.x - UI.cam.x) / UI.cam.s, wy = (p.y - UI.cam.y) / UI.cam.s, s = clampScale(UI.cam.s * factor);
        UI.cam = { s, x: p.x - wx * s, y: p.y - wy * s };
        apply();
    };
    // keep the page from scrolling while a finger is on the map
    svg.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    svg.addEventListener('contextmenu', e => e.preventDefault());

    const P = new Map();
    let g1 = null, pinch = null, drag = null, holdT = null, lastTap = { t: 0, x: 0, y: 0 };
    const cancelHold = () => { clearTimeout(holdT); holdT = null; };

    // While a table is held, only that one SVG group is moved (a transform), nothing is redrawn.
    // It follows the finger exactly; the "snap" part (grid / magnet) glides in over a few frames.
    let ease = null;
    function paintHeld() { if (ease) ease.el.setAttribute('transform', `translate(${ease.fx + ease.cx} ${ease.fy + ease.cy})`); }
    function easeStep() {
        if (!ease) return;
        ease.raf = 0;
        ease.cx += (ease.tx - ease.cx) * 0.4; ease.cy += (ease.ty - ease.cy) * 0.4;
        const done = Math.abs(ease.tx - ease.cx) < 0.05 && Math.abs(ease.ty - ease.cy) < 0.05;
        if (done) { ease.cx = ease.tx; ease.cy = ease.ty; }
        paintHeld();
        if (!done) ease.raf = requestAnimationFrame(easeStep);
    }
    function stopEase() { if (ease && ease.raf) cancelAnimationFrame(ease.raf); ease = null; }
    function paintMagnet() {
        g.querySelectorAll('.magnet').forEach(n => { if (n.dataset.uid !== UI.magnet) n.classList.remove('magnet'); });
        if (UI.magnet) { const n = g.querySelector('[data-uid="' + UI.magnet + '"]'); if (n) n.classList.add('magnet'); }
    }

    function beginDrag() {
        const u = unitByKey(zoneId, g1.key);
        if (!u) return;
        stopEase();
        drag = { key: u.key, ids: u.ms.map(m => m.id), base: u.ms.map(m => ({ id: m.id, x: m.x, y: m.y })) };
        UI.drag = { key: u.key }; UI.sel = u.key;
        try { if (navigator.vibrate) navigator.vibrate(35); } catch (e) { }
        redraw();   // once: draws the "held" look
        const el = g.querySelector('[data-uid="' + u.key + '"]');
        if (el) { g.appendChild(el); ease = { el, fx: 0, fy: 0, cx: 0, cy: 0, tx: 0, ty: 0, raf: 0 }; }   // appended last = drawn above its neighbours
    }
    function moveDrag(dxw, dyw) {
        drag.base.forEach(b => { const m = tableById(b.id); m.x = b.x + dxw; m.y = b.y + dyw; });
        const sn = magnetSnap(zoneId, drag.key);
        let ax = sn.dx, ay = sn.dy;
        if (!sn.join && !ax) { const m0 = tableById(drag.ids[0]); ax = Math.round(m0.x / 10) * 10 - m0.x; }
        if (!sn.join && !ay) { const m0 = tableById(drag.ids[0]); ay = Math.round(m0.y / 10) * 10 - m0.y; }
        drag.ids.forEach(id => { const m = tableById(id); m.x += ax; m.y += ay; });
        UI.magnet = sn.join;
        if (ease) {
            ease.fx = dxw; ease.fy = dyw; ease.tx = ax; ease.ty = ay;
            paintHeld();
            if (!ease.raf && (ease.cx !== ease.tx || ease.cy !== ease.ty)) ease.raf = requestAnimationFrame(easeStep);
        }
        paintMagnet();
    }
    function abortDrag() {
        stopEase();
        drag.base.forEach(b => { const m = tableById(b.id); m.x = b.x; m.y = b.y; });
        drag = null; UI.drag = null; UI.magnet = null; redraw();
    }
    async function endDrag() {
        const d = drag; drag = null; UI.drag = null;
        const join = UI.magnet; UI.magnet = null;
        UI.mutedTablesUntil = Date.now() + 4000;   // ignore the live-update echo of our own move
        stopEase();
        redraw();   // drop at once: the table is already where it belongs, the save happens behind it
        const moved = d.base.some(b => { const m = tableById(b.id); return m.x !== b.x || m.y !== b.y; });
        let key = d.key;
        try {
            if (moved) await Promise.all(d.ids.map(id => { const m = tableById(id); return db(sb().from('rest_tables').update({ x: Math.round(m.x), y: Math.round(m.y) }).eq('id', id)); }));
            if (join && UI.joinCol) {
                const o = unitByKey(zoneId, join);
                const tabsInvolved = new Set([...d.ids, ...o.ms.map(m => m.id)].map(id => { const tb = tabForTable(id); return tb ? tb.id : null; }).filter(Boolean));
                if (tabsInvolved.size > 1) toast('Both have open tabs. Close or merge one first, then join.', true);
                else {
                    const gid = o.ms[0].join_group || uid();
                    const ids = [...d.ids, ...o.ms.map(m => m.id)];
                    await db(sb().from('rest_tables').update({ join_group: gid }).in('id', ids));
                    ids.forEach(id => { tableById(id).join_group = gid; });
                    key = unitKeyOf(ids.map(id => tableById(id)));
                    toast('Joined: ' + unitLabelOf(ids.map(id => tableById(id))));
                }
            }
        } catch (e) { await load(); }
        UI.sel = key; render();
    }

    svg.addEventListener('pointerdown', e => {
        try { svg.setPointerCapture(e.pointerId); } catch (er) { }
        const p = local(e);
        P.set(e.pointerId, p);
        if (P.size === 2) {
            cancelHold(); if (drag) abortDrag();
            const [a, b] = [...P.values()], mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: UI.cam.s, wx: (mid.x - UI.cam.x) / UI.cam.s, wy: (mid.y - UI.cam.y) / UI.cam.s };
            g1 = null; return;
        }
        if (P.size > 2) return;
        const key = unitAt(e);
        g1 = { key, start: p, cam: { ...UI.cam }, moved: false, type: e.pointerType, armed: false };
        if (UI.edit && key && canLayout()) {
            if (e.pointerType === 'mouse') g1.armed = true;                       // mouse: drag at once
            else holdT = setTimeout(() => { if (g1 && !g1.moved) beginDrag(); }, 380); // touch: press and hold
        }
    });
    svg.addEventListener('pointermove', e => {
        if (!P.has(e.pointerId)) return;
        const p = local(e);
        P.set(e.pointerId, p);
        if (pinch && P.size >= 2) {
            const [a, b] = [...P.values()], mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const s = clampScale(pinch.s0 * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinch.d0);
            UI.cam = { s, x: mid.x - pinch.wx * s, y: mid.y - pinch.wy * s };
            apply(); return;
        }
        if (!g1) return;
        const dx = p.x - g1.start.x, dy = p.y - g1.start.y;
        if (!g1.moved && Math.hypot(dx, dy) > (g1.type === 'mouse' ? 3 : 8)) {
            g1.moved = true;
            if (g1.armed) beginDrag(); else if (!drag) cancelHold();
        }
        if (!g1.moved && !drag) return;
        if (drag) { moveDrag(dx / UI.cam.s, dy / UI.cam.s); return; }
        UI.cam = { s: g1.cam.s, x: g1.cam.x + dx, y: g1.cam.y + dy }; // one to one with the finger
        apply();
    });
    const end = e => {
        if (!P.has(e.pointerId)) return;
        P.delete(e.pointerId); cancelHold();
        if (pinch) { if (P.size < 2) { pinch = null; saveCam(); redraw(); } return; }
        const gg = g1; g1 = null;
        if (drag) { endDrag(); return; }
        if (!gg) return;
        if (!gg.moved) {
            if (gg.key) { onTableTap(gg.key); return; }
            const now = Date.now(), p = local(e);
            if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { zoomAt(p, 2); saveCam(); redraw(); lastTap = { t: 0, x: 0, y: 0 }; }
            else lastTap = { t: now, x: p.x, y: p.y };
        } else { saveCam(); redraw(); }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', e => { if (drag) abortDrag(); end(e); });
    svg.addEventListener('wheel', e => {
        e.preventDefault();
        zoomAt(local(e), e.deltaY < 0 ? 1.12 : 1 / 1.12);
        clearTimeout(svg._wt); svg._wt = setTimeout(() => { saveCam(); redraw(); }, 150);
    }, { passive: false });
}

function onTableTap(tid) {
    const t = tableById(tid);
    if (!t) return;
    if (UI.edit && canLayout()) { UI.sel = unitKeyOf(membersOf(tid)); render(); return; }
    if (UI.join) { joinTap(t); return; }
    if (UI.sheet && UI.sheet.type === 'pick') { sendCart({ tableId: t.id }); return; }
    if (UI.sheet && UI.sheet.type === 'move') { moveTab(UI.sheet.tabId, t); return; }
    const tab = tabForTable(tid);
    UI.sheet = { type: 'table', tableId: tid, tabId: tab ? tab.id : null };
    render();
}

function zoneChips() {
    return D.zones.map(z => `<button class="rs-chip ${UI.zoneId === z.id ? 'on' : ''}" data-act="zone" data-id="${z.id}">${esc(z.name)}</button>`).join('');
}

function floorView() {
    if (!D.zones.length) {
        return `<div class="rs-card">No floor yet. ${canLayout() ? 'Go to <b>Manage</b> to add a zone and tables.' : 'Ask a manager to set up the tables.'}</div>`;
    }
    const join = UI.join ? `<div class="rs-offline" style="background:#E6E3F7;color:#3b3380;border-color:#c9c3ee"><b>Joining tables:</b> tap the tables to add to ${esc(tabLabel(tabById(UI.join.tabId) || {}))}. <button class="rs-btn sm pri" data-act="join-done">Done</button></div>` : '';
    const quick = D.tabs.filter(t => !tablesOfTab(t.id).length).map(t => `<button class="rs-chip" data-act="tab-open" data-id="${t.id}">${esc(t.label || 'Tab')} · ${fmt(tabAmount(t.id))}</button>`).join('');
    let body;
    if (UI.list) {
        const rows = D.tabs.map(tab => `<tr data-act="tab-open" data-id="${tab.id}" style="cursor:pointer"><td><b>${esc(tabLabel(tab))}</b></td><td>${mins(tab.opened_at)}m</td><td style="text-align:right">${fmt(tabAmount(tab.id))}</td></tr>`).join('');
        body = `<div class="rs-card">${rows ? `<table class="rs-tbl">${rows}</table>` : '<span class="rs-muted">No open tabs.</span>'}</div>`;
    } else body = LEGEND + mapHtml(UI.zoneId);
    let edit = '';
    if (UI.edit && canLayout()) {
        const u = UI.sel ? unitByKey(UI.zoneId, UI.sel) : null;
        let sel;
        if (!u) sel = '<div class="rs-muted" style="margin-top:8px">Tap a table to edit it.</div>';
        else if (u.ms.length === 1) sel = `<div class="rs-row" style="margin-top:10px"><label>Name <input data-f="label" value="${esc(u.ms[0].label)}" size="8"></label><button class="rs-btn sm" data-act="dup">Duplicate</button><button class="rs-btn sm dan" data-act="deltable">Delete</button></div>`;
        else sel = `<div class="rs-row" style="margin-top:10px"><b>${esc(u.label)}</b><span class="rs-muted">joined</span><button class="rs-btn sm" data-act="unjoin">Separate</button></div>`;
        edit = `<div class="rs-card" style="margin-top:10px"><div class="rs-row"><button class="rs-btn pri" data-act="addtable">+ Table</button><button class="rs-btn" data-act="addzone">+ Zone</button><button class="rs-btn" data-act="renamezone">Rename zone</button></div>
        <div class="rs-muted" style="margin-top:6px">Press and hold a table, feel the buzz, then drag it. Bring tables side by side to join them.</div>
        ${sel}${UI.undo ? `<div class="rs-row" style="margin-top:8px"><span>Deleted ${esc(UI.undo.label)}</span><button class="rs-btn sm" data-act="undo">Undo</button></div>` : ''}</div>`;
    }
    return `${join}<div class="rs-row"><div class="rs-chips" style="margin:0;flex:1">${zoneChips()}</div>
        <button class="rs-btn sm" data-act="listtoggle">${UI.list ? 'Map' : 'List'}</button>
        <button class="rs-btn sm" data-act="fit">Fit all</button>
        ${canLayout() ? `<button class="rs-btn sm ${UI.edit ? 'pri' : ''}" data-act="edittoggle">${UI.edit ? 'Done editing' : 'Edit layout'}</button>` : ''}</div>
        ${body}${edit}
        <div class="rs-row" style="margin-top:10px"><button class="rs-btn sm" data-act="quicktab">+ Quick tab</button><button class="rs-btn sm" data-act="temptable">+ Temporary table</button>${quick}</div>`;
}

// ---------------------------------------------------------------
// Bottom sheets: table picker, table / tab, bill, move, menu item
// ---------------------------------------------------------------
function sheetInner() {
    const sh = UI.sheet;
    if (!sh) return '';
    if (sh.type === 'pick') return pickSheet();
    if (sh.type === 'table') return tableSheet();
    if (sh.type === 'bill') return billSheet();
    if (sh.type === 'move') return moveSheet();
    if (sh.type === 'menuedit') return menuEditSheet();
    if (sh.type === 'unit') return unitSheet();
    if (sh.type === 'waste') return wasteSheet();
    return '';
}

function statusWord(t) {
    const s = tableStatus(t);
    return { free: 'free', seated: 'seated', served: 'served', ordered: 'ordered', ready: 'food ready', bill: 'bill requested' }[s];
}
function pickChips() {
    const q = (UI.pickq || '').trim().toLowerCase();
    return allUnits().filter(u => !q || u.label.toLowerCase().includes(q))
        .map(u => `<button class="rs-chip" data-act="pick-table" data-id="${u.key}">${esc(u.label)} <span class="rs-muted">${statusWord(u.ms[0])}</span></button>`).join('') || '<span class="rs-muted">No table matches.</span>';
}
function pickSheet() {
    const opts = allUnits().map(u => `<option value="${u.key}">${esc(u.label)} (${statusWord(u.ms[0])})</option>`).join('');
    const total = UI.cart.reduce((s, c) => s + c.qty * c.price, 0);
    return `<h3>Which table? <span class="rs-muted">${fmt(total)}</span></h3>
        <input data-bind="pickq" value="${esc(UI.pickq || '')}" placeholder="Search table or number" style="width:100%">
        <div class="rs-chips" id="rs-pickchips" style="flex-wrap:wrap;overflow:visible">${pickChips()}</div>
        <div class="rs-row" style="margin:6px 0"><select data-act="pick-select" style="flex:1"><option value="">Or choose from the list…</option>${opts}</select></div>
        <div class="rs-row" style="margin:6px 0"><input id="rs-qname" placeholder="Quick tab name (e.g. Bar stool 3)" style="flex:1"><button class="rs-btn" data-act="pick-quick">Send</button></div>
        <div class="rs-row" style="margin:6px 0"><button class="rs-btn sm" data-act="pickmap">${UI.pickMap ? 'Hide floor map' : 'Show floor map'}</button><button class="rs-btn sm" data-act="temptable">+ Temporary table</button></div>
        ${UI.pickMap ? `<div class="rs-chips">${zoneChips()}</div>${mapHtml(UI.zoneId)}` : ''}
        <div class="rs-row" style="margin-top:10px"><button class="rs-btn" data-act="closesheet-btn">Cancel</button></div>`;
}

function itemRow(i) {
    const acts = [];
    if (i.status === 'ready') acts.push(`<button class="rs-btn sm pri" data-act="serve" data-id="${i.id}">Served</button>`);
    if (i.status === 'new' || canVoidSent()) if (i.status !== 'void' && !i.paid) acts.push(`<button class="rs-btn sm" data-act="void" data-id="${i.id}">Void</button>`);
    const who = [i.added_by ? 'Ordered by ' + esc(i.added_by) : '', i.ready_by ? (i.station === 'bar' ? 'Poured' : 'Prepared') + ' by ' + esc(i.ready_by) : '', i.served_by ? 'Served by ' + esc(i.served_by) : '', i.status === 'void' && i.voided_by ? 'Voided by ' + esc(i.voided_by) + (i.void_reason ? ': ' + esc(i.void_reason) : '') : ''].filter(Boolean).join(' · ');
    return `<tr><td>${i.qty} × ${esc(i.name)}${i.note ? `<div class="rs-muted">${esc(i.note)}</div>` : ''}${who ? `<div class="rs-muted">${who}</div>` : ''}</td>
        <td><span class="rs-st ${i.status}">${i.paid ? 'paid' : i.status}</span></td><td style="text-align:right">${fmt(i.qty * i.unit_price)}</td><td>${acts.join(' ')}</td></tr>`;
}
function tableSheet() {
    const sh = UI.sheet;
    const t = sh.tableId ? tableById(sh.tableId) : null;
    const tab = sh.tabId ? tabById(sh.tabId) : (t ? tabForTable(t.id) : null);
    if (!tab) {
        if (!t) return '<div class="rs-muted">This table is gone.</div><button class="rs-btn" data-act="closesheet-btn">Close</button>';
        return `<h3>${esc(t.label)} <span class="rs-st">free</span></h3>
            <div class="rs-row"><button class="rs-btn pri" data-act="startorder" data-id="${t.id}">Start order</button><button class="rs-btn" data-act="closesheet-btn">Close</button></div>`;
    }
    const its = itemsOf(tab.id).filter(i => i.status !== 'void' || !i.paid);
    const live = liveItems(tab.id);
    const tabs = tablesOfTab(tab.id);
    return `<h3>${esc(tabLabel(tab))} <span class="rs-muted">${mins(tab.opened_at)} min</span></h3>
        ${its.length ? `<table class="rs-tbl">${its.map(itemRow).join('')}</table>` : '<div class="rs-muted">Nothing ordered yet.</div>'}
        <div class="rs-row" style="margin:10px 0"><b>To pay: ${fmt(tabAmount(tab.id))}</b></div>
        <div class="rs-row">
          <button class="rs-btn pri" data-act="addmore" data-id="${tab.id}">Add items</button>
          ${live.length ? `<button class="rs-btn" data-act="bill" data-id="${tab.id}">Bill</button>
          <button class="rs-btn" data-act="reqbill" data-id="${tab.id}">${tab.bill_requested ? 'Cancel bill request' : 'Bill requested'}</button>` : `<button class="rs-btn" data-act="closeempty" data-id="${tab.id}">Close empty tab</button>`}
        </div>
        <div class="rs-row" style="margin-top:8px">
          ${tabs.length ? `<button class="rs-btn sm" data-act="move" data-id="${tab.id}">Move tab</button>` : ''}
          ${canJoin() && tabs.length ? `<button class="rs-btn sm" data-act="join" data-id="${tab.id}">Join tables</button>` : ''}
          ${canJoin() && tabs.length > 1 ? tabs.map(x => `<button class="rs-btn sm" data-act="separate" data-id="${tab.id}" data-t="${x.id}">Separate ${esc(x.label)}</button>`).join('') : ''}
          <span class="rs-sp"></span><button class="rs-btn" data-act="closesheet-btn">Close</button>
        </div>`;
}

function billChannels() {
    const codes = ctx.channelAccountCodes || (typeof CHANNEL_ACCOUNT_CODES !== 'undefined' ? CHANNEL_ACCOUNT_CODES : { Cash: '1010' });
    return Object.keys(codes).filter(k => !/receivable|payable/i.test(k));
}
function billSheet() {
    const tab = tabById(UI.sheet.tabId);
    if (!tab) return '<div class="rs-muted">This tab is already closed.</div><button class="rs-btn" data-act="closesheet-btn">Close</button>';
    const B = UI.bill;
    const lines = unpaidItems(tab.id);
    const sub = lines.filter(i => B.sel.has(i.id)).reduce((s, i) => s + i.qty * i.unit_price, 0);
    const svc = round2(sub * (Number(B.svc) || 0) / 100);
    const rows = lines.map(i => waitingForStock(i)
        ? `<tr style="opacity:.6"><td><input type="checkbox" disabled></td><td>${i.qty} × ${esc(i.name)} <span class="rs-st new">waiting for Ready</span></td><td style="text-align:right">${fmt(i.qty * i.unit_price)}</td></tr>`
        : `<tr><td><input type="checkbox" data-act="billsel" data-id="${i.id}" ${B.sel.has(i.id) ? 'checked' : ''}></td><td>${i.qty} × ${esc(i.name)}</td><td style="text-align:right">${fmt(i.qty * i.unit_price)}</td></tr>`).join('');
    const chans = billChannels().map(c => `<option ${B.chan === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
    return `<h3>Bill: ${esc(tabLabel(tab))}</h3>
        <div class="rs-muted" style="margin-bottom:6px">Untick items to leave them for later (split bill).</div>
        <table class="rs-tbl">${rows}</table>
        <div class="rs-row" style="margin:10px 0"><label>Service charge % <input data-bind="svc" type="number" min="0" step="0.5" value="${B.svc}" style="width:80px"></label>
          <label>Paid by <select data-bind="chan">${chans}</select></label></div>
        <div id="rs-billtotals">${billTotals(sub, svc)}</div>
        <div class="rs-row" style="margin-top:10px"><button class="rs-btn pri" data-act="pay">Pay selected</button><button class="rs-btn" data-act="closesheet-btn">Back</button></div>`;
}
function billTotals(sub, svc) {
    return `<table class="rs-tbl"><tr><td>Items</td><td style="text-align:right">${fmt(sub)}</td></tr><tr><td>Service charge</td><td style="text-align:right">${fmt(svc)}</td></tr><tr><td><b>Total</b></td><td style="text-align:right"><b>${fmt(sub + svc)}</b></td></tr></table>`;
}
function updateBillTotals() {
    const tab = tabById(UI.sheet && UI.sheet.tabId); const el = root.querySelector('#rs-billtotals');
    if (!tab || !el) return;
    const sub = unpaidItems(tab.id).filter(i => UI.bill.sel.has(i.id)).reduce((s, i) => s + i.qty * i.unit_price, 0);
    el.innerHTML = billTotals(sub, round2(sub * (Number(UI.bill.svc) || 0) / 100));
}

function moveSheet() {
    const tab = tabById(UI.sheet.tabId);
    return `<h3>Move ${esc(tab ? tabLabel(tab) : 'tab')} to another table</h3>
        <div class="rs-muted">Tap a free table on the map.</div>
        <div class="rs-chips">${zoneChips()}</div>${mapHtml(UI.zoneId)}
        <div class="rs-row" style="margin-top:10px"><button class="rs-btn" data-act="closesheet-btn">Cancel</button></div>`;
}

// Cost, profit and margin of one serving (oldest stock first)
function costCardHtml(d, price) {
    if (!canCosts()) return '';
    const c = d.lines.reduce((s, l) => s + (l.stock_item_id ? fifoCost(l.stock_item_id, Number(l.qty) || 0) : 0), 0)
        || (d.link && !d.lines.length ? fifoCost(d.link, 1) : 0);
    if (!(c > 0)) return '';
    return `<div class="rs-card" style="margin-top:8px;background:var(--bg)"><div class="rs-row"><span>Cost <b>${fmt(c)}</b></span><span>Profit <b>${fmt(price - c)}</b></span><span>Margin <b>${pct(price - c, price) || '-'}</b></span></div><div class="rs-muted">Per serving, oldest stock first (FIFO). New ingredients with no stock yet count as 0 until you purchase them.</div></div>`;
}
function updateCostLine() {
    const el = root.querySelector('#rs-costline'), pr = root.querySelector('#rs-m-price');
    if (el && UI.sheet && UI.sheet.draft) el.innerHTML = costCardHtml(UI.sheet.draft, parseFloat(pr && pr.value) || 0);
}
function menuEditSheet() {
    const sh = UI.sheet;
    const m = sh.id ? menuById(sh.id) : {};
    if (!sh.draft) sh.draft = { f: null, lines: recipeLines(m.id || '').map(r => ({ stock_item_id: r.stock_item_id, name: invName(r.stock_item_id), qty: r.qty, newUnit: '' })), link: m.stock_item_id || '', linkName: m.stock_item_id ? invName(m.stock_item_id) : '', linkUnit: 'piece' };
    const d = sh.draft, f = d.f || {};
    const v = (k, def) => (f[k] !== undefined ? f[k] : def);
    const cats = [...new Set(D.menu.map(x => x.category || 'General'))].map(c => `<option value="${esc(c)}">`).join('');
    const stockOpts = sel => '<option value="">Choose stock item…</option>' + invItems().map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.desc)}</option>`).join('');
    let recipe = '';
    const noPrep = !!v('no_prep', !!m.no_prep);
    if (UI.p2 && canMenu()) {
        const price = parseFloat(v('price', m.price)) || 0;
        const list = `<datalist id="rs-stock-list">${invItems().map(x => `<option value="${esc(x.desc)}">`).join('')}</datalist>`;
        if (noPrep) {
            const isNewLink = !d.link && String(d.linkName || '').trim();
            recipe = `<div class="rs-card" style="margin-top:10px"><b>Bottled or packed item sold as it is</b>
                <div class="rs-muted">Link it to one stock item: each one sold takes 1 from stock. Leave empty if you do not track its stock.</div>${list}
                <div class="rs-row" style="margin-top:6px"><input data-bind="linkname" list="rs-stock-list" placeholder="Search, or type a new item" value="${esc(d.linkName || '')}" style="flex:1;min-width:120px">
                ${isNewLink ? `<select data-act="link-newunit" style="width:92px"><option value="piece" ${d.linkUnit === 'piece' ? 'selected' : ''}>pieces</option><option value="ml" ${d.linkUnit === 'ml' ? 'selected' : ''}>ml</option><option value="g" ${d.linkUnit === 'g' ? 'selected' : ''}>g</option></select>` : ''}</div>
                ${isNewLink ? '<div class="rs-muted" style="margin-top:4px">New item: it will be added to your inventory (category Ingredients).</div>' : ''}
                <div id="rs-costline">${costCardHtml(d, price)}</div></div>`;
        } else {
            const rows = d.lines.map((l, k) => {
                const isNew = !l.stock_item_id && String(l.name || '').trim();
                return `<div class="rs-row" style="margin:4px 0">
                <input data-bind="rcpname" data-i="${k}" list="rs-stock-list" placeholder="Search, or type a new ingredient" value="${esc(l.name || '')}" style="flex:1;min-width:120px">
                <input data-bind="rcpqty" data-i="${k}" type="number" min="1" step="1" placeholder="Qty" value="${l.qty ?? ''}" style="width:70px">
                ${l.stock_item_id ? `<span class="rs-muted" style="width:34px">${unitOf(l.stock_item_id)}</span>`
                    : isNew ? `<select data-act="rcp-newunit" data-i="${k}" style="width:92px"><option value="">Unit…</option><option value="ml" ${l.newUnit === 'ml' ? 'selected' : ''}>ml</option><option value="g" ${l.newUnit === 'g' ? 'selected' : ''}>g</option><option value="piece" ${l.newUnit === 'piece' ? 'selected' : ''}>pieces</option></select>` : '<span style="width:34px"></span>'}
                <button class="rs-btn sm" data-act="rcp-del" data-i="${k}">✕</button></div>${isNew ? '<div class="rs-muted" style="margin:-2px 0 4px">New ingredient: it will be added to your inventory (category Ingredients).</div>' : ''}`;
            }).join('');
            recipe = `<div class="rs-card" style="margin-top:10px"><b>What one serving uses</b>
                <div class="rs-muted">Whole numbers in the stock unit (ml, g or pieces). Stock is taken when the kitchen or bar taps Ready.</div>${list}
                ${rows}<button class="rs-btn sm" data-act="rcp-add" style="margin-top:6px">+ Ingredient</button>
                <div id="rs-costline">${costCardHtml(d, price)}</div></div>`;
        }
    }
    return `<h3>${m.id ? 'Edit' : 'New'} menu item</h3>
        <div style="display:grid;gap:8px">
        <input id="rs-m-name" placeholder="Name (e.g. Mojito)" value="${esc(v('name', m.name || ''))}">
        <input id="rs-m-cat" list="rs-cats" placeholder="Category (e.g. Cocktails)" value="${esc(v('category', m.category || ''))}"><datalist id="rs-cats">${cats}</datalist>
        <input id="rs-m-price" data-bind="mprice" type="number" min="0" step="0.01" placeholder="Price" value="${v('price', m.price ?? '')}">
        <select id="rs-m-station"><option value="kitchen" ${v('station', m.station) !== 'bar' ? 'selected' : ''}>Kitchen</option><option value="bar" ${v('station', m.station) === 'bar' ? 'selected' : ''}>Bar</option></select>
        <label><input id="rs-m-noprep" data-act="mm-noprep" type="checkbox" ${v('no_prep', !!m.no_prep) ? 'checked' : ''}> No preparation (bottled drink: skips the kitchen/bar screen)</label>
        <label><input id="rs-m-fav" type="checkbox" ${v('favourite', !!m.favourite) ? 'checked' : ''}> Show first (popular)</label>
        <label><input id="rs-m-active" type="checkbox" ${v('active', m.id ? !!m.active : true) ? 'checked' : ''}> On the menu</label></div>
        ${recipe}
        <div class="rs-row" style="margin-top:12px"><button class="rs-btn pri" data-act="mm-save">Save</button><button class="rs-btn" data-act="closesheet-btn">Cancel</button></div>`;
}
function captureMenuForm() {
    const sh = UI.sheet;
    if (!sh || sh.type !== 'menuedit' || !sh.draft) return;
    const g = id => root.querySelector('#' + id);
    if (!g('rs-m-name')) return;
    sh.draft.f = { name: g('rs-m-name').value, category: g('rs-m-cat').value, price: g('rs-m-price').value, station: g('rs-m-station').value,
        no_prep: g('rs-m-noprep').checked, favourite: g('rs-m-fav').checked, active: g('rs-m-active').checked };
}

// Ingredient units: how a stock item is measured. Prices come from purchases / inventory.
function unitSheet() {
    const id = UI.sheet.id, it = invById(id), u = unitRow(id) || {};
    if (!it) return '<div class="rs-muted">Item not found.</div><button class="rs-btn" data-act="closesheet-btn">Close</button>';
    const lp = lastPurchase(id);
    const size = Number(u.pack_size) || 0, unit = unitText(u.base_unit);
    const info = [];
    if (lp) info.push(`Last purchase: ${lp.qty} × ${fmt(lp.cost)} each (${esc(lp.date || '')})`);
    if (size) info.push(`Next ${esc(u.pack_name || 'pack')} costs ${fmt(fifoCost(id, size))} (oldest stock first), ${fmt(fifoCost(id, 1))} per ${unit}`);
    return `<h3>${esc(it.desc)} <span class="rs-muted" style="font-size:13px;font-weight:400">${esc(it.category || '')}</span></h3>
        <div class="rs-muted" style="margin-bottom:8px">Stock is counted in the small unit (a 750 ml bottle is stock of 750). On the Purchase page you enter packs; the system converts them using the pack size below.</div>
        <div style="display:grid;gap:8px">
        <label>Measured in <select id="rs-u-base"><option value="ml" ${u.base_unit === 'ml' ? 'selected' : ''}>ml (liquids)</option><option value="g" ${u.base_unit === 'g' ? 'selected' : ''}>g (food by weight)</option><option value="piece" ${!u.base_unit || u.base_unit === 'piece' ? 'selected' : ''}>pieces</option></select></label>
        <input id="rs-u-pack" placeholder="Pack name (e.g. bottle, sack, crate)" value="${esc(u.pack_name || '')}">
        <input id="rs-u-size" type="number" min="1" placeholder="Units in one pack (e.g. 750)" value="${u.pack_size ?? ''}"></div>
        ${info.length ? `<div class="rs-muted" style="margin-top:8px">${info.join('<br>')}</div>` : ''}
        <div class="rs-muted" style="margin-top:8px">Changing the pack size only affects purchases made from now on. Stock already in the system is not changed.</div>
        <div class="rs-row" style="margin-top:12px"><button class="rs-btn pri" data-act="unit-save">Save</button><button class="rs-btn" data-act="closesheet-btn">Cancel</button></div>`;
}

async function loadUnitsQuiet() {
    try { const r = await sb().from('rest_stock_units').select('*').eq('tenant_id', ctx.tenantId); if (!r.error) D.units = r.data; } catch (e) { }
}

// ---------------------------------------------------------------
// Kitchen / bar screen
// ---------------------------------------------------------------
function kitchenView() {
    const st = UI.station;
    const items = D.items.filter(i => i.status === 'new' && (st === 'all' || i.station === st));
    const byTab = new Map();
    items.forEach(i => { if (!byTab.has(i.tab_id)) byTab.set(i.tab_id, []); byTab.get(i.tab_id).push(i); });
    const tickets = [...byTab.entries()].map(([tabId, its]) => ({ tab: tabById(tabId), its: its.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at)) }))
        .filter(x => x.tab).sort((a, b) => new Date(a.its[0].sent_at) - new Date(b.its[0].sent_at));
    const seg = [['kitchen', 'Kitchen'], ['bar', 'Bar'], ['all', 'Both']].map(([k, l]) => `<button class="rs-chip ${st === k ? 'on' : ''}" data-act="station" data-s="${k}">${l}</button>`).join('');
    const cards = tickets.map(({ tab, its }) => {
        const age = mins(its[0].sent_at);
        const ringing = [...UI.pending.values()].some(p => p.tab === tab.id);
        return `<div class="rs-kt ${age >= 15 ? 'late' : ''} ${ringing ? 'alarm' : ''}" data-tab="${tab.id}">${ringing ? '<div class="rs-ackhint">NEW ORDER · tap here to stop the alarm</div>' : ''}<div class="rs-row"><b style="font-size:18px">${esc(tabLabel(tab))}</b><span class="rs-muted">${age} min</span><span class="rs-sp"></span>
            ${its.length > 1 ? `<button class="rs-btn sm" data-act="readyall" data-id="${tab.id}">All ready</button>` : ''}</div>
            ${its.map(i => `<div class="rs-kitem"><div class="n">${i.qty} × ${esc(i.name)}${i.note ? `<div class="rs-muted" style="font-size:13px">${esc(i.note)}</div>` : ''}${i.added_by ? `<div class="rs-muted" style="font-size:12px">Ordered by ${esc(i.added_by)}</div>` : ''}</div><button class="rs-btn pri" data-act="ready" data-id="${i.id}">Ready</button></div>`).join('')}</div>`;
    }).join('');
    const snd = `<button class="rs-btn sm ${soundOn() ? 'pri' : ''}" data-act="soundtoggle">${soundOn() ? 'Sound on' : 'Sound off'}</button><button class="rs-btn sm" data-act="soundtest">Test</button>`;
    const lock = soundLocked() ? `<button class="rs-offline" style="width:100%;text-align:left;cursor:pointer;margin-top:8px" data-act="soundtest">The phone is keeping the order bell silent. <b>Tap here once</b> to turn it on.</button>` : '';
    return `<div class="rs-row"><div class="rs-chips" style="margin:0">${seg}</div><span class="rs-sp"></span>${snd}<span class="rs-muted">${navigator.onLine ? (UI.live ? 'Live' : 'Refreshing every 20 s') : 'Offline'}</span></div>
        ${lock}
        ${cards || '<div class="rs-card rs-muted" style="margin-top:10px">No orders waiting.</div>'}`;
}

// ---------------------------------------------------------------
// Stock: counts (open bottles in tenths) and waste log
// ---------------------------------------------------------------
const trackedItems = () => invItems().filter(i => unitRow(i.id));
function countQty(id) {
    const v = UI.count.vals[id] || {}, u = unitRow(id) || {}, size = Number(u.pack_size) || 0;
    const has = x => x !== undefined && x !== '' && !isNaN(Number(x));
    if (size) {
        if (!has(v.packs) && !has(v.tenths)) return null;
        return round2((has(v.packs) ? Number(v.packs) : 0) * size + (has(v.tenths) ? Math.min(10, Number(v.tenths)) : 0) / 10 * size);
    }
    return has(v.qty) ? Number(v.qty) : null;
}
function countRows() {
    const q = (UI.count.q || '').trim().toLowerCase();
    const list = trackedItems().filter(i => !q || String(i.desc).toLowerCase().includes(q)).slice(0, 80);
    if (!list.length) return '<div class="rs-muted">No ingredients with a unit yet. Set units in Manage, Ingredient units.</div>';
    return list.map(i => {
        const u = unitRow(i.id), size = Number(u.pack_size) || 0, v = UI.count.vals[i.id] || {}, cq = countQty(i.id);
        const inputs = size
            ? `<input data-bind="cpacks" data-id="${i.id}" type="number" min="0" step="1" placeholder="Full ${esc(u.pack_name || 'packs')}" value="${v.packs ?? ''}" style="width:96px"><input data-bind="ctenths" data-id="${i.id}" type="number" min="0" max="10" step="1" placeholder="Open /10" value="${v.tenths ?? ''}" style="width:84px">`
            : `<input data-bind="cqty" data-id="${i.id}" type="number" min="0" step="1" placeholder="${unitText(u.base_unit)}" value="${v.qty ?? ''}" style="width:110px">`;
        return `<div class="rs-line"><div class="n"><b>${esc(i.desc)}</b><div class="rs-muted">${esc(i.category || '')}</div></div>${inputs}<span class="rs-muted" id="rs-ct-${i.id}" style="min-width:70px;text-align:right">${cq === null ? '' : '= ' + cq + ' ' + unitText(u.base_unit)}</span></div>`;
    }).join('');
}
function stockView() {
    let html = '';
    if (canCount()) {
        const locs = [...new Set(['Bar', 'Store room', ...UI.counts.map(c => c.location)])].map(l => `<option value="${esc(l)}">`).join('');
        html += `<div class="rs-card" style="margin-bottom:12px"><b>Stock count</b>
            <div class="rs-muted" style="margin:4px 0 8px">Count what is physically there. For an open bottle, enter its level in tenths (0 empty, 5 half, 10 full). Count first thing, before deliveries arrive.</div>
            <div class="rs-row"><label>Location <input data-bind="cloc" list="rs-locs" value="${esc(UI.count.loc)}" style="width:150px"></label><datalist id="rs-locs">${locs}</datalist>
            <input data-bind="cq" value="${esc(UI.count.q)}" placeholder="Search item" style="flex:1;min-width:120px"></div>
            <div id="rs-countlist" style="margin-top:8px">${countRows()}</div>
            <div class="rs-row" style="margin-top:10px"><button class="rs-btn pri" data-act="count-save">Save count</button></div></div>`;
    }
    if (canWaste()) {
        const rows = UI.waste.slice(0, 30).map(w => `<tr><td>${esc(invName(w.stock_item_id))}<div class="rs-muted">${esc(REASONS[w.reason] || w.reason)} · ${esc(w.logged_by || '')} · ${new Date(w.created_at).toLocaleDateString()}</div></td><td style="text-align:right">${w.qty} ${unitOf(w.stock_item_id)}</td><td style="text-align:right">${fmt(w.cost)}</td></tr>`).join('');
        html += `<div class="rs-card"><div class="rs-row"><b>Waste</b><span class="rs-sp"></span><button class="rs-btn pri sm" data-act="w-open">+ Log waste</button></div>
            <div class="rs-muted" style="margin-top:4px">Spills, breakage, expired stock, over-pours, free and staff drinks. Each entry takes the stock out and records the cost.</div>
            ${canCosts() ? (rows ? `<table class="rs-tbl" style="margin-top:8px">${rows}</table>` : '<div class="rs-muted" style="margin-top:8px">Nothing logged yet.</div>') : ''}</div>`;
    }
    return html || '<div class="rs-card">Your role cannot count stock or log waste.</div>';
}
async function loadCounts() {
    try {
        const r = await sb().from('rest_counts').select('*').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).range(0, 59);
        if (!r.error) UI.counts = r.data.filter(okBranch);
    } catch (e) { }
}
async function loadWaste() {
    if (!canCosts()) return;
    try {
        const r = await sb().from('rest_waste_log').select('*').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).range(0, 49);
        if (!r.error) UI.waste = r.data;
    } catch (e) { }
}
function wasteSheet() {
    const d = UI.sheet.draft;
    const reasons = Object.entries(REASONS).filter(([k]) => k !== 'void_after_ready').map(([k, l]) => `<option value="${k}" ${d.reason === k ? 'selected' : ''}>${l}</option>`).join('');
    const names = d.mode === 'menu' ? D.menu.filter(m => m.active).map(m => m.name) : trackedItems().map(i => i.desc);
    const sid = d.mode === 'stock' ? matchStock(d.name) : '';
    const u = sid ? unitRow(sid) : null;
    const unitSel = d.mode === 'stock' ? `<select data-act="w-unit" style="width:110px"><option value="base">${u ? unitText(u.base_unit) : 'units'}</option>${u && Number(u.pack_size) > 0 ? `<option value="pack" ${d.unit === 'pack' ? 'selected' : ''}>${esc(u.pack_name || 'pack')}</option>` : ''}</select>` : '<span class="rs-muted">servings</span>';
    return `<h3>Log waste</h3><div style="display:grid;gap:8px">
        <label>Reason <select data-act="w-reason" style="width:100%">${reasons}</select></label>
        <label>What was lost <select data-act="w-mode" style="width:100%"><option value="stock" ${d.mode === 'stock' ? 'selected' : ''}>A stock item (ml, g, pieces)</option><option value="menu" ${d.mode === 'menu' ? 'selected' : ''}>A menu item (free or staff drink, spilled cocktail)</option></select></label>
        <datalist id="rs-wlist">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        <input data-bind="wname" list="rs-wlist" placeholder="${d.mode === 'menu' ? 'Search the menu' : 'Search stock'}" value="${esc(d.name)}">
        <div class="rs-row"><input data-bind="wqty" type="number" min="1" step="1" placeholder="Quantity" value="${d.qty}" style="flex:1">${unitSel}</div>
        <input data-bind="wnote" placeholder="Note (optional)" value="${esc(d.note)}"></div>
        <div class="rs-row" style="margin-top:12px"><button class="rs-btn pri" data-act="w-save">Log waste</button><button class="rs-btn" data-act="closesheet-btn">Cancel</button></div>`;
}

// Variance: what the counts say was used, against what sales say should have been used.
function varianceHtml() {
    const opts = sel => '<option value="">Choose…</option>' + UI.counts.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.location)} · ${new Date(c.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${c.counted_by ? ' · ' + esc(c.counted_by) : ''}</option>`).join('');
    let out = '';
    const v = UI.variance;
    if (v) {
        const head = '<tr><th>Item</th><th style="text-align:right">Used (count)</th><th style="text-align:right">Sold</th><th style="text-align:right">Waste</th><th style="text-align:right">Unexplained</th><th style="text-align:right">Bottles</th><th style="text-align:right">Money</th><th style="text-align:right">%</th></tr>';
        const rows = v.rows.map(r => `<tr><td>${esc(r.name)}<div class="rs-muted">${esc(r.category)} · ${r.open} + ${r.purch} − ${r.close}</div></td><td style="text-align:right">${r.actual} ${r.unit}</td><td style="text-align:right">${r.sold}</td><td style="text-align:right">${r.waste}</td><td style="text-align:right;${r.unexplained > 0 ? 'color:#B23A2E' : ''}"><b>${r.unexplained}</b></td><td style="text-align:right">${r.bottles === null ? '' : r.bottles}</td><td style="text-align:right">${fmt(r.money)}</td><td style="text-align:right">${r.pct === null ? '' : r.pct + '%'}</td></tr>`).join('');
        const tot = v.rows.reduce((s, r) => s + r.money, 0);
        out = `<div style="overflow-x:auto;margin-top:8px"><table class="rs-tbl">${head}${rows}</table></div>
            <div class="rs-muted" style="margin-top:6px">Unexplained = used − sold − logged waste. Positive means more went than the sales explain. Total ${fmt(tot)}.${v.skipped ? ` ${v.skipped} item(s) were not counted both times and are left out.` : ''}</div>`;
    }
    return `<div class="rs-card" style="margin-top:10px"><b>Stock variance</b>
        <div class="rs-muted">Pick two counts at the same location. Purchases dated from the opening day to the closing day are included, so count before deliveries arrive.</div>
        <div class="rs-row" style="margin-top:6px"><label>Opening <select data-act="var-open">${opts(UI.varSel.open)}</select></label><label>Closing <select data-act="var-close">${opts(UI.varSel.close)}</select></label><button class="rs-btn pri" data-act="var-run">Show</button></div>${out}</div>`;
}
async function runVariance() {
    const o = UI.counts.find(c => c.id === UI.varSel.open), c = UI.counts.find(c => c.id === UI.varSel.close);
    if (!o || !c) { toast('Choose an opening and a closing count.', true); return; }
    if (o.location !== c.location) { toast('Both counts must be at the same location.', true); return; }
    if (new Date(o.created_at) >= new Date(c.created_at)) { toast('The opening count must be earlier than the closing count.', true); return; }
    try {
        const tid = ctx.tenantId;
        const between = q => { q = q.gte('created_at', o.created_at).lte('created_at', c.created_at); return o.branch_id ? q.eq('branch_id', o.branch_id) : q; };
        const [ol, cl, mv, wl] = await Promise.all([
            db(sb().from('rest_count_lines').select('stock_item_id,qty').eq('count_id', o.id)),
            db(sb().from('rest_count_lines').select('stock_item_id,qty').eq('count_id', c.id)),
            db(between(sb().from('rest_stock_moves').select('stock_item_id,qty,unit_cost').eq('tenant_id', tid)).range(0, 9999)),
            db(between(sb().from('rest_waste_log').select('stock_item_id,qty').eq('tenant_id', tid).eq('deducted', true)).range(0, 9999))
        ]);
        const sum = (rows, k = 'qty') => { const m = {}; rows.forEach(r => { m[r.stock_item_id] = (m[r.stock_item_id] || 0) + Number(r[k]); }); return m; };
        const om = sum(ol), cm = sum(cl), soldM = sum(mv), wasteM = sum(wl);
        const costM = {}; mv.forEach(r => { costM[r.stock_item_id] = (costM[r.stock_item_id] || 0) + Number(r.qty) * Number(r.unit_cost); });
        const d0 = new Date(o.created_at).toLocaleDateString('en-CA'), d1 = new Date(c.created_at).toLocaleDateString('en-CA');
        const rows = []; let skipped = 0;
        new Set([...Object.keys(om), ...Object.keys(cm)]).forEach(id => {
            if (!(id in om) || !(id in cm)) { skipped++; return; }
            const it = invById(id), u = unitRow(id) || {}, size = Number(u.pack_size) || 0;
            const comp = it ? `[${it.category}] ${it.desc}` : '';
            const purch = (S().purchaseLog || []).filter(p => p.desc === comp && p.date >= d0 && p.date <= d1).reduce((s, p) => s + Number(p.qty) * (size || 1), 0);
            const open = om[id], close = cm[id], actual = round2(open + purch - close), sold = round2(soldM[id] || 0), waste = round2(wasteM[id] || 0);
            const unexplained = round2(actual - sold - waste);
            const unitCost = sold > 0 ? (costM[id] || 0) / sold : fifoCost(id, 1);
            rows.push({ id, name: it ? it.desc : 'Unknown item', category: it ? (it.category || '') : '', unit: unitText(u.base_unit), open, purch: round2(purch), close, actual, sold, waste, unexplained,
                bottles: size ? round2(unexplained / size) : null, money: round2(unexplained * unitCost), pct: sold > 0 ? Math.round(unexplained / sold * 100) : null });
        });
        rows.sort((a, b) => Math.abs(b.money) - Math.abs(a.money));
        UI.variance = { rows, skipped };
        render();
    } catch (e) { }
}

// ---------------------------------------------------------------
// Reports: recipe cost / margin, and sales by menu item and category
// ---------------------------------------------------------------
function wasteReportHtml(rows) {
    const group = fn => { const m = {}; rows.forEach(w => { const k = fn(w); m[k] = m[k] || { name: k, qty: 0, cost: 0, n: 0 }; m[k].cost += Number(w.cost); m[k].n++; }); return Object.values(m).sort((a, b) => b.cost - a.cost); };
    const tbl = list => `<table class="rs-tbl">${list.map(x => `<tr><td>${esc(x.name)}</td><td style="text-align:right">${x.n}×</td><td style="text-align:right">${fmt(x.cost)}</td></tr>`).join('')}</table>`;
    const total = rows.reduce((s, w) => s + Number(w.cost), 0);
    return `<div class="rs-card" style="margin-top:10px"><b>Waste</b>: ${rows.length} entries, cost ${fmt(total)}
        <div class="rs-muted" style="margin-top:6px">By reason</div>${tbl(group(w => REASONS[w.reason] || w.reason))}
        <div class="rs-muted" style="margin-top:6px">By product</div>${tbl(group(w => invName(w.stock_item_id)).slice(0, 15))}
        <div class="rs-muted" style="margin-top:6px">By person</div>${tbl(group(w => w.logged_by || 'Unknown'))}</div>`;
}
function monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('en-CA'); }
function reportView() {
    const r = UI.rep || { from: monthStart(), to: todayISO(), rows: null };
    let out = '';
    if (r.rows) {
        const tot = r.rows.reduce((a, x) => ({ q: a.q + x.qty, rev: a.rev + x.rev, cost: a.cost + x.cost }), { q: 0, rev: 0, cost: 0 });
        const line = x => `<tr><td>${esc(x.name)}</td><td style="text-align:right">${x.qty}</td><td style="text-align:right">${fmt(x.rev)}</td><td style="text-align:right">${fmt(x.cost)}</td><td style="text-align:right">${fmt(x.rev - x.cost)}</td><td style="text-align:right">${pct(x.rev - x.cost, x.rev)}</td></tr>`;
        const byCat = {};
        r.rows.forEach(x => { const c = x.category; byCat[c] = byCat[c] || { name: c, qty: 0, rev: 0, cost: 0 }; byCat[c].qty += x.qty; byCat[c].rev += x.rev; byCat[c].cost += x.cost; });
        const head = '<tr><th>Item</th><th style="text-align:right">Sold</th><th style="text-align:right">Sales</th><th style="text-align:right">Cost</th><th style="text-align:right">Profit</th><th style="text-align:right">Margin</th></tr>';
        out = `<div class="rs-card" style="margin-top:10px"><b>Total</b>: ${tot.q} sold, sales ${fmt(tot.rev)}, cost ${fmt(tot.cost)}, profit ${fmt(tot.rev - tot.cost)}, margin ${tot.rev > 0 ? Math.round((tot.rev - tot.cost) / tot.rev * 100) : 0}%, pour cost ${tot.rev > 0 ? Math.round(tot.cost / tot.rev * 100) : 0}%
            <div class="rs-muted">Paid items only. Items without a recipe show cost 0.</div></div>
            <div class="rs-card" style="margin-top:10px"><b>By category</b><table class="rs-tbl">${head}${Object.values(byCat).sort((a, b) => b.rev - a.rev).map(line).join('')}</table></div>
            <div class="rs-card" style="margin-top:10px"><b>By menu item</b><table class="rs-tbl">${head}${r.rows.slice().sort((a, b) => b.rev - a.rev).map(line).join('')}</table></div>`;
    }
    const recipeRows = D.menu.filter(m => m.active).map(m => ({ m, c: recipeCost(m) })).filter(x => x.c !== null).sort((a, b) => a.m.name.localeCompare(b.m.name))
        .map(({ m, c }) => `<tr><td>${esc(m.name)}</td><td style="text-align:right">${fmt(m.price)}</td><td style="text-align:right">${fmt(c)}</td><td style="text-align:right">${fmt(m.price - c)}</td><td style="text-align:right">${pct(m.price - c, m.price)}</td></tr>`).join('');
    return `<div class="rs-card"><div class="rs-row"><label>From <input id="rs-rep-from" type="date" value="${r.from}"></label><label>To <input id="rs-rep-to" type="date" value="${r.to}"></label><button class="rs-btn pri" data-act="rep-run">Show</button></div></div>${out}
        ${UI.p3 ? varianceHtml() : ''}
        ${UI.p3 && r.waste ? wasteReportHtml(r.waste) : ''}
        <div class="rs-card" style="margin-top:10px"><b>Recipe cost and margin today</b><div class="rs-muted">Cost of the next serving, oldest stock first (FIFO).</div>
        ${recipeRows ? `<table class="rs-tbl"><tr><th>Item</th><th style="text-align:right">Price</th><th style="text-align:right">Cost</th><th style="text-align:right">Profit</th><th style="text-align:right">Margin</th></tr>${recipeRows}</table>` : '<div class="rs-muted">No recipes yet.</div>'}</div>`;
}
async function runReport() {
    const from = root.querySelector('#rs-rep-from').value, to = root.querySelector('#rs-rep-to').value;
    if (!from || !to || from > to) { toast('Choose a valid date range.', true); return; }
    try {
        const tid = ctx.tenantId;
        const start = new Date(from + 'T00:00:00').toISOString(), end = new Date(new Date(to + 'T00:00:00').getTime() + 86400000).toISOString();
        const items = await db(sb().from('rest_tab_items').select('*').eq('tenant_id', tid).eq('paid', true).neq('status', 'void').gte('sent_at', start).lt('sent_at', end).range(0, 4999));
        const cost = {};
        for (let k = 0; k < items.length; k += 150) {
            const ids = items.slice(k, k + 150).map(x => x.id);
            const mv = await db(sb().from('rest_stock_moves').select('tab_item_id,qty,unit_cost').eq('tenant_id', tid).in('tab_item_id', ids));
            mv.forEach(x => { cost[x.tab_item_id] = (cost[x.tab_item_id] || 0) + Number(x.qty) * Number(x.unit_cost); });
        }
        const by = {};
        items.forEach(x => {
            const m = menuById(x.menu_item_id), key = x.menu_item_id || x.name;
            const row = by[key] = by[key] || { name: m ? m.name : x.name, category: m ? (m.category || 'General') : 'Other', qty: 0, rev: 0, cost: 0 };
            row.qty += x.qty; row.rev += x.qty * Number(x.unit_price); row.cost += cost[x.id] || 0;
        });
        let waste = null;
        if (UI.p3) waste = await db(sb().from('rest_waste_log').select('*').eq('tenant_id', tid).gte('created_at', start).lt('created_at', end).range(0, 4999));
        UI.rep = { from, to, rows: Object.values(by), waste };
        render();
    } catch (e) { }
}

// ---------------------------------------------------------------
// Manage: menu, zones and tables
// ---------------------------------------------------------------
function recipeNote(m) {
    const n = recipeLines(m.id).length;
    const base = n ? `${n} ingredient${n > 1 ? 's' : ''}` : (m.stock_item_id ? 'linked to stock' : 'no recipe');
    const c = canCosts() ? recipeCost(m) : null;
    if (c === null || !(m.price > 0)) return base;
    return `${base} · cost ${fmt(c)} · profit ${fmt(m.price - c)} · margin ${pct(m.price - c, m.price)}`;
}
function manageView() {
    let html = '';
    if (canMenu()) {
        const rows = D.menu.slice().sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name)).map(m => `<tr data-act="mm-edit" data-id="${m.id}" style="cursor:pointer;${m.active ? '' : 'opacity:.5'}"><td><b>${esc(m.name)}</b><div class="rs-muted">${esc(m.category || 'General')}${m.no_prep ? ' · no prep' : ''}${UI.p2 ? ' · ' + recipeNote(m) : ''}</div></td><td>${m.station === 'bar' ? 'Bar' : 'Kitchen'}</td><td style="text-align:right">${fmt(m.price)}</td></tr>`).join('');
        html += `<div class="rs-card" style="margin-bottom:12px"><div class="rs-row"><b>Menu</b><span class="rs-sp"></span><button class="rs-btn pri sm" data-act="mm-new">+ Menu item</button></div>
            ${rows ? `<table class="rs-tbl" style="margin-top:8px">${rows}</table>` : '<div class="rs-muted" style="margin-top:8px">No items yet.</div>'}</div>`;
    }
    if (canMenu() && UI.p2) {
        const q = (UI.unitq || '').trim().toLowerCase();
        const list = invItems().filter(x => !q || String(x.desc).toLowerCase().includes(q)).slice(0, 40);
        const rows = list.map(x => { const u = unitRow(x.id); return `<tr data-act="unit-edit" data-id="${x.id}" style="cursor:pointer"><td><b>${esc(x.desc)}</b><div class="rs-muted">${esc(x.category || '')}</div></td><td>${u ? unitText(u.base_unit) : '<span class="rs-muted">not set</span>'}</td><td>${u && u.pack_size ? esc(u.pack_name || 'pack') + ' = ' + u.pack_size : ''}</td><td style="text-align:right">${u && u.pack_size ? fmt(fifoCost(x.id, Number(u.pack_size))) : (fifoCost(x.id, 1) ? fmt(fifoCost(x.id, 1)) + ' / ' + (u ? unitText(u.base_unit) : 'unit') : '')}</td></tr>`; }).join('');
        html += `<div class="rs-card" style="margin-bottom:12px"><div class="rs-row"><b>Ingredient units</b><span class="rs-sp"></span><input data-bind="unitq" value="${esc(UI.unitq || '')}" placeholder="Search stock" style="max-width:180px"></div>
            <div class="rs-muted" style="margin:4px 0 6px">How each ingredient is measured (ml, g or pieces) and how big a pack is. The last column is the cost of the next pack from your stock, oldest first, taken from purchases.</div>
            <div id="rs-unitlist">${rows ? `<table class="rs-tbl">${rows}</table>` : '<span class="rs-muted">No stock items yet. Add them on the Purchase page first.</span>'}</div></div>`;
    }
    if (canLayout()) {
        const zrows = D.zones.map(z => `<tr><td><b>${esc(z.name)}</b></td><td>${D.tables.filter(t => t.zone_id === z.id).length} tables</td><td style="text-align:right"><button class="rs-btn sm" data-act="setup" data-id="${z.id}">Lay out a grid</button></td></tr>`).join('');
        html += `<div class="rs-card"><div class="rs-row"><b>Floor</b><span class="rs-sp"></span><button class="rs-btn sm" data-act="addzone">+ Zone</button><button class="rs-btn pri sm" data-act="goedit">Edit layout</button></div>
            ${zrows ? `<table class="rs-tbl" style="margin-top:8px">${zrows}</table>` : '<div class="rs-muted" style="margin-top:8px">Start by adding a zone (for example Main hall).</div>'}</div>`;
    }
    return html;
}

// ---------------------------------------------------------------
// Actions
// ---------------------------------------------------------------
const nextLabel = () => {
    const nums = D.tables.filter(t => !t.is_temporary).map(t => parseInt(String(t.label).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
    return 'T' + ((nums.length ? Math.max(...nums) : 0) + 1);
};
async function addTable(temp) {
    if (!UI.zoneId) { toast('Add a zone first.', true); return; }
    const svg = root.querySelector ? root.querySelector('svg.rs-map') : null, cam = getCam(UI.zoneId);
    const W = (svg && svg.clientWidth) || 360, H = (svg && svg.clientHeight) || 420;
    let x = Math.round(((W / 2 - cam.x) / cam.s - DIAM / 2) / 10) * 10, y = Math.round(((H / 2 - cam.y) / cam.s - DIAM / 2) / 10) * 10;
    const us = layoutUnits(UI.zoneId);
    for (let k = 0; k < 60 && us.some(u => x < u.x1 + 10 && x + DIAM > u.x0 - 10 && y < u.y1 + 10 && y + DIAM > u.y0 - 10); k++) { x += 100; if (k % 6 === 5) { x -= 600; y += 100; } }
    const n = D.tables.filter(t => t.is_temporary).length + 1;
    const row = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), zone_id: UI.zoneId,
        label: temp ? 'Temp ' + n : nextLabel(), shape: 'round', x, y, width: DIAM, height: DIAM, rotation: 0, seats: 4, is_temporary: !!temp, active: true };
    if (UI.joinCol) row.join_group = null;
    await db(sb().from('rest_tables').insert(row));
    await load(); UI.sel = row.id; return row;
}
async function patchTable(id, patch) {
    await db(sb().from('rest_tables').update(patch).eq('id', id));
    Object.assign(tableById(id) || {}, patch);
}

async function sendCart(target) {
    if (!UI.cart.length || UI.sending) return;
    UI.sending = true;
    // Instant feedback: the screen clears at once; if saving fails the order comes back.
    const cartCopy = UI.cart.slice(), pt = UI.pickTarget;
    UI.cart = []; UI.pickTarget = null; UI.sheet = null; UI.pickq = '';
    render();
    toast('Sending…');
    let created = null;
    try {
        let tab = null;
        if (target.tabId) tab = tabById(target.tabId);
        else if (target.tableId) {
            tab = tabForTable(target.tableId);
            if (!tab) {
                const ms = membersOf(target.tableId);
                tab = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), label: unitLabelOf(ms), status: 'open', opened_by: username() };
                await db(sb().from('rest_tabs').insert(tab));
                created = tab;
                await db(sb().from('rest_tab_tables').insert(ms.map(m => ({ tab_id: tab.id, table_id: m.id, tenant_id: ctx.tenantId }))));
            }
        } else if (target.quick) {
            const name = target.quick.trim();
            tab = D.tabs.find(x => !tablesOfTab(x.id).length && (x.label || '').toLowerCase() === name.toLowerCase());
            if (!tab) {
                tab = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), label: name, status: 'open', opened_by: username() };
                await db(sb().from('rest_tabs').insert(tab));
                created = tab;
            }
        }
        if (!tab) throw new Error('no table');
        const rows = cartCopy.map(c => ({ id: uid(), tenant_id: ctx.tenantId, tab_id: tab.id, menu_item_id: c.id, name: c.name,
            qty: c.qty, unit_price: c.price, note: c.note || null, station: c.station, status: c.no_prep ? 'served' : 'new', added_by: username() }));
        await db(sb().from('rest_tab_items').insert(rows));
        if (UI.p2) {
            const quick = rows.filter(r => r.status === 'served').map(r => r.id);
            if (quick.length) {
                try { showShort(await db(sb().rpc('rest_deduct_items', { p_ids: quick }))); }
                catch (e) { toast('Order sent, but stock was not updated for the drinks. Tell a manager.', true); }
            }
        }
        toast('Sent to ' + tabLabelSafe(tab, target));
        await load(); render();
    } catch (e) {
        if (created) { try { await sb().from('rest_tabs').delete().eq('id', created.id); } catch (x) { } }
        UI.cart = cartCopy; UI.pickTarget = pt;
        render();
    } finally { UI.sending = false; }
}
function tabLabelSafe(tab, target) {
    if (target.tableId) { const ms = membersOf(target.tableId); if (ms.length) return unitLabelOf(ms); }
    return tab.label || 'tab';
}

function snapItems() { return D.items.map(i => ({ ...i })); }
async function markReady(ids) {
    if (!ids.length) return;
    const snap = snapItems();
    D.items.forEach(i => { if (ids.includes(i.id) && i.status === 'new') { i.status = 'ready'; i.ready_by = username(); } });
    render();
    try {
        if (UI.p2) {
            // Status change and stock deduction happen together on the server, once per item.
            showShort(await db(sb().rpc('rest_mark_ready', { p_ids: ids, p_by: username() })));
        } else {
            await db(sb().from('rest_tab_items').update({ status: 'ready', ready_at: new Date().toISOString(), ready_by: username() }).in('id', ids).eq('status', 'new'));
        }
        scheduleLoad();
    } catch (e) { D.items = snap; await load(); render(); }
}

async function voidItem(id) {
    const it = D.items.find(i => i.id === id);
    if (!it) return;
    let reason = null;
    if (it.status !== 'new') {
        if (!canVoidSent()) { toast('Only a manager can void something already sent out.', true); return; }
        reason = (prompt('Why is this being voided? (required)') || '').trim();
        if (!reason) return;
    } else if (!confirm('Remove ' + it.name + '?')) return;
    const snap = snapItems();
    it.status = 'void'; it.voided_by = username(); it.void_reason = reason;
    render();
    try {
        if (UI.p3) await db(sb().rpc('rest_void_item', { p_item: id, p_reason: reason || '', p_by: username() }));
        else await db(sb().from('rest_tab_items').update({ status: 'void', voided_by: username(), void_reason: reason }).eq('id', id).neq('status', 'void'));
        scheduleLoad();
    } catch (e) { D.items = snap; await load(); render(); }
}

async function relabel(tabId) {
    const tab = tabById(tabId);
    if (!tab) return;
    const label = tabLabel(tab);
    if (label !== tab.label) await db(sb().from('rest_tabs').update({ label }).eq('id', tabId));
}

async function moveTab(tabId, table) {
    const ms = membersOf(table.id);
    if (ms.some(m => tabForTable(m.id))) { toast(unitLabelOf(ms) + ' already has a tab.', true); return; }
    if (!navigator.onLine) { toast('No connection. Nothing was sent.', true); return; }
    const tab = tabById(tabId);
    const keepTT = D.tabTables.slice(), keepLabel = tab ? tab.label : null;
    const newIds = new Set(ms.map(m => m.id));
    const old = tablesOfTab(tabId).filter(t => !newIds.has(t.id)).map(t => t.id);
    const label = unitLabelOf(ms);
    // Show the move at once; the database catches up behind it and we undo it if that fails.
    D.tabTables = D.tabTables.filter(x => !(x.tab_id === tabId && old.includes(x.table_id)))
        .concat(ms.map(m => ({ tab_id: tabId, table_id: m.id, tenant_id: ctx.tenantId })));
    if (tab) tab.label = label;
    UI.sheet = null; render(); toast('Moved to ' + label);
    try {
        await db(sb().from('rest_tab_tables').insert(ms.map(m => ({ tab_id: tabId, table_id: m.id, tenant_id: ctx.tenantId }))));
        if (old.length) await db(sb().from('rest_tab_tables').delete().eq('tab_id', tabId).in('table_id', old));
        await db(sb().from('rest_tabs').update({ label }).eq('id', tabId));
        scheduleLoad();
    } catch (e) {
        D.tabTables = keepTT; if (tab) tab.label = keepLabel;
        await load(); render();
    }
}

async function joinTap(t) {
    const main = tabById(UI.join.tabId);
    if (!main) { UI.join = null; render(); return; }
    if (tablesOfTab(main.id).some(x => x.id === t.id)) return;
    const other = tabForTable(t.id);
    try {
        if (!other) {
            const have = new Set(tablesOfTab(main.id).map(x => x.id));
            await db(sb().from('rest_tab_tables').insert(membersOf(t.id).filter(m => !have.has(m.id)).map(m => ({ tab_id: main.id, table_id: m.id, tenant_id: ctx.tenantId }))));
        } else {
            // Items keep who ordered them and their kitchen status, so nothing is re-sent.
            await db(sb().from('rest_tab_items').update({ tab_id: main.id }).eq('tab_id', other.id));
            await db(sb().from('rest_tab_tables').update({ tab_id: main.id }).eq('tab_id', other.id));
            await db(sb().from('rest_tabs').update({ status: 'merged', merged_into: main.id }).eq('id', other.id));
        }
        await load(); await relabel(main.id); await load(); render();
    } catch (e) { }
}

async function recordSale(tab, lines, svc, chan, costs = {}) {
    const codes = ctx.channelAccountCodes || (typeof CHANNEL_ACCOUNT_CODES !== 'undefined' ? CHANNEL_ACCOUNT_CODES : {});
    const code = codes[chan];
    const st = (S().saleTypes || [])[0];
    const sType = typeof st === 'string' ? st : (st && (st.name || st.label)) || 'Sale';
    const date = todayISO(), groupId = 'RB-' + Date.now(), branchId = branch(), customer = tabLabel(tab) || 'Walk-in';
    const rows = lines.map(i => ({ desc: i.name, qty: i.qty, price: Number(i.unit_price), cogs: round2(costs[i.id] || 0) }));
    if (svc > 0) rows.push({ desc: 'Service charge', qty: 1, price: svc });
    let total = 0, cogsTotal = 0;
    const made = rows.map((r, idx) => {
        const amt = round2(r.qty * r.price); total += amt; cogsTotal += (r.cogs || 0);
        const row = { id: `SL-${Date.now().toString().slice(-5)}-${idx}`, date, customer, desc: r.desc, qty: r.qty, price: r.price, total: amt, cogs: r.cogs || 0,
            channel: chan, type: sType, paid: true, paidChannel: chan, amountPaid: amt, payments: [{ date, amount: amt, channel: chan }],
            restorationLayers: [], branchId, groupId, vatIncluded: false };
        S().salesLog.push(row);
        window.queueWrite({ kind: 'insert', table: 'sales_log', row: window.toDbSale(row) });
        return row;
    });
    const journal = { id: made[0].id, date, desc: window.stampDesc(`Restaurant bill: ${customer}`), branchId,
        lines: [{ account: code, dr: round2(total), cr: 0 }, { account: '4010', cr: round2(total), dr: 0 }] };
    if (cogsTotal > 0) journal.lines.push({ account: '5010', dr: round2(cogsTotal), cr: 0 }, { account: '1200', cr: round2(cogsTotal), dr: 0 });
    S().journal.push(journal);
    window.queueWrite({ kind: 'insert', table: 'journal_entries', row: window.toDbJournal(journal) });
    if (typeof window.addNotification === 'function') window.addNotification('Restaurant bill paid', `ETB ${fmt(total)} (${chan})`, `${customer}: ${lines.length} item(s)`);
    if (typeof window.renderSalesLogTable === 'function') { try { window.renderSalesLogTable(); } catch (e) { } }
    return total;
}

async function payBill() {
    const tab = tabById(UI.sheet.tabId), B = UI.bill;
    if (!tab || UI.paying) return;
    const lines = unpaidItems(tab.id).filter(i => B.sel.has(i.id) && !waitingForStock(i));
    if (!lines.length) { toast('Select at least one item.', true); return; }
    const codes = ctx.channelAccountCodes || (typeof CHANNEL_ACCOUNT_CODES !== 'undefined' ? CHANNEL_ACCOUNT_CODES : {});
    if (!codes[B.chan]) { toast('Choose how it was paid.', true); return; }
    UI.paying = true;
    try {
        const sub = lines.reduce((s, i) => s + i.qty * i.unit_price, 0);
        const svc = round2(sub * (Number(B.svc) || 0) / 100);
        const ids = lines.map(i => i.id);
        // Real cost of what was used (Phase 2). Fetched first: if this fails nothing is marked paid.
        const costs = {};
        if (UI.p2) (await db(sb().rpc('rest_item_costs', { p_ids: ids })) || []).forEach(r => { costs[r.tab_item_id] = Number(r.cost) || 0; });
        // Claim the items first. If someone else paid some of them a moment ago, stop.
        const got = await db(sb().from('rest_tab_items').update({ paid: true }).in('id', ids).eq('paid', false).select('id'));
        if (got.length !== ids.length) {
            if (got.length) await db(sb().from('rest_tab_items').update({ paid: false }).in('id', got.map(g => g.id)));
            toast('Some of these items were just paid by someone else. Reloading.', true);
            await load(); render(); return;
        }
        await recordSale(tab, lines, svc, B.chan, costs);
        try { localStorage.setItem('rs_svc_' + ctx.tenantId, String(B.svc)); } catch (e) { }
        await load();
        if (!unpaidItems(tab.id).length) {
            await db(sb().from('rest_tabs').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', tab.id));
            const temps = tablesOfTab(tab.id).filter(t => t.is_temporary).map(t => t.id);
            if (temps.length) await db(sb().from('rest_tables').update({ active: false }).in('id', temps));
            toast('Paid. Table is free.');
        } else toast('Paid. The rest of the tab stays open.');
        UI.sheet = null; await load(); render();
    } catch (e) { render(); }
    finally { UI.paying = false; }
}

const ACT = {
    view: el => {
        UI.view = el.dataset.v; UI.sheet = null; UI.join = null; render();
        if (UI.view === 'reports' && UI.p3 && canCosts()) loadCounts().then(() => render());
        if (UI.view === 'stock' && UI.p3) { loadCounts(); loadWaste().then(() => render()); }
    },
    cat: el => { UI.cat = el.dataset.c; render(); },
    add: el => {
        const m = menuById(el.dataset.id); if (!m) return;
        const ex = UI.cart.find(c => c.id === m.id && !c.note);
        if (ex) ex.qty++; else UI.cart.push({ id: m.id, name: m.name, price: Number(m.price), station: m.station, no_prep: !!m.no_prep, qty: 1, note: '' });
        updateOrderParts();
    },
    inc: el => { UI.cart[+el.dataset.i].qty++; updateOrderParts(); },
    dec: el => { const c = UI.cart[+el.dataset.i]; c.qty--; if (c.qty <= 0) UI.cart.splice(+el.dataset.i, 1); updateOrderParts(); },
    cartnote: el => { const c = UI.cart[+el.dataset.i]; const n = prompt('Note for the kitchen (e.g. no onions)', c.note || ''); if (n !== null) { c.note = n.trim(); updateOrderParts(); } },
    clearcart: () => { UI.cart = []; updateOrderParts(); render(); },
    clearpick: () => { UI.pickTarget = null; updateOrderParts(); },
    send: () => { if (UI.pickTarget) sendCart(UI.pickTarget); else { UI.sheet = { type: 'pick' }; UI.pickq = ''; render(); } },
    'pick-table': el => sendCart({ tableId: el.dataset.id }),
    'pick-select': el => { if (el.value) sendCart({ tableId: el.value }); },
    'pick-quick': () => { const n = (root.querySelector('#rs-qname').value || '').trim(); if (!n) { toast('Type a name.', true); return; } sendCart({ quick: n }); },
    pickmap: () => { UI.pickMap = !UI.pickMap; render(); },
    closesheet: (el, e) => { if (e.target === el) { UI.sheet = null; render(); } },
    'closesheet-btn': () => { UI.sheet = null; render(); },
    zone: el => { UI.zoneId = el.dataset.id; UI.cam = null; UI.camZone = null; render(); },
    listtoggle: () => { UI.list = !UI.list; render(); },
    fit: () => { try { localStorage.removeItem(`rs_cam_${ctx.tenantId}_${UI.zoneId}`); } catch (e) { } UI.cam = null; UI.camZone = null; render(); },
    edittoggle: () => { UI.edit = !UI.edit; UI.sel = null; render(); },
    goedit: () => { UI.view = 'floor'; UI.edit = true; render(); },
    'tab-open': el => { UI.sheet = { type: 'table', tabId: el.dataset.id }; render(); },
    quicktab: async () => {
        const n = (prompt('Name for the tab (e.g. Wedding group, Bar stool 3)') || '').trim(); if (!n) return;
        try {
            const tab = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), label: n, status: 'open', opened_by: username() };
            await db(sb().from('rest_tabs').insert(tab)); await load();
            UI.sheet = { type: 'table', tabId: tab.id }; render();
        } catch (e) { }
    },
    temptable: async () => {
        try {
            const r = await addTable(true);
            if (UI.sheet && UI.sheet.type === 'pick') { render(); return; }
            render(); toast(r.label + ' added');
        } catch (e) { }
    },
    startorder: el => { UI.pickTarget = { tableId: el.dataset.id }; UI.view = 'order'; UI.sheet = null; render(); },
    addmore: el => { UI.pickTarget = { tabId: el.dataset.id }; UI.view = 'order'; UI.sheet = null; render(); },
    serve: async el => {
        const it = D.items.find(i => i.id === el.dataset.id); if (!it) return;
        const withWho = D.items.some(i => 'served_by' in i), snap = snapItems();
        it.status = 'served'; if (withWho) it.served_by = username();
        render();
        try { await db(sb().from('rest_tab_items').update(withWho ? { status: 'served', served_by: username() } : { status: 'served' }).eq('id', it.id).eq('status', 'ready')); scheduleLoad(); }
        catch (e) { D.items = snap; await load(); render(); }
    },
    void: el => voidItem(el.dataset.id),
    reqbill: async el => {
        const tb = tabById(el.dataset.id); if (!tb) return;
        const was = !!tb.bill_requested;
        tb.bill_requested = !was; render();
        try { await db(sb().from('rest_tabs').update({ bill_requested: !was }).eq('id', tb.id)); scheduleLoad(); }
        catch (e) { tb.bill_requested = was; await load(); render(); }
    },
    closeempty: async el => { try { await db(sb().from('rest_tabs').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', el.dataset.id)); UI.sheet = null; await load(); render(); } catch (e) { } },
    move: el => { UI.sheet = { type: 'move', tabId: el.dataset.id }; render(); },
    join: el => { UI.join = { tabId: el.dataset.id }; UI.sheet = null; UI.view = 'floor'; UI.list = false; render(); },
    'join-done': () => { UI.join = null; render(); },
    separate: async el => {
        const tabId = el.dataset.id, tid = el.dataset.t;
        if (tablesOfTab(tabId).length < 2) return;
        try {
            await db(sb().from('rest_tab_tables').delete().eq('tab_id', tabId).eq('table_id', tid));
            await load(); await relabel(tabId); await load(); UI.sheet = null; render();
            toast('Separated. Items stay on the remaining tab.');
        } catch (e) { }
    },
    bill: el => {
        const tab = tabById(el.dataset.id); if (!tab) return;
        let svc = 0; try { svc = Number(localStorage.getItem('rs_svc_' + ctx.tenantId)) || 0; } catch (e) { }
        UI.bill = { sel: new Set(unpaidItems(tab.id).filter(i => !waitingForStock(i)).map(i => i.id)), svc, chan: billChannels()[0] };
        UI.sheet = { type: 'bill', tabId: tab.id }; render();
    },
    billsel: el => { if (el.checked) UI.bill.sel.add(el.dataset.id); else UI.bill.sel.delete(el.dataset.id); updateBillTotals(); },
    pay: () => payBill(),
    station: el => { setStation(el.dataset.s); prunePending(0); render(); },
    soundtoggle: () => { setSound(!soundOn()); if (soundOn()) unlockAudio(); prunePending(0); render(); },
    soundtest: () => {
        unlockAudio();
        const a = audio();
        if (!a) { toast('This phone cannot play sound here.', true); return; }
        const go = () => { alarmBurst(a, UI.station === 'bar' ? 'bar' : 'kitchen', 0); render(); };
        if (a.state === 'running') go(); else a.resume().then(go, () => render());
    },
    ready: el => markReady([el.dataset.id]),
    readyall: el => markReady(D.items.filter(i => i.tab_id === el.dataset.id && i.status === 'new' && (UI.station === 'all' || i.station === UI.station)).map(i => i.id)),
    // layout editing
    addtable: async () => { try { await addTable(false); render(); } catch (e) { } },
    addzone: async () => {
        const n = (prompt('Zone name (e.g. Main hall, Terrace)') || '').trim(); if (!n) return;
        try {
            const z = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), name: n, sort: D.zones.length, active: true };
            await db(sb().from('rest_zones').insert(z)); await load(); UI.zoneId = z.id; UI.cam = null; UI.camZone = null; render();
        } catch (e) { }
    },
    renamezone: async () => {
        const z = D.zones.find(x => x.id === UI.zoneId); if (!z) return;
        const n = (prompt('Zone name', z.name) || '').trim(); if (!n) return;
        try { await db(sb().from('rest_zones').update({ name: n }).eq('id', z.id)); await load(); render(); } catch (e) { }
    },
    setup: async el => {
        const n = parseInt(prompt('How many tables? They will be laid out in a grid you can then drag into place.'), 10);
        if (!n || n < 1 || n > 200) return;
        const zoneId = el.dataset.id, cols = Math.ceil(Math.sqrt(n));
        const start = D.tables.filter(t => !t.is_temporary).length;
        const rows = Array.from({ length: n }, (_, i) => ({ id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), zone_id: zoneId,
            label: 'T' + (start + i + 1), shape: 'round', x: (i % cols) * 100, y: Math.floor(i / cols) * 100, width: DIAM, height: DIAM, rotation: 0, seats: 4, is_temporary: false, active: true, ...(UI.joinCol ? { join_group: null } : {}) }));
        try { await db(sb().from('rest_tables').insert(rows)); await load(); UI.zoneId = zoneId; UI.cam = null; UI.camZone = null; UI.view = 'floor'; UI.edit = true; render(); } catch (e) { }
    },
    dup: async () => {
        const t0 = tableById(UI.sel); if (!t0) return;
        const row = { ...t0, id: uid(), label: nextLabel(), x: t0.x + 100, y: t0.y, join_group: UI.joinCol ? null : undefined };
        delete row.created_at; if (!UI.joinCol) delete row.join_group;
        try { await db(sb().from('rest_tables').insert(row)); await load(); UI.sel = row.id; render(); } catch (e) { }
    },
    unjoin: async () => {
        const u = unitByKey(UI.zoneId, UI.sel); if (!u || u.ms.length < 2) return;
        try { await db(sb().from('rest_tables').update({ join_group: null }).in('id', u.ms.map(m => m.id))); u.ms.forEach(m => { m.join_group = null; }); UI.sel = null; toast('Separated'); render(); } catch (e) { }
    },
    deltable: async () => {
        const t = tableById(UI.sel); if (!t) return;
        if (t.join_group) { toast('Separate this table first, then delete it.', true); return; }
        if (tabForTable(t.id)) { toast(t.label + ' has an open tab. Close it first.', true); return; }
        try {
            await patchTable(t.id, { active: false });
            UI.undo = { id: t.id, label: t.label }; UI.sel = null;
            setTimeout(() => { if (UI.undo && UI.undo.id === t.id) { UI.undo = null; if (UI.view === 'floor') render(); } }, 6000);
            await load(); render();
        } catch (e) { }
    },
    undo: async () => { if (!UI.undo) return; const id = UI.undo.id; UI.undo = null; try { await db(sb().from('rest_tables').update({ active: true }).eq('id', id)); await load(); render(); } catch (e) { } },
    // menu management
    'rep-run': () => runReport(),
    'var-open': el => { UI.varSel.open = el.value; },
    'var-close': el => { UI.varSel.close = el.value; },
    'var-run': () => runVariance(),
    'count-save': async () => {
        const lines = trackedItems().map(i => ({ id: i.id, qty: countQty(i.id) })).filter(l => l.qty !== null);
        if (!lines.length) { toast('Enter at least one quantity.', true); return; }
        const cid = uid();
        try {
            await db(sb().from('rest_counts').insert({ id: cid, tenant_id: ctx.tenantId, branch_id: branch(), location: (UI.count.loc || '').trim() || 'Bar', counted_by: username() }));
            try { await db(sb().from('rest_count_lines').insert(lines.map(l => ({ id: uid(), count_id: cid, tenant_id: ctx.tenantId, stock_item_id: l.id, qty: l.qty })))); }
            catch (e) { try { await sb().from('rest_counts').delete().eq('id', cid); } catch (x) { } throw e; }
            UI.count.vals = {}; toast('Count saved (' + lines.length + ' items)');
            await loadCounts(); render();
        } catch (e) { }
    },
    'w-open': () => { UI.sheet = { type: 'waste', draft: { mode: 'stock', name: '', qty: '', unit: 'base', reason: 'spilled_broken', note: '' } }; render(); },
    'w-mode': el => { UI.sheet.draft.mode = el.value; UI.sheet.draft.name = ''; UI.sheet.draft.unit = 'base'; render(); },
    'w-reason': el => { UI.sheet.draft.reason = el.value; },
    'w-unit': el => { UI.sheet.draft.unit = el.value; },
    'w-save': async () => {
        const d = UI.sheet.draft, qty = Number(d.qty);
        if (!(qty > 0)) { toast('Enter a quantity.', true); return; }
        let args;
        if (d.mode === 'stock') {
            const sid = matchStock(d.name);
            if (!sid) { toast('Choose a stock item from the list.', true); return; }
            let units = qty;
            if (d.unit === 'pack') { const size = Number((unitRow(sid) || {}).pack_size) || 0; if (!size) { toast('This item has no pack size.', true); return; } units = qty * size; }
            args = { p_stock_item: sid, p_qty: Math.round(units), p_menu_item: null, p_servings: 1 };
        } else {
            const m = D.menu.find(x => x.active && x.name.toLowerCase() === String(d.name).trim().toLowerCase());
            if (!m) { toast('Choose a menu item from the list.', true); return; }
            args = { p_stock_item: null, p_qty: null, p_menu_item: m.id, p_servings: Math.max(1, Math.round(qty)) };
        }
        try {
            const res = await db(sb().rpc('rest_log_waste', { ...args, p_reason: d.reason, p_note: d.note || '', p_by: username(), p_branch: branch() }));
            UI.sheet = null;
            toast(canCosts() ? 'Waste logged, cost ' + fmt(res && res.cost) : 'Waste logged');
            showShort(res); await loadWaste(); render();
        } catch (e) { }
    },
    'unit-edit': el => { UI.sheet = { type: 'unit', id: el.dataset.id }; render(); },
    'unit-save': async () => {
        const g = id => root.querySelector('#' + id);
        const size = parseFloat(g('rs-u-size').value);
        const row = { stock_item_id: UI.sheet.id, tenant_id: ctx.tenantId, base_unit: g('rs-u-base').value,
            pack_name: g('rs-u-pack').value.trim() || null, pack_size: size > 0 ? size : null };
        try { await db(sb().from('rest_stock_units').upsert(row, { onConflict: 'stock_item_id' })); UI.sheet = null; await load(); render(); } catch (e) { }
    },
    'rcp-add': () => { captureMenuForm(); UI.sheet.draft.lines.push({ stock_item_id: '', name: '', qty: '', newUnit: '' }); render(); },
    'rcp-del': el => { captureMenuForm(); UI.sheet.draft.lines.splice(+el.dataset.i, 1); render(); },
    'rcp-newunit': el => { UI.sheet.draft.lines[+el.dataset.i].newUnit = el.value; },
    'link-newunit': el => { UI.sheet.draft.linkUnit = el.value; },
    'mm-noprep': () => { captureMenuForm(); render(); },
    'mm-new': () => { UI.sheet = { type: 'menuedit' }; render(); },
    'mm-edit': el => { UI.sheet = { type: 'menuedit', id: el.dataset.id }; render(); },
    'mm-save': async () => {
        const g = id => root.querySelector('#' + id);
        const name = g('rs-m-name').value.trim(), price = parseFloat(g('rs-m-price').value);
        if (!name || isNaN(price) || price < 0) { toast('Enter a name and a price.', true); return; }
        const row = { tenant_id: ctx.tenantId, name, category: g('rs-m-cat').value.trim() || 'General', price, station: g('rs-m-station').value,
            no_prep: g('rs-m-noprep').checked, favourite: g('rs-m-fav').checked, active: g('rs-m-active').checked };
        let lines = [], link = null, newLinkName = '';
        if (UI.p2 && canMenu() && UI.sheet.draft) {
            const dd = UI.sheet.draft;
            if (row.no_prep) {
                link = matchStock(dd.linkName) || null;
                if (!link && String(dd.linkName || '').trim()) newLinkName = dd.linkName.trim();
            } else {
                lines = dd.lines.filter(l => l.stock_item_id || String(l.name || '').trim() || l.qty);
                lines.forEach(l => { l.stock_item_id = matchStock(l.name) || l.stock_item_id || ''; });
                if (lines.some(l => (!l.stock_item_id && !String(l.name || '').trim()) || !(Number(l.qty) >= 1) || !Number.isInteger(Number(l.qty)))) { toast('Each ingredient needs a name and a whole quantity of at least 1.', true); return; }
                if (lines.some(l => !l.stock_item_id && !l.newUnit)) { toast('Choose a unit (ml, g or pieces) for each new ingredient.', true); return; }
                const keys = lines.map(l => l.stock_item_id || 'new:' + String(l.name).trim().toLowerCase());
                if (new Set(keys).size !== lines.length) { toast('The same ingredient is listed twice.', true); return; }
            }
            row.stock_item_id = link; row.uses_stock = lines.length > 0 || !!link || !!newLinkName;
        }
        try {
            // Register typed-in ingredients in the inventory, with their unit
            for (const l of lines.filter(x => !x.stock_item_id)) {
                const created = createIngredient(l.name);
                l.stock_item_id = created.id;
                await db(sb().from('rest_stock_units').upsert({ stock_item_id: created.id, tenant_id: ctx.tenantId, base_unit: l.newUnit }, { onConflict: 'stock_item_id' }));
            }
            if (newLinkName) {
                const created = createIngredient(newLinkName);
                row.stock_item_id = created.id;
                await db(sb().from('rest_stock_units').upsert({ stock_item_id: created.id, tenant_id: ctx.tenantId, base_unit: UI.sheet.draft.linkUnit || 'piece' }, { onConflict: 'stock_item_id' }));
            }
            const id = UI.sheet.id || uid();
            if (UI.sheet.id) await db(sb().from('rest_menu_items').update(row).eq('id', id));
            else await db(sb().from('rest_menu_items').insert({ ...row, id, sort: D.menu.length }));
            if (UI.p2 && canMenu() && UI.sheet.draft) {
                await db(sb().from('rest_recipe_lines').delete().eq('menu_item_id', id));
                if (lines.length) await db(sb().from('rest_recipe_lines').insert(lines.map(l => ({ id: uid(), tenant_id: ctx.tenantId, menu_item_id: id, stock_item_id: l.stock_item_id, qty: Number(l.qty) }))));
            }
            UI.sheet = null; await load(); render();
        } catch (e) { }
    }
};

function wireEvents() {
    if (root.dataset.wired) return;
    root.dataset.wired = '1';
    root.addEventListener('click', e => {
        const kt = e.target.closest && e.target.closest('.rs-kt[data-tab]');
        if (kt && ackTab(kt.dataset.tab)) render();     // tapping the order (or its Ready button) stops its alarm
        const el = e.target.closest('[data-act]');
        if (!el || !root.contains(el)) return;
        if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox')) return; // those use 'change'
        if (el.tagName === 'INPUT') return; // checkbox uses change
        const fn = ACT[el.dataset.act];
        if (!fn) return;
        const r = fn(el, e);
        if (r && typeof r.finally === 'function' && el.classList && el.classList.contains('rs-btn')) {
            el.classList.add('busy');
            r.finally(() => el.classList.remove('busy'));
        }
    });
    root.addEventListener('change', e => {
        const el = e.target;
        if (el.dataset && el.dataset.act && (el.tagName === 'SELECT' || el.type === 'checkbox')) { const fn = ACT[el.dataset.act]; if (fn) fn(el, e); return; }
        if (el.dataset && el.dataset.f) { editField(el); return; }
        if (el.dataset && el.dataset.bind === 'chan') { UI.bill.chan = el.value; }
        if (el.dataset && (el.dataset.bind === 'rcpname' || el.dataset.bind === 'linkname')) { captureMenuForm(); render(); }
        if (el.dataset && el.dataset.bind === 'wname') render();
        if (UI.dirty) { /* a refresh was held back while typing */ }
    });
    root.addEventListener('input', e => {
        const el = e.target, b = el.dataset && el.dataset.bind;
        if (!b) return;
        if (b === 'q') { UI.q = el.value; updateOrderParts(); }
        else if (b === 'pickq') { UI.pickq = el.value; const c = root.querySelector('#rs-pickchips'); if (c) c.innerHTML = pickChips(); }
        else if (b === 'svc') { UI.bill.svc = el.value; updateBillTotals(); }
        else if (b === 'cloc') UI.count.loc = el.value;
        else if (b === 'cq') { UI.count.q = el.value; const l = root.querySelector('#rs-countlist'); if (l) l.innerHTML = countRows(); }
        else if (b === 'cpacks' || b === 'ctenths' || b === 'cqty') {
            const id = el.dataset.id, v = UI.count.vals[id] = UI.count.vals[id] || {};
            v[b === 'cpacks' ? 'packs' : b === 'ctenths' ? 'tenths' : 'qty'] = el.value;
            const sp = root.querySelector('#rs-ct-' + id), q = countQty(id);
            if (sp) sp.textContent = q === null ? '' : '= ' + q + ' ' + unitOf(id);
        }
        else if (b === 'wname' || b === 'wqty' || b === 'wnote') { UI.sheet.draft[b === 'wname' ? 'name' : b === 'wqty' ? 'qty' : 'note'] = el.value; }
        else if (b === 'rcpqty') { UI.sheet.draft.lines[+el.dataset.i].qty = el.value; updateCostLine(); }
        else if (b === 'mprice') updateCostLine();
        else if (b === 'linkname') { const d = UI.sheet.draft; d.linkName = el.value; d.link = matchStock(el.value); updateCostLine(); }
        else if (b === 'rcpname') { const l = UI.sheet.draft.lines[+el.dataset.i]; l.name = el.value; l.stock_item_id = matchStock(el.value); }
        else if (b === 'unitq') { UI.unitq = el.value; render(); const n = root.querySelector('[data-bind="unitq"]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }
    });
    root.addEventListener('focusout', () => { if (UI.dirty) setTimeout(() => { const a = document.activeElement; if (!(a && root.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) render(); }, 150); });
    setInterval(() => { if (UI.view === 'kitchen' && root && root.offsetParent !== null && !UI.sheet) render(); }, 30000);
}

async function editField(el) {
    const t = tableById(UI.sel); if (!t) return;
    const f = el.dataset.f;
    let v = el.value;
    if (['seats', 'width', 'height'].includes(f)) { v = Number(v); if (!v || v < 1) return; }
    if (f === 'label' && !String(v).trim()) return;
    try { await patchTable(t.id, { [f]: v }); render(); } catch (e) { }
}

// ---------------------------------------------------------------
// Entry points used by index.html / business-types.config.js
// ---------------------------------------------------------------
function injectCss() {
    if (document.getElementById('rs-css')) return;
    const s = document.createElement('style');
    s.id = 'rs-css'; s.textContent = css;
    document.head.appendChild(s);
}

// Called once after login by loadVerticalModule(). Nothing to draw on the
// dashboard for this vertical.
export function init(c) {
    ctx = c;
    // Order bell: restore this device's choices, unlock sound on the first tap, listen for new orders.
    injectCss();
    try {
        const st = localStorage.getItem('rs_station_' + ctx.tenantId);
        if (st === 'kitchen' || st === 'bar' || st === 'all') UI.station = st;
        UI.sound = localStorage.getItem('rs_sound_' + ctx.tenantId) !== 'off';
    } catch (e) { }
    if (!window._rsAudioHooked) {
        window._rsAudioHooked = true;
        const wake = () => { if (!(AC && AC.state === 'running')) { unlockAudio(); if (UI.pending.size) setTimeout(alarmNow, 80); } };
        ['pointerdown', 'touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, wake, { capture: true, passive: true }));
    }
    try { startOrderWatch(); } catch (e) { console.warn('Order bell listener not started:', e); }
    // Pack sizes are needed by the Purchase page before the Restaurant page is ever opened.
    window.restaurantPackSize = id => { const u = D.units.find(x => x.stock_item_id === id); return u && Number(u.pack_size) > 0 ? Number(u.pack_size) : 0; };
    loadUnitsQuiet();
}
export function refresh(c) { if (c) ctx = c; }

// Called by switchView('restaurant') in index.html.
export async function renderRestaurant(c) {
    if (c) ctx = { ...ctx, ...c };
    root = document.getElementById('restaurant-mount');
    if (!root || !ctx) return;
    injectCss(); wireEvents();
    if (!UI.booted) { UI.booted = true; root.innerHTML = '<div class="rs"><div class="rs-muted">Loading…</div></div>'; subscribe(); }
    await load();
    render();
}
