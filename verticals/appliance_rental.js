// verticals/appliance_rental.js
//
// Only fetched for tenants with business_type === 'appliance_rental' (see
// business-types.config.js -> loadVerticalModule).
//
// Unlike the first version of this module, there's no separate "Rentals"
// page or asset table anymore. Rental assets ARE inventory items --
// added via the same Add Product form, restocked via the same Purchase
// page, everything else uses. This module only adds:
//   - Two extra sections on the Inventory/Stock page (Availability,
//     Assets), replacing the normal Stock List for this business type.
//   - A Bookings section on the Sales page, replacing the normal
//     sale-recording UI for this business type.
//   - A dashboard widget (Out / Overdue / Due soon).
//
// Bookings live in their own `rentals` table (see
// migration_appliance_rental_v3.sql) since a booking -- customer, dates,
// deposit, payments -- doesn't fit the inventory_items/lots shape.
// Fetched bookings are cached on state.rentalBookings so they ride along
// with the app's existing full-state offline cache.
//
// `date` (booking-made date, separate from the rental period's start/end)
// and `group_id` (ties multiple assets booked together in one basket, same
// idea as sales_log/purchase_log's group_id) were added to `rentals` after
// v3 -- run the migration snippet below once against an existing database.
// fromDbBooking() falls back gracefully if these columns aren't there yet.
//
// `rental_write_offs` (jsonb, default '[]') was added to `inventory_items`
// to support dated write-offs -- run this once against an existing database:
//   ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS rental_write_offs jsonb DEFAULT '[]'::jsonb;
// Falls back to [] gracefully if the column doesn't exist yet.
//
// Quantity model: an item's lots (added via Purchase) are its total Qty
// on hand and are NEVER touched by booking/check-out/check-in -- only a
// new Purchase changes them. "Available now" is simply Qty on hand minus
// whatever's reserved or currently out, computed live, never stored.
//
// index.html top-level `function` declarations attach to `window` (it's
// a classic, non-module script), so this ES module reaches them that way.
const hasPerm = (...a) => window.hasPerm(...a);
const queueWrite = (...a) => window.queueWrite(...a);
const stampDesc = (...a) => window.stampDesc(...a);
const toDbJournal = (...a) => window.toDbJournal(...a);
const addNotification = (...a) => window.addNotification(...a);
const resolveTransactionBranch = (...a) => window.resolveTransactionBranch(...a);
const buildChannelOptionsHtml = (...a) => window.buildChannelOptionsHtml(...a);
const handleChannelSelectChange = (...a) => window.handleChannelSelectChange(...a);
const initiateEditProductDefinition = (...a) => window.initiateEditProductDefinition(...a);
const writeOffExpiringLot = (...a) => window.writeOffExpiringLot(...a);
const fmtDate = (...a) => window.fmtDate(...a);
const gregorianToEthiopian = (...a) => window.gregorianToEthiopian(...a);
const ethMonthName = (...a) => window.ethMonthName(...a);
const initEthiopianDatePickers = (...a) => window.initEthiopianDatePickers(...a);
const getTransactionAuthor = (...a) => window.getTransactionAuthor(...a);
const branchNameById = (...a) => window.branchNameById(...a);
const isBranchClosed = (...a) => window.isBranchClosed(...a);
const getChannelBreakdown = (...a) => window.getChannelBreakdown(...a);
const renderChannelBreakdownHtml = (...a) => window.renderChannelBreakdownHtml(...a);
const updateBranchColumnVisibility = (...a) => window.updateBranchColumnVisibility(...a);
const syncItemLots = (...a) => window.syncItemLots(...a);
const printReceiptFor = (...a) => window.printReceiptFor(...a);
const printInvoiceFor = (...a) => window.printInvoiceFor(...a);
const buyerInfoStackHTML = (...a) => window.buyerInfoStackHTML(...a);

let ctx = null; // { state, tenantId, supabaseClient, channelAccountCodes, branchId, calendarPref, mountEl }
let widgetMountEl = null; // mount for the dashboard's Out/Overdue/Due-soon widget -- kept separate from ctx.mountEl, see refresh() below
let inventoryActiveTab = 'availability';
// Category / name filters shared by the Availability and Assets tabs (kept
// in module state, not just the DOM, so they survive a tab switch or a
// calendar re-render).
let inventoryFilterCategory = '';
let inventoryFilterName = '';
// Multi-item bookings created from the cart share a bookingGroupId (see
// submitBookingForm) and collapse into one row in the table, the same way
// a multi-item purchase basket collapses in the core Purchase History.
let expandedBookingGroups = new Set();
// A wide window rendered once and scrolled through (rather than paged).
// Starts at today so the first column visible on load is the current day.
const CALENDAR_DAYS = 45;
const CAL_COL_WIDTH = 56;
let calendarStart = todayISO();
let bookingsFilter = 'active';
// Search-box filters layered on top of the Active/Overdue/Returned/All
// status tab above -- kept in module state (not just the DOM) so they
// survive the full-shell re-renders that already happen on every booking
// action (check out, cancel, void, payment, etc.).
let bookingsFilterDate = '';
let bookingsFilterCustomer = '';
let bookingsFilterItem = '';
let bookingsFilterStart = '';
let bookingsFilterChannel = '';
let bookingsFilterAuthor = '';
let bookingCart = [];        // [{ itemId, qty }] being built in the New Booking form
let bookingContext = null;   // { itemId } prefill for the New Booking form
let checkinContext = null;   // booking id currently open in the Check In modal
let paymentContext = null;   // { id, isGroup } currently open in the Record Payment modal -- id is a booking id, or a groupId when isGroup is true
let writeOffContext = null;  // item id currently open in the Write Off (pick a batch) modal

// ---------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------
function todayISO() { return new Date().toISOString().split('T')[0]; }
function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
}
function daysBetween(startIso, endIso) {
    return Math.round((new Date(endIso + 'T00:00:00') - new Date(startIso + 'T00:00:00')) / 86400000);
}
function fmtShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
// Compact calendar-header label, Ethiopian-aware -- fmtDate() (the app's
// shared formatter) gives the full "23 Meskerem 2018" form, too wide for
// a narrow day column, so this trims to day + 3-letter month.
function fmtCal(iso) {
    if (!iso) return '—';
    if (ctx.calendarPref !== 'ethiopian') return fmtShort(iso);
    const parts = iso.split('-').map(Number);
    const eth = gregorianToEthiopian({ y: parts[0], m: parts[1], d: parts[2] });
    return `${eth.d} ${ethMonthName(eth.m).slice(0, 3)}`;
}

// ---------------------------------------------------------------
// DB row <-> app object mapping (bookings only -- items use the core
// app's own inventory_items/inventory_lots mapping, unchanged)
// ---------------------------------------------------------------
function fromDbBooking(row) {
    return {
        id: row.id, itemId: row.item_id, branchId: row.branch_id || null,
        // Booking-made date, distinct from the rental period (start_date /
        // expected_return_date below). Falls back to start_date for rows
        // written before the `date` column existed (see the migration note
        // in the module header).
        date: row.date || row.start_date,
        groupId: row.group_id || null,
        customerName: row.customer_name, customerPhone: row.customer_phone || '', customerAddress: row.customer_address || '',
        qty: row.qty || 1,
        startDate: row.start_date, expectedReturnDate: row.expected_return_date, actualReturnDate: row.actual_return_date || null,
        rateType: row.rate_type, amount: Number(row.amount) || 0, amountPaid: Number(row.amount_paid) || 0,
        depositAmount: Number(row.deposit_amount) || 0, depositStatus: row.deposit_status || 'held',
        depositForfeitedAmount: Number(row.deposit_forfeited_amount) || 0,
        status: row.status, damageNotes: row.damage_notes || '', payments: row.payments || [],
        buyerTin: row.buyer_tin || '', buyerTradeName: row.buyer_trade_name || ''
    };
}
function toDbBooking(b) {
    return {
        id: b.id, tenant_id: ctx.tenantId, item_id: b.itemId, branch_id: b.branchId || null,
        date: b.date || b.startDate, group_id: b.groupId || null,
        customer_name: b.customerName, customer_phone: b.customerPhone || null, customer_address: b.customerAddress || null,
        qty: b.qty, start_date: b.startDate, expected_return_date: b.expectedReturnDate, actual_return_date: b.actualReturnDate || null,
        rate_type: b.rateType, amount: b.amount, amount_paid: b.amountPaid,
        deposit_amount: b.depositAmount, deposit_status: b.depositStatus, deposit_forfeited_amount: b.depositForfeitedAmount,
        status: b.status, damage_notes: b.damageNotes || null, payments: b.payments || [],
        buyer_tin: b.buyerTin || null, buyer_trade_name: b.buyerTradeName || null
    };
}

// ---------------------------------------------------------------
// Data
// ---------------------------------------------------------------
async function fetchBookings() {
    try {
        const res = await ctx.supabaseClient.from('rentals').select('*').eq('tenant_id', ctx.tenantId);
        ctx.state.rentalBookings = (res.data || []).map(fromDbBooking);
    } catch (e) {
        // Offline or failed -- keep whatever's already in state (restored
        // from the full-state offline cache) rather than wiping it out.
        ctx.state.rentalBookings = ctx.state.rentalBookings || [];
    }
}
function items() { return ctx.state.inventory || []; }
function bookings() { return ctx.state.rentalBookings || []; }
function itemById(id) { return items().find(i => i.id === id); }
function itemIndexById(id) { return items().findIndex(i => i.id === id); }
function bookingById(id) { return bookings().find(b => b.id === id); }

// ---------------------------------------------------------------
// Booking groups (multi-item bookings created together from the cart)
// ---------------------------------------------------------------
function bookingGroupRows(groupId) { return bookings().filter(b => b.groupId === groupId); }
function bookingGroupTotal(groupId) { return bookingGroupRows(groupId).reduce((s, b) => s + b.amount, 0); }
function bookingGroupPaid(groupId) { return bookingGroupRows(groupId).reduce((s, b) => s + b.amountPaid, 0); }
function bookingGroupPayments(groupId) { return bookingGroupRows(groupId).flatMap(b => b.payments || []); }
function rateTypeLabel(rt) { return rt ? rt.charAt(0).toUpperCase() + rt.slice(1) : '—'; }
// Same composite format Sales/Purchase History already show in their
// Product Item column (they store "[Category] Name" as the line's desc
// directly) -- bookings store itemId instead, so this rebuilds the same
// label from the live item record.
function itemLabel(item) { return item ? `[${item.category}] ${item.desc}` : '—'; }

function qtyOnHand(item) { return (item.lots || []).reduce((s, l) => s + (l.qty || 0), 0); }
// Dated write-off log support -- item.rentalWriteOffs is a list of
// { date, qty } events (see recordRentalWriteOff below and the matching
// core-side logic in writeOffExpiringLot, index.html). qtyOnHand() always
// reflects TODAY's true total (lots are reduced immediately). For any
// OTHER day being asked about, add back whatever was written off strictly
// AFTER that day -- so a unit removed today still shows as in stock on
// every day before today, and only disappears from today onward.
function qtyOnHandAsOf(item, dateIso) {
    const future = (item.rentalWriteOffs || []).filter(w => w.date > dateIso).reduce((s, w) => s + w.qty, 0);
    return qtyOnHand(item) + future;
}
function qtyOutOrReserved(item) {
    return bookings().filter(b => b.itemId === item.id && (b.status === 'reserved' || b.status === 'out')).reduce((s, b) => s + b.qty, 0);
}
function qtyAvailable(item) { return Math.max(0, qtyOnHand(item) - qtyOutOrReserved(item)); }
// Date-specific version for the Availability calendar -- only counts
// bookings whose date range actually covers that day (exclusive of the
// return date itself, so a booking due back on day X doesn't block day X).
function qtyAvailableOnDate(item, dateIso) {
    const committed = bookings().filter(b => b.itemId === item.id && (b.status === 'reserved' || b.status === 'out')
        && dateIso >= b.startDate && dateIso < b.expectedReturnDate).reduce((s, b) => s + b.qty, 0);
    return Math.max(0, qtyOnHandAsOf(item, dateIso) - committed);
}
// What's actually free across a WHOLE date range (the New Booking modal's
// Add Asset list needs this, not the blanket "available right now" figure
// qtyAvailable() gives) -- the worst single day in the range caps the
// whole booking, same logic the Availability calendar already uses one day
// at a time via qtyAvailableOnDate().
function qtyAvailableForRange(item, startIso, endIso) {
    if (!startIso || !endIso || endIso <= startIso) return qtyAvailable(item);
    const days = daysBetween(startIso, endIso);
    let min = qtyOnHand(item);
    for (let i = 0; i < days; i++) min = Math.min(min, qtyAvailableOnDate(item, addDays(startIso, i)));
    return Math.max(0, min);
}

// Shared by the Availability and Assets tabs -- Category and Item
// Specification/Name filters (see inventoryFilterCategory/Name above),
// same substring-match behavior as the core Stock List's own filters.
function filteredItems() {
    return items().slice().sort((a, b) => a.desc.localeCompare(b.desc)).filter(i =>
        (!inventoryFilterCategory || (i.category || '').toLowerCase().includes(inventoryFilterCategory)) &&
        (!inventoryFilterName || (i.desc || '').toLowerCase().includes(inventoryFilterName))
    );
}

function isOverdue(b) {
    return b.status === 'out' && !b.actualReturnDate && b.expectedReturnDate < todayISO();
}
function displayStatus(b) { return isOverdue(b) ? 'overdue' : b.status; }
function statusBadge(status) {
    const map = {
        reserved: ['#DDE6F5', 'var(--info)', 'Reserved'],
        out: ['#FCEEDD', 'var(--warning)', 'Out'],
        overdue: ['#FAECE7', 'var(--danger)', 'Overdue'],
        returned: ['#E2EFE8', 'var(--success)', 'Returned']
    };
    const [bg, fg, label] = map[status] || ['#eee', '#666', status];
    return `<span style="background:${bg}; color:${fg}; font-size:11px; padding:2px 8px; border-radius:20px; white-space:nowrap; font-weight:600;">${label}</span>`;
}

function billableDays(start, end) { return Math.max(1, daysBetween(start, end)); }
function suggestRateType(days) { return days >= 25 ? 'monthly' : (days >= 7 ? 'weekly' : 'daily'); }
function perUnitAmount(item, rateType, days) {
    if (rateType === 'monthly' && item.monthlyRate) return Math.ceil(days / 30) * item.monthlyRate;
    if (rateType === 'weekly' && item.weeklyRate) return Math.ceil(days / 7) * item.weeklyRate;
    return days * (item.dailyRate || 0);
}

// ---------------------------------------------------------------
// Entry points called by index.html
// ---------------------------------------------------------------
export async function init(c) {
    ctx = c;
    widgetMountEl = c.mountEl;
    await fetchBookings();
    renderDashboardWidget();
    // Bookings load asynchronously and finish well after the Dashboard's
    // first render (see the login sequence in index.html: Deep Sales
    // Analytics renders before loadVerticalModule() even starts loading
    // this file). Without this, a rental tenant would open the app to an
    // empty Deep Sales Analytics card and only see their data after
    // clicking to another page and back. Only refresh it if the Dashboard
    // happens to still be the active view -- no need to touch it otherwise.
    if (typeof window.renderAnalyticalDashboards === 'function' && document.getElementById('view-dashboard')?.classList.contains('active')) {
        window.renderAnalyticalDashboards();
    }
}
// Called every time the dashboard's mini "Out / Overdue / Due in 3 days"
// widget needs to refresh (e.g. after any write-off, booking change, etc.
// -- see renderAnalyticalDashboards() in index.html). IMPORTANT: this must
// NOT merge c.mountEl into the shared ctx, or it clobbers whatever page
// mount (Inventory's #inventory-rental-mount or Sales'
// #sales-rental-mount) was set there last -- that used to leave the
// Inventory/Sales page pointed at the wrong (hidden) mount element after
// any background dashboard refresh, making tab switches like Availability
// silently render into the dashboard widget instead of the visible page.
export function refresh(c) {
    const { mountEl, ...rest } = c;
    ctx = { ...ctx, ...rest };
    if (mountEl) widgetMountEl = mountEl;
    renderDashboardWidget();
}
export async function renderInventorySection(c) {
    ctx = { ...ctx, ...c };
    if (!ctx.state.rentalBookings) { ctx.mountEl.innerHTML = `<div class="card"><p style="color:var(--text-light);">Loading…</p></div>`; await fetchBookings(); }
    renderInventoryContent();
}
export async function renderBookingSection(c) {
    ctx = { ...ctx, ...c };
    if (!ctx.state.rentalBookings) { ctx.mountEl.innerHTML = `<div class="card"><p style="color:var(--text-light);">Loading…</p></div>`; await fetchBookings(); }
    renderBookingContent();
}

// ---------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------
function renderDashboardWidget() {
    if (!widgetMountEl) return;
    const bs = bookings();
    const outCount = bs.filter(b => b.status === 'out' && !isOverdue(b)).length;
    const overdueCount = bs.filter(isOverdue).length;
    const upcoming = bs.filter(b => b.status === 'reserved' && b.startDate >= todayISO() && b.startDate <= addDays(todayISO(), 3)).length;
    widgetMountEl.style.maxWidth = '380px';
    widgetMountEl.innerHTML = `
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
            ${miniStat('Out', outCount, 'var(--warning)', 'out')}
            ${miniStat('Overdue', overdueCount, 'var(--danger)', 'overdue')}
            ${miniStat('Due in 3 days', upcoming, 'var(--info)', 'due_soon')}
        </div>`;
}
function miniStat(label, value, color, filterKey) {
    return `<div style="flex:1; min-width:100px; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:10px 12px; box-shadow:var(--shadow-sm); cursor:pointer;" onclick="rentalUI.openStatusPopup('${filterKey}', '${label}')" title="View these bookings">
        <p style="font-size:11px; color:var(--text-light); margin:0 0 4px;">${label}</p>
        <p style="font-family:'IBM Plex Mono',monospace; font-size:18px; font-weight:600; color:${value ? color : 'var(--text)'}; margin:0;">${value}</p>
    </div>`;
}
// Same status predicates renderBookingsTableBody() uses for the Bookings
// page's own Active/Overdue/etc. filter, reused here so the popup always
// lists exactly what the box counted.
function statusMatchFor(filterKey) {
    if (filterKey === 'out') return b => b.status === 'out' && !isOverdue(b);
    if (filterKey === 'overdue') return isOverdue;
    if (filterKey === 'due_soon') return b => b.status === 'reserved' && b.startDate >= todayISO() && b.startDate <= addDays(todayISO(), 3);
    return () => true;
}
// Popup for a dashboard box (Out / Overdue / Due in 3 days) -- shows the
// matching bookings right there in a modal, the same way the Total
// Revenue/Expenses/Net Profit boxes use launchDrillDown() + the shared
// audit-modal, instead of navigating away to the Bookings page.
function openStatusPopup(filterKey, label) {
    const matches = bookings().filter(statusMatchFor(filterKey))
        .sort((a, b) => (a.expectedReturnDate || a.startDate).localeCompare(b.expectedReturnDate || b.startDate));
    let html = '';
    if (matches.length === 0) {
        html = `<p style="color:var(--text-light); font-size:13px;">No bookings in this category right now.</p>`;
    } else {
        html = `<table><thead><tr><th>Customer</th><th>Asset</th><th class="num">Qty</th><th>Start</th><th>Expected Return</th><th style="text-align:center;">Status</th></tr></thead><tbody>
            ${matches.map(b => {
                const item = itemById(b.itemId);
                return `<tr><td>${b.customerName}</td><td>${itemLabel(item)}</td><td class="num">${b.qty}</td><td>${fmtDate(b.startDate)}</td><td>${fmtDate(b.expectedReturnDate)}</td><td style="text-align:center;">${statusBadge(displayStatus(b))}</td></tr>`;
            }).join('')}
        </tbody></table>`;
    }
    document.getElementById('modal-title').innerText = label;
    document.getElementById('modal-body-content').innerHTML = html;
    document.getElementById('audit-modal').style.display = 'flex';
}

// ---------------------------------------------------------------
// Inventory page content: Availability + Assets
// ---------------------------------------------------------------
function renderInventoryContent() {
    const tabs = [['availability', 'Availability'], ['assets', 'Assets']];
    ctx.mountEl.innerHTML = `
        <div class="card" style="margin-bottom:16px;">
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                ${tabs.map(([key, label]) => `<button class="btn" style="${inventoryActiveTab === key ? '' : 'background:var(--bg); color:var(--text); border:1px solid var(--border);'}" onclick="rentalUI.switchInventoryTab('${key}')">${label}</button>`).join('')}
            </div>
        </div>
        <div id="inventory-tab-content"></div>
        <div id="inventory-rentals-modals"></div>`;
    renderInventoryTabContent();
}
function switchInventoryTab(tab) { inventoryActiveTab = tab; renderInventoryContent(); }
function renderInventoryTabContent() {
    const el = document.getElementById('inventory-tab-content');
    if (!el) return;
    el.innerHTML = inventoryActiveTab === 'availability' ? availabilityShellHTML() : assetsShellHTML();
    if (inventoryActiveTab === 'availability') renderAvailabilityBody(); else renderAssetsBody();
    initEthiopianDatePickers();
}
// Re-reads the (shared) Category/Name filter inputs and re-renders only the
// active tab's body -- not the whole tab (which would blow away the input
// element mid-keystroke and drop focus), same approach the core Stock List
// uses for its own Category/Name filters.
function applyInventoryFilter() {
    const catEl = document.getElementById('rental-inv-filter-category');
    const nameEl = document.getElementById('rental-inv-filter-name');
    inventoryFilterCategory = catEl ? catEl.value.toLowerCase().trim() : '';
    inventoryFilterName = nameEl ? nameEl.value.toLowerCase().trim() : '';
    if (inventoryActiveTab === 'availability') renderAvailabilityBody(); else renderAssetsBody();
}
function filterPanelHTML() {
    return `
        <div class="filter-panel" style="margin-bottom:12px;">
            <div class="form-group"><label>Search Category</label><input type="text" id="rental-inv-filter-category" placeholder="Filter category..." value="${inventoryFilterCategory}" oninput="rentalUI.applyInventoryFilter()"></div>
            <div class="form-group"><label>Search Name</label><input type="text" id="rental-inv-filter-name" placeholder="Filter name..." value="${inventoryFilterName}" oninput="rentalUI.applyInventoryFilter()"></div>
        </div>`;
}

function availabilityShellHTML() {
    return `
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
                <h2 style="border:none; margin:0;">Availability</h2>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                    <input type="date" id="cal-filter-date" value="${todayISO()}" onchange="rentalUI.jumpCalendarToDate()" style="font-size:12px;">
                    <button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.shiftCalendar(-5)">← Earlier</button>
                    <button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.shiftCalendar(5)">Later →</button>
                </div>
            </div>
            ${filterPanelHTML()}
            <div id="rental-availability-body"></div>
        </div>`;
}
function renderAvailabilityBody() {
    const el = document.getElementById('rental-availability-body');
    if (!el) return;
    const list = filteredItems();
    const dates = Array.from({ length: CALENDAR_DAYS }, (_, i) => addDays(calendarStart, i));
    const canBook = hasPerm('sales.create');
    el.innerHTML = list.length === 0 ? `<p style="color:var(--text-light); font-size:13px;">${items().length === 0 ? 'Add a product above to get started.' : 'No assets match this filter.'}</p>` : `
        <!-- Grows to full length with the page as rows are added -- both
             header rows (Asset + dates) stay pinned to the top of the page's
             scroll area while scrolling through rows, same table-scroll
             pattern as the Sales/Purchase history tables. The inner
             #rental-cal-scroll div still handles horizontal scrolling of the
             date columns only. -->
        <div class="table-scroll" style="display:flex; border:1px solid var(--border); border-radius:8px;">
            <div style="flex-shrink:0;">
                <table style="margin:0;">
                    <thead><tr><th style="min-width:150px; height:36px;">Asset</th></tr></thead>
                    <tbody>
                        ${list.map(i => `<tr style="height:44px;"><td>${i.desc}</td></tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <!-- Only this inner strip scrolls horizontally -- the Asset
                 column stays put as the user scrolls through dates. -->
            <div id="rental-cal-scroll" style="overflow-x:auto; flex:1;">
                <table style="margin:0;">
                    <thead><tr>${dates.map(d => `<th style="text-align:center; font-size:11px; min-width:${CAL_COL_WIDTH}px; height:36px; ${d === todayISO() ? 'background:var(--bg); border-bottom:2px solid var(--primary);' : ''}">${fmtCal(d)}</th>`).join('')}</tr></thead>
                    <tbody>
                        ${list.map(i => `<tr style="height:44px;">${dates.map(d => calendarCell(i, d, canBook)).join('')}</tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
}
function calendarCell(item, dateIso, canBook) {
    const total = qtyOnHandAsOf(item, dateIso);
    const avail = qtyAvailableOnDate(item, dateIso);
    const bg = total === 0 ? '#eee' : (avail <= 0 ? '#F8D7D2' : (avail < total ? '#FCEEDD' : '#E2EFE8'));
    const clickable = canBook && avail > 0;
    const onclick = clickable ? ` onclick="rentalUI.openBookingModal('${item.id}', '${dateIso}')" style="cursor:pointer;"` : '';
    return `<td title="${avail} of ${total} available ${fmtDate(dateIso)}"${onclick}><div style="width:100%; height:22px; background:${bg}; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:10px; color:var(--text-light);">${total > 0 ? avail : ''}</div></td>`;
}
function shiftCalendar(days) {
    const container = document.getElementById('rental-cal-scroll');
    if (container) container.scrollLeft += days * CAL_COL_WIDTH;
}
function jumpCalendarToDate() {
    const input = document.getElementById('cal-filter-date');
    if (!input || !input.value) return;
    const target = input.value;
    let offset = daysBetween(calendarStart, target);
    if (offset < 0 || offset >= CALENDAR_DAYS - 3) {
        // Outside (or too near the edge of) the currently rendered
        // window -- recentre the whole range around the picked date and
        // re-render before trying to scroll to it.
        calendarStart = addDays(target, -5);
        renderInventoryTabContent();
        offset = 5;
    }
    requestAnimationFrame(() => {
        const container = document.getElementById('rental-cal-scroll');
        if (container) container.scrollLeft = Math.max(0, (offset - 1) * CAL_COL_WIDTH);
    });
}

function assetsShellHTML() {
    return `
        <div class="card">
            <h2>Assets</h2>
            ${filterPanelHTML()}
            <div id="rental-assets-body"></div>
        </div>`;
}
function renderAssetsBody() {
    const el = document.getElementById('rental-assets-body');
    if (!el) return;
    const list = filteredItems();
    el.innerHTML = list.length === 0 ? `<p style="color:var(--text-light); font-size:13px;">${items().length === 0 ? 'No assets yet — use Add Product above.' : 'No assets match this filter.'}</p>` : `
        <table>
            <thead><tr><th>Category</th><th>Item Specification / Name</th><th class="num">Qty</th><th class="num">Daily</th><th class="num">Weekly</th><th class="num">Monthly</th><th style="text-align:center;">Action</th></tr></thead>
            <tbody>
                ${list.map(i => `<tr>
                    <td>${i.category}</td>
                    <td><strong>${i.desc}</strong></td>
                    <td class="num">${qtyOnHand(i)}</td>
                    <td class="num">${i.dailyRate ? 'ETB ' + i.dailyRate.toFixed(2) : '—'}</td>
                    <td class="num">${i.weeklyRate ? 'ETB ' + i.weeklyRate.toFixed(2) : '—'}</td>
                    <td class="num">${i.monthlyRate ? 'ETB ' + i.monthlyRate.toFixed(2) : '—'}</td>
                    <td style="text-align:center; white-space:nowrap;">
                        ${hasPerm('inventory.edit_products') ? `<button class="btn btn-small" onclick="initiateEditProductDefinition(${itemIndexById(i.id)})">Edit</button> ` : ''}
                        ${hasPerm('rentals.write_off') && i.lots && i.lots.length > 0 ? `<button class="btn btn-small btn-danger" onclick="rentalUI.openWriteOffModal('${i.id}')">Write Off</button>` : ''}
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;
}

// ---------------------------------------------------------------
// Write off -- pick which purchase batch (lot) to remove, reusing the
// same core writeOffExpiringLot() the pharmacy vertical uses (it already
// knows how to pull a lot out of stock and post a loss journal entry --
// see the account-code branch in index.html for the fixed-asset codes).
// ---------------------------------------------------------------
function openWriteOffModal(itemId) {
    writeOffContext = itemId;
    const item = itemById(itemId);
    if (!item) return;
    const idx = itemIndexById(itemId);
    document.getElementById('inventory-rentals-modals').innerHTML = `
    <div class="modal-overlay active" onclick="rentalUI.closeWriteOffModal()">
        <div class="modal-box" onclick="event.stopPropagation()" style="max-width:460px;">
            <h3 style="color:var(--primary); margin-bottom:8px;">Write Off — ${item.desc}</h3>
            <p style="font-size:13px; color:var(--text-light); margin-bottom:14px;">Pick a batch and how many units to remove. This can't be undone.</p>
            ${(item.lots || []).length === 0 ? `<p style="color:var(--text-light); font-size:13px;">No stock to write off.</p>` : `
            <table>
                <thead><tr><th class="num">Qty</th><th class="num">Unit Cost</th><th class="num" style="min-width:70px;">Write Off</th><th style="text-align:center;">Action</th></tr></thead>
                <tbody>
                    ${item.lots.map(l => `<tr>
                        <td class="num">${l.qty}</td>
                        <td class="num">ETB ${l.cost.toFixed(2)}</td>
                        <td class="num"><input type="number" id="wo-qty-${l.id}" min="1" max="${l.qty}" value="${l.qty}" style="width:64px; text-align:right;"></td>
                        <td style="text-align:center;"><button class="btn btn-small btn-danger" onclick="rentalUI.confirmWriteOff(${idx}, '${l.id}')">Write Off</button></td>
                    </tr>`).join('')}
                </tbody>
            </table>`}
            <div style="display:flex; justify-content:flex-end; margin-top:14px;">
                <button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.closeWriteOffModal()">Close</button>
            </div>
        </div>
    </div>`;
}
function confirmWriteOff(itemIndex, lotId) {
    const qtyInput = document.getElementById(`wo-qty-${lotId}`);
    const qty = qtyInput ? parseInt(qtyInput.value) || 0 : 0;
    if (qty < 1) return;
    writeOffExpiringLot(itemIndex, lotId, qty);
    closeWriteOffModal();
}
function closeWriteOffModal() {
    const el = document.getElementById('inventory-rentals-modals');
    if (el) el.innerHTML = '';
    writeOffContext = null;
    renderInventoryTabContent();
}

// ---------------------------------------------------------------
// Automatic write-off for units never brought back at Check In --
// distinct from the Write Off button above (which lets someone pick a
// batch by hand for damaged/lost stock sitting on the shelf). This one
// has no picker: it just needs to remove `qty` units, oldest batch
// first, the same order a sale would consume stock in.
// ---------------------------------------------------------------
function recordRentalWriteOff(item, qty, dateIso) {
    item.rentalWriteOffs = item.rentalWriteOffs || [];
    item.rentalWriteOffs.push({ id: crypto.randomUUID(), date: dateIso, qty });
    queueWrite({ kind: 'update', table: 'inventory_items', id: item.id, patch: { rental_write_offs: item.rentalWriteOffs } });
}
function consumeLotsFIFO(item, qty) {
    const beforeLots = item.lots.map(l => ({ ...l }));
    let remaining = qty, lossAmount = 0;
    item.lots.forEach(lot => {
        if (remaining <= 0) return;
        const take = Math.min(remaining, lot.qty);
        lossAmount += take * lot.cost;
        lot.qty -= take;
        remaining -= take;
    });
    item.lots = item.lots.filter(l => l.qty > 0);
    syncItemLots(item, beforeLots);
    return { lossAmount, consumedQty: qty - remaining };
}
// Called from Check In when the qty actually handed back is less than
// what was booked out (see submitCheckIn). Removes the missing units
// from stock -- dated as today, so the Availability calendar still shows
// them as in stock on every day before today (see qtyOnHandAsOf) -- posts
// the usual inventory-loss journal, and, if the booking was already
// overdue, bills extra for every day it sat unreturned past the expected
// return date, at the item's daily rate. That's rental income the
// business would otherwise lose entirely along with the asset.
function writeOffMissingUnits(item, missingQty, booking) {
    const date = todayISO();
    const { lossAmount, consumedQty } = consumeLotsFIFO(item, missingQty);
    if (consumedQty > 0) {
        recordRentalWriteOff(item, consumedQty, date);
        item.history = item.history || [];
        item.history.push(`[${new Date().toLocaleString()}] ${consumedQty} unit(s) not returned by ${booking.customerName} (Booking ${booking.id}) — written off, ETB ${lossAmount.toFixed(2)} loss recorded`);
        queueWrite({ kind: 'update', table: 'inventory_items', id: item.id, patch: { history: item.history } });
    }
    if (lossAmount > 0) {
        const lossJournal = {
            id: crypto.randomUUID(), date, branchId: booking.branchId,
            desc: stampDesc(`Rental equipment write-off: ${consumedQty} x ${item.desc} not returned (Booking ${booking.id})`),
            lines: [{ account: '6070', dr: lossAmount, cr: 0 }, { account: '1500', cr: lossAmount, dr: 0 }]
        };
        ctx.state.journal.push(lossJournal);
        queueWrite({ kind: 'insert', table: 'journal_entries', row: toDbJournal(lossJournal) });
    }

    let overdueCharge = 0;
    if (isOverdue(booking) && item.dailyRate) {
        const daysOverdue = Math.max(0, daysBetween(booking.expectedReturnDate, date));
        overdueCharge = +(consumedQty * item.dailyRate * daysOverdue).toFixed(2);
        if (overdueCharge > 0) {
            booking.amount += overdueCharge;
            queueWrite({ kind: 'update', table: 'rentals', id: booking.id, patch: { amount: booking.amount } });
            const chargeJournal = {
                id: crypto.randomUUID(), date, branchId: booking.branchId,
                desc: stampDesc(`Overdue charge: ${consumedQty} x ${item.desc} not returned, ${daysOverdue} day(s) overdue (Booking ${booking.id})`),
                lines: [{ account: '1300', dr: overdueCharge, cr: 0 }, { account: '4020', cr: overdueCharge, dr: 0 }]
            };
            ctx.state.journal.push(chargeJournal);
            queueWrite({ kind: 'insert', table: 'journal_entries', row: toDbJournal(chargeJournal) });
        }
    }
    return { lossAmount, overdueCharge, consumedQty };
}

// ---------------------------------------------------------------
// Sales page content: Bookings
// ---------------------------------------------------------------
function bookingsHTML() {
    const filters = [['active', 'Active'], ['overdue', 'Overdue'], ['returned', 'Returned'], ['all', 'All']];
    return `
        ${hasPerm('sales.create') ? newBookingInlineHTML() : ''}
        <div class="card">
            <h2>Bookings</h2>
            <div class="filter-panel" id="bookings-status-filters" style="margin-bottom:12px;">
                ${filters.map(([key, label]) => `<button class="btn btn-small" data-filter-key="${key}" style="${bookingsFilter === key ? '' : 'background:var(--bg); color:var(--text); border:1px solid var(--border);'}" onclick="rentalUI.setBookingsFilter('${key}')">${label}</button>`).join('')}
            </div>
            <div class="filter-panel">
                <div class="form-group"><label>Filter Date</label><input type="date" id="rbk-filter-date" value="${bookingsFilterDate}" onchange="rentalUI.applyBookingsFilter()"></div>
                <div class="form-group"><label>Customer Name / Phone</label><input type="text" id="rbk-filter-customer" placeholder="Search..." value="${bookingsFilterCustomer}" oninput="rentalUI.applyBookingsFilter()"></div>
                <div class="form-group"><label>Product Item</label><input type="text" id="rbk-filter-item" placeholder="Search..." value="${bookingsFilterItem}" oninput="rentalUI.applyBookingsFilter()"></div>
                <div class="form-group"><label>Start</label><input type="date" id="rbk-filter-start" value="${bookingsFilterStart}" onchange="rentalUI.applyBookingsFilter()"></div>
                <div class="form-group"><label>Channel</label>
                    <select id="rbk-filter-channel" onchange="rentalUI.applyBookingsFilter()">
                        <option value="">-- All --</option>
                        <option value="Cash" ${bookingsFilterChannel === 'Cash' ? 'selected' : ''}>Cash</option>
                        <option value="Mobile banking" ${bookingsFilterChannel === 'Mobile banking' ? 'selected' : ''}>Mobile banking</option>
                        <option value="Accounts receivable" ${bookingsFilterChannel === 'Accounts receivable' ? 'selected' : ''}>Accounts receivable</option>
                    </select>
                </div>
                <div class="form-group" id="rbk-filter-by-group" style="display:${ctx.state.hasEmployees ? 'block' : 'none'};"><label>By</label>
                    <select id="rbk-filter-author" onchange="rentalUI.applyBookingsFilter()"><option value="">-- All --</option></select>
                </div>
            </div>
            <div id="bookings-total-display" style="font-size:13px; font-weight:600; color:var(--primary);"></div>
        </div>
        <div class="card">
            <div class="table-scroll">
                <div id="bookings-table-wrap"></div>
            </div>
        </div>
        <div id="sales-rentals-modals"></div>`;
}
// "By" is built from whoever actually has a booking right now, same
// approach the core Sales/Purchase/Expense History "By" filters use --
// rebuilt every full render since who's booked can change.
function syncBookingAuthorFilter() {
    const sel = document.getElementById('rbk-filter-author');
    if (!sel) return;
    const prev = sel.value;
    const authors = Array.from(new Set(bookings().map(b => getTransactionAuthor(b.id)).filter(a => a && a !== '—'))).sort();
    sel.innerHTML = `<option value="">-- All --</option>` + authors.map(a => `<option value="${a}">${a}</option>`).join('');
    if (authors.includes(prev)) sel.value = prev;
}
// Re-reads the filter inputs into module state and redraws only the table
// -- not the whole card -- so typing in Customer/Product doesn't drop
// focus mid-keystroke, the same approach the Inventory tab's own
// Category/Name filters use.
function applyBookingsFilter() {
    bookingsFilterDate = document.getElementById('rbk-filter-date')?.value || '';
    bookingsFilterCustomer = document.getElementById('rbk-filter-customer')?.value || '';
    bookingsFilterItem = document.getElementById('rbk-filter-item')?.value || '';
    bookingsFilterStart = document.getElementById('rbk-filter-start')?.value || '';
    bookingsFilterChannel = document.getElementById('rbk-filter-channel')?.value || '';
    bookingsFilterAuthor = document.getElementById('rbk-filter-author')?.value || '';
    renderBookingsTableBody();
}
function renderBookingsTableBody() {
    const el = document.getElementById('bookings-table-wrap');
    if (!el) return;

    let statusMatch;
    if (bookingsFilter === 'active') statusMatch = b => b.status === 'reserved' || b.status === 'out';
    else if (bookingsFilter === 'overdue') statusMatch = isOverdue;
    else if (bookingsFilter === 'returned') statusMatch = b => b.status === 'returned';
    else if (bookingsFilter === 'out') statusMatch = b => b.status === 'out' && !isOverdue(b);
    else if (bookingsFilter === 'due_soon') statusMatch = b => b.status === 'reserved' && b.startDate >= todayISO() && b.startDate <= addDays(todayISO(), 3);
    else statusMatch = () => true; // 'all' -- the search fields below then filter across every status instead of just one

    const fD = bookingsFilterDate;
    const fC = bookingsFilterCustomer.toLowerCase().trim();
    const fI = bookingsFilterItem.toLowerCase().trim();
    const fStart = bookingsFilterStart;
    const fCh = bookingsFilterChannel;
    const fBy = ctx.state.hasEmployees ? bookingsFilterAuthor : '';

    // Date/Customer/Phone/Product/Start are uniform per booking line, so
    // they're folded straight into the same per-row test as the status tab
    // -- whichever status tab is active, these narrow further within it.
    const matches = b => statusMatch(b)
        && (!fD || b.date === fD)
        && (!fC || b.customerName.toLowerCase().includes(fC) || (b.customerPhone || '').toLowerCase().includes(fC))
        && (!fI || itemLabel(itemById(b.itemId)).toLowerCase().includes(fI))
        && (!fStart || b.startDate === fStart);

    const all = bookings().slice().sort((a, b) => b.startDate.localeCompare(a.startDate));

    // Collapse multi-item bookings (shared groupId, created together from
    // the New Booking cart) into one row each -- same pattern as the core
    // Purchase/Sales History collapsing a multi-item basket. A group is
    // shown if ANY of its lines matches; once shown, every line in it is
    // available on expand regardless of that line's own status.
    const seenGroups = new Set();
    let displayList = [];
    all.forEach(b => {
        if (b.groupId) {
            if (seenGroups.has(b.groupId)) return;
            seenGroups.add(b.groupId);
            const groupRows = bookingGroupRows(b.groupId);
            if (groupRows.some(matches)) displayList.push({ isGroup: true, groupId: b.groupId, rows: groupRows });
        } else {
            if (matches(b)) displayList.push({ isGroup: false, row: b });
        }
    });

    // Every display entry gets its channel breakdown up front (whether or
    // not a channel filter is applied) -- both the Channel filter itself
    // and the "Total shown" figure below need it, and this way it's only
    // computed once per entry instead of twice.
    displayList.forEach(entry => {
        const rows = entry.isGroup ? entry.rows : [entry.row];
        entry._total = rows.reduce((s, r) => s + r.amount, 0);
        const record = entry.isGroup
            ? { payments: bookingGroupPayments(entry.groupId), amountPaid: bookingGroupPaid(entry.groupId) }
            : entry.row;
        entry._breakdown = getChannelBreakdown(record, entry._total, 'Accounts receivable');
    });

    // Channel and By apply to the whole booking/group at once (its combined
    // payments and primary author), not per line -- same as the core Sales
    // History filters, applied after grouping for the same reason.
    if (fCh) displayList = displayList.filter(entry => entry._breakdown.some(b => b.channel === fCh));
    if (fBy) displayList = displayList.filter(entry => getTransactionAuthor(entry.isGroup ? entry.rows[0].id : entry.row.id) === fBy);

    // With no channel filter, the total is every shown booking's full
    // amount. With one applied, it's ONLY the slice that actually went
    // through that channel -- e.g. filtering "Cash" on a 200 booking paid
    // 100 Cash + 100 Mobile banking shows 100, not 200. Same rule the core
    // Sales/Purchase History totals use.
    const totalShown = fCh
        ? displayList.reduce((sum, entry) => sum + entry._breakdown.filter(b => b.channel === fCh).reduce((a, b) => a + b.amount, 0), 0)
        : displayList.reduce((sum, entry) => sum + entry._total, 0);
    const totalEl = document.getElementById('bookings-total-display');
    if (totalEl) totalEl.innerText = `Total shown: ETB ${totalShown.toFixed(2)} (${displayList.length})`;

    el.innerHTML = displayList.length === 0 ? `<p style="color:var(--text-light); font-size:13px;">No bookings match this filter.</p>` : `
            <table>
                <thead><tr><th>Date</th><th>Customer Name</th><th>Product Item</th><th class="num">Quantity</th><th>Start</th><th>Expected Return</th><th>Status</th><th class="num">Amount</th><th>Channel / Status / Type</th><th class="branch-col">Branch</th><th>By</th><th style="text-align:center;">Action</th></tr></thead>
                <tbody>${displayList.map(entry => entry.isGroup ? bookingGroupRowsHTML(entry) : bookingRow(entry.row)).join('')}</tbody>
            </table>`;
}
// Status tab click -- swaps just the button styling and the table body,
// leaving the search filters (and any focus in them) untouched.
function setBookingsFilter(f) {
    bookingsFilter = f;
    document.querySelectorAll('#bookings-status-filters button').forEach(btn => {
        btn.style.cssText = btn.dataset.filterKey === f ? '' : 'background:var(--bg); color:var(--text); border:1px solid var(--border);';
    });
    renderBookingsTableBody();
}
function renderBookingContent() {
    ctx.mountEl.innerHTML = bookingsHTML();
    syncBookingAuthorFilter();
    renderBookingsTableBody();
    updateBranchColumnVisibility();
    initBookingFormWidgets();
}
// The New Booking panel is now a permanent fixture of the Bookings page
// (not a toggled popup), so every full re-render of the page -- not just
// the moment it's first opened -- needs to re-wire its widgets: repopulate
// the Add Asset datalist, redraw whatever's in the cart, re-attach the
// Ethiopian date pickers, and recompute the Amount. No-ops harmlessly if
// the form isn't in the DOM (e.g. the user lacks sales.create).
function initBookingFormWidgets() {
    if (!document.getElementById('rb-start')) return;
    renderCartLines();
    initEthiopianDatePickers();
    recalcBooking();
}

// Per-line Check Out / Check In / Cancel / Void buttons -- these act on one
// specific booking row (one asset), independent of any group it belongs to.
function lineActions(b) {
    let actions = '';
    if (b.status === 'reserved') {
        if (hasPerm('sales.create')) actions += `<button class="btn btn-small" onclick="rentalUI.checkOutBooking('${b.id}')">Check Out</button> `;
        if (hasPerm('sales.void')) actions += `<button class="btn btn-small btn-danger" onclick="rentalUI.cancelBooking('${b.id}')">Cancel</button> `;
    } else {
        // Once an item has actually left with the customer (status 'out',
        // including overdue, or already 'returned'), Cancel no longer
        // applies -- Void is the equivalent for a booking that's past that
        // point, fully reversing it instead of just flipping its status.
        if (b.status === 'out' && hasPerm('rentals.checkin')) actions += `<button class="btn btn-small" onclick="rentalUI.openCheckInModal('${b.id}')">Check In</button> `;
        if (hasPerm('sales.void')) actions += `<button class="btn btn-small btn-danger" onclick="rentalUI.voidBooking('${b.id}')">Void</button> `;
    }
    return actions;
}
// Void fully reverses a booking that's already been checked out (or
// returned) -- unlike Cancel (which only applies before check-out and just
// flips status to 'returned', keeping the row as history), this removes
// the booking row entirely and deletes every journal entry tied to it
// (creation revenue, any deposit held/settled, any payments received), the
// same "reverse and remove" shape deleteSale()/deletePurchase() use in the
// core app. "Reverses the quantity" happens for free: qtyAvailable() and
// qtyAvailableOnDate() are computed live from bookings(), so removing the
// row immediately frees up whatever it had reserved/out -- there's no
// separate stock figure to restore, since lots are never touched by
// booking/check-out/check-in in the first place (see the module header).
// Unlike core voids, this doesn't write a Trash entry -- there's no
// rental-aware Undo path in the core Trash view yet, so a "restore" button
// there would be a dead end.
function voidBooking(id) {
    const b = bookingById(id);
    if (!b) return;
    if (isBranchClosed(b.branchId)) { alert(`This booking belongs to "${branchNameById(b.branchId)}", which is closed. Reopen the branch first to void it.`); return; }
    const item = itemById(b.itemId);
    if (!confirm(`Void this booking? This permanently reverses ${b.qty}x "${itemLabel(item)}" for ${b.customerName} -- its revenue, deposit, and any payments will be removed from the books. This can't be undone.`)) return;

    const removedJournalIds = ctx.state.journal.filter(j => j.id === b.id || (j.desc && j.desc.includes(`Booking ${b.id}`))).map(j => j.id);
    ctx.state.journal = ctx.state.journal.filter(j => !removedJournalIds.includes(j.id));
    ctx.state.rentalBookings = ctx.state.rentalBookings.filter(r => r.id !== b.id);

    queueWrite({ kind: 'delete', table: 'rentals', id: b.id });
    removedJournalIds.forEach(jid => queueWrite({ kind: 'delete', table: 'journal_entries', id: jid }));

    addNotification('Booking Voided', `${itemLabel(item)} booking for ${b.customerName} reversed and removed.`, `Was ${displayStatus(b)}, ETB ${b.amount.toFixed(2)}`);
    renderBookingContent();
}
// Whole-transaction version -- reverses every line in the group (and every
// journal entry tied to any of them: creation revenue, deposits, payments)
// in one go, with a single confirm, instead of voiding line by line.
function voidBookingGroup(groupId) {
    const rows = bookingGroupRows(groupId);
    if (rows.length === 0) return;
    if (rows.some(r => isBranchClosed(r.branchId))) { alert(`This booking belongs to a closed branch. Reopen the branch first to void it.`); return; }
    if (!confirm(`Void this whole booking? This permanently reverses all ${rows.length} item(s) for ${rows[0].customerName} -- their revenue, deposits, and any payments will be removed from the books. This can't be undone.`)) return;

    const bookingIds = rows.map(r => r.id);
    const removedJournalIds = ctx.state.journal.filter(j => bookingIds.includes(j.id) || (j.desc && bookingIds.some(bid => j.desc.includes(`Booking ${bid}`)))).map(j => j.id);
    ctx.state.journal = ctx.state.journal.filter(j => !removedJournalIds.includes(j.id));
    ctx.state.rentalBookings = ctx.state.rentalBookings.filter(r => r.groupId !== groupId);

    bookingIds.forEach(bid => queueWrite({ kind: 'delete', table: 'rentals', id: bid }));
    removedJournalIds.forEach(jid => queueWrite({ kind: 'delete', table: 'journal_entries', id: jid }));

    addNotification('Booking Voided', `${rows.length} item(s) for ${rows[0].customerName} reversed and removed.`, `Whole multi-item booking`);
    renderBookingContent();
}
// The Channel / Status / Type cell -- payment channel breakdown + paid
// status (same shape as the core Sales/Purchase History columns), plus the
// booking's rate type (Daily/Weekly/Monthly) standing in for "Type".
function channelStatusCell(record, total, rateType) {
    const breakdown = getChannelBreakdown(record, total, 'Accounts receivable');
    const remaining = Math.max(0, total - (record.amountPaid || 0));
    let html = renderChannelBreakdownHtml(breakdown);
    if (remaining <= 0.001) html += `<br><small style="color:var(--success)">[Paid in full]</small>`;
    else if ((record.amountPaid || 0) > 0) html += `<br><small style="color:var(--warning)">[Owes ETB ${remaining.toFixed(2)}]</small>`;
    else html += `<br><small style="color:var(--danger)">[Pending]</small>`;
    html += `<br><small style="color:var(--accent)">[${rateTypeLabel(rateType)}]</small>`;
    return html;
}
function bookingRow(b) {
    const item = itemById(b.itemId);
    const balance = Math.max(0, b.amount - b.amountPaid);
    const status = displayStatus(b);
    let actions = lineActions(b);
    if (balance > 0.001 && hasPerm('sales.mark_paid')) actions += `<button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.openPaymentModal('${b.id}')">Record Payment</button> `;
    return `<tr>
        <td>${fmtDate(b.date)}</td>
        <td>${b.customerName}${b.customerPhone ? `<br><span style="font-size:11px; color:var(--text-light);">${b.customerPhone}</span>` : ''}${buyerInfoStackHTML(b)}</td>
        <td class="truncate-cell" title="${itemLabel(item)}">${itemLabel(item)}</td>
        <td class="num">${b.qty}</td>
        <td>${fmtDate(b.startDate)}</td>
        <td>${fmtDate(b.expectedReturnDate)}</td>
        <td>${statusBadge(status)}</td>
        <td class="num">ETB ${b.amount.toFixed(2)}</td>
        <td>${channelStatusCell(b, b.amount, b.rateType)}</td>
        <td class="branch-col">${branchNameById(b.branchId)}</td>
        <td><small>${getTransactionAuthor(b.id)}</small></td>
        <td style="text-align:center; white-space:nowrap;">${actions}</td>
    </tr>`;
}
// A group's lines can each be at a different lifecycle stage (one item
// already out, another still reserved) since check-out/check-in happen per
// line -- so the collapsed row shows every distinct status present instead
// of picking just one.
function groupStatusSummary(rows) {
    const counts = {};
    rows.forEach(r => { const s = displayStatus(r); counts[s] = (counts[s] || 0) + 1; });
    const keys = Object.keys(counts);
    if (keys.length === 1) return statusBadge(keys[0]);
    return keys.map(k => `${statusBadge(k)} <small>×${counts[k]}</small>`).join(' ');
}
function toggleBookingGroupExpand(groupId) {
    if (expandedBookingGroups.has(groupId)) expandedBookingGroups.delete(groupId);
    else expandedBookingGroups.add(groupId);
    renderBookingContent();
}
// Check In stays per-line (each asset can come back in different
// condition and its own deposit gets settled individually) -- everything
// else in a grouped booking now acts on the whole transaction at once,
// see groupTransactionActions() below.
function lineActionsForGroupChild(b) {
    if (b.status === 'out' && hasPerm('rentals.checkin')) return `<button class="btn btn-small" onclick="rentalUI.openCheckInModal('${b.id}')">Check In</button>`;
    return '';
}
// Check Out / Cancel / Void act on every line in the group at once, the
// same way Record Payment already settles the whole basket in one go --
// a grouped booking is one real-world transaction, not several.
function groupTransactionActions(groupId, rows, balance) {
    const reserved = rows.filter(r => r.status === 'reserved');
    const progressed = rows.some(r => r.status !== 'reserved'); // at least one line already out or returned
    let html = '';
    if (balance > 0.001 && hasPerm('sales.mark_paid')) html += `<button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.openPaymentModal('${groupId}', true)">Record Payment</button> `;
    if (reserved.length > 0) {
        if (hasPerm('sales.create')) html += `<button class="btn btn-small" onclick="rentalUI.checkOutBookingGroup('${groupId}')">Check Out</button> `;
        if (hasPerm('sales.void')) html += `<button class="btn btn-small btn-danger" onclick="rentalUI.cancelBookingGroup('${groupId}')">Cancel</button> `;
    }
    if (progressed && hasPerm('sales.void')) html += `<button class="btn btn-small btn-danger" onclick="rentalUI.voidBookingGroup('${groupId}')">Void</button> `;
    return html;
}

// ---------------------------------------------------------------
// Printing -- thermal Receipt and full-page Invoice, using the same
// engine/layout core Sales & Purchase History use (see printReceiptFor/
// printInvoiceFor and their renderReceiptHTML/renderInvoiceHTML, index.html).
// This just builds the generic { lines, total, ... } shape from a booking
// or booking group -- deposit/rental-period info goes in extraNotes since
// that's rental-specific and neither core document knows about it.
// ---------------------------------------------------------------
function printBookingButtons(id, isGroup) {
    return `<button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.printBookingReceipt('${id}', ${!!isGroup})" title="Print thermal receipt">🧾 Receipt</button> <button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.printBookingInvoice('${id}', ${!!isGroup})" title="Print full-page invoice">📄 Invoice</button> `;
}
function buildBookingPrintData(id, isGroup) {
    const rows = isGroup ? bookingGroupRows(id) : [bookingById(id)].filter(Boolean);
    if (rows.length === 0) return null;
    const primary = rows[0];
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const amountPaid = rows.reduce((s, r) => s + r.amountPaid, 0);
    const record = { payments: rows.flatMap(r => r.payments || []), amountPaid };
    const extraNotes = rows.map(r => {
        const item = itemById(r.itemId);
        let note = `${r.qty}x ${item ? item.desc : '—'}: ${fmtDate(r.startDate)} to ${fmtDate(r.expectedReturnDate)} (${rateTypeLabel(r.rateType)})`;
        if (r.depositAmount > 0) note += ` — Deposit ${r.depositStatus === 'refunded' ? 'refunded' : (r.depositStatus === 'forfeited' ? 'forfeited' : (r.depositStatus === 'partial' ? 'partly settled' : 'held'))}: ETB ${r.depositAmount.toFixed(2)}`;
        return note;
    });
    return {
        docNumber: String(id).slice(-8), date: primary.date, branchId: primary.branchId,
        docLabel: 'Rental Booking Receipt', counterpartyLabel: 'Customer',
        counterpartyName: primary.customerName, counterpartyPhone: primary.customerPhone || '',
        buyerTin: primary.buyerTin || '', buyerTradeName: primary.buyerTradeName || '',
        lines: rows.map(r => ({ desc: itemLabel(itemById(r.itemId)), qty: r.qty, unit: r.qty ? r.amount / r.qty : r.amount, total: r.amount })),
        total, amountPaid, vatIncluded: false,
        channelBreakdown: getChannelBreakdown(record, total, 'Accounts receivable'),
        extraNotes
    };
}
// Printing goes through the shared buyer-info prompt in index.html (asks
// for TIN/trade name, remembers it on this booking or group for next time)
// before actually building the document and printing it -- see
// openBuyerInfoModal/confirmBuyerInfoAndPrint there, which calls back into
// buildBookingPrintDataPublic below once the info is saved.
function printBookingReceipt(id, isGroup) { window.openBuyerInfoModal('booking', id, isGroup, 'receipt'); }
function printBookingInvoice(id, isGroup) { window.openBuyerInfoModal('booking', id, isGroup, 'invoice'); }
function buildBookingPrintDataPublic(id, isGroup) { return buildBookingPrintData(id, isGroup); }
function getBookingBuyerInfo(id, isGroup) {
    const rows = isGroup ? bookingGroupRows(id) : [bookingById(id)].filter(Boolean);
    return rows[0] ? { tin: rows[0].buyerTin || '', name: rows[0].buyerTradeName || '' } : { tin: '', name: '' };
}
function saveBookingBuyerInfo(id, isGroup, tin, name) {
    const rows = isGroup ? bookingGroupRows(id) : [bookingById(id)].filter(Boolean);
    rows.forEach(r => {
        r.buyerTin = tin; r.buyerTradeName = name;
        queueWrite({ kind: 'update', table: 'rentals', id: r.id, patch: { buyer_tin: tin, buyer_trade_name: name } });
    });
    renderBookingContent();
}
function collectBookingBuyerInfo() {
    const tins = new Set(), names = new Set();
    bookings().forEach(b => { if (b.buyerTin) tins.add(b.buyerTin); if (b.buyerTradeName) names.add(b.buyerTradeName); });
    return { tins: [...tins], names: [...names] };
}

function bookingGroupRowsHTML(entry) {
    const { groupId, rows } = entry;
    const primary = rows[0];
    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    const total = bookingGroupTotal(groupId);
    const paid = bookingGroupPaid(groupId);
    const balance = Math.max(0, total - paid);
    const groupRecord = { payments: bookingGroupPayments(groupId), amountPaid: paid };
    const isExpanded = expandedBookingGroups.has(groupId);
    const groupActions = groupTransactionActions(groupId, rows, balance);
    const descCell = `<span style="cursor:pointer;" onclick="rentalUI.toggleBookingGroupExpand('${groupId}')">🧺 ${isExpanded ? '▾' : '▸'} ${rows.length} items</span>`;
    let html = `<tr>
        <td>${fmtDate(primary.date)}</td>
        <td>${primary.customerName}${primary.customerPhone ? `<br><span style="font-size:11px; color:var(--text-light);">${primary.customerPhone}</span>` : ''}${buyerInfoStackHTML(primary)}</td>
        <td class="truncate-cell">${descCell}</td>
        <td class="num">${totalQty}</td>
        <td>${fmtDate(primary.startDate)}</td>
        <td>${fmtDate(primary.expectedReturnDate)}</td>
        <td>${groupStatusSummary(rows)}</td>
        <td class="num"><strong>ETB ${total.toFixed(2)}</strong></td>
        <td>${channelStatusCell(groupRecord, total, primary.rateType)}</td>
        <td class="branch-col">${branchNameById(primary.branchId)}</td>
        <td><small>${getTransactionAuthor(primary.id)}</small></td>
        <td style="text-align:center; white-space:nowrap;">${groupActions}</td>
    </tr>`;
    if (isExpanded) {
        rows.forEach(r => {
            const item = itemById(r.itemId);
            html += `<tr style="background:var(--bg);">
                <td></td><td></td>
                <td class="truncate-cell" style="padding-left:32px;" title="${itemLabel(item)}"><small>↳ ${itemLabel(item)}</small></td>
                <td class="num"><small>${r.qty}</small></td>
                <td></td><td></td>
                <td>${statusBadge(displayStatus(r))}</td>
                <td class="num"><small>ETB ${r.amount.toFixed(2)}</small></td>
                <td style="text-align:center; white-space:nowrap;">${lineActionsForGroupChild(r)}</td>
                <td colspan="3"></td>
            </tr>`;
        });
    }
    return html;
}

// ---------------------------------------------------------------
// New Booking modal -- a small cart: add one or more assets (with their
// own quantities) before filling in the shared dates/customer/payment
// details once and creating all the bookings together.
// ---------------------------------------------------------------
// Whichever modal container actually exists on the current page -- the
// Bookings page has 'sales-rentals-modals', the Inventory/Availability
// page has 'inventory-rentals-modals'. This quick-book path (clicking a
// day on the Availability calendar) can be triggered from either.
function bookingModalsEl() {
    return document.getElementById('sales-rentals-modals') || document.getElementById('inventory-rentals-modals');
}
// Quick-book from a calendar day click on the Availability tab -- stays a
// small popup since it's a shortcut from a different page, not the main
// New Booking flow (see newBookingInlineHTML() below for that one).
function openBookingModal(prefillItemId, prefillDate) {
    bookingCart = [];
    const start = prefillDate || todayISO();
    const end = addDays(start, 1);
    const host = bookingModalsEl();
    if (!host) return;
    host.innerHTML = `
    <div class="modal-overlay active" onclick="rentalUI.closeBookingModal()">
        <div class="modal-box" onclick="event.stopPropagation()" style="max-width:460px; max-height:88vh; overflow-y:auto;">
            <h3 style="color:var(--primary); margin-bottom:14px;">New Booking</h3>
            ${bookingFormFieldsHTML(start, end)}
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.closeBookingModal()">Cancel</button>
                <button class="btn btn-small btn-success" onclick="rentalUI.submitBookingForm()">Create Booking</button>
            </div>
        </div>
    </div>`;
    refreshAddItemDatalist();
    if (prefillItemId) addCartLineFor(prefillItemId, 1);
    else renderCartLines();
    initEthiopianDatePickers();
    recalcBooking();
}
function closeBookingModal() { const el = bookingModalsEl(); if (el) el.innerHTML = ''; bookingCart = []; }

// Main "New Booking" entry point on the Bookings page -- sits directly in
// the page instead of a popup. Same fields as the calendar quick-book
// above (bookingFormFieldsHTML), just without the modal wrapper.
function bookingFormFieldsHTML(start, end) {
    return `
            <div class="form-group"><label>Start Date</label><input type="date" id="rb-start" value="${start}" onchange="rentalUI.recalcBooking()"></div>
            <div class="form-group"><label>Expected Return</label><input type="date" id="rb-end" value="${end}" onchange="rentalUI.recalcBooking()"></div>
            <div class="form-group"><label>Customer Name</label><input type="text" id="rb-cust-name"></div>
            <div class="form-group"><label>Customer Phone</label><input type="text" id="rb-cust-phone"></div>
            <div class="form-group"><label>Customer Address</label><input type="text" id="rb-cust-address"></div>
            <div class="form-group">
                <label>Add Asset</label>
                <input type="text" id="rb-add-item" list="rb-item-list" oninput="rentalUI.updateAddItemAvailability()" placeholder="Type to filter..." style="min-width: 300px;" autocomplete="off">
                <datalist id="rb-item-list"></datalist>
                <div><small id="rb-add-avail" style="color:var(--text-light);"></small></div>
            </div>
            <div class="form-group"><label>Qty</label><input type="number" id="rb-add-qty" min="1" value="1"></div>
            <div class="form-group" style="padding-top: 22px;"><button type="button" class="btn btn-small" onclick="rentalUI.addCartLine()">+ Add</button></div>
            <div id="rb-cart" style="margin-bottom:14px; width:100%;"></div>

            <div class="form-group"><label>Rate Type</label>
                <select id="rb-ratetype" onchange="rentalUI.recalcBooking()">
                    <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                </select>
            </div>
            <div class="form-group"><label>Amount (ETB)</label><input type="number" id="rb-amount" step="0.01" min="0" oninput="rentalUI.syncPaidNow()"></div>
            <div class="form-group">
                <label>Deposit (ETB, optional) <span title="A refundable security amount held from the customer, separate from the rental price. Given back when the item returns undamaged; kept in part or full if it doesn't. Leave at 0 if you don't take deposits." style="cursor:help; color:var(--text-light);">ⓘ</span></label>
                <input type="number" id="rb-deposit" step="0.01" min="0" value="0">
            </div>
            <div class="form-group"><label>Paid Now (ETB)</label><input type="number" id="rb-paidnow" step="0.01" min="0" value="0"></div>
            <div class="form-group"><label>Payment Channel</label>
                <select id="rb-channel" onchange="handleChannelSelectChange(this)" onfocus="this.dataset.prevValue=this.value">${buildChannelOptionsHtml(['Cash', 'Mobile banking'], 'Cash')}</select>
            </div>
            <div id="rb-error" style="display:none; background:#F1DCD8; color:var(--danger); font-size:13px; padding:10px; border-radius:6px; margin-bottom:12px; width:100%;"></div>`;
}
function newBookingInlineHTML() {
    const start = todayISO();
    const end = addDays(start, 1);
    return `
        <div class="card">
            <h2>New Booking</h2>
            ${bookingFormFieldsHTML(start, end)}
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button class="btn btn-small btn-success" onclick="rentalUI.submitBookingForm()">Create Booking</button>
            </div>
        </div>`;
}

// Reads the currently-selected Start/Expected Return from the form -- every
// availability figure in this modal (the dropdown, the Add cap, cart
// validation) is computed against this exact window, not just "on hand
// right now", so it matches what the Availability calendar would show for
// those same dates.
function currentBookingWindow() {
    const start = document.getElementById('rb-start')?.value;
    const end = document.getElementById('rb-end')?.value;
    return { start, end: (start && end && end > start) ? end : null };
}
// Matches an item by its "[category] desc" composite label -- the same
// format the Sales/Purchase "Type to filter..." item fields use, so a
// typed or datalist-picked value resolves the same way here.
function itemByLabel(label) { return items().find(i => itemLabel(i) === label); }
// Populates the datalist backing the Add Asset search field with every
// item that still has availability for the currently-selected date
// window -- rebuilt on every date change / cart change so it always
// reflects what's actually bookable right now.
function refreshAddItemDatalist() {
    const dl = document.getElementById('rb-item-list');
    if (!dl) return;
    const { start, end } = currentBookingWindow();
    const availableItems = items()
        .map(i => ({ item: i, avail: end ? qtyAvailableForRange(i, start, end) : qtyAvailable(i) }))
        .filter(x => x.avail > 0);
    dl.innerHTML = availableItems.map(({ item }) => `<option value="${itemLabel(item)}"></option>`).join('');
    updateAddItemAvailability();
}
// Shows how many of the currently-typed asset are free for the selected
// dates, right under the search field -- the dropdown used to carry this
// in its option text, but a free-text field needs it surfaced separately.
function updateAddItemAvailability() {
    const input = document.getElementById('rb-add-item');
    const availEl = document.getElementById('rb-add-avail');
    if (!input || !availEl) return;
    const item = itemByLabel(input.value);
    if (!item) { availEl.textContent = ''; return; }
    const { start, end } = currentBookingWindow();
    const avail = end ? qtyAvailableForRange(item, start, end) : qtyAvailable(item);
    availEl.textContent = `${avail} available`;
}

function renderCartLines() {
    const el = document.getElementById('rb-cart');
    if (!el) return;
    if (bookingCart.length === 0) {
        el.innerHTML = `<p style="font-size:12px; color:var(--text-light); margin:0;">No items added yet.</p>`;
        return;
    }
    el.innerHTML = `<table style="margin:0;"><thead><tr><th>Asset</th><th class="num">Qty</th><th style="text-align:center;">Remove</th></tr></thead><tbody>
        ${bookingCart.map((line, idx) => { const item = itemById(line.itemId); return `<tr>
            <td>${itemLabel(item)}</td>
            <td class="num">${line.qty}</td>
            <td style="text-align:center;"><button class="btn btn-small btn-danger" onclick="rentalUI.removeCartLine(${idx})">×</button></td>
        </tr>`; }).join('')}
    </tbody></table>`;
}
function addCartLineFor(itemId, qty) {
    const item = itemById(itemId);
    if (!item) return;
    const { start, end } = currentBookingWindow();
    const cap = end ? qtyAvailableForRange(item, start, end) : qtyAvailable(item);
    const already = bookingCart.filter(l => l.itemId === itemId).reduce((s, l) => s + l.qty, 0);
    const capped = Math.max(0, Math.min(qty, cap - already));
    if (capped <= 0) { renderCartLines(); return; }
    const existing = bookingCart.find(l => l.itemId === itemId);
    if (existing) existing.qty += capped; else bookingCart.push({ itemId, qty: capped });
    renderCartLines();
}
function addCartLine() {
    const input = document.getElementById('rb-add-item');
    const qtyInput = document.getElementById('rb-add-qty');
    const item = itemByLabel(input.value);
    if (!item) { alert('Type or pick an asset from the list first.'); return; }
    const itemId = item.id;
    const qty = parseInt(qtyInput.value) || 1;
    const { start, end } = currentBookingWindow();
    const cap = end ? qtyAvailableForRange(item, start, end) : qtyAvailable(item);
    const already = bookingCart.filter(l => l.itemId === itemId).reduce((s, l) => s + l.qty, 0);
    if (already >= cap) { alert(`No more of "${itemLabel(item)}" available for those dates.`); return; }
    addCartLineFor(itemId, qty);
    input.value = '';
    qtyInput.value = 1;
    recalcBooking();
}
function removeCartLine(idx) {
    bookingCart.splice(idx, 1);
    renderCartLines();
    recalcBooking();
}

function recalcBooking() {
    const start = document.getElementById('rb-start').value;
    const end = document.getElementById('rb-end').value;
    // Availability is date-range specific -- when the dates change, cap any
    // cart line that now exceeds what's actually free over the new window
    // (a line added under an old, more generous date range could otherwise
    // overbook the new one), and refresh the Add Asset list/quantities to
    // match.
    if (start && end && end > start) {
        let changed = false;
        bookingCart.forEach(line => {
            const item = itemById(line.itemId);
            if (!item) return;
            const cap = qtyAvailableForRange(item, start, end);
            if (line.qty > cap) { line.qty = cap; changed = true; }
        });
        const before = bookingCart.length;
        bookingCart = bookingCart.filter(l => l.qty > 0);
        if (changed || bookingCart.length !== before) renderCartLines();
    }
    refreshAddItemDatalist();
    if (!start || !end || end <= start) return;
    const days = billableDays(start, end);
    const rtSel = document.getElementById('rb-ratetype');
    rtSel.value = suggestRateType(days);
    const rateType = rtSel.value;
    const total = bookingCart.reduce((sum, line) => {
        const item = itemById(line.itemId);
        return item ? sum + perUnitAmount(item, rateType, days) * line.qty : sum;
    }, 0);
    document.getElementById('rb-amount').value = total.toFixed(2);
    syncPaidNow();
}
// Keeps "Paid Now" mirroring "Amount" the instant Amount changes, whether
// that's from recalcBooking() (dates/cart/rate changed) or the person
// typing directly into the Amount field.
function syncPaidNow() {
    const amountEl = document.getElementById('rb-amount');
    const paidEl = document.getElementById('rb-paidnow');
    if (amountEl && paidEl) paidEl.value = amountEl.value;
}

function submitBookingForm() {
    const errEl = document.getElementById('rb-error');
    const start = document.getElementById('rb-start').value;
    const end = document.getElementById('rb-end').value;
    const rateType = document.getElementById('rb-ratetype').value;
    const totalAmount = parseFloat(document.getElementById('rb-amount').value) || 0;
    const custName = document.getElementById('rb-cust-name').value.trim();
    const custPhone = document.getElementById('rb-cust-phone').value.trim();
    const custAddress = document.getElementById('rb-cust-address').value.trim();
    const deposit = parseFloat(document.getElementById('rb-deposit').value) || 0;
    const paidNow = parseFloat(document.getElementById('rb-paidnow').value) || 0;
    const channel = document.getElementById('rb-channel').value;

    if (bookingCart.length === 0) { errEl.innerText = 'Add at least one asset.'; errEl.style.display = 'block'; return; }
    if (!custName) { errEl.innerText = "Enter the customer's name."; errEl.style.display = 'block'; return; }
    if (!start || !end || end <= start) { errEl.innerText = 'Expected return must be after the start date.'; errEl.style.display = 'block'; return; }
    for (const line of bookingCart) {
        const item = itemById(line.itemId);
        if (!item) { errEl.innerText = 'One of the added assets no longer exists.'; errEl.style.display = 'block'; return; }
        const cap = qtyAvailableForRange(item, start, end);
        if (line.qty > cap) { errEl.innerText = `Only ${cap} of "${itemLabel(item)}" available for ${fmtDate(start)} – ${fmtDate(end)}.`; errEl.style.display = 'block'; return; }
    }
    if (paidNow > totalAmount + 0.001) { errEl.innerText = `Paid Now can't be more than the total (ETB ${totalAmount.toFixed(2)}).`; errEl.style.display = 'block'; return; }

    // Each line's natural share of the total (from its own rate calc) is
    // used to split the (possibly manually-overridden) total amount,
    // paid-now, and deposit proportionally across the rows this creates --
    // the last line absorbs any rounding remainder so the sum matches
    // exactly what was entered.
    const days = billableDays(start, end);
    const rawAmounts = bookingCart.map(line => { const item = itemById(line.itemId); return perUnitAmount(item, rateType, days) * line.qty; });
    const rawTotal = rawAmounts.reduce((s, a) => s + a, 0) || 1;

    (async () => {
        const branchId = await resolveTransactionBranch();
        if (!branchId) return;

        // Multiple assets added to the cart become one basket -- a shared
        // groupId so the Bookings table can collapse them into a single
        // expandable row, the same way a multi-item Purchase basket does.
        // A single-asset booking gets no groupId and stays a plain row.
        const groupId = bookingCart.length > 1 ? `RGRP-${Date.now().toString().slice(-6)}` : null;
        const bookingDate = todayISO();

        let remAmount = totalAmount, remPaid = paidNow, remDeposit = deposit;
        bookingCart.forEach((line, idx) => {
            const item = itemById(line.itemId);
            const isLast = idx === bookingCart.length - 1;
            const share = rawAmounts[idx] / rawTotal;
            const lineAmount = isLast ? remAmount : +(totalAmount * share).toFixed(2);
            const linePaid = isLast ? remPaid : +(paidNow * share).toFixed(2);
            const lineDeposit = isLast ? remDeposit : +(deposit * share).toFixed(2);
            remAmount -= lineAmount; remPaid -= linePaid; remDeposit -= lineDeposit;

            const id = crypto.randomUUID();
            const booking = {
                id, itemId: item.id, branchId, date: bookingDate, groupId,
                customerName: custName, customerPhone: custPhone, customerAddress: custAddress, qty: line.qty,
                startDate: start, expectedReturnDate: end, actualReturnDate: null, rateType, amount: lineAmount, amountPaid: linePaid,
                depositAmount: lineDeposit, depositStatus: lineDeposit > 0 ? 'held' : 'refunded', depositForfeitedAmount: 0,
                status: 'reserved', damageNotes: '', payments: linePaid > 0 ? [{ date: todayISO(), amount: linePaid, channel }] : []
            };
            ctx.state.rentalBookings.push(booking);
            queueWrite({ kind: 'insert', table: 'rentals', row: toDbBooking(booking) });

            const remaining = Math.max(0, lineAmount - linePaid);
            const lines = [];
            if (linePaid > 0) lines.push({ account: ctx.channelAccountCodes[channel], dr: linePaid, cr: 0 });
            if (remaining > 0) lines.push({ account: '1300', dr: remaining, cr: 0 });
            lines.push({ account: '4020', cr: lineAmount, dr: 0 });
            const revenueJournal = { id, date: todayISO(), desc: stampDesc(`Rental booked: ${line.qty}x ${item.desc} / Cust: ${custName}`), lines, branchId };
            ctx.state.journal.push(revenueJournal);
            queueWrite({ kind: 'insert', table: 'journal_entries', row: toDbJournal(revenueJournal) });

            if (lineDeposit > 0) {
                const depositJournal = { id: crypto.randomUUID(), date: todayISO(), desc: stampDesc(`Deposit held: ${item.desc} / Cust: ${custName} (Booking ${id})`), lines: [{ account: ctx.channelAccountCodes[channel], dr: lineDeposit, cr: 0 }, { account: '2030', cr: lineDeposit, dr: 0 }], branchId };
                ctx.state.journal.push(depositJournal);
                queueWrite({ kind: 'insert', table: 'journal_entries', row: toDbJournal(depositJournal) });
            }
        });

        addNotification('Rental Booked', `${bookingCart.length} item(s) booked for ${custName}`, `${fmtDate(start)} – ${fmtDate(end)}, ETB ${totalAmount.toFixed(2)}`);
        closeBookingModal();   // clears the calendar quick-book popup, if that's what was open
        bookingCart = [];       // clears the always-visible New Booking panel's cart for the next entry
        renderBookingContent();
    })();
}

// ---------------------------------------------------------------
// Check out / cancel
// ---------------------------------------------------------------
function checkOutBooking(id) {
    const b = bookingById(id);
    if (!b) return;
    const item = itemById(b.itemId);
    if (!confirm(`Confirm ${b.qty}x "${itemLabel(item)}" is leaving with ${b.customerName}?`)) return;
    b.status = 'out';
    queueWrite({ kind: 'update', table: 'rentals', id: b.id, patch: { status: 'out' } });
    renderBookingContent();
}
function cancelBooking(id) {
    const b = bookingById(id);
    if (!b) return;
    if (!confirm('Cancel this reservation? This does not reverse any payment already recorded.')) return;
    b.status = 'returned';
    b.damageNotes = (b.damageNotes ? b.damageNotes + ' | ' : '') + 'Cancelled before check-out.';
    queueWrite({ kind: 'update', table: 'rentals', id: b.id, patch: { status: 'returned', damage_notes: b.damageNotes } });
    renderBookingContent();
}
// Whole-transaction versions -- act on every still-reserved line in the
// group with one confirm, instead of one at a time.
function checkOutBookingGroup(groupId) {
    const rows = bookingGroupRows(groupId).filter(r => r.status === 'reserved');
    if (rows.length === 0) return;
    if (!confirm(`Confirm all ${rows.length} reserved item(s) in this booking are leaving with ${rows[0].customerName}?`)) return;
    rows.forEach(b => {
        b.status = 'out';
        queueWrite({ kind: 'update', table: 'rentals', id: b.id, patch: { status: 'out' } });
    });
    renderBookingContent();
}
function cancelBookingGroup(groupId) {
    const rows = bookingGroupRows(groupId).filter(r => r.status === 'reserved');
    if (rows.length === 0) return;
    if (!confirm('Cancel this whole reservation? This does not reverse any payment already recorded.')) return;
    rows.forEach(b => {
        b.status = 'returned';
        b.damageNotes = (b.damageNotes ? b.damageNotes + ' | ' : '') + 'Cancelled before check-out.';
        queueWrite({ kind: 'update', table: 'rentals', id: b.id, patch: { status: 'returned', damage_notes: b.damageNotes } });
    });
    renderBookingContent();
}

// ---------------------------------------------------------------
// Check in
// ---------------------------------------------------------------
function openCheckInModal(id) {
    checkinContext = id;
    const b = bookingById(id);
    if (!b) return;
    document.getElementById('sales-rentals-modals').innerHTML = `
    <div class="modal-overlay active" onclick="rentalUI.closeCheckInModal()">
        <div class="modal-box" onclick="event.stopPropagation()" style="max-width:400px;">
            <h3 style="color:var(--primary); margin-bottom:14px;">Check In — ${b.customerName}</h3>
            <div class="form-group" style="margin-bottom:10px;"><label>Qty Returned (of ${b.qty})</label><input type="number" id="ci-qty-returned" min="0" max="${b.qty}" value="${b.qty}" style="width:100%;" oninput="rentalUI.updateCheckInMissingHint()"></div>
            <p id="ci-missing-hint" style="display:none; font-size:12px; color:var(--warning); margin:-4px 0 10px;"></p>
            <div class="form-group" style="margin-bottom:10px;"><label>Condition Notes (optional)</label><input type="text" id="ci-notes" style="width:100%;" placeholder="e.g. minor scratch on casing"></div>
            ${b.depositAmount > 0 ? `
            <div class="form-group" style="margin-bottom:10px;"><label>Deposit Held (ETB ${b.depositAmount.toFixed(2)})</label>
                <select id="ci-deposit-action" style="width:100%;" onchange="rentalUI.toggleForfeitField()">
                    <option value="refund">Refund in full</option>
                    <option value="forfeit_partial">Forfeit part (damage)</option>
                    <option value="forfeit_full">Forfeit in full (damage)</option>
                </select>
            </div>
            <div class="form-group" id="ci-forfeit-group" style="display:none; margin-bottom:10px;"><label>Amount to Forfeit (ETB)</label><input type="number" id="ci-forfeit-amount" step="0.01" min="0" max="${b.depositAmount}" style="width:100%;"></div>
            <div class="form-group" style="margin-bottom:10px;"><label>Refund Channel</label>
                <select id="ci-channel" style="width:100%;" onchange="handleChannelSelectChange(this)" onfocus="this.dataset.prevValue=this.value">${buildChannelOptionsHtml(['Cash', 'Mobile banking'], 'Cash')}</select>
            </div>` : ''}
            <div id="ci-error" style="display:none; background:#F1DCD8; color:var(--danger); font-size:13px; padding:10px; border-radius:6px; margin-bottom:12px;"></div>
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.closeCheckInModal()">Cancel</button>
                <button class="btn btn-small btn-success" onclick="rentalUI.submitCheckIn()">Confirm Return</button>
            </div>
        </div>
    </div>`;
}
function closeCheckInModal() { const el = document.getElementById('sales-rentals-modals'); if (el) el.innerHTML = ''; checkinContext = null; }
// Live preview while typing the returned qty -- warns before Confirm
// Return is even clicked that some units will be written off (and, if
// the booking's overdue, billed extra), rather than that only showing
// up after the fact in the item's history.
function updateCheckInMissingHint() {
    const b = bookingById(checkinContext);
    const hint = document.getElementById('ci-missing-hint');
    const qtyInput = document.getElementById('ci-qty-returned');
    if (!b || !hint || !qtyInput) return;
    const returned = Math.max(0, Math.min(b.qty, parseInt(qtyInput.value) || 0));
    const missing = b.qty - returned;
    if (missing <= 0) { hint.style.display = 'none'; return; }
    const item = itemById(b.itemId);
    const overdueNote = (isOverdue(b) && item && item.dailyRate) ? ' — will also be billed extra for the overdue days.' : '';
    hint.innerText = `${missing} unit(s) won't be returned. They'll be written off${overdueNote}`;
    hint.style.display = 'block';
}
function toggleForfeitField() {
    const action = document.getElementById('ci-deposit-action').value;
    document.getElementById('ci-forfeit-group').style.display = action === 'forfeit_partial' ? 'block' : 'none';
}
function submitCheckIn() {
    const b = bookingById(checkinContext);
    if (!b) return;
    const errEl = document.getElementById('ci-error');
    const notes = document.getElementById('ci-notes') ? document.getElementById('ci-notes').value.trim() : '';
    const item = itemById(b.itemId);

    const qtyInput = document.getElementById('ci-qty-returned');
    let qtyReturned = qtyInput ? parseInt(qtyInput.value) : b.qty;
    if (isNaN(qtyReturned) || qtyReturned < 0) qtyReturned = 0;
    if (qtyReturned > b.qty) qtyReturned = b.qty;
    const missingQty = b.qty - qtyReturned;

    let forfeited = 0, refunded = 0, channel = null;
    if (b.depositAmount > 0) {
        const action = document.getElementById('ci-deposit-action').value;
        channel = document.getElementById('ci-channel').value;
        if (action === 'forfeit_full') forfeited = b.depositAmount;
        else if (action === 'forfeit_partial') {
            forfeited = parseFloat(document.getElementById('ci-forfeit-amount').value) || 0;
            if (forfeited > b.depositAmount + 0.001) { errEl.innerText = `Can't forfeit more than the ETB ${b.depositAmount.toFixed(2)} held.`; errEl.style.display = 'block'; return; }
        }
        refunded = Math.max(0, b.depositAmount - forfeited);
    }

    // Handle any units that never came back BEFORE flipping the booking to
    // 'returned' -- writeOffMissingUnits checks isOverdue(b), which only
    // reads true while status is still 'out'.
    let writeOffResult = null;
    if (missingQty > 0 && item) writeOffResult = writeOffMissingUnits(item, missingQty, b);

    b.status = 'returned';
    b.actualReturnDate = todayISO();
    b.damageNotes = notes + (writeOffResult && writeOffResult.consumedQty > 0
        ? `${notes ? ' | ' : ''}${writeOffResult.consumedQty} unit(s) not returned — written off` + (writeOffResult.overdueCharge > 0 ? `, ETB ${writeOffResult.overdueCharge.toFixed(2)} overdue charge added` : '') + '.'
        : '');
    b.depositForfeitedAmount = forfeited;
    b.depositStatus = forfeited === 0 ? 'refunded' : (refunded === 0 ? 'forfeited' : 'partial');
    queueWrite({
        kind: 'update', table: 'rentals', id: b.id,
        patch: { status: 'returned', actual_return_date: b.actualReturnDate, damage_notes: b.damageNotes, deposit_forfeited_amount: forfeited, deposit_status: b.depositStatus }
    });

    if (b.depositAmount > 0) {
        const lines = [];
        if (refunded > 0) lines.push({ account: '2030', dr: refunded, cr: 0 }, { account: ctx.channelAccountCodes[channel], cr: refunded, dr: 0 });
        // Forfeited deposits post to 4030 (Other Income), not 4020 (Rental
        // Revenue) -- it's money the business keeps, but it's a damage/loss
        // recovery, not rental income, so it's kept out of revenue reports.
        if (forfeited > 0) lines.push({ account: '2030', dr: forfeited, cr: 0 }, { account: '4030', cr: forfeited, dr: 0 });
        if (lines.length) {
            const settleJournal = { id: crypto.randomUUID(), date: todayISO(), desc: stampDesc(`Deposit settled via ${channel}: ${item ? item.desc : ''} / Cust: ${b.customerName} (Booking ${b.id})`), lines, branchId: b.branchId };
            ctx.state.journal.push(settleJournal);
            queueWrite({ kind: 'insert', table: 'journal_entries', row: toDbJournal(settleJournal) });
        }
    }

    addNotification('Rental Returned', `${item ? item.desc : 'Asset'} checked in from ${b.customerName}`,
        writeOffResult && writeOffResult.consumedQty > 0 ? `${writeOffResult.consumedQty} unit(s) not returned — written off.` : (notes || undefined));
    closeCheckInModal();
    renderBookingContent();
}

// ---------------------------------------------------------------
// Record Payment
// ---------------------------------------------------------------
// id is either one booking's id (isGroup falsy) or a groupId (isGroup
// true) -- a group payment settles the whole multi-item basket at once,
// same as the core Multi-Item Purchase's single Record Payment action.
function openPaymentModal(id, isGroup) {
    paymentContext = { id, isGroup: !!isGroup };
    let balance, total, branchId;
    if (isGroup) {
        total = bookingGroupTotal(id);
        balance = Math.max(0, total - bookingGroupPaid(id));
        branchId = (bookingGroupRows(id)[0] || {}).branchId;
    } else {
        const b = bookingById(id);
        if (!b) return;
        total = b.amount;
        balance = Math.max(0, b.amount - b.amountPaid);
        branchId = b.branchId;
    }
    if (isBranchClosed(branchId)) { paymentContext = null; alert(`This booking belongs to "${branchNameById(branchId)}", which is closed. Reopen the branch first to record a payment against it.`); return; }
    document.getElementById('sales-rentals-modals').innerHTML = `
    <div class="modal-overlay active" onclick="rentalUI.closePaymentModal()">
        <div class="modal-box" onclick="event.stopPropagation()" style="max-width:380px;">
            <h3 style="color:var(--primary); margin-bottom:8px;">Record Payment</h3>
            <p style="font-size:13px; color:var(--text-light); margin-bottom:14px;">Owed: ETB ${balance.toFixed(2)} of ETB ${total.toFixed(2)} total</p>
            <div class="form-group" style="margin-bottom:14px;"><label>Amount (ETB)</label><input type="number" id="rp-amount" step="0.01" min="0.01" max="${balance}" value="${balance.toFixed(2)}" style="width:100%;"></div>
            <div class="form-group" style="margin-bottom:14px;"><label>Channel</label>
                <select id="rp-channel" style="width:100%;" onchange="handleChannelSelectChange(this)" onfocus="this.dataset.prevValue=this.value">${buildChannelOptionsHtml(['Cash', 'Mobile banking'], 'Cash')}</select>
            </div>
            <div id="rp-error" style="display:none; background:#F1DCD8; color:var(--danger); font-size:13px; padding:10px; border-radius:6px; margin-bottom:12px;"></div>
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button class="btn btn-small" style="background:var(--bg); color:var(--text); border:1px solid var(--border);" onclick="rentalUI.closePaymentModal()">Cancel</button>
                <button class="btn btn-small btn-success" onclick="rentalUI.submitPayment()">Save Payment</button>
            </div>
        </div>
    </div>`;
}
function closePaymentModal() { const el = document.getElementById('sales-rentals-modals'); if (el) el.innerHTML = ''; paymentContext = null; }
function submitPayment() {
    if (!paymentContext) return;
    const { id, isGroup } = paymentContext;
    const errEl = document.getElementById('rp-error');
    const rows = isGroup ? bookingGroupRows(id) : [bookingById(id)].filter(Boolean);
    if (rows.length === 0) { closePaymentModal(); return; }
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const balance = Math.max(0, total - rows.reduce((s, r) => s + r.amountPaid, 0));
    const amount = parseFloat(document.getElementById('rp-amount').value);
    const channel = document.getElementById('rp-channel').value;
    if (isNaN(amount) || amount <= 0) { errEl.innerText = 'Enter a valid amount.'; errEl.style.display = 'block'; return; }
    if (amount > balance + 0.001) { errEl.innerText = `Can't be more than the ETB ${balance.toFixed(2)} owed.`; errEl.style.display = 'block'; return; }

    const date = todayISO();
    // A single-item booking is settled directly. A group payment is a
    // waterfall: fill each line's own remaining balance in turn until the
    // amount entered is used up, so no line is ever paid past its own
    // total -- each affected line gets its own payment record and journal
    // entry, same as at booking time.
    let remaining = amount;
    rows.forEach(b => {
        if (remaining <= 0.001) return;
        const lineBalance = Math.max(0, b.amount - b.amountPaid);
        if (lineBalance <= 0.001) return;
        const applied = Math.min(lineBalance, remaining);
        remaining -= applied;

        b.payments = b.payments || [];
        b.payments.push({ date, amount: applied, channel });
        b.amountPaid += applied;
        queueWrite({ kind: 'update', table: 'rentals', id: b.id, patch: { amount_paid: b.amountPaid, payments: b.payments } });
        const paymentJournal = { id: crypto.randomUUID(), date, desc: stampDesc(`Payment received for Booking ${b.id} via ${channel}`), lines: [{ account: ctx.channelAccountCodes[channel], dr: applied, cr: 0 }, { account: '1300', cr: applied, dr: 0 }], branchId: b.branchId };
        ctx.state.journal.push(paymentJournal);
        queueWrite({ kind: 'insert', table: 'journal_entries', row: toDbJournal(paymentJournal) });
    });

    closePaymentModal();
    renderBookingContent();
}

// Exposed as a single global so inline onclick="" handlers (which run in
// window/global scope, not this module's scope) can reach these.
window.rentalUI = {
    switchInventoryTab, shiftCalendar, jumpCalendarToDate, applyInventoryFilter,
    setBookingsFilter, applyBookingsFilter, toggleBookingGroupExpand, openStatusPopup,
    openWriteOffModal, closeWriteOffModal, confirmWriteOff,
    openBookingModal, closeBookingModal, recalcBooking, syncPaidNow, updateAddItemAvailability, addCartLine, removeCartLine, submitBookingForm,
    checkOutBooking, cancelBooking, voidBooking,
    checkOutBookingGroup, cancelBookingGroup, voidBookingGroup,
    openCheckInModal, closeCheckInModal, toggleForfeitField, updateCheckInMissingHint, submitCheckIn,
    openPaymentModal, closePaymentModal, submitPayment,
    printBookingReceipt, printBookingInvoice, buildBookingPrintDataPublic,
    getBookingBuyerInfo, saveBookingBuyerInfo, collectBookingBuyerInfo,
    // Called by the core app's bulkReplaceAllData() (Factory Reset,
    // Restore Backup, onboarding import) -- those flows wipe and reinsert
    // inventory_items, and any surviving `rentals` row referencing a
    // deleted item would trip the rentals_item_id_fkey constraint. Core
    // code doesn't know this table's column shape, so it calls this to get
    // rows already in DB format rather than building them itself.
    serializeForBulkReplace: () => (ctx.state.rentalBookings || []).map(toDbBooking)
};