// verticals/pharmacy.js
//
// Only fetched for tenants with business_type === 'pharmacy' (see
// business-types.config.js -> loadVerticalModule). Renders two
// dashboard cards -- "Expiring soon" and "Expired" -- each expandable
// in place to show the underlying batches.
//
// Reads from state that's already in memory (state.inventory[i].lots)
// rather than firing its own Supabase query -- same offline-first
// pattern the rest of the app uses.

const WARN_DAYS = 30;
const DANGER_DAYS = 7;

function daysUntil(dateStr) {
    const ms = new Date(dateStr) - new Date(new Date().toDateString());
    return Math.ceil(ms / 86400000);
}

function getLots(state, predicate) {
    const rows = [];
    (state.inventory || []).forEach(item => {
        (item.lots || []).forEach(lot => {
            if (!lot.expiry || lot.qty <= 0) return;
            const days = daysUntil(lot.expiry);
            if (predicate(days)) rows.push({ itemName: item.desc || item.name, lot, days });
        });
    });
    return rows.sort((a, b) => a.days - b.days);
}

const getExpiringSoon = state => getLots(state, d => d >= 0 && d <= WARN_DAYS);
const getExpired = state => getLots(state, d => d < 0);

function badge(days) {
    if (days < 0) return `<span style="background:#FAECE7; color:var(--danger); font-size:11px; padding:2px 8px; border-radius:20px;">Expired ${Math.abs(days)}d ago</span>`;
    const danger = days <= DANGER_DAYS;
    const bg = danger ? '#FAECE7' : '#FCEEDD';
    const fg = danger ? 'var(--danger)' : 'var(--warning)';
    return `<span style="background:${bg}; color:${fg}; font-size:11px; padding:2px 8px; border-radius:20px;">${days} days</span>`;
}

function cardHTML(id, title, countColor, rows, emptyLabel) {
    return `
        <div id="${id}-card" style="background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px; cursor:pointer; box-shadow:var(--shadow-sm); margin-bottom:8px;">
            <div style="display:flex; align-items:center; justify-content:space-between;">
                <div>
                    <p style="font-size:11px; color:var(--text-light); margin:0 0 4px;">${title}</p>
                    <p style="font-family:'IBM Plex Mono',monospace; font-size:20px; font-weight:600; color:${rows.length ? countColor : 'var(--text)'}; margin:0;">${rows.length}</p>
                </div>
                <span id="${id}-chevron" style="color:var(--text-light); transition:transform 0.15s; display:inline-block;">&#9662;</span>
            </div>
        </div>
        <div id="${id}-details" style="display:none; background:var(--surface); border:1px solid var(--border); border-top:none; border-radius:0 0 10px 10px; margin:-12px 0 8px; overflow:hidden;">
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead>
                    <tr style="text-align:left; color:var(--text-light); border-bottom:1px solid var(--border);">
                        <th style="padding:8px 12px; font-weight:400;">Medicine</th>
                        <th style="padding:8px 12px; font-weight:400;">Expiry</th>
                        <th style="padding:8px 12px; font-weight:400;">Qty</th>
                        <th style="padding:8px 12px; font-weight:400; text-align:right;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `
                        <tr style="border-bottom:1px solid var(--border);">
                            <td style="padding:8px 12px; color:var(--text);">${r.itemName}</td>
                            <td style="padding:8px 12px; font-family:'IBM Plex Mono',monospace; color:var(--text);">${r.lot.expiry}</td>
                            <td style="padding:8px 12px; font-family:'IBM Plex Mono',monospace; color:var(--text);">${r.lot.qty}</td>
                            <td style="padding:8px 12px; text-align:right;">${badge(r.days)}</td>
                        </tr>`).join('') || `<tr><td colspan="4" style="padding:12px; text-align:center; color:var(--text-light);">${emptyLabel}</td></tr>`}
                </tbody>
            </table>
        </div>`;
}

function wireToggle(id) {
    const card = document.getElementById(`${id}-card`);
    const details = document.getElementById(`${id}-details`);
    const chevron = document.getElementById(`${id}-chevron`);
    if (!card) return;
    let open = false;
    card.addEventListener('click', () => {
        open = !open;
        details.style.display = open ? 'block' : 'none';
        chevron.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
        card.style.borderRadius = open ? '10px 10px 0 0' : '10px';
        card.style.marginBottom = open ? '0' : '8px';
    });
}

function render(mountEl, state) {
    const soon = getExpiringSoon(state);
    const expired = getExpired(state);
    mountEl.style.maxWidth = '340px';
    mountEl.innerHTML =
        cardHTML('pharm-soon', 'Expiring soon', 'var(--danger)', soon, `Nothing expiring in the next ${WARN_DAYS} days.`) +
        cardHTML('pharm-expired', 'Expired', 'var(--danger)', expired, 'No expired stock.');
    wireToggle('pharm-soon');
    wireToggle('pharm-expired');
}

// ctx: { state, mountEl } -- mountEl is the shared vertical-widgets slot
// on the dashboard (see index.html near the top of the dashboard view).
export function init(ctx) {
    render(ctx.mountEl, ctx.state);
}

// Call again whenever the dashboard re-renders (renderAnalyticalDashboards
// already does this) so both counts and any expanded table stay current.
export function refresh(ctx) {
    render(ctx.mountEl, ctx.state);
}