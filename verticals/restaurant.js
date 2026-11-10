// verticals/restaurant.js
//
// Only fetched for tenants with business_type === 'restaurant' (see
// business-types.config.js -> loadVerticalModule).
//
// Phase 1: floor map, tabs, kitchen / bar screen, bill and close.
// Not in this phase: recipes and stock deduction (Phase 2), counts,
// variance and waste log (Phase 3).
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
.rs button{font-family:inherit}
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
.rs-mapwrap{border:1px solid var(--border);border-radius:10px;background:var(--bg);overflow:hidden;touch-action:none}
.rs-map{width:100%;height:58vh;min-height:320px;display:block;touch-action:none;user-select:none;-webkit-user-select:none}
.rs-t rect,.rs-t ellipse{stroke-width:2}
.rs-t text{font-size:15px;font-weight:600;text-anchor:middle;dominant-baseline:middle;pointer-events:none;fill:#222}
.rs-t text.s{font-size:11px;font-weight:400}
.rs-t.free rect,.rs-t.free ellipse{fill:#EDF0EC;stroke:#b9c2b8}
.rs-t.seated rect,.rs-t.seated ellipse,.rs-t.served rect,.rs-t.served ellipse{fill:#E6EEF7;stroke:#7f9cc0}
.rs-t.ordered rect,.rs-t.ordered ellipse{fill:#FCEEDD;stroke:#C97A22}
.rs-t.ready rect,.rs-t.ready ellipse{fill:#DDF1E6;stroke:#3E9B78}
.rs-t.bill rect,.rs-t.bill ellipse{fill:#E6E3F7;stroke:#6a5fc0}
.rs-t.sel rect,.rs-t.sel ellipse{stroke:#d33;stroke-dasharray:6 3}
.rs-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--text-light);margin:8px 0}
.rs-dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.rs-ov{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2000;display:flex;align-items:flex-end;justify-content:center}
.rs-sheet{background:var(--surface);width:100%;max-width:560px;max-height:88vh;overflow:auto;border-radius:16px 16px 0 0;padding:16px;color:var(--text)}
@media(min-width:700px){.rs-ov{align-items:center}.rs-sheet{border-radius:16px}}
.rs-sheet h3{margin:0 0 8px;font-size:17px}
.rs-st{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;background:#eee;color:#555}
.rs-st.new{background:#FCEEDD;color:#8a4b0f}.rs-st.ready{background:#DDF1E6;color:#1f6b4c}.rs-st.void{background:#FAECE7;color:#8d2b1c}
.rs-kt{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:12px;margin-bottom:10px}
.rs-kt.late{border-color:#B23A2E}
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

function beep() {
    try {
        const a = new (window.AudioContext || window.webkitAudioContext)();
        const o = a.createOscillator(), g = a.createGain();
        o.connect(g); g.connect(a.destination);
        o.frequency.value = 880; g.gain.value = 0.15;
        o.start(); setTimeout(() => { o.stop(); a.close(); }, 250);
    } catch (e) { }
}

// ---------------------------------------------------------------
// Data
// ---------------------------------------------------------------
const D = { zones: [], tables: [], menu: [], tabs: [], tabTables: [], items: [] };
const UI = {
    view: null, zoneId: null, cat: 'All', q: '', cart: [], pickTarget: null,
    sheet: null, edit: false, sel: null, list: false, join: null, station: 'kitchen',
    vb: null, error: null, chan: null, seenNew: null, undo: null, dirty: false, booted: false, loadedOnce: false
};

async function load() {
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

    // New-order sound on the kitchen screen
    const nowNew = new Set(D.items.filter(i => i.status === 'new' && !D.menu.find(m => m.id === i.menu_item_id)?.no_prep).map(i => i.id));
    if (UI.seenNew && UI.view === 'kitchen') {
        for (const id of nowNew) if (!UI.seenNew.has(id)) { beep(); break; }
    }
    UI.seenNew = nowNew;
    UI.loadedOnce = true;
}

let loadTimer = null;
function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(async () => {
        if (!root || !document.body.contains(root)) return;
        await load();
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
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'tenant_id=eq.' + tid }, () => scheduleLoad());
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
    const link = D.tabTables.find(x => x.table_id === tableId);
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

function availableViews() {
    const v = [];
    if (canOrder()) { v.push(['order', 'Menu']); v.push(['floor', 'Tables']); }
    if (canKitchen()) v.push(['kitchen', 'Kitchen / Bar']);
    if (canMenu() || canLayout()) v.push(['manage', 'Manage']);
    return v;
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------
function render() {
    if (!root) return;
    UI.dirty = false;
    if (UI.error) {
        const missing = /rest_|relation|schema cache/i.test(UI.error);
        root.innerHTML = `<div class="rs"><div class="rs-err">${missing
            ? 'The restaurant tables are not in the database yet. Run <b>restaurant-phase1.sql</b> in the Supabase SQL editor, then reload.'
            : 'Could not load: ' + esc(UI.error)}</div></div>`;
        return;
    }
    const views = availableViews();
    if (!views.length) { root.innerHTML = '<div class="rs"><div class="rs-card">Your role does not have restaurant access. Ask the owner to turn it on under Roles.</div></div>'; return; }
    if (!UI.view || !views.some(v => v[0] === UI.view)) UI.view = views[0][0];
    if (!UI.zoneId || !D.zones.some(z => z.id === UI.zoneId)) UI.zoneId = D.zones[0]?.id || null;
    const body = UI.view === 'order' ? orderView() : UI.view === 'floor' ? floorView() : UI.view === 'kitchen' ? kitchenView() : manageView();
    const nav = views.map(([k, l]) => `<button class="rs-tab ${UI.view === k ? 'on' : ''}" data-act="view" data-v="${k}">${l}${k === 'order' && UI.cart.length ? ` (${UI.cart.reduce((s, c) => s + c.qty, 0)})` : ''}</button>`).join('');
    const off = navigator.onLine ? '' : '<div class="rs-offline">No connection. Orders cannot be sent until the internet is back.</div>';
    root.innerHTML = `<div class="rs"><div class="rs-bar">${nav}</div>${off}${body}</div>${sheetHtml()}`;
    afterRender();
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
function fitBox(zoneId) {
    const ts = D.tables.filter(t => t.zone_id === zoneId);
    if (!ts.length) return { x: 0, y: 0, w: 600, h: 400 };
    const x0 = Math.min(...ts.map(t => t.x)) - 50, y0 = Math.min(...ts.map(t => t.y)) - 50;
    const x1 = Math.max(...ts.map(t => t.x + t.width)) + 50, y1 = Math.max(...ts.map(t => t.y + t.height)) + 50;
    return { x: x0, y: y0, w: Math.max(300, x1 - x0), h: Math.max(220, y1 - y0) };
}
function getVb(zoneId) {
    if (UI.vb && UI.vbZone === zoneId) return UI.vb;
    let v = null;
    try { v = JSON.parse(localStorage.getItem(`rs_vb_${ctx.tenantId}_${zoneId}`) || 'null'); } catch (e) { }
    UI.vb = v && v.w ? v : fitBox(zoneId);
    UI.vbZone = zoneId;
    return UI.vb;
}
function saveVb() { try { localStorage.setItem(`rs_vb_${ctx.tenantId}_${UI.vbZone}`, JSON.stringify(UI.vb)); } catch (e) { } }
const vbStr = v => `${v.x} ${v.y} ${v.w} ${v.h}`;

function mapInner(zoneId) {
    const ts = D.tables.filter(t => t.zone_id === zoneId);
    const v = getVb(zoneId);
    if (!ts.length) return `<text x="${v.x + v.w / 2}" y="${v.y + v.h / 2}" text-anchor="middle" fill="#888" font-size="16">No tables in this zone yet</text>`;
    const detail = v.w < 520;
    return ts.map(t => {
        const st = tableStatus(t), cx = t.x + t.width / 2, cy = t.y + t.height / 2;
        const rot = `transform="rotate(${t.rotation || 0} ${cx} ${cy})"`;
        const shape = t.shape === 'round'
            ? `<ellipse cx="${cx}" cy="${cy}" rx="${t.width / 2}" ry="${t.height / 2}" ${rot}/>`
            : `<rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" rx="10" ${rot}/>`;
        const tab = tabForTable(t.id);
        const sub = detail && tab ? `<text class="s" x="${cx}" y="${cy + 14}">${fmt(tabAmount(tab.id))} · ${mins(tab.opened_at)}m</text>` : '';
        const cls = (UI.edit && UI.sel === t.id) || (UI.join && tab && tab.id === UI.join.tabId) ? ' sel' : '';
        return `<g class="rs-t ${st}${cls}" data-tid="${t.id}">${shape}<text x="${cx}" y="${detail && tab ? cy - 6 : cy}">${esc(t.label)}</text>${sub}</g>`;
    }).join('');
}
function mapHtml(zoneId) {
    const v = getVb(zoneId);
    return `<div class="rs-mapwrap"><svg class="rs-map" viewBox="${vbStr(v)}">${mapInner(zoneId)}</svg></div>`;
}
const LEGEND = `<div class="rs-legend"><span><i class="rs-dot" style="background:#EDF0EC;border:1px solid #b9c2b8"></i>Free</span><span><i class="rs-dot" style="background:#FCEEDD;border:1px solid #C97A22"></i>Ordered</span><span><i class="rs-dot" style="background:#DDF1E6;border:1px solid #3E9B78"></i>Food ready</span><span><i class="rs-dot" style="background:#E6E3F7;border:1px solid #6a5fc0"></i>Bill requested</span></div>`;

function wireMap() {
    root.querySelectorAll('svg.rs-map').forEach(wireOne);
}
function wireOne(svg) {
    const P = new Map();
    let drag = null, pinch = null, lastTap = 0;
    const upp = () => 1 / Math.min(svg.clientWidth / UI.vb.w, svg.clientHeight / UI.vb.h || 1);
    const setVb = () => svg.setAttribute('viewBox', vbStr(UI.vb));
    const redraw = () => { svg.innerHTML = mapInner(UI.vbZone); };
    const clamp = w => Math.min(4000, Math.max(150, w));

    svg.addEventListener('pointerdown', e => {
        svg.setPointerCapture(e.pointerId);
        P.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (P.size === 1) {
            const g = e.target.closest('[data-tid]');
            const t = g ? tableById(g.dataset.tid) : null;
            drag = { tid: t ? t.id : null, moved: false, sx: e.clientX, sy: e.clientY, vb: { ...UI.vb }, ox: t ? t.x : 0, oy: t ? t.y : 0 };
            if (UI.edit && t && canLayout()) { UI.sel = t.id; }
        } else if (P.size === 2) {
            const [a, b] = [...P.values()];
            const r = svg.getBoundingClientRect();
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const k = upp();
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), vb: { ...UI.vb },
                fx: UI.vb.x + (mx - r.left) * k, fy: UI.vb.y + (my - r.top) * k,
                rx: (mx - r.left) / r.width, ry: (my - r.top) / r.height };
            drag = null;
        }
    });
    svg.addEventListener('pointermove', e => {
        if (!P.has(e.pointerId)) return;
        P.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && P.size >= 2) {
            const [a, b] = [...P.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const w = clamp(pinch.vb.w * pinch.d / d), h = w * pinch.vb.h / pinch.vb.w;
            UI.vb = { x: pinch.fx - pinch.rx * w, y: pinch.fy - pinch.ry * h, w, h };
            setVb(); return;
        }
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        const k = upp();
        if (UI.edit && drag.tid && canLayout()) {
            const t = tableById(drag.tid);
            t.x = Math.round((drag.ox + dx * k) / 10) * 10;
            t.y = Math.round((drag.oy + dy * k) / 10) * 10;
            redraw();
        } else {
            UI.vb = { ...drag.vb, x: drag.vb.x - dx * k, y: drag.vb.y - dy * k };
            setVb();
        }
    });
    const end = async e => {
        if (!P.has(e.pointerId)) return;
        P.delete(e.pointerId);
        if (pinch) { if (P.size < 2) { pinch = null; saveVb(); redraw(); } return; }
        const d = drag; drag = null;
        if (!d) return;
        if (!d.moved) {
            const now = Date.now();
            if (!d.tid && now - lastTap < 350) { // double tap on empty space: zoom in
                const k = upp(), r = svg.getBoundingClientRect();
                const fx = UI.vb.x + (e.clientX - r.left) * k, fy = UI.vb.y + (e.clientY - r.top) * k;
                const w = clamp(UI.vb.w / 2), h = w * UI.vb.h / UI.vb.w;
                UI.vb = { x: fx - (e.clientX - r.left) / r.width * w, y: fy - (e.clientY - r.top) / r.height * h, w, h };
                setVb(); redraw(); saveVb();
            }
            lastTap = now;
            if (d.tid) onTableTap(d.tid);
        } else if (UI.edit && d.tid && canLayout()) {
            const t = tableById(d.tid);
            try { await db(sb().from('rest_tables').update({ x: t.x, y: t.y }).eq('id', t.id)); } catch (er) { await load(); }
            render();
        } else { saveVb(); redraw(); }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', e => {
        e.preventDefault();
        const k = upp(), r = svg.getBoundingClientRect();
        const fx = UI.vb.x + (e.clientX - r.left) * k, fy = UI.vb.y + (e.clientY - r.top) * k;
        const w = clamp(UI.vb.w * (e.deltaY < 0 ? 0.87 : 1.15)), h = w * UI.vb.h / UI.vb.w;
        UI.vb = { x: fx - (e.clientX - r.left) / r.width * w, y: fy - (e.clientY - r.top) / r.height * h, w, h };
        setVb(); redraw(); saveVb();
    }, { passive: false });
}

function onTableTap(tid) {
    const t = tableById(tid);
    if (!t) return;
    if (UI.edit && canLayout()) { render(); return; }
    // Joining tables: tap the tables to add to the group
    if (UI.join) { joinTap(t); return; }
    // Picking a table for the waiter's cart
    if (UI.sheet && UI.sheet.type === 'pick') { sendCart({ tableId: t.id }); return; }
    // Moving a tab to another table
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
        const t = UI.sel ? tableById(UI.sel) : null;
        edit = `<div class="rs-card" style="margin-top:10px"><div class="rs-row"><button class="rs-btn pri" data-act="addtable">+ Table</button><button class="rs-btn" data-act="addzone">+ Zone</button><button class="rs-btn" data-act="renamezone">Rename zone</button><span class="rs-muted">Drag tables to move them.</span></div>
        ${t ? `<div class="rs-row" style="margin-top:10px">
            <label>Name <input data-f="label" value="${esc(t.label)}" size="8"></label>
            <label>Shape <select data-f="shape"><option value="square" ${t.shape === 'square' ? 'selected' : ''}>Square</option><option value="wide" ${t.shape === 'wide' ? 'selected' : ''}>Wide</option><option value="round" ${t.shape === 'round' ? 'selected' : ''}>Round</option></select></label>
            <label>Seats <input data-f="seats" type="number" min="1" value="${t.seats || 4}" style="width:64px"></label>
            <label>W <input data-f="width" type="number" min="40" step="10" value="${t.width}" style="width:70px"></label>
            <label>H <input data-f="height" type="number" min="40" step="10" value="${t.height}" style="width:70px"></label>
            <button class="rs-btn sm" data-act="rot">Rotate 90°</button><button class="rs-btn sm" data-act="dup">Duplicate</button><button class="rs-btn sm dan" data-act="deltable">Delete</button></div>` : '<div class="rs-muted" style="margin-top:8px">Tap a table to edit it.</div>'}
        ${UI.undo ? `<div class="rs-row" style="margin-top:8px"><span>Deleted ${esc(UI.undo.label)}</span><button class="rs-btn sm" data-act="undo">Undo</button></div>` : ''}</div>`;
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
function sheetHtml() {
    const sh = UI.sheet;
    if (!sh) return '';
    let inner = '';
    if (sh.type === 'pick') inner = pickSheet();
    else if (sh.type === 'table') inner = tableSheet();
    else if (sh.type === 'bill') inner = billSheet();
    else if (sh.type === 'move') inner = moveSheet();
    else if (sh.type === 'menuedit') inner = menuEditSheet();
    return `<div class="rs-ov" data-act="closesheet"><div class="rs-sheet rs">${inner}</div></div>`;
}

function statusWord(t) {
    const s = tableStatus(t);
    return { free: 'free', seated: 'seated', served: 'served', ordered: 'ordered', ready: 'food ready', bill: 'bill requested' }[s];
}
function pickChips() {
    const q = (UI.pickq || '').trim().toLowerCase();
    const list = D.tables.filter(t => !q || t.label.toLowerCase().includes(q))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return list.map(t => `<button class="rs-chip" data-act="pick-table" data-id="${t.id}">${esc(t.label)} <span class="rs-muted">${statusWord(t)}</span></button>`).join('') || '<span class="rs-muted">No table matches.</span>';
}
function pickSheet() {
    const opts = D.tables.slice().sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        .map(t => `<option value="${t.id}">${esc(t.label)} (${statusWord(t)})</option>`).join('');
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
    return `<tr><td>${i.qty} × ${esc(i.name)}${i.note ? `<div class="rs-muted">${esc(i.note)}</div>` : ''}</td>
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
    const rows = lines.map(i => `<tr><td><input type="checkbox" data-act="billsel" data-id="${i.id}" ${B.sel.has(i.id) ? 'checked' : ''}></td><td>${i.qty} × ${esc(i.name)}</td><td style="text-align:right">${fmt(i.qty * i.unit_price)}</td></tr>`).join('');
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

function menuEditSheet() {
    const m = UI.sheet.id ? menuById(UI.sheet.id) : {};
    const cats = [...new Set(D.menu.map(x => x.category || 'General'))].map(c => `<option value="${esc(c)}">`).join('');
    return `<h3>${m.id ? 'Edit' : 'New'} menu item</h3>
        <div style="display:grid;gap:8px">
        <input id="rs-m-name" placeholder="Name (e.g. Mojito)" value="${esc(m.name || '')}">
        <input id="rs-m-cat" list="rs-cats" placeholder="Category (e.g. Cocktails)" value="${esc(m.category || '')}"><datalist id="rs-cats">${cats}</datalist>
        <input id="rs-m-price" type="number" min="0" step="0.01" placeholder="Price" value="${m.price ?? ''}">
        <select id="rs-m-station"><option value="kitchen" ${m.station !== 'bar' ? 'selected' : ''}>Kitchen</option><option value="bar" ${m.station === 'bar' ? 'selected' : ''}>Bar</option></select>
        <label><input id="rs-m-noprep" type="checkbox" ${m.no_prep ? 'checked' : ''}> No preparation (bottled drink: skips the kitchen/bar screen)</label>
        <label><input id="rs-m-fav" type="checkbox" ${m.favourite ? 'checked' : ''}> Show first (popular)</label>
        <label><input id="rs-m-active" type="checkbox" ${m.id ? (m.active ? 'checked' : '') : 'checked'}> On the menu</label></div>
        <div class="rs-row" style="margin-top:12px"><button class="rs-btn pri" data-act="mm-save">Save</button><button class="rs-btn" data-act="closesheet-btn">Cancel</button></div>`;
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
        return `<div class="rs-kt ${age >= 15 ? 'late' : ''}"><div class="rs-row"><b style="font-size:18px">${esc(tabLabel(tab))}</b><span class="rs-muted">${age} min</span><span class="rs-sp"></span>
            ${its.length > 1 ? `<button class="rs-btn sm" data-act="readyall" data-id="${tab.id}">All ready</button>` : ''}</div>
            ${its.map(i => `<div class="rs-kitem"><div class="n">${i.qty} × ${esc(i.name)}${i.note ? `<div class="rs-muted" style="font-size:13px">${esc(i.note)}</div>` : ''}</div><button class="rs-btn pri" data-act="ready" data-id="${i.id}">Ready</button></div>`).join('')}</div>`;
    }).join('');
    return `<div class="rs-row"><div class="rs-chips" style="margin:0">${seg}</div><span class="rs-sp"></span><span class="rs-muted">${navigator.onLine ? (UI.live ? 'Live' : 'Refreshing every 20 s') : 'Offline'}</span></div>
        ${cards || '<div class="rs-card rs-muted" style="margin-top:10px">No orders waiting.</div>'}`;
}

// ---------------------------------------------------------------
// Manage: menu, zones and tables
// ---------------------------------------------------------------
function manageView() {
    let html = '';
    if (canMenu()) {
        const rows = D.menu.slice().sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name)).map(m => `<tr data-act="mm-edit" data-id="${m.id}" style="cursor:pointer;${m.active ? '' : 'opacity:.5'}"><td><b>${esc(m.name)}</b><div class="rs-muted">${esc(m.category || 'General')}${m.no_prep ? ' · no prep' : ''}</div></td><td>${m.station === 'bar' ? 'Bar' : 'Kitchen'}</td><td style="text-align:right">${fmt(m.price)}</td></tr>`).join('');
        html += `<div class="rs-card" style="margin-bottom:12px"><div class="rs-row"><b>Menu</b><span class="rs-sp"></span><button class="rs-btn pri sm" data-act="mm-new">+ Menu item</button></div>
            ${rows ? `<table class="rs-tbl" style="margin-top:8px">${rows}</table>` : '<div class="rs-muted" style="margin-top:8px">No items yet.</div>'}</div>`;
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
    const v = getVb(UI.zoneId);
    const n = D.tables.filter(t => t.is_temporary).length + 1;
    const row = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), zone_id: UI.zoneId,
        label: temp ? 'Temp ' + n : nextLabel(), shape: 'square',
        x: Math.round((v.x + v.w / 2 - 40) / 10) * 10, y: Math.round((v.y + v.h / 2 - 40) / 10) * 10,
        width: 80, height: 80, rotation: 0, seats: 4, is_temporary: !!temp, active: true };
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
    let created = null;
    try {
        let tab = null;
        if (target.tabId) tab = tabById(target.tabId);
        else if (target.tableId) {
            tab = tabForTable(target.tableId);
            if (!tab) {
                const t = tableById(target.tableId);
                tab = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), label: t.label, status: 'open', opened_by: username() };
                await db(sb().from('rest_tabs').insert(tab));
                created = tab;
                await db(sb().from('rest_tab_tables').insert({ tab_id: tab.id, table_id: t.id, tenant_id: ctx.tenantId }));
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
        if (!tab) { toast('Pick a table.', true); return; }
        const rows = UI.cart.map(c => ({ id: uid(), tenant_id: ctx.tenantId, tab_id: tab.id, menu_item_id: c.id, name: c.name,
            qty: c.qty, unit_price: c.price, note: c.note || null, station: c.station, status: c.no_prep ? 'served' : 'new', added_by: username() }));
        await db(sb().from('rest_tab_items').insert(rows));
        const where = tabLabelSafe(tab, target);
        UI.cart = []; UI.pickTarget = null; UI.sheet = null; UI.pickq = '';
        toast('Sent to ' + where);
        await load(); render();
    } catch (e) {
        if (created) { try { await sb().from('rest_tabs').delete().eq('id', created.id); } catch (x) { } }
        render();
    } finally { UI.sending = false; }
}
function tabLabelSafe(tab, target) {
    if (target.tableId) { const t = tableById(target.tableId); if (t) return t.label; }
    return tab.label || 'tab';
}

async function markReady(ids) {
    try {
        await db(sb().from('rest_tab_items').update({ status: 'ready', ready_at: new Date().toISOString(), ready_by: username() }).in('id', ids).eq('status', 'new'));
        await load(); render();
    } catch (e) { }
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
    try {
        await db(sb().from('rest_tab_items').update({ status: 'void', voided_by: username(), void_reason: reason }).eq('id', id).neq('status', 'void'));
        await load(); render();
    } catch (e) { }
}

async function relabel(tabId) {
    const tab = tabById(tabId);
    if (!tab) return;
    const label = tabLabel(tab);
    if (label !== tab.label) await db(sb().from('rest_tabs').update({ label }).eq('id', tabId));
}

async function moveTab(tabId, table) {
    if (tabForTable(table.id)) { toast(table.label + ' already has a tab.', true); return; }
    try {
        await db(sb().from('rest_tab_tables').insert({ tab_id: tabId, table_id: table.id, tenant_id: ctx.tenantId }));
        const old = tablesOfTab(tabId).filter(t => t.id !== table.id).map(t => t.id);
        if (old.length) await db(sb().from('rest_tab_tables').delete().eq('tab_id', tabId).in('table_id', old));
        await db(sb().from('rest_tabs').update({ label: table.label }).eq('id', tabId));
        UI.sheet = null; await load(); render(); toast('Moved to ' + table.label);
    } catch (e) { }
}

async function joinTap(t) {
    const main = tabById(UI.join.tabId);
    if (!main) { UI.join = null; render(); return; }
    if (tablesOfTab(main.id).some(x => x.id === t.id)) return;
    const other = tabForTable(t.id);
    try {
        if (!other) {
            await db(sb().from('rest_tab_tables').insert({ tab_id: main.id, table_id: t.id, tenant_id: ctx.tenantId }));
        } else {
            // Items keep who ordered them and their kitchen status, so nothing is re-sent.
            await db(sb().from('rest_tab_items').update({ tab_id: main.id }).eq('tab_id', other.id));
            await db(sb().from('rest_tab_tables').update({ tab_id: main.id }).eq('tab_id', other.id));
            await db(sb().from('rest_tabs').update({ status: 'merged', merged_into: main.id }).eq('id', other.id));
        }
        await load(); await relabel(main.id); await load(); render();
    } catch (e) { }
}

async function recordSale(tab, lines, svc, chan) {
    const codes = ctx.channelAccountCodes || (typeof CHANNEL_ACCOUNT_CODES !== 'undefined' ? CHANNEL_ACCOUNT_CODES : {});
    const code = codes[chan];
    const st = (S().saleTypes || [])[0];
    const sType = typeof st === 'string' ? st : (st && (st.name || st.label)) || 'Sale';
    const date = todayISO(), groupId = 'RB-' + Date.now(), branchId = branch(), customer = tabLabel(tab) || 'Walk-in';
    const rows = lines.map(i => ({ desc: i.name, qty: i.qty, price: Number(i.unit_price) }));
    if (svc > 0) rows.push({ desc: 'Service charge', qty: 1, price: svc });
    let total = 0;
    const made = rows.map((r, idx) => {
        const amt = round2(r.qty * r.price); total += amt;
        const row = { id: `SL-${Date.now().toString().slice(-5)}-${idx}`, date, customer, desc: r.desc, qty: r.qty, price: r.price, total: amt, cogs: 0,
            channel: chan, type: sType, paid: true, paidChannel: chan, amountPaid: amt, payments: [{ date, amount: amt, channel: chan }],
            restorationLayers: [], branchId, groupId, vatIncluded: false };
        S().salesLog.push(row);
        window.queueWrite({ kind: 'insert', table: 'sales_log', row: window.toDbSale(row) });
        return row;
    });
    const journal = { id: made[0].id, date, desc: window.stampDesc(`Restaurant bill: ${customer}`), branchId,
        lines: [{ account: code, dr: round2(total), cr: 0 }, { account: '4010', cr: round2(total), dr: 0 }] };
    S().journal.push(journal);
    window.queueWrite({ kind: 'insert', table: 'journal_entries', row: window.toDbJournal(journal) });
    if (typeof window.addNotification === 'function') window.addNotification('Restaurant bill paid', `ETB ${fmt(total)} (${chan})`, `${customer}: ${lines.length} item(s)`);
    if (typeof window.renderSalesLogTable === 'function') { try { window.renderSalesLogTable(); } catch (e) { } }
    return total;
}

async function payBill() {
    const tab = tabById(UI.sheet.tabId), B = UI.bill;
    if (!tab || UI.paying) return;
    const lines = unpaidItems(tab.id).filter(i => B.sel.has(i.id));
    if (!lines.length) { toast('Select at least one item.', true); return; }
    const codes = ctx.channelAccountCodes || (typeof CHANNEL_ACCOUNT_CODES !== 'undefined' ? CHANNEL_ACCOUNT_CODES : {});
    if (!codes[B.chan]) { toast('Choose how it was paid.', true); return; }
    UI.paying = true;
    try {
        const sub = lines.reduce((s, i) => s + i.qty * i.unit_price, 0);
        const svc = round2(sub * (Number(B.svc) || 0) / 100);
        const ids = lines.map(i => i.id);
        // Claim the items first. If someone else paid some of them a moment ago, stop.
        const got = await db(sb().from('rest_tab_items').update({ paid: true }).in('id', ids).eq('paid', false).select('id'));
        if (got.length !== ids.length) {
            if (got.length) await db(sb().from('rest_tab_items').update({ paid: false }).in('id', got.map(g => g.id)));
            toast('Some of these items were just paid by someone else. Reloading.', true);
            await load(); render(); return;
        }
        await recordSale(tab, lines, svc, B.chan);
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
    view: el => { UI.view = el.dataset.v; UI.sheet = null; UI.join = null; render(); },
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
    zone: el => { UI.zoneId = el.dataset.id; UI.vb = null; render(); },
    listtoggle: () => { UI.list = !UI.list; render(); },
    fit: () => { UI.vb = fitBox(UI.zoneId); UI.vbZone = UI.zoneId; saveVb(); render(); },
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
    serve: async el => { try { await db(sb().from('rest_tab_items').update({ status: 'served' }).eq('id', el.dataset.id).eq('status', 'ready')); await load(); render(); } catch (e) { } },
    void: el => voidItem(el.dataset.id),
    reqbill: async el => { const t = tabById(el.dataset.id); try { await db(sb().from('rest_tabs').update({ bill_requested: !t.bill_requested }).eq('id', t.id)); await load(); render(); } catch (e) { } },
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
        UI.bill = { sel: new Set(unpaidItems(tab.id).map(i => i.id)), svc, chan: billChannels()[0] };
        UI.sheet = { type: 'bill', tabId: tab.id }; render();
    },
    billsel: el => { if (el.checked) UI.bill.sel.add(el.dataset.id); else UI.bill.sel.delete(el.dataset.id); updateBillTotals(); },
    pay: () => payBill(),
    station: el => { UI.station = el.dataset.s; render(); },
    ready: el => markReady([el.dataset.id]),
    readyall: el => markReady(D.items.filter(i => i.tab_id === el.dataset.id && i.status === 'new' && (UI.station === 'all' || i.station === UI.station)).map(i => i.id)),
    // layout editing
    addtable: async () => { try { await addTable(false); render(); } catch (e) { } },
    addzone: async () => {
        const n = (prompt('Zone name (e.g. Main hall, Terrace)') || '').trim(); if (!n) return;
        try {
            const z = { id: uid(), tenant_id: ctx.tenantId, branch_id: branch(), name: n, sort: D.zones.length, active: true };
            await db(sb().from('rest_zones').insert(z)); await load(); UI.zoneId = z.id; UI.vb = null; render();
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
            label: 'T' + (start + i + 1), shape: 'square', x: (i % cols) * 110, y: Math.floor(i / cols) * 110, width: 80, height: 80, rotation: 0, seats: 4, is_temporary: false, active: true }));
        try { await db(sb().from('rest_tables').insert(rows)); await load(); UI.zoneId = zoneId; UI.vb = null; UI.view = 'floor'; UI.edit = true; render(); } catch (e) { }
    },
    rot: async () => { const t = tableById(UI.sel); if (!t) return; try { await patchTable(t.id, { rotation: ((t.rotation || 0) + 90) % 360 }); render(); } catch (e) { } },
    dup: async () => {
        const t = tableById(UI.sel); if (!t) return;
        const row = { ...t, id: uid(), label: nextLabel(), x: t.x + 20, y: t.y + 20, created_at: undefined };
        delete row.created_at;
        try { await db(sb().from('rest_tables').insert(row)); await load(); UI.sel = row.id; render(); } catch (e) { }
    },
    deltable: async () => {
        const t = tableById(UI.sel); if (!t) return;
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
    'mm-new': () => { UI.sheet = { type: 'menuedit' }; render(); },
    'mm-edit': el => { UI.sheet = { type: 'menuedit', id: el.dataset.id }; render(); },
    'mm-save': async () => {
        const g = id => root.querySelector('#' + id);
        const name = g('rs-m-name').value.trim(), price = parseFloat(g('rs-m-price').value);
        if (!name || isNaN(price) || price < 0) { toast('Enter a name and a price.', true); return; }
        const row = { tenant_id: ctx.tenantId, name, category: g('rs-m-cat').value.trim() || 'General', price, station: g('rs-m-station').value,
            no_prep: g('rs-m-noprep').checked, favourite: g('rs-m-fav').checked, active: g('rs-m-active').checked };
        try {
            if (UI.sheet.id) await db(sb().from('rest_menu_items').update(row).eq('id', UI.sheet.id));
            else await db(sb().from('rest_menu_items').insert({ ...row, id: uid(), sort: D.menu.length }));
            UI.sheet = null; await load(); render();
        } catch (e) { }
    }
};

function wireEvents() {
    if (root.dataset.wired) return;
    root.dataset.wired = '1';
    root.addEventListener('click', e => {
        const el = e.target.closest('[data-act]');
        if (!el || !root.contains(el)) return;
        if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox')) return; // those use 'change'
        if (el.tagName === 'INPUT') return; // checkbox uses change
        const fn = ACT[el.dataset.act];
        if (fn) fn(el, e);
    });
    root.addEventListener('change', e => {
        const el = e.target;
        if (el.dataset && el.dataset.act && (el.tagName === 'SELECT' || el.type === 'checkbox')) { const fn = ACT[el.dataset.act]; if (fn) fn(el, e); return; }
        if (el.dataset && el.dataset.f) { editField(el); return; }
        if (el.dataset && el.dataset.bind === 'chan') { UI.bill.chan = el.value; }
        if (UI.dirty) { /* a refresh was held back while typing */ }
    });
    root.addEventListener('input', e => {
        const el = e.target, b = el.dataset && el.dataset.bind;
        if (!b) return;
        if (b === 'q') { UI.q = el.value; updateOrderParts(); }
        else if (b === 'pickq') { UI.pickq = el.value; const c = root.querySelector('#rs-pickchips'); if (c) c.innerHTML = pickChips(); }
        else if (b === 'svc') { UI.bill.svc = el.value; updateBillTotals(); }
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
export function init(c) { ctx = c; }
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
