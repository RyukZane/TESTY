const Database = require('better-sqlite3');
const raw = new Database(process.env.DB_PATH || 'data.db');
raw.pragma('journal_mode = WAL');
raw.exec(`
CREATE TABLE IF NOT EXISTS guilds(id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT, channel TEXT UNIQUE, opener TEXT, category TEXT, number INTEGER,
  claimed_by TEXT, status TEXT DEFAULT 'open', opened_at INTEGER, first_response INTEGER, closed_at INTEGER, closed_by TEXT, rating INTEGER);
CREATE TABLE IF NOT EXISTS warns(id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT, user TEXT, mod TEXT, reason TEXT, at INTEGER);
`);
// q = modal questions [label, 's' short | 'p' paragraph]
const CATS = [
  { id: 'general', name: 'General Support', emoji: '<:emoji_57:1562856319189262416>', style: 'Success', desc: 'Questions about the server, your account or anything else.', q: [['Describe your issue', 'p']] },
  { id: 'report', name: 'Player Reports', emoji: '<:decay_star:1561853138149969982>', style: 'Danger', desc: 'Report cheaters, griefers or rule breakers. Evidence required.', q: [['Player IGN / Discord', 's'], ['What happened?', 'p'], ['Evidence (links)', 'p']] },
  { id: 'bug', name: 'Bug Reports', emoji: '<:warn_yellow:1540692551076548670>', style: 'Primary', desc: 'Found a bug, glitch or exploit? Let us know.', q: [['What is the bug?', 'p'], ['Steps to reproduce', 'p']] },
  { id: 'claim', name: 'Claims & Perks', emoji: '<:box:1565212755399544903>', style: 'Secondary', desc: 'Rewards, ranks and store perks you have not received.', q: [['Your Minecraft IGN', 's'], ['What did you not receive?', 'p']] },
  { id: 'appeal', name: 'Ban Appeal', emoji: '<:punishments_decay:1562856317365002302>', style: 'Secondary', desc: 'Think a punishment was a mistake? Ask for a review.', q: [['Minecraft IGN', 's'], ['Ban reason', 's'], ['Why should it be lifted?', 'p']] },
];
const OLD_EMOJI = { general: ['💬', '<:emoji_57:1562373092175646851>'], report: ['🚨'], bug: ['🛠️'], claim: ['👑', '<:box:1560987102424993812>'], appeal: ['🔓', '<:punishments_decay:1560957250061865032>'] }; // servers that saved older default emojis get migrated
const DEF = () => ({
  prefix: '*',
  ticket: { panelCh: null, panelMsg: null, logCh: null, roles: [], max: 2, blacklist: [], counter: 0, cats: structuredClone(CATS) },
  logs: { channel: null, channels: {}, off: [] },
  automod: { words: [], links: false, invites: true, spam: true, caps: false, mentions: 5, action: 'delete', minutes: 10, whitelist: [] },
  mediaonly: [],
});
function get(id) {
  const d = DEF(); const r = raw.prepare('SELECT data FROM guilds WHERE id=?').get(id); if (!r) return d;
  const s = JSON.parse(r.data);
  for (const k of Object.keys(d)) if (s[k] !== undefined) d[k] = (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) ? { ...d[k], ...s[k] } : s[k];
  for (const c of d.ticket.cats) { const n = CATS.find(x => x.id === c.id); if (n && OLD_EMOJI[c.id]?.includes(c.emoji)) c.emoji = n.emoji; }
  return d;
}
function set(id, patch) { const s = { ...get(id), ...patch }; raw.prepare('INSERT INTO guilds(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(s)); return s; }
function mut(id, key, fn) { const s = get(id); fn(s[key], s); set(id, { [key]: s[key] }); return s[key]; }
module.exports = { raw, get, set, mut };
