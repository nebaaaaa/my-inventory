// business-types.config.js
//
// Always loaded (it's tiny). Maps each tenant's business_type to:
//   - label overrides for the nav/i18n strings that should read
//     differently for that vertical (e.g. "Inventory" -> "Medicines")
//   - modulePath: the vertical-specific module to lazy-load, or null
//     if this business type has no extra behavior yet
//
// To add a new vertical (cafe, hotel, rental): add an entry here and
// write the matching file under verticals/. Nothing else in this file
// changes, and nothing in index.html needs to change either.

const BUSINESS_TYPES = {
    retail: {
        // Catch-all for any shop selling physical products that isn't its
        // own defined vertical yet — electrical, hardware, general stores,
        // etc. Not "electrical" specifically: this is the default every
        // shop gets until it's explicitly given its own vertical (like
        // pharmacy below), so it should never assume one particular trade.
        label: 'Retail / General Shop',
        labelOverrides: {},
        modulePath: null
    },
    pharmacy: {
        label: 'Pharmacy',
        // Pharmacies here also sell cosmetics, skincare, and supplements —
        // not just medicines — so "Inventory" stays as-is rather than
        // being renamed. The expiry-date field and dashboard card are
        // what's actually pharmacy-specific, not the nav label.
        labelOverrides: {},
        modulePath: './verticals/pharmacy.js'
    },
    appliance_rental: {
        label: 'Home Appliance Rental',
        // Unlike pharmacy, this vertical replaces content on two EXISTING
        // pages rather than adding a new one: Inventory/Stock gets
        // Availability + Assets sections in place of the Stock List, and
        // Sales gets a Bookings section in place of normal sale entry.
        // index.html hides the default content for those two sections
        // (see applyBusinessTypeLabels) and gives the module two empty
        // mount divs (#inventory-rental-mount, #sales-rental-mount) to
        // render into instead. Add Product / Purchase are reused as-is.
        // The Sales nav label itself is renamed via this override, since
        // it no longer records plain sales for this vertical.
        labelOverrides: { 'nav.sales': 'Booking' },
        modulePath: './verticals/appliance_rental.js'
    }
};

// Call once after currentTenantId/businessType are known (right after
// login, alongside the rest of the post-login setup). Safe to call for
// business types with no extra module — it just resolves immediately.
async function loadVerticalModule(businessType, ctx) {
    const config = BUSINESS_TYPES[businessType];
    if (!config || !config.modulePath) return null;
    const mod = await import(config.modulePath);
    if (typeof mod.init === 'function') mod.init(ctx);
    return mod;
}