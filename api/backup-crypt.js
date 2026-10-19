// /api/backup-crypt.js  (NEW) - encrypts and decrypts MELEYA backup files.
// The master key lives ONLY in this server's environment (Vercel > Settings > Environment Variables):
//   BACKUP_MASTER_KEY   32 random bytes, base64.  Create one with:  openssl rand -base64 32
//   (optional) BACKUP_KEY_VERSION  current key number, default 1. To rotate, add BACKUP_MASTER_KEY_V2 and set
//   BACKUP_KEY_VERSION=2; keep every old key (BACKUP_MASTER_KEY or BACKUP_MASTER_KEY_V1...) so old files still open.
// The key never reaches the browser: the app sends a small piece of the backup here and gets the scrambled piece back.
// Only the OWNER of the business named in the file can use this (checked against your Supabase), and the
// shop owner never sees the key. Admin recovery without the app: decrypt-backup.mjs.
import crypto from 'node:crypto';

export const config = { maxDuration: 20 };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nwkrrcatdhppvlceuzwg.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53a3JyY2F0ZGhwcHZsY2V1endnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMjEzNjUsImV4cCI6MjA5OTg5NzM2NX0.kELqbONKGQIs2Z99Zx8rEcwuYekTCugLYtbsYW3_0h8';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function masterKey(version) {
    const raw = process.env['BACKUP_MASTER_KEY_V' + version] || (version === 1 ? process.env.BACKUP_MASTER_KEY : '');
    if (!raw) throw new HttpError(500, 'Backup encryption is not set up on the server.');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new HttpError(500, 'Backup encryption key on the server is not valid.');
    return key;
}
// One key per file: HKDF(master key, random salt of the file, business id).
function fileKey(version, salt, kid) {
    return Buffer.from(crypto.hkdfSync('sha256', masterKey(version), salt, 'meleya-backup-v2|' + kid, 32));
}
const aad = (kid, index, total, version) => Buffer.from(`${kid}|${index}|${total}|${version}`, 'utf8');

async function requireOwner(req, kid) {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'Please sign in again.');
    const headers = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers });
    if (!u.ok) throw new HttpError(401, 'Please sign in again.');
    const user = await u.json();
    if (!user || !user.id) throw new HttpError(401, 'Please sign in again.');
    const m = await fetch(`${SUPABASE_URL}/rest/v1/business_members?business_id=eq.${encodeURIComponent(kid)}&user_id=eq.${encodeURIComponent(user.id)}&is_owner=eq.true&select=id&limit=1`, { headers });
    const rows = m.ok ? await m.json().catch(() => null) : null;
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(403, 'Only the owner of this business can use this backup.');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    try {
        const b = req.body || {};
        const { action, kid } = b;
        const index = Number(b.index), total = Number(b.total);
        if (!/^[A-Za-z0-9-]{8,64}$/.test(String(kid || ''))) throw new HttpError(400, 'Invalid backup.');
        if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total || total > 2000) throw new HttpError(400, 'Invalid backup.');
        const salt = Buffer.from(String(b.salt || ''), 'base64');
        if (salt.length !== 16) throw new HttpError(400, 'Invalid backup.');
        await requireOwner(req, kid);

        if (action === 'encrypt') {
            const version = Number(process.env.BACKUP_KEY_VERSION || 1);
            const data = Buffer.from(String(b.data || ''), 'base64');
            if (!data.length || data.length > 3 * 1024 * 1024) throw new HttpError(400, 'Invalid backup piece.');
            const iv = crypto.randomBytes(12);
            const c = crypto.createCipheriv('aes-256-gcm', fileKey(version, salt, kid), iv);
            c.setAAD(aad(kid, index, total, version));
            const ct = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
            return res.status(200).json({ iv: iv.toString('base64'), ct: ct.toString('base64'), kv: version });
        }
        if (action === 'decrypt') {
            const version = Number(b.kv || 1);
            const iv = Buffer.from(String(b.iv || ''), 'base64'), all = Buffer.from(String(b.ct || ''), 'base64');
            if (iv.length !== 12 || all.length < 17) throw new HttpError(400, 'This backup file is damaged.');
            const d = crypto.createDecipheriv('aes-256-gcm', fileKey(version, salt, kid), iv);
            d.setAAD(aad(kid, index, total, version));
            d.setAuthTag(all.subarray(all.length - 16));
            let plain;
            try { plain = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]); }
            catch (e) { throw new HttpError(400, 'This backup file is damaged or was changed, so it cannot be opened.'); }
            return res.status(200).json({ data: plain.toString('base64') });
        }
        throw new HttpError(400, 'Unknown action.');
    } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        return res.status(status).json({ error: e instanceof HttpError ? e.message : 'Backup service error.' });
    }
}
