'use strict';
// ════════════════════════════════════════════════════════════════════════════════════════════════
//  ticket.js — Advanced Discord ticket system in ONE file (bot + slash + prefix + web dashboard + database)
//
//  INSTALL (your index.js already does this, so just replace the file):
//      require('./ticket').attach(client);          // before client.login(...)
//
//  What it adds:  /ticket …  slash commands  •  !ticket …  prefix commands (prefix configurable)  •  buttons / select menus /
//  modals handled by ONE interaction router  •  live staff leaderboard  •  automatic staff promotions  •  statistics  •  logs
//  •  transcripts  •  a web dashboard at "/" (your website.js shows it inside /admin → Tickets, same login).
//
//  ENVIRONMENT (Railway → Variables):
//      DASHBOARD_PASSWORD=...   PUBLIC_URL=https://your-app.up.railway.app   DATA_DIR=/data/tickets   (Railway Volume mounted at /data)
//      TICKET_COMMAND=ticket    (slash command name)        GUILD_ID=...  (optional; used for old data + fast command registration)
//      CLIENT_ID, CLIENT_SECRET, DASHBOARD_ADMINS=id,id     (optional Discord login; redirect: PUBLIC_URL/auth/callback)
//      DASHBOARD_PORT=...       (only if PORT is already used)       TICKET_NO_WEB=1  (do not start the dashboard)
//  Needs: Node 20+, discord.js 14.19+, better-sqlite3, Message Content intent (for prefix commands + staff stats).
//  Your existing data (tickets.db: panels, categories, tickets, settings) is migrated automatically — nothing is lost.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const path = require('path'), fs = require('fs'), crypto = require('crypto'), http = require('http');
const DJS = require('discord.js');
const { ChannelType, PermissionFlagsBits: P, EmbedBuilder, ActionRowBuilder: Row, ButtonBuilder, ButtonStyle: BS, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle: TS, MessageFlags, SlashCommandBuilder, Events, ActivityType } = DJS;
const EPH = MessageFlags.Ephemeral;
const Database = require('better-sqlite3');

// ───────────────────────────────────────────── 1. DEFAULTS (everything is editable from the dashboard / commands) ─────────────────────────────────────────────
const mkEmbed = (o = {}) => ({ title: '', description: '', color: '#5865F2', image: '', thumbnail: '', footer: '', footerIcon: '', author: '', authorIcon: '', timestamp: false, fields: [], ...o });
const ACTIONS = ['claim', 'unclaim', 'close', 'reopen', 'delete', 'add', 'remove', 'rename', 'transfer', 'transcript', 'notify', 'say', 'info'];
const BTN_ACTIONS = ['claim', 'unclaim', 'close', 'closereason', 'reopen', 'delete', 'add', 'remove', 'transfer', 'transcript', 'notify', 'rename', 'message', 'link'];
const LOG_EVENTS = ['create', 'claim', 'unclaim', 'close', 'reopen', 'delete', 'transfer', 'promotion', 'activity', 'transcript'];
const btn = (id, label, emoji, style, action, when, claimState = 'any', extra = {}) => ({ id, label, emoji, style, action, when, claimState, subjects: [], roles: [], text: '', url: '', ...extra });
const DEFAULT_BUTTONS = () => [
  btn('claim', 'Claim', '🙋', 'Success', 'claim', 'open', 'unclaimed'),
  btn('unclaim', 'Unclaim', '↩️', 'Secondary', 'unclaim', 'open', 'claimed'),
  btn('close', 'Close', '🔒', 'Danger', 'close', 'open'),
  btn('closereason', 'Close with Reason', '📝', 'Danger', 'closereason', 'open'),
  btn('reopen', 'Reopen', '🔓', 'Success', 'reopen', 'closed'),
  btn('transcript', 'Transcript', '📜', 'Secondary', 'transcript', 'closed'),
  btn('delete', 'Delete', '🗑️', 'Danger', 'delete', 'closed'),
];
const SETTINGS = {
  brandName: 'Support', prefix: '!', useBotPrefix: false, botNickname: '', presence: '', presenceType: 'Custom', presenceStatus: 'online',
  features: { tickets: true, prefixCommands: true, leaderboard: true, promotions: true, staffStats: true, transcripts: true, autoClose: true, logging: true },
  logChannelId: '', transcriptChannelId: '', ratingChannelId: '', closedCategoryId: '', parentPrefix: '', channelName: '{type}-{number}', numbering: { start: 1, pad: 4 },
  maxPerUser: 3, staffBypassLimit: true, cooldownSeconds: 10, staffRoles: [], adminRoles: [],
  perms: { claim: ['staff'], unclaim: ['staff'], close: ['creator', 'staff'], reopen: ['staff'], delete: ['admin'], add: ['staff'], remove: ['staff'], rename: ['staff'], transfer: ['staff'], transcript: ['creator', 'staff'], notify: ['creator'], say: ['staff'], info: ['creator', 'staff'] },
  confirmClose: true, closeBehavior: { creatorCanView: true, renameClosed: true, closedPrefix: 'closed-', deleteDelay: 5 },
  transcript: { enabled: true, format: 'html', sendToLog: true, dmCreator: true, limit: 2000 },
  autoClose: { hours: 0 }, showAnswers: true,
  notifications: { pingStaffOnOpen: true, dmOnClose: true, notifyCooldownMinutes: 5 },
  logging: { channels: Object.fromEntries(LOG_EVENTS.map(e => [e, ''])), enabled: Object.fromEntries(LOG_EVENTS.map(e => [e, e !== 'activity'])) },
  buttons: DEFAULT_BUTTONS(),
  stats: { weekStartsOn: 1, utcOffsetMinutes: 0 },
  leaderboard: {
    enabled: true, channelId: '', messageId: '', messageChannelId: '', messageStyle: '', style: 'cards', period: 'alltime', top: 10, intervalMinutes: 10, updateOnActivity: true, showButtons: true, resetAt: 0,
    title: '🏆 Staff Leaderboard', description: 'Top support staff of **{server}**\nRanked by **{period}** resolved tickets • updated {updated}', color: '#F1C40F', footer: '{brand} • live leaderboard', thumbnail: '', timestamp: true, useTopAvatar: true,
    emojis: { first: '🥇', second: '🥈', third: '🥉', other: '🔹' },
    rankFormat: '{medal} **#{rank}** {mention}', rowFormat: '✅ **{resolved}** resolved • 🙋 {claimed} claimed • 🛠️ {managed} managed\n📅 Week **{weekly}** • Month **{monthly}** • All-time **{alltime}**',
    emptyText: 'No staff activity yet. Claim and resolve tickets to appear here!',
  },
  promotion: {
    enabled: true, auto: true, retainPrevious: false, announce: true, announceChannelId: '', announceManual: true, dmStaff: true,
    creditMode: 'claimer', creditCloserIfUnclaimed: true, minStaffMessages: 1, minAgeMinutes: 0, countAutoClosed: false, uncreditOnReopen: false, levels: [],
  },
  messages: {
    welcome: mkEmbed({ title: '🎫 {category}  •  {ticket}', description: '👋 Hey {user}, welcome to **{server}** support!\n\n> 📝 Describe your issue in as much detail as you can.\n> ⏱️ A staff member will be with you shortly.\n\n-# 💡 Use the buttons below to manage this ticket.', footer: '{brand} • Ticket {ticket}', timestamp: true }),
    confirm: mkEmbed({ title: '⚠️ Close this ticket?', description: 'Are you sure you want to close ticket **{ticket}**?\n📜 A transcript will be saved.', color: '#ED4245' }),
    closed: mkEmbed({ title: '🔒 Ticket closed', description: '👮 **Closed by:** {closer}\n📋 **Reason:** {reason}', color: '#99AAB5', footer: '{brand} • Ticket {ticket}', timestamp: true }),
    reopened: mkEmbed({ title: '🔓 Ticket reopened', description: '✅ Reopened by {closer}.', color: '#57F287' }),
    claimed: mkEmbed({ description: '🙋 {staff} has claimed this ticket and will be helping you.', color: '#57F287' }),
    unclaimed: mkEmbed({ description: '↩️ This ticket is no longer claimed. Another staff member will help you soon.', color: '#FEE75C' }),
    transcript: mkEmbed({ title: '📜 Transcript • {ticket}', description: '🗂️ {category} • opened by {user}\n🔒 Closed by {closer} • 💬 {messages} messages', color: '#99AAB5', timestamp: true }),
    promotion: mkEmbed({ title: '🎉 Staff promotion', description: '{user} has been promoted to **{level}**!\nResolved tickets: **{resolved_tickets}** • Rank **#{rank}**\nNext: {next_level}', color: '#57F287', footer: '{brand}', timestamp: true }),
    limitText: '❌ You already have **{count}** open ticket(s). The maximum is **{max}**. Please close one first.',
    noPermText: '❌ You do not have permission to do that.',
    cooldownText: '⏳ Please wait **{seconds}s** before opening another ticket.',
    disabledText: '❌ The ticket system is currently disabled.',
  },
};
const PANEL = { mode: 'buttons', placeholder: 'Choose a ticket type', embed: mkEmbed({ title: 'Support', description: 'Press a button below to open a ticket.' }) };
const CATEGORY = { name: 'General Support', label: 'General Support', emoji: '🎫', style: 'Primary', description: 'Questions and help', roles: [], maxPerUser: null, channelName: '', parentId: '', welcome: null, openingMessage: '', perms: {}, buttons: null, enabled: true, cooldownSeconds: null, logChannelId: '', transcriptChannelId: '', questions: [] };
const QUESTION = { label: 'Minecraft IGN', style: 'short', required: true, placeholder: 'e.g. Steve123', kind: 'ign' };


// ───────────────────────────────────────────── 2. DATABASE (SQLite — survives restarts; shared by bot + dashboard) ─────────────────────────────────────────────
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data', 'tickets');
{ const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH, onRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID;
  if (onRailway && !(vol && DATA.startsWith(path.resolve(vol)))) console.error(`❌ Ticket data folder ${DATA} is NOT on a Railway Volume - settings, stats and transcripts are erased on every redeploy. Add a Volume (mount path /data) and set DATA_DIR=/data/tickets.`); }
for (const d of ['', 'uploads', 'transcripts']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
const raw = new Database(path.join(DATA, 'tickets.db')); if (raw.pragma) raw.pragma('journal_mode = WAL');
raw.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gsettings(guild_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS panels(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, channel_id TEXT, message_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT, panel_id INTEGER, position INTEGER DEFAULT 0, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER NOT NULL, channel_id TEXT UNIQUE, user_id TEXT NOT NULL, category_id INTEGER, category_name TEXT, panel_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT, close_reason TEXT,
  answers TEXT DEFAULT '[]', added TEXT DEFAULT '[]', last_activity INTEGER, transcript TEXT, welcome_id TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, ticket_id INTEGER, user_id TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS staff(guild_id TEXT NOT NULL, user_id TEXT NOT NULL, registered_at INTEGER, removed INTEGER DEFAULT 0, reset_at INTEGER DEFAULT 0, PRIMARY KEY(guild_id, user_id));
CREATE TABLE IF NOT EXISTS ticket_staff(ticket_id INTEGER NOT NULL, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, claimed INTEGER DEFAULT 0, claimed_at INTEGER, msgs INTEGER DEFAULT 0, managed_at INTEGER, PRIMARY KEY(ticket_id, user_id));
CREATE TABLE IF NOT EXISTS credits(ticket_id INTEGER NOT NULL, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(ticket_id, user_id));
CREATE TABLE IF NOT EXISTS promo_history(id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, level_id TEXT, level_name TEXT, role_id TEXT, count INTEGER, kind TEXT NOT NULL, by_user TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_credits_g ON credits(guild_id, user_id, ts);
CREATE INDEX IF NOT EXISTS idx_ts_g ON ticket_staff(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_promo ON promo_history(guild_id, user_id);
`);
const addCol = (t, c, def) => { if (!raw.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) raw.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
for (const [t, c, d] of [['panels', 'guild_id', 'TEXT'], ['categories', 'guild_id', 'TEXT'], ['tickets', 'guild_id', 'TEXT'], ['events', 'guild_id', 'TEXT'],
  ['tickets', 'outcome', 'TEXT'], ['tickets', 'credited_at', 'INTEGER'], ['tickets', 'first_response_at', 'INTEGER'], ['tickets', 'response_by', 'TEXT'], ['tickets', 'closed_msg_id', 'TEXT'], ['tickets', 'rating', 'INTEGER']]) addCol(t, c, d);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (b, o) => { const r = Array.isArray(b) ? [...b] : { ...b }; for (const k of Object.keys(o || {})) r[k] = isObj(b?.[k]) && isObj(o[k]) ? merge(b[k], o[k]) : o[k]; return r; };
const clone = v => JSON.parse(JSON.stringify(v));
const q = sql => raw.prepare(sql);
const sCache = new Map();
const store = {
  raw, DATA, merge, clone,
  settings: {
    get(gid) { gid = String(gid); let c = sCache.get(gid); if (c) return c; const r = q('SELECT value FROM gsettings WHERE guild_id = ?').get(gid); const saved = r ? JSON.parse(r.value) : {}; c = merge(SETTINGS, saved);
      if (r && !saved._m?.cr) { // one-time: servers that already saved their buttons get the new "Close with Reason" button right after Close
        if (Array.isArray(saved.buttons) && !saved.buttons.some(b => b.action === 'closereason')) { const bs = [...c.buttons], i = bs.findIndex(b => b.action === 'close'); bs.splice(i < 0 ? bs.length : i + 1, 0, DEFAULT_BUTTONS().find(b => b.id === 'closereason')); c.buttons = saved.buttons = bs; }
        saved._m = { ...(saved._m || {}), cr: 1 }; c._m = saved._m;
        try { q('UPDATE gsettings SET value = ? WHERE guild_id = ?').run(JSON.stringify(saved), gid); } catch { }
      }
      sCache.set(gid, c); return c; },
    save(gid, obj) { gid = String(gid); q('INSERT INTO gsettings(guild_id, value) VALUES(?, ?) ON CONFLICT(guild_id) DO UPDATE SET value = excluded.value').run(gid, JSON.stringify(obj)); sCache.delete(gid); return this.get(gid); },
    set(gid, patch) { return this.save(gid, merge(clone(this.get(gid)), patch)); },
    reset(gid, section) { if (!(section in SETTINGS)) throw new Error('Unknown section'); const cur = clone(this.get(gid)); cur[section] = clone(SETTINGS[section]); return this.save(gid, cur); },
    resetAll(gid) { q('DELETE FROM gsettings WHERE guild_id = ?').run(String(gid)); sCache.delete(String(gid)); return this.get(gid); },
    has: gid => !!q('SELECT 1 x FROM gsettings WHERE guild_id = ?').get(String(gid)),
    legacy: () => { const r = q("SELECT value FROM settings WHERE key = 'all'").get(); return r ? JSON.parse(r.value) : null; },
    secret() { let r = q("SELECT value FROM settings WHERE key = 'secret'").get(); if (!r) { const v = crypto.randomBytes(32).toString('hex'); q("INSERT INTO settings(key, value) VALUES('secret', ?)").run(v); return v; } return r.value; },
  },
};
const flatP = r => r && ({ ...JSON.parse(r.data), id: r.id, name: r.name, channel_id: r.channel_id, message_id: r.message_id, guild_id: r.guild_id });
store.panels = {
  all: gid => q('SELECT * FROM panels WHERE guild_id = ? ORDER BY id').all(String(gid)).map(flatP),
  get: id => flatP(q('SELECT * FROM panels WHERE id = ?').get(Number(id))),
  save(p) { const { id, name, channel_id, message_id, guild_id, ...data } = p;
    if (id) { q('UPDATE panels SET name = ?, channel_id = ?, data = ? WHERE id = ?').run(name || 'Panel', channel_id || null, JSON.stringify(data), Number(id)); return this.get(id); }
    const r = q('INSERT INTO panels(name, channel_id, data, guild_id) VALUES(?, ?, ?, ?)').run(name || 'Panel', channel_id || null, JSON.stringify(data), String(guild_id)); return this.get(Number(r.lastInsertRowid)); },
  setMessage: (id, channel, message) => q('UPDATE panels SET channel_id = ?, message_id = ? WHERE id = ?').run(channel ?? null, message ?? null, Number(id)),
  remove(id) { q('UPDATE categories SET panel_id = NULL WHERE panel_id = ?').run(Number(id)); q('DELETE FROM panels WHERE id = ?').run(Number(id)); },
};
const flatC = r => r && ({ ...merge(CATEGORY, JSON.parse(r.data)), id: r.id, panel_id: r.panel_id, position: r.position, guild_id: r.guild_id });
store.categories = {
  all: gid => q('SELECT * FROM categories WHERE guild_id = ? ORDER BY position, id').all(String(gid)).map(flatC),
  forPanel: pid => q('SELECT * FROM categories WHERE panel_id = ? ORDER BY position, id').all(Number(pid)).map(flatC),
  get: id => flatC(q('SELECT * FROM categories WHERE id = ?').get(Number(id))),
  save(c) { const { id, panel_id, position, guild_id, ...data } = c;
    if (id) { q('UPDATE categories SET panel_id = ?, position = ?, data = ? WHERE id = ?').run(panel_id ?? null, position ?? 0, JSON.stringify(data), Number(id)); return this.get(id); }
    const r = q('INSERT INTO categories(panel_id, position, data, guild_id) VALUES(?, ?, ?, ?)').run(panel_id ?? null, position ?? 0, JSON.stringify(data), String(guild_id)); return this.get(Number(r.lastInsertRowid)); },
  remove: id => q('DELETE FROM categories WHERE id = ?').run(Number(id)),
};
const T = r => r && ({ ...r, answers: JSON.parse(r.answers || '[]'), added: JSON.parse(r.added || '[]') });
const DAY = 864e5;
store.tickets = {
  byId: id => T(q('SELECT * FROM tickets WHERE id = ?').get(Number(id))),
  ratingByStaff: gid => new Map(q('SELECT claimed_by u, AVG(rating) a, COUNT(rating) n FROM tickets WHERE guild_id = ? AND rating IS NOT NULL AND claimed_by IS NOT NULL GROUP BY claimed_by').all(String(gid)).map(r => [r.u, r])),
  ratingAvg: gid => q('SELECT AVG(rating) a, COUNT(rating) n FROM tickets WHERE guild_id = ? AND rating IS NOT NULL').get(String(gid)),
  openByStaff: gid => new Map(q("SELECT claimed_by u, COUNT(*) n FROM tickets WHERE guild_id = ? AND status = 'open' AND claimed_by IS NOT NULL GROUP BY claimed_by").all(String(gid)).map(r => [r.u, r.n])),
  byChannel: ch => T(q('SELECT * FROM tickets WHERE channel_id = ?').get(String(ch))),
  nextNumber: gid => q('SELECT COALESCE(MAX(number), ?) + 1 AS n FROM tickets WHERE guild_id = ?').get(store.settings.get(gid).numbering.start - 1, String(gid)).n,
  create(t) { const r = q('INSERT INTO tickets(number, channel_id, user_id, category_id, category_name, panel_id, status, created_at, last_activity, answers, guild_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.number, t.channel_id, t.user_id, t.category_id ?? null, t.category_name || '', t.panel_id ?? null, 'open', Date.now(), Date.now(), JSON.stringify(t.answers || []), String(t.guild_id)); return this.byId(Number(r.lastInsertRowid)); },
  update(id, patch) { const cols = Object.keys(patch); if (!cols.length) return this.byId(id); q(`UPDATE tickets SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map(c => (typeof patch[c] === 'object' && patch[c] !== null ? JSON.stringify(patch[c]) : (patch[c] === undefined ? null : patch[c]))), Number(id)); return this.byId(id); },
  list({ gid, status, limit = 100, user } = {}) { const w = ['guild_id = ?'], a = [String(gid)]; if (status && status !== 'all') { w.push('status = ?'); a.push(status); } if (user) { w.push('user_id = ?'); a.push(user); }
    return q(`SELECT * FROM tickets WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...a, limit).map(T); },
  openFor: (gid, user) => q("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'").all(String(gid), String(user)).map(T),
  idle: before => q("SELECT * FROM tickets WHERE status = 'open' AND last_activity < ?").all(before).map(T),
  touch: ch => q("UPDATE tickets SET last_activity = ? WHERE channel_id = ? AND status = 'open'").run(Date.now(), String(ch)),
  avgClaimMs: (gid, days) => q('SELECT AVG(claimed_at - created_at) a FROM tickets WHERE guild_id = ? AND claimed_at IS NOT NULL AND claimed_at >= created_at AND created_at > ?').get(String(gid), Date.now() - days * DAY).a,
  staffActive: (gid, mins) => q("SELECT COUNT(DISTINCT user_id) n FROM ticket_staff WHERE guild_id = ? AND managed_at > ?").get(String(gid), Date.now() - mins * 60000).n,
  stats(gid) { gid = String(gid); const c = (s, ...a) => q('SELECT COUNT(*) n FROM tickets WHERE guild_id = ?' + s).get(gid, ...a).n;
    return { total: c(''), open: c(" AND status = 'open'"), closed: c(" AND status = 'closed'"), deleted: c(" AND status = 'deleted'"), claimed: c(" AND status = 'open' AND claimed_by IS NOT NULL"), resolved: c(' AND credited_at IS NOT NULL'),
      today: c(' AND created_at > ?', Date.now() - DAY), week: c(' AND created_at > ?', Date.now() - 7 * DAY),
      perDay: q('SELECT created_at FROM tickets WHERE guild_id = ? AND created_at > ?').all(gid, Date.now() - 14 * DAY).map(r => r.created_at),
      byCategory: q('SELECT category_name name, COUNT(*) n FROM tickets WHERE guild_id = ? GROUP BY category_name ORDER BY n DESC LIMIT 8').all(gid) }; },
  allStats() { const c = s => q('SELECT COUNT(*) n FROM tickets' + s).get().n; return { total: c(''), open: c(" WHERE status = 'open'"), closed: c(" WHERE status = 'closed'"), today: c(' WHERE created_at > ' + (Date.now() - DAY)) }; },
};
store.events = {
  log(gid, type, ticketId, userId, data) { q('INSERT INTO events(ts, type, ticket_id, user_id, data, guild_id) VALUES(?, ?, ?, ?, ?, ?)').run(Date.now(), type, ticketId ?? null, userId ?? null, data ? JSON.stringify(data) : null, gid ? String(gid) : null); },
  recent: (gid, n = 25) => q('SELECT e.*, t.number FROM events e LEFT JOIN tickets t ON t.id = e.ticket_id WHERE e.guild_id = ? ORDER BY e.id DESC LIMIT ?').all(String(gid), n).map(e => ({ ...e, data: e.data ? JSON.parse(e.data) : null })),
};

// ---------- staff statistics: every number comes from rows that can only exist once (ticket_staff: one row per ticket+staff, credits: one row per ticket+staff) ----------
const periodStart = (period, s) => { // start (ms) of today / this week / this month in the configured timezone offset
  if (period === 'alltime') return 0; const off = (s.stats.utcOffsetMinutes || 0) * 60000, d = new Date(Date.now() + off);
  if (period === 'today') { d.setUTCHours(0, 0, 0, 0); return d.getTime() - off; }
  if (period === 'weekly') { const diff = (d.getUTCDay() - (s.stats.weekStartsOn ?? 1) + 7) % 7; d.setUTCHours(0, 0, 0, 0); return d.getTime() - diff * DAY - off; }
  if (period === 'monthly') { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.getTime() - off; } return 0;
};
const PERIODS = ['today', 'weekly', 'monthly', 'alltime'];
store.staff = {
  list: gid => q('SELECT * FROM staff WHERE guild_id = ?').all(String(gid)),
  get: (gid, uid) => q('SELECT * FROM staff WHERE guild_id = ? AND user_id = ?').get(String(gid), String(uid)),
  register(gid, uid) { q('INSERT INTO staff(guild_id, user_id, registered_at, removed) VALUES(?, ?, ?, 0) ON CONFLICT(guild_id, user_id) DO UPDATE SET removed = 0').run(String(gid), String(uid), Date.now()); },
  remove: (gid, uid) => q('INSERT INTO staff(guild_id, user_id, registered_at, removed) VALUES(?, ?, ?, 1) ON CONFLICT(guild_id, user_id) DO UPDATE SET removed = 1').run(String(gid), String(uid), Date.now()),
  reset(gid, uid) { q('INSERT INTO staff(guild_id, user_id, registered_at, removed, reset_at) VALUES(?, ?, ?, 0, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET reset_at = excluded.reset_at').run(String(gid), String(uid), Date.now(), Date.now()); },
  isRemoved: (gid, uid) => !!q('SELECT 1 x FROM staff WHERE guild_id = ? AND user_id = ? AND removed = 1').get(String(gid), String(uid)),
  // one row per (ticket, staff member): INSERT OR IGNORE makes double counting impossible
  touch(tid, gid, uid) { q('INSERT INTO ticket_staff(ticket_id, guild_id, user_id, managed_at) VALUES(?, ?, ?, ?) ON CONFLICT(ticket_id, user_id) DO NOTHING').run(Number(tid), String(gid), String(uid), Date.now()); },
  claim(tid, gid, uid) { this.touch(tid, gid, uid); q('UPDATE ticket_staff SET claimed = 1, claimed_at = COALESCE(claimed_at, ?) WHERE ticket_id = ? AND user_id = ?').run(Date.now(), Number(tid), String(uid)); },
  msg(tid, gid, uid) { this.touch(tid, gid, uid); q('UPDATE ticket_staff SET msgs = msgs + 1 WHERE ticket_id = ? AND user_id = ?').run(Number(tid), String(uid)); },
  msgsFor: tid => q('SELECT user_id, claimed, msgs FROM ticket_staff WHERE ticket_id = ?').all(Number(tid)),
  everClaimed: tid => !!q('SELECT 1 x FROM ticket_staff WHERE ticket_id = ? AND claimed = 1').get(Number(tid)),
  credit(tid, gid, uid) { return q('INSERT OR IGNORE INTO credits(ticket_id, guild_id, user_id, ts) VALUES(?, ?, ?, ?)').run(Number(tid), String(gid), String(uid), Date.now()).changes > 0; },
  uncredit: tid => q('DELETE FROM credits WHERE ticket_id = ?').run(Number(tid)),
  // counts since `since` (ms), respecting the per-user reset baseline
  count(kind, gid, uid, since) {
    const tbl = kind === 'resolved' ? 'credits' : 'ticket_staff', col = kind === 'resolved' ? 'ts' : kind === 'claimed' ? 'claimed_at' : 'managed_at', extra = kind === 'claimed' ? 'AND x.claimed = 1' : '';
    return q(`SELECT COUNT(*) n FROM ${tbl} x LEFT JOIN staff s ON s.guild_id = x.guild_id AND s.user_id = x.user_id WHERE x.guild_id = ? AND x.user_id = ? ${extra} AND x.${col} > MAX(?, COALESCE(s.reset_at, 0))`).get(String(gid), String(uid), since).n; },
  avgResponse: (gid, uid) => q('SELECT AVG(first_response_at - created_at) a FROM tickets WHERE guild_id = ? AND response_by = ? AND first_response_at >= created_at').get(String(gid), String(uid)).a,
  avgResolution: (gid, uid) => q('SELECT AVG(t.closed_at - t.created_at) a FROM tickets t JOIN credits c ON c.ticket_id = t.id WHERE c.guild_id = ? AND c.user_id = ? AND t.closed_at IS NOT NULL').get(String(gid), String(uid)).a,
  // everyone who has any activity (or is registered), with counts for a period; `lb` applies the leaderboard reset time
  board(gid, s, period, lb = true) {
    gid = String(gid); const since = Math.max(periodStart(period, s), lb ? (s.leaderboard.resetAt || 0) : 0), rows = new Map(), get = u => { if (!rows.has(u)) rows.set(u, { id: u, resolved: 0, claimed: 0, managed: 0 }); return rows.get(u); };
    const agg = (tbl, col, extra, key) => { for (const r of q(`SELECT x.user_id u, COUNT(*) n FROM ${tbl} x LEFT JOIN staff s ON s.guild_id = x.guild_id AND s.user_id = x.user_id WHERE x.guild_id = ? ${extra} AND x.${col} > MAX(?, COALESCE(s.reset_at, 0)) AND COALESCE(s.removed, 0) = 0 GROUP BY x.user_id`).all(gid, since)) get(r.u)[key] = r.n; };
    agg('credits', 'ts', '', 'resolved'); agg('ticket_staff', 'claimed_at', 'AND x.claimed = 1', 'claimed'); agg('ticket_staff', 'managed_at', '', 'managed');
    for (const r of q('SELECT user_id FROM staff WHERE guild_id = ? AND removed = 0').all(gid)) get(r.user_id);
    return [...rows.values()].sort((a, b) => b.resolved - a.resolved || b.claimed - a.claimed || b.managed - a.managed || (a.id < b.id ? -1 : 1));
  },
};
store.promo = {
  add(gid, uid, o) { q('INSERT INTO promo_history(guild_id, user_id, level_id, level_name, role_id, count, kind, by_user, ts) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(String(gid), String(uid), o.level_id ?? null, o.level_name ?? null, o.role_id ?? null, o.count ?? 0, o.kind, o.by_user ?? null, Date.now()); },
  forUser: (gid, uid) => q('SELECT * FROM promo_history WHERE guild_id = ? AND user_id = ? ORDER BY id DESC').all(String(gid), String(uid)),
  recent: (gid, n = 30) => q('SELECT * FROM promo_history WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(String(gid), n),
  awarded: (gid, uid) => q("SELECT DISTINCT level_id FROM promo_history WHERE guild_id = ? AND user_id = ? AND level_id IS NOT NULL AND kind IN ('auto', 'manual_promote', 'sync')").all(String(gid), String(uid)).map(r => r.level_id),
};


// ───────────────────────────────────────────── 3. UTILITIES ─────────────────────────────────────────────
const fill = (s, v) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => (k.toLowerCase() in v ? v[k.toLowerCase()] : m));
const lower = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v == null ? '' : String(v)]));
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9_ -]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 90) || 'ticket';
const colorInt = (c, d = 0x5865F2) => { const m = String(c || '').trim().match(/^#?([0-9a-f]{6})$/i); return m ? parseInt(m[1], 16) : d; };
const safeFile = n => path.basename(String(n)).replace(/[^\w.\-]/g, '_');
const uploadPath = n => path.join(DATA, 'uploads', safeFile(n));
const clip = (s, n) => String(s ?? '').slice(0, n);
const uniq = a => [...new Set(a.filter(Boolean))];
const rid = () => crypto.randomBytes(4).toString('hex');
const fmtMs = ms => ms == null ? 'n/a' : ms < 60000 ? '<1 min' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : ms < 864e5 ? (ms / 3600000).toFixed(1) + ' h' : (ms / 864e5).toFixed(1) + ' d';
const ts = ms => (ms ? `<t:${Math.floor(ms / 1000)}:f>` : '—');
// image fields are a normal link or "upload:<file>" (picked in the dashboard); uploads are attached to the Discord message
function img(val, files) {
  if (!val) return null;
  if (String(val).startsWith('upload:')) { const n = safeFile(val.slice(7)), p = uploadPath(n); if (!fs.existsSync(p)) return null; if (files && !files.some(f => f.name === n)) files.push({ attachment: p, name: n }); return `attachment://${n}`; }
  return /^https?:\/\//i.test(val) ? val : null;
}
// custom embed JSON (dashboard) -> EmbedBuilder. null when the embed is empty.
function embed(c, vars, files = []) {
  if (!c) return null; const v = lower(vars), f = s => fill(s, v), e = new EmbedBuilder().setColor(colorInt(c.color)); let any = false;
  if (c.title) { e.setTitle(clip(f(c.title), 256)); any = true; }
  if (c.description) { e.setDescription(clip(f(c.description), 4000)); any = true; }
  const im = img(c.image, files), th = img(c.thumbnail, files), fi = img(c.footerIcon, files), ai = img(c.authorIcon, files);
  if (im) { e.setImage(im); any = true; } if (th) { e.setThumbnail(th); any = true; }
  if (c.author || ai) { e.setAuthor({ name: clip(f(c.author || '\u200b'), 256), iconURL: ai || undefined }); any = true; }
  if (c.footer || fi) { e.setFooter({ text: clip(f(c.footer || '\u200b'), 2048), iconURL: fi || undefined }); any = true; }
  for (const fl of (c.fields || []).slice(0, 10)) if (fl && (fl.name || fl.value)) { e.addFields({ name: clip(f(fl.name) || '\u200b', 256), value: clip(f(fl.value) || '\u200b', 1024), inline: !!fl.inline }); any = true; }
  if (c.timestamp) e.setTimestamp(); return any ? e : null;
}
// "🎫", "<:name:id>", "<a:name:id>" or a numeric emoji ID  ->  value usable on buttons / select options
function emoji(s, guild) {
  s = String(s || '').trim(); if (!s) return undefined;
  const m = s.match(/^<(a?):(\w+):(\d+)>$/); if (m) return { animated: !!m[1], name: m[2], id: m[3] };
  if (/^\d{15,22}$/.test(s)) { const e = guild?.emojis.cache.get(s); return { animated: !!e?.animated, name: e?.name || 'emoji', id: s }; }
  return { name: s };
}
const etext = (s, g) => { s = String(s || '').trim(); if (/^<a?:\w+:\d+>$/.test(s)) return s; if (/^\d{15,22}$/.test(s)) { const e = g?.emojis.cache.get(s); return e ? e.toString() : ''; } return s; };
const STYLE = { Primary: BS.Primary, Secondary: BS.Secondary, Success: BS.Success, Danger: BS.Danger, Link: BS.Link };
/* transcripts: HTML (looks like Discord) or TXT */
const TR = (() => {
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = s => esc(s).replace(/```([\s\S]*?)```/g, '<pre>$1</pre>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/__([^_\n]+)__/g, '<u>$1</u>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');

async function fetchAll(channel, limit) {
  const out = []; let before;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break; out.push(...batch.values()); before = batch.last().id; if (batch.size < 100) break;
  }
  return out.reverse().slice(-limit);
}
function html(t, msgs, title) {
  const rows = msgs.map(m => {
    const att = [...m.attachments.values()].map(a => /\.(png|jpe?g|gif|webp)$/i.test(a.name || '') ? `<a href="${esc(a.url)}"><img src="${esc(a.url)}"></a>` : `<a class="file" href="${esc(a.url)}">📎 ${esc(a.name)}</a>`).join('');
    const emb = m.embeds.map(e => `<div class="embed" style="border-color:${e.hexColor || '#5865f2'}">${e.title ? `<b>${esc(e.title)}</b><br>` : ''}${e.description ? md(e.description) : ''}${(e.fields || []).map(f => `<div><b>${esc(f.name)}</b><br>${md(f.value)}</div>`).join('')}</div>`).join('');
    return `<div class="msg"><img class="av" src="${esc(m.author.displayAvatarURL?.({ extension: 'png', size: 64 }) || '')}"><div><span class="name">${esc(m.member?.displayName || m.author.username)}</span>${m.author.bot ? '<span class="bot">BOT</span>' : ''}<span class="time">${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC</span><div class="body">${md(m.cleanContent || '')}</div>${att}${emb}</div></div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{margin:0;background:#313338;color:#dbdee1;font:15px/1.4 system-ui,sans-serif}header{padding:18px 22px;background:#2b2d31;border-bottom:1px solid #1e1f22}h1{margin:0 0 4px;font-size:20px}header small{color:#949ba4}
.wrap{padding:12px 22px}.msg{display:flex;gap:12px;padding:6px 0}.av{width:40px;height:40px;border-radius:50%;flex:none;background:#1e1f22}.name{font-weight:600;color:#fff}.time{color:#949ba4;font-size:12px;margin-left:8px}.bot{background:#5865f2;color:#fff;border-radius:3px;font-size:10px;padding:1px 4px;margin-left:6px}
.body{word-break:break-word}.msg img:not(.av){max-width:420px;max-height:320px;border-radius:6px;margin-top:6px;display:block}.embed{border-left:4px solid;background:#2b2d31;border-radius:4px;padding:8px 12px;margin-top:6px;max-width:520px}.file{display:inline-block;margin-top:6px;color:#00a8fc}
code,pre{background:#1e1f22;border-radius:4px;padding:1px 4px}pre{padding:8px;display:block;white-space:pre-wrap}a{color:#00a8fc}</style></head><body><header><h1>${esc(title)}</h1><small>Opened ${new Date(t.created_at).toUTCString()} • ${msgs.length} messages</small></header><div class="wrap">${rows}</div></body></html>`;
}
const text = (t, msgs, title) => `${title}\nOpened ${new Date(t.created_at).toUTCString()} • ${msgs.length} messages\n${'='.repeat(50)}\n` + msgs.map(m => `[${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19)}] ${m.member?.displayName || m.author.username}: ${m.cleanContent || ''}${[...m.attachments.values()].map(a => `\n   [file] ${a.url}`).join('')}${m.embeds.length ? `\n   [embed] ${m.embeds.map(e => e.title || e.description || '').join(' | ').slice(0, 300)}` : ''}`).join('\n');

// returns { file: <path>, name, messages }
async function generate(channel, t, { format = 'html', limit = 2000 } = {}) {
  const msgs = await fetchAll(channel, limit), title = `Ticket #${String(t.number).padStart(S(t.guild_id).numbering.pad, '0')} • ${t.category_name || 'ticket'}`;
  const ext = format === 'txt' ? 'txt' : 'html', name = `ticket-${t.guild_id || 'g'}-${String(t.number).padStart(4, '0')}.${ext}`, file = path.join(DATA, 'transcripts', name);
  fs.writeFileSync(file, ext === 'html' ? html(t, msgs, title) : text(t, msgs, title)); return { file, name, messages: msgs.length };
}

return { generate };
})();

// ───────────────────────────────────────────── 4. CORE: permissions, placeholders, logging, buttons ─────────────────────────────────────────────
class Deny extends Error { }
const deny = m => { throw new Deny(m); };
const S = gid => store.settings.get(gid);
const padN = (gid, n) => String(n).padStart(S(gid).numbering.pad, '0');
store.tickets.markCredited = id => q('UPDATE tickets SET credited_at = ? WHERE id = ? AND credited_at IS NULL').run(Date.now(), Number(id)).changes > 0;

const staffRoles = (gid, cat) => uniq([...S(gid).staffRoles, ...S(gid).adminRoles, ...(cat?.roles || [])]);
const isAdmin = m => m.permissions.has(P.Administrator) || S(m.guild.id).adminRoles.some(r => m.roles.cache.has(r));
const isStaff = (m, cat) => isAdmin(m) || staffRoles(m.guild.id, cat).some(r => m.roles.cache.has(r));
const isStaffAnywhere = m => isStaff(m) || store.categories.all(m.guild.id).some(c => (c.roles || []).some(r => m.roles.cache.has(r)));
const subjectOk = (x, m, t, cat) => (x === 'admin' && isAdmin(m)) || (x === 'staff' && isStaff(m, cat)) || (x === 'creator' && t?.user_id === m.id);
// permission matrix (dashboard) + per-category overrides + per-button overrides. The ticket creator is a first-class subject.
function can(action, m, t, cat, b) {
  if (m.permissions.has(P.Administrator)) return true;
  if (b && ((b.subjects || []).length || (b.roles || []).length)) return isAdmin(m) || (b.subjects || []).some(x => subjectOk(x, m, t, cat)) || (b.roles || []).some(r => m.roles.cache.has(r));
  return ({ ...S(m.guild.id).perms, ...(cat?.perms || {}) }[action] || []).some(x => subjectOk(x, m, t, cat));
}
const need = (env, action, b) => { if (!env.force && !can(action, env.member, env.t, env.cat, b)) deny(S(env.g.id).messages.noPermText); };

// ---------- staff statistics bundle (used by commands, placeholders, leaderboard, dashboard) ----------
const levelsOf = gid => [...S(gid).promotion.levels].sort((a, b) => a.required - b.required);
function levelInfo(g, uid, total, member) {
  const lv = levelsOf(g.id); let cur = null;
  if (member) { for (const l of lv) if (l.roleId && member.roles.cache.has(l.roleId)) cur = l; }
  else { const aw = store.promo.awarded(g.id, uid); for (const l of lv) if (aw.includes(l.id)) cur = l; }
  const nxt = cur ? lv.find(l => l.required > cur.required) : lv[0];
  return { current: cur, next: nxt || null, remaining: nxt ? Math.max(0, nxt.required - total) : 0 };
}
function userStats(g, uid, member) {
  const gid = g.id, s = S(gid), per = {};
  for (const p of PERIODS) { const since = periodStart(p, s); per[p] = { claimed: store.staff.count('claimed', gid, uid, since), resolved: store.staff.count('resolved', gid, uid, since), managed: store.staff.count('managed', gid, uid, since) }; }
  const board = store.staff.board(gid, s, 'alltime', true), idx = board.findIndex(r => r.id === String(uid)), total = store.staff.count('resolved', gid, uid, 0);
  return { per, rank: idx >= 0 ? idx + 1 : null, total, avgResponse: store.staff.avgResponse(gid, uid), avgResolution: store.staff.avgResolution(gid, uid), ...levelInfo(g, uid, total, member) };
}
// ---------- placeholders usable in every message / embed ----------
function vars(g, t, cat, x = {}) {
  const a = t?.answers || [], now = Math.floor(Date.now() / 1000), ign = a.find(z => z.kind === 'ign'), sid = x.staffId || t?.claimed_by, st = sid && S(g.id).features.staffStats ? userStats(g, sid) : null, s = S(g.id);
  const o = { user: t ? `<@${t.user_id}>` : '', userid: t?.user_id || '', username: x.username || '', server: g.name, category: cat?.name || t?.category_name || '', type: slug(cat?.name || t?.category_name || 'ticket'),
    number: t ? padN(g.id, t.number) : '', ticket_id: t ? padN(g.id, t.number) : '', ticket: t ? `#${padN(g.id, t.number)}` : '', staff: sid ? `<@${sid}>` : 'nobody yet', staff_name: x.staffName || '', claimer: t?.claimed_by ? `<@${t.claimed_by}>` : 'nobody',
    closer: x.closer ? (/^\d{15,25}$/.test(String(x.closer)) ? `<@${x.closer}>` : String(x.closer)) : 'Auto', reason: x.reason || 'No reason given', brand: s.brandName, channel: t?.channel_id ? `<#${t.channel_id}>` : '', date: `<t:${now}:D>`, time: `<t:${now}:t>`, timestamp: `<t:${now}:R>`, updated: `<t:${now}:R>`,
    ign: ign?.value || '', max: x.max ?? '', count: x.count ?? '', seconds: x.seconds ?? '', messages: x.messages ?? '', period: x.period ?? '', role: x.role ?? '', level: x.level ?? '',
    resolved_tickets: st ? st.total : '0', claimed_tickets: st ? st.per.alltime.claimed : '0', managed_tickets: st ? st.per.alltime.managed : '0', weekly: st ? st.per.weekly.resolved : '0', monthly: st ? st.per.monthly.resolved : '0', rank: st?.rank ?? '-',
    next_level: st?.next ? `${st.next.name} (${st.next.required})` : 'max level', remaining: st ? st.remaining : '0', ...(x.extra || {}) };
  if (st && !x.level) o.level = st.current?.name || 'none'; a.forEach((z, n) => { o['answer' + (n + 1)] = z.value; }); return o;
}
// ---------- logging ----------
const COLORS = { create: 0x57F287, claim: 0x5865F2, unclaim: 0xFEE75C, close: 0xED4245, reopen: 0xFEE75C, delete: 0x99AAB5, transfer: 0xEB459E, promotion: 0x57F287, activity: 0x99AAB5, transcript: 0x99AAB5 };
const logChannel = (g, type, cat) => { const s = S(g.id), ids = [s.logging.channels[type], ['create', 'claim', 'unclaim', 'close', 'reopen', 'delete', 'transfer'].includes(type) ? cat?.logChannelId : '', s.logChannelId];
  for (const id of ids) { const c = id && g.channels.cache.get(id); if (c?.isTextBased?.() && c.type !== ChannelType.GuildCategory) return c; } return null; };
async function logEvent(g, type, t, text, cat, files) {
  const s = S(g.id); store.events.log(g.id, type, t?.id, t?.claimed_by || t?.user_id, { text });
  if (!s.features.logging || s.logging.enabled[type] === false) return; const ch = logChannel(g, type, cat); if (!ch) return;
  const e = new EmbedBuilder().setColor(COLORS[type] || 0x5865F2).setTitle(`${t ? `Ticket ${type} • #${padN(g.id, t.number)}` : `Staff ${type}`}`).setDescription(clip(text, 4000)).setTimestamp();
  if (t) e.addFields({ name: 'Category', value: t.category_name || '—', inline: true }, { name: 'Creator', value: `<@${t.user_id}>`, inline: true });
  await ch.send({ embeds: [e], files, allowedMentions: { parse: [] } }).catch(e2 => console.error('Ticket log failed:', e2.message));
}
// compact "staff activity" feed (separate channel / toggle)
async function activity(g, userId, text, t) {
  const s = S(g.id); if (!s.features.logging || !s.logging.enabled.activity) return; const ch = logChannel(g, 'activity', null); if (!ch) return;
  await ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.activity).setDescription(clip(`<@${userId}> ${text}${t ? ` • #${padN(g.id, t.number)}` : ''}`, 2000)).setTimestamp()], allowedMentions: { parse: [] } }).catch(() => { });
}
// ---------- buttons engine: configurable buttons on ticket messages (global set + per-category override) ----------
const buttonSet = (cat, s) => (Array.isArray(cat?.buttons) ? cat.buttons : s.buttons);
const PERM_OF = { claim: 'claim', unclaim: 'unclaim', close: 'close', closereason: 'close', reopen: 'reopen', delete: 'delete', add: 'add', remove: 'remove', transfer: 'transfer', transcript: 'transcript', notify: 'notify', rename: 'rename', message: 'info', link: 'info' };
function buildControls(g, t, cat, view) {
  const list = buttonSet(cat, S(g.id)).filter(b => (b.when === 'always' || b.when === view) && (view !== 'open' || b.claimState === 'any' || (b.claimState === 'claimed') === !!t.claimed_by)).slice(0, 25), rows = [];
  for (let n = 0; n < list.length; n += 5) rows.push(new Row().addComponents(...list.slice(n, n + 5).map(b => {
    const x = new ButtonBuilder(), em = emoji(b.emoji, g), label = clip(b.label, 80);
    if (b.action === 'link' && /^https?:\/\//i.test(b.url || '')) x.setStyle(BS.Link).setURL(b.url); else x.setStyle(STYLE[b.style] && b.style !== 'Link' ? STYLE[b.style] : BS.Secondary).setCustomId(`tt:b:${b.id}`);
    if (label) x.setLabel(label); if (em) x.setEmoji(em); if (!label && !em) x.setLabel(b.action); return x; })));
  return rows;
}


// ───────────────────────────────────────────── 5. TICKET ENGINE (opening, actions, closing, stats hooks) ─────────────────────────────────────────────
const mention = id => (/^\d{15,25}$/.test(String(id)) ? `<@${id}>` : String(id || '—'));
const friendly = e => ({ 50013: 'I am missing permissions (or my role is below the target role/member).', 50001: 'I cannot access that channel.', 10003: 'Unknown channel.', 10008: 'Unknown message.', 10011: 'Unknown role.', 50007: 'That user has DMs closed.', 50035: 'Discord rejected the content: ' + clip(e?.message, 160) }[e?.code] || e?.message || 'Unknown error');
const withLock = (map, key, fn) => { const run = (map.get(key) || Promise.resolve()).catch(() => { }).then(fn); map.set(key, run); run.finally(() => { if (map.get(key) === run) map.delete(key); }).catch(() => { }); return run; };

// ---------- discord categories + channel permissions ----------
const STAFF_PERMS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks', 'ManageMessages'];
const CREATOR = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true };
function overwrites(g, cat, opener) {
  const ow = [{ id: g.id, deny: [P.ViewChannel] }, { id: g.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.ManageMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles] }];
  for (const r of staffRoles(g.id, cat)) if (g.roles.cache.has(r)) ow.push({ id: r, allow: STAFF_PERMS.map(n => P[n]) });
  if (opener) ow.push({ id: opener, allow: Object.keys(CREATOR).map(n => P[n]) }); return ow;
}
async function grantStaff(g, ch, cat) {
  for (const r of staffRoles(g.id, cat)) { if (!g.roles.cache.has(r)) continue; const cur = ch.permissionOverwrites.cache.get(r); if (cur?.allow.has(STAFF_PERMS.map(n => P[n]))) continue;
    await ch.permissionOverwrites.edit(r, Object.fromEntries(STAFF_PERMS.map(n => [n, true])), { reason: 'Ticket staff access' }).catch(e => console.error('Staff access sync failed:', e.message)); }
}
async function verifyAccess(g, ch, cat) { // every staff role must really be able to see the ticket; repairs it, returns roles that still can't
  const bad = [];
  for (const id of staffRoles(g.id, cat)) { const role = g.roles.cache.get(id); if (!role || ch.permissionsFor(role)?.has(P.ViewChannel)) continue;
    await ch.permissionOverwrites.edit(id, Object.fromEntries(STAFF_PERMS.map(n => [n, true]))).catch(() => { }); if (!ch.permissionsFor(role)?.has(P.ViewChannel)) bad.push(role); }
  return bad;
}
const plocks = new Map();
const ensureParent = (g, cat) => withLock(plocks, 'p:' + g.id + ':' + cat.id, () => findParent(g, cat));
async function findParent(g, cat) { // find (or create ONCE) the Discord category for a ticket type; overflow into "<name> 2" at 50 channels
  await g.channels.fetch().catch(() => { });
  const isCat = c => c?.type === ChannelType.GuildCategory, base = clip(`${S(g.id).parentPrefix}${cat.name}`.trim() || 'Tickets', 90);
  for (let n = 1; n <= 20; n++) {
    const name = n === 1 ? base : `${base} ${n}`; let p = n === 1 && cat.parentId ? g.channels.cache.get(cat.parentId) : null;
    if (!isCat(p)) p = g.channels.cache.find(c => isCat(c) && c.name.toLowerCase() === name.toLowerCase());
    if (!p) p = await g.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites(g, cat), reason: 'Ticket category' }); else await grantStaff(g, p, cat);
    if (g.channels.cache.filter(c => c.parentId === p.id).size < 50) return p;
  }
  throw new Error('All ticket categories are full.');
}
const tchan = (g, cat, exceptId) => { const s = S(g.id), ok = c => c?.isTextBased?.() && c.id !== exceptId && c.type !== ChannelType.GuildCategory;
  for (const id of [cat?.transcriptChannelId, s.logging.channels.transcript, s.transcriptChannelId, cat?.logChannelId, s.logChannelId]) { const c = id && g.channels.cache.get(id); if (ok(c)) return c; }
  return g.channels.cache.find(c => ok(c) && /^(?:\W|_)*(?:ticket[-_ ]?)?(?:transcripts?|logs?)(?:\W|_)*$/i.test(c.name.replace(/[^\w -]/g, ''))) || null; };

// ---------- opening ----------
const cooldowns = new Map(), creating = new Set();
const limitMsg = (gid, max, count) => fill(S(gid).messages.limitText, lower({ max, count }));
function limitReached(i, cat) {
  const s = S(i.guild.id), mine = store.tickets.openFor(i.guild.id, i.user.id); if (s.staffBypassLimit && isStaff(i.member, cat)) return null;
  if (s.maxPerUser > 0 && mine.length >= s.maxPerUser) return limitMsg(i.guild.id, s.maxPerUser, mine.length);
  const cmax = cat.maxPerUser === null || cat.maxPerUser === '' || cat.maxPerUser === undefined ? 0 : Number(cat.maxPerUser), inCat = mine.filter(t => t.category_id === cat.id).length;
  return cmax > 0 && inCat >= cmax ? limitMsg(i.guild.id, cmax, inCat) : null;
}
function cooldownLeft(i, cat) {
  const s = S(i.guild.id), sec = Number(cat.cooldownSeconds ?? s.cooldownSeconds) || 0; if (!sec || (s.staffBypassLimit && isStaff(i.member, cat))) return 0;
  const last = cooldowns.get(i.guild.id + ':' + i.user.id) || 0; return Math.max(0, Math.ceil((last + sec * 1000 - Date.now()) / 1000));
}
async function open(i, catId) {
  const g = i.guild, s = S(g.id); if (!s.features.tickets) return i.reply({ content: s.messages.disabledText, flags: EPH });
  const cat = store.categories.get(catId); if (!cat || cat.guild_id !== g.id || cat.enabled === false) return i.reply({ content: '❌ This ticket type is not available.', flags: EPH });
  const lim = limitReached(i, cat); if (lim) return i.reply({ content: lim, flags: EPH });
  const cd = cooldownLeft(i, cat); if (cd > 0) return i.reply({ content: fill(s.messages.cooldownText, lower({ seconds: cd })), flags: EPH });
  const qs = (cat.questions || []).slice(0, 5); if (!qs.length) return create(i, cat, []);
  const m = new ModalBuilder().setCustomId(`tt:modal:${cat.id}`).setTitle(clip(cat.name, 45));
  qs.forEach((qq, n) => { const t = new TextInputBuilder().setCustomId('q' + n).setLabel(clip(qq.label || 'Question', 45)).setStyle(qq.style === 'paragraph' ? TS.Paragraph : TS.Short).setRequired(qq.required !== false).setMaxLength(qq.kind === 'ign' ? 32 : 1000);
    if (qq.placeholder) t.setPlaceholder(clip(qq.placeholder, 100)); if (qq.kind === 'ign') t.setMinLength(2); m.addComponents(new Row().addComponents(t)); });
  return i.showModal(m);
}
const IGN_RE = /^[A-Za-z0-9_.# ]{2,32}$/;
async function submitModal(i, catId) {
  const cat = store.categories.get(catId); if (!cat || cat.guild_id !== i.guild.id) return i.reply({ content: '❌ This ticket type no longer exists.', flags: EPH });
  const lim = limitReached(i, cat); if (lim) return i.reply({ content: lim, flags: EPH });
  const answers = (cat.questions || []).slice(0, 5).map((qq, n) => ({ label: qq.label, kind: qq.kind || 'text', value: (i.fields.getTextInputValue('q' + n) || '').trim().replace(/`/g, "'") }));
  const bad = answers.find(a => a.kind === 'ign' && a.value && !IGN_RE.test(a.value));
  if (bad) return i.reply({ content: `❌ "${clip(bad.label, 40)}" does not look valid (letters, numbers, _ . # and spaces, 2–32 characters). Press the button and try again.`, flags: EPH });
  return create(i, cat, answers);
}
async function create(i, cat, answers) {
  const g = i.guild, s = S(g.id), key = g.id + ':' + i.user.id;
  if (creating.has(key)) return i.reply({ content: '⏳ Your ticket is already being created.', flags: EPH }); // prevents duplicate tickets from double clicks
  creating.add(key); await i.deferReply({ flags: EPH });
  try {
    const lim = limitReached(i, cat); if (lim) return await i.editReply(lim); // re-check inside the lock
    const parent = await ensureParent(g, cat), num = store.tickets.nextNumber(g.id), draft = { number: num, answers, user_id: i.user.id, category_name: cat.name }, v = lower(vars(g, draft, cat, { username: i.user.username }));
    const ch = await g.channels.create({ name: slug(fill(cat.channelName || s.channelName, v)), type: ChannelType.GuildText, parent: parent.id, topic: clip(`Ticket ${v.ticket} • ${cat.name} • opener ${i.user.id}${v.ign ? ` • IGN ${v.ign}` : ''}`, 1000), permissionOverwrites: overwrites(g, cat, i.user.id) });
    const t = store.tickets.create({ ...draft, guild_id: g.id, channel_id: ch.id, category_id: cat.id, panel_id: cat.panel_id }), noAccess = await verifyAccess(g, ch, cat);
    cooldowns.set(key, Date.now());
    const files = [], cfg = cat.welcome || s.messages.welcome, e = embed(cfg, vars(g, t, cat, { username: i.user.username }), files) || new EmbedBuilder().setColor(0x5865F2).setDescription(`Welcome ${i.user}!`);
    if (s.showAnswers && answers.length) e.addFields(answers.filter(a => a.value).map(a => ({ name: clip(a.label, 256), value: clip('> ' + a.value.replace(/\n/g, '\n> '), 1000) })));
    const ping = s.notifications.pingStaffOnOpen ? staffRoles(g.id, cat).map(r => `<@&${r}>`).join(' ') : '', opening = cat.openingMessage ? '\n' + fill(cat.openingMessage, lower(vars(g, t, cat, { username: i.user.username }))) : '';
    const msg = await ch.send({ content: clip(`${i.user} ${ping}${opening}`.trim(), 2000), embeds: [e], files, components: buildControls(g, t, cat, 'open'), allowedMentions: { users: [i.user.id], roles: ping ? staffRoles(g.id, cat) : [] } });
    store.tickets.update(t.id, { welcome_id: msg.id });
    await logEvent(g, 'create', t, `${i.user} opened ${ch}`, cat);
    if (noAccess.length) await logEvent(g, 'create', t, `⚠️ ${noAccess.join(' ')} cannot see this ticket. Give the bot Administrator (or Manage Channels + Manage Roles) and move its role above them.`, cat);
    return await i.editReply(`✅ Your ticket is ready: ${ch}`);
  } catch (e) { console.error('Ticket creation failed:', e); return i.editReply('❌ I could not create your ticket. Please tell an admin (the bot needs Manage Channels and Manage Roles).').catch(() => { }); }
  finally { creating.delete(key); }
}

// ---------- actions (used by buttons, slash commands, prefix commands and the dashboard — one implementation, so stats are never counted twice) ----------
const pending = new Map(), notified = new Map();
const actor = env => env.member?.id || env.userId || 'dashboard';
const open_ = env => { if (env.t.status !== 'open') deny('This ticket is closed.'); };
const notice = (cfg, g, t, cat, x) => { const files = [], e = embed(cfg, vars(g, t, cat, x), files); return { embeds: e ? [e] : [], files, public: true }; };
const ensureStaff = (gid, uid) => { if (!store.staff.get(gid, uid)) store.staff.register(gid, uid); };
async function refreshControls(env, t) {
  const m = t.welcome_id && await env.channel.messages.fetch(t.welcome_id).catch(() => null);
  if (m?.edit) await m.edit({ components: t.status === 'open' ? buildControls(env.g, t, env.cat, 'open') : [] }).catch(() => { });
}
// ---------- rating: after a ticket closes the creator gets a DM with 5 star buttons ----------
const RATING = { 1: ['Poor', '#ED4245'], 2: ['Fair', '#E67E22'], 3: ['Good', '#FEE75C'], 4: ['Great', '#2ECC71'], 5: ['Excellent', '#57F287'] };
const starBar = n => '★'.repeat(n) + '☆'.repeat(5 - n);
async function sendRating(g, t) {
  const u = await g.client.users.fetch(t.user_id).catch(() => null); if (!u) return;
  const row = new Row().addComponents(...[1, 2, 3, 4, 5].map(n => new ButtonBuilder().setCustomId(`tt:rt:${t.id}:${n}`).setLabel(`${n} ⭐`).setStyle(n <= 2 ? BS.Danger : n === 3 ? BS.Secondary : BS.Success)));
  const handler = t.claimed_by && (g.members.cache.get(t.claimed_by)?.displayName || null);
  const e = new EmbedBuilder().setColor('#F1C40F').setTitle('⭐ How did we do?')
    .setDescription(`Your ticket **#${padN(g.id, t.number)}** in **${g.name}** is now closed.\n\nTap a button below to rate the support you received.\n-# 1 ⭐ Poor  ➜  5 ⭐ Excellent`)
    .addFields({ name: '🗂️ Category', value: t.category_name || '—', inline: true }, ...(handler ? [{ name: '🙋 Handled by', value: handler, inline: true }] : []))
    .setFooter({ text: `${g.name} • your feedback helps us improve` }).setTimestamp();
  const ic = g.iconURL?.(); if (ic) e.setThumbnail(ic);
  await u.send({ embeds: [e], components: [row] }).catch(() => { });
}
async function handleRating(i) {
  const [, , id, n] = i.customId.split(':'), t = store.tickets.byId(id), stars = Number(n);
  if (!t || i.user.id !== t.user_id || !(stars >= 1 && stars <= 5)) return i.reply({ content: '❌ This rating is not available.', flags: EPH });
  if (t.rating) return i.update({ components: [] }).catch(() => { });
  store.tickets.update(t.id, { rating: stars });
  const [label, color] = RATING[stars];
  await i.update({ embeds: [new EmbedBuilder().setColor(color).setTitle('💛 Thank you for your feedback!').setDescription(`You rated ticket **#${padN(t.guild_id, t.number)}**\n# ${starBar(stars)}\n**${stars}/5** • ${label}`).setFooter({ text: 'Your rating was sent to the staff team' })], components: [] });
  const g = i.client.guilds.cache.get(t.guild_id); if (!g) return;
  let ch = S(g.id).ratingChannelId && g.channels.cache.get(S(g.id).ratingChannelId); // dedicated rating channel, falls back to the log channel
  if (!ch?.isTextBased?.()) { if (!S(g.id).features.logging) return; ch = logChannel(g, 'close', store.categories.get(t.category_id)); }
  if (!ch) return;
  const who = t.claimed_by || t.closed_by;
  await ch.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(`⭐ New rating • #${padN(g.id, t.number)}`).setDescription(`# ${starBar(stars)}\n**${stars}/5** • ${label}`)
    .addFields({ name: '👤 Member', value: `<@${t.user_id}>`, inline: true }, { name: '🗂️ Category', value: t.category_name || '—', inline: true }, { name: t.claimed_by ? '🙋 Handled by' : '🔒 Closed by', value: who ? `<@${who}>` : '—', inline: true }).setTimestamp()], allowedMentions: { parse: [] } }).catch(() => { });
}
const tickets = {
  async claim(env) { need(env, 'claim', env.btn); open_(env); if (env.t.claimed_by) deny(`Already claimed by <@${env.t.claimed_by}>.`);
    const who = actor(env), t = store.tickets.update(env.t.id, { claimed_by: who, claimed_at: Date.now() }); ensureStaff(env.g.id, who); store.staff.claim(t.id, env.g.id, who);
    await refreshControls(env, t); await logEvent(env.g, 'claim', t, `<@${who}> claimed <#${t.channel_id}>`, env.cat); lbSchedule(env.g); return notice(S(env.g.id).messages.claimed, env.g, t, env.cat, { staffId: who }); },
  async unclaim(env) { need(env, 'unclaim', env.btn); open_(env); if (!env.t.claimed_by) deny('This ticket is not claimed.');
    if (!env.force && env.t.claimed_by !== env.member.id && !isAdmin(env.member)) deny(`Only <@${env.t.claimed_by}> or an admin can unclaim this.`);
    const t = store.tickets.update(env.t.id, { claimed_by: null, claimed_at: null }); await refreshControls(env, t); await logEvent(env.g, 'unclaim', t, `<@${actor(env)}> unclaimed <#${t.channel_id}>`, env.cat); return notice(S(env.g.id).messages.unclaimed, env.g, t, env.cat, {}); },
  async transfer(env, user) { need(env, 'transfer', env.btn); open_(env); if (!user) deny('Pick a staff member.'); const m = await env.g.members.fetch(user.id).catch(() => null); if (!m || !isStaff(m, env.cat)) deny('That member is not support staff for this ticket.');
    const t = store.tickets.update(env.t.id, { claimed_by: user.id, claimed_at: Date.now() }); ensureStaff(env.g.id, user.id); store.staff.claim(t.id, env.g.id, user.id); await refreshControls(env, t);
    await logEvent(env.g, 'transfer', t, `<@${actor(env)}> transferred <#${t.channel_id}> to ${user}`, env.cat); lbSchedule(env.g); return { text: `🔁 Ticket transferred to ${user}.`, public: true }; },
  async requestClose(env, reason) { need(env, 'close', env.btn); open_(env); if (!S(env.g.id).confirmClose) return tickets.close(env, reason);
    pending.set(env.channel.id, reason || ''); const files = [], e = embed(S(env.g.id).messages.confirm, vars(env.g, env.t, env.cat, { reason }), files) || new EmbedBuilder().setDescription('Close this ticket?');
    return { embeds: [e], files, public: true, components: [new Row().addComponents(new ButtonBuilder().setCustomId('tt:cc').setLabel('Confirm close').setEmoji('✅').setStyle(BS.Danger), new ButtonBuilder().setCustomId('tt:cu').setLabel('Close (not resolved)').setStyle(BS.Secondary), new ButtonBuilder().setCustomId('tt:cx').setLabel('Cancel').setStyle(BS.Secondary))] }; },
  async close(env, reason, opts = {}) {
    need(env, 'close', env.btn); open_(env); const { g, channel } = env, s = S(g.id), auto = !!opts.auto, unresolved = !!opts.unresolved, who = auto ? 'auto' : actor(env); let t = env.t, tr = null;
    if (s.features.transcripts && s.transcript.enabled) tr = await TR.generate(channel, t, s.transcript).catch(e => { console.error('Transcript failed:', e.message); return null; });
    t = store.tickets.update(t.id, { status: 'closed', closed_at: Date.now(), closed_by: who, close_reason: reason || '', transcript: tr?.name || t.transcript, outcome: auto ? 'auto' : unresolved ? 'unresolved' : 'resolved' });
    const lock = s.closeBehavior.creatorCanView ? { ViewChannel: true, SendMessages: false, AddReactions: false, AttachFiles: false } : { ViewChannel: false };
    for (const id of [t.user_id, ...t.added]) await channel.permissionOverwrites.edit(id, lock, { reason: 'Ticket closed' }).catch(() => { });
    if (s.closeBehavior.renameClosed) await channel.setName(clip(s.closeBehavior.closedPrefix + channel.name.replace(s.closeBehavior.closedPrefix, ''), 100)).catch(() => { });
    if (s.closedCategoryId && g.channels.cache.get(s.closedCategoryId)) await channel.setParent(s.closedCategoryId, { lockPermissions: false }).catch(() => { });
    await refreshControls(env, t);
    const files = [], e = embed(s.messages.closed, vars(g, t, env.cat, { closer: auto ? null : who, reason: reason || (auto ? `No activity for ${s.autoClose.hours}h` : '') }), files);
    const cm = await channel.send({ embeds: e ? [e] : [], files, components: buildControls(g, t, env.cat, 'closed'), allowedMentions: { parse: [] } }).catch(() => null); if (cm) store.tickets.update(t.id, { closed_msg_id: cm.id });
    if (tr) {
      const att = [{ attachment: tr.file, name: tr.name }], tch = tchan(g, env.cat, channel.id), te = embed(s.messages.transcript, vars(g, t, env.cat, { closer: auto ? null : who, messages: tr.messages }));
      if (s.transcript.sendToLog && tch?.isTextBased()) await tch.send({ embeds: te ? [te] : [], files: att, allowedMentions: { parse: [] } }).catch(() => { });
      if (s.transcript.dmCreator && s.notifications.dmOnClose) { const u = await g.client.users.fetch(t.user_id).catch(() => null); await u?.send({ embeds: [new EmbedBuilder().setColor(0x99AAB5).setTitle(`Your ticket #${padN(g.id, t.number)} was closed`).setDescription(`**${g.name}** • ${t.category_name}${reason ? `\nReason: ${reason}` : ''}`)], files: att }).catch(() => { }); }
    } else if (s.notifications.dmOnClose) { const u = await g.client.users.fetch(t.user_id).catch(() => null); await u?.send(`Your ticket **#${padN(g.id, t.number)}** in **${g.name}** was closed.${reason ? `\nReason: ${reason}` : ''}`).catch(() => { }); }
    await sendRating(g, t);
    await logEvent(g, 'close', t, `${auto ? 'Auto-closed' : `${mention(who)} closed`} ${channel}${reason ? ` — ${reason}` : ''}${unresolved ? ' (not resolved)' : ''}`, env.cat);
    if (!auto) await activity(g, who, `closed a ticket${unresolved ? ' (not resolved)' : ''}`, t);
    await creditAndPromote(env, t, who, { auto, unresolved }); lbSchedule(g); return { text: '🔒 Ticket closed.' }; },
  async reopen(env) { need(env, 'reopen', env.btn); if (env.t.status !== 'closed') deny('This ticket is not closed.'); const { g, channel } = env, s = S(g.id);
    let t = store.tickets.update(env.t.id, { status: 'open', closed_at: null, closed_by: null, outcome: null, last_activity: Date.now() });
    for (const id of [t.user_id, ...t.added]) await channel.permissionOverwrites.edit(id, CREATOR, { reason: 'Ticket reopened' }).catch(() => { });
    if (channel.name.startsWith(s.closeBehavior.closedPrefix)) await channel.setName(channel.name.slice(s.closeBehavior.closedPrefix.length)).catch(() => { });
    if (t.closed_msg_id) { const m = await channel.messages.fetch(t.closed_msg_id).catch(() => null); await m?.edit({ components: [] }).catch(() => { }); }
    if (s.promotion.uncreditOnReopen && t.credited_at) { store.staff.uncredit(t.id); t = store.tickets.update(t.id, { credited_at: null }); lbSchedule(g); }
    await refreshControls(env, t); await logEvent(g, 'reopen', t, `${mention(actor(env))} reopened ${channel}`, env.cat); await activity(g, actor(env), 'reopened a ticket', t); return notice(s.messages.reopened, g, t, env.cat, { closer: actor(env) }); },
  async remove_ticket(env) { need(env, 'delete', env.btn); const { g, channel } = env, s = S(g.id); let t = env.t;
    if (s.features.transcripts && s.transcript.enabled && !t.transcript) { const tr = await TR.generate(channel, t, s.transcript).catch(() => null); if (tr) { t = store.tickets.update(t.id, { transcript: tr.name }); const tch = tchan(g, env.cat, channel.id); if (tch?.isTextBased()) await tch.send({ content: `Transcript for deleted ticket #${padN(g.id, t.number)}`, files: [{ attachment: tr.file, name: tr.name }] }).catch(() => { }); } }
    store.tickets.update(t.id, { status: 'deleted', closed_at: t.closed_at || Date.now(), outcome: t.outcome || 'deleted' }); await logEvent(g, 'delete', t, `${mention(actor(env))} deleted ticket #${padN(g.id, t.number)} (${t.category_name})`, env.cat); await activity(g, actor(env), 'deleted a ticket', t);
    const delay = Math.max(0, Number(s.closeBehavior.deleteDelay) || 0); setTimeout(() => channel.delete('Ticket deleted').catch(() => { }), delay * 1000);
    return { text: `🗑️ This ticket will be deleted in ${delay} seconds.`, public: true }; },
  async transcript(env) { need(env, 'transcript', env.btn); const s = S(env.g.id), tr = await TR.generate(env.channel, env.t, s.transcript);
    store.tickets.update(env.t.id, { transcript: tr.name }); const file = [{ attachment: tr.file, name: tr.name }], tch = tchan(env.g, env.cat, env.channel.id), te = embed(s.messages.transcript, vars(env.g, env.t, env.cat, { closer: actor(env), messages: tr.messages }));
    await activity(env.g, actor(env), 'generated a transcript', env.t);
    if (tch) { await tch.send({ embeds: te ? [te] : [], files: file, allowedMentions: { parse: [] } }); return { text: `📄 Transcript saved to ${tch}.` }; }
    return { text: `📄 Transcript (${tr.messages} messages) — set a log/transcript channel so it is posted there.`, files: file }; },
  async add(env, user) { need(env, 'add', env.btn); open_(env); if (!user) deny('Pick a member.'); const m = await env.g.members.fetch(user.id).catch(() => null); if (!m) deny('That member is not in this server.');
    await env.channel.permissionOverwrites.edit(user.id, CREATOR); store.tickets.update(env.t.id, { added: uniq([...env.t.added, user.id]) }); await activity(env.g, actor(env), `added ${user} to a ticket`, env.t); return { text: `➕ ${user} was added to the ticket.`, public: true }; },
  async removeMember(env, user) { need(env, 'remove', env.btn); if (!user) deny('Pick a member.'); if (user.id === env.t.user_id) deny('You cannot remove the ticket creator.'); if (user.id === env.g.client.user.id) deny('You cannot remove me.');
    await env.channel.permissionOverwrites.delete(user.id).catch(() => deny('That member has no special access to this ticket.')); store.tickets.update(env.t.id, { added: env.t.added.filter(x => x !== user.id) }); await activity(env.g, actor(env), `removed ${user} from a ticket`, env.t); return { text: `➖ ${user} was removed from the ticket.`, public: true }; },
  async rename(env, name) { need(env, 'rename', env.btn); const n = slug(name || ''); await env.channel.setName(n); await activity(env.g, actor(env), `renamed a ticket to ${n}`, env.t); return { text: `✏️ Renamed to **${n}**.`, public: true }; },
  async say(env, text) { need(env, 'say'); if (!text) deny('Write a message.'); await env.channel.send({ content: clip(text, 2000), allowedMentions: { parse: ['users', 'roles'] } }); return { text: '✅ Sent.' }; },
  async notify(env) { need(env, 'notify', env.btn); open_(env); const s = S(env.g.id), last = notified.get(env.t.id) || 0, cd = (s.notifications.notifyCooldownMinutes || 0) * 60000;
    if (!env.force && Date.now() - last < cd) deny(`Staff were already notified. Please wait ${Math.ceil((cd - (Date.now() - last)) / 60000)} more minute(s).`); notified.set(env.t.id, Date.now());
    const to = env.t.claimed_by ? [`<@${env.t.claimed_by}>`] : staffRoles(env.g.id, env.cat).map(r => `<@&${r}>`);
    await env.channel.send({ content: `🔔 ${to.join(' ') || 'Staff'} — <@${env.t.user_id}> is asking for assistance.`, allowedMentions: { parse: ['users', 'roles'] } }); return { text: '🔔 Staff notified.', public: false }; },
  async info(env) { need(env, 'info'); const t = env.t, g = env.g;
    const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`Ticket #${padN(g.id, t.number)} • ${t.category_name}`).addFields({ name: 'Creator', value: `<@${t.user_id}>`, inline: true }, { name: 'Status', value: t.status + (t.outcome ? ` (${t.outcome})` : ''), inline: true }, { name: 'Claimed by', value: t.claimed_by ? `<@${t.claimed_by}>` : '—', inline: true },
      { name: 'Opened', value: ts(t.created_at), inline: true }, { name: 'Closed', value: ts(t.closed_at), inline: true }, { name: 'Closed by', value: t.closed_by ? mention(t.closed_by) : '—', inline: true },
      { name: 'First staff reply', value: t.first_response_at ? `${fmtMs(t.first_response_at - t.created_at)} by <@${t.response_by}>` : '—', inline: true }, { name: 'Counted as resolved', value: t.credited_at ? 'Yes' : 'No', inline: true });
    if (t.added.length) e.addFields({ name: 'Added members', value: t.added.map(x => `<@${x}>`).join(' ') }); return { embeds: [e], allowedMentions: { parse: [] } }; },
};
// ---------- crediting resolved tickets (one credit per ticket+staff, ever) and promotion check ----------
async function creditAndPromote(env, t, who, { auto, unresolved }) {
  const { g } = env, s = S(g.id), pr = s.promotion; if (!s.features.staffStats || unresolved || (auto && !pr.countAutoClosed) || t.credited_at) return;
  const rows = store.staff.msgsFor(t.id), msgs = rows.reduce((a, r) => a + r.msgs, 0);
  if (msgs < (Number(pr.minStaffMessages) || 0)) return; if (pr.minAgeMinutes && Date.now() - t.created_at < pr.minAgeMinutes * 60000) return;
  const closer = /^\d{15,25}$/.test(String(who)) ? await g.members.fetch(who).catch(() => null) : null, closerStaff = closer && isStaff(closer, env.cat), rec = new Set(), claimer = store.tickets.byId(t.id).claimed_by;
  if (pr.creditMode === 'closer') { if (closerStaff) rec.add(who); }
  else if (pr.creditMode === 'claimer_closer') { if (claimer) rec.add(claimer); if (closerStaff) rec.add(who); }
  else if (pr.creditMode === 'participants') { for (const r of rows) if (r.claimed || r.msgs >= Math.max(1, Number(pr.minStaffMessages) || 1)) rec.add(r.user_id); if (claimer) rec.add(claimer); }
  else { if (claimer) rec.add(claimer); else if (pr.creditCloserIfUnclaimed && closerStaff) rec.add(who); }
  rec.delete(t.user_id); for (const u of [...rec]) if (store.staff.isRemoved(g.id, u)) rec.delete(u); if (!rec.size) return;
  if (!store.tickets.markCredited(t.id)) return; // atomic gate: a ticket can only ever be credited once
  for (const u of rec) { ensureStaff(g.id, u); store.staff.credit(t.id, g.id, u); }
  for (const u of rec) await checkPromotion(g, u).catch(e => console.error('Promotion check failed:', e.message));
}
// ---------- button / select / modal router ----------
const envFor = (i, t) => ({ g: i.guild, channel: i.channel, member: i.member, user: i.user, t, cat: store.categories.get(t.category_id) });
async function send(i, res) {
  const o = res && { content: res.text, embeds: res.embeds, files: res.files, components: res.components, allowedMentions: res.allowedMentions || { parse: [] }, ...(res.flags ? { flags: res.flags } : {}) };
  if (i.deferred && !i.replied) { if (!res) return i.deleteReply().catch(() => { }); if (res.public) { await i.deleteReply().catch(() => { }); return i.followUp(o); } return i.editReply(o); }
  if (!res) return; if (i.deferred || i.replied) return i.followUp({ ...o, flags: (res.public ? 0 : EPH) | (res.flags || 0) }); return i.reply({ ...o, flags: res.public ? 0 : EPH });
}
const userPicker = (mode, text) => ({ content: text, flags: EPH, components: [new Row().addComponents(new UserSelectMenuBuilder().setCustomId(`tt:us:${mode}`).setPlaceholder('Choose a member').setMinValues(1).setMaxValues(1))] });
async function panelButton(i, pid, idx) { // buttons under a panel: quick help / rules text, or "your tickets"
  const p = store.panels.get(Number(pid)), b = p?.buttons?.[Number(idx)]; if (!b) return i.reply({ content: '❌ This button is no longer available.', flags: EPH });
  if (b.kind === 'tickets') { const rows = store.tickets.openFor(i.guild.id, i.user.id); return i.reply({ content: rows.length ? '🎫 **Your open tickets**\n' + rows.map(t => `• <#${t.channel_id}> — ${t.category_name}`).join('\n') : 'You have no open tickets.', flags: EPH }); }
  return i.reply({ content: clip(b.text || '…', 1900), flags: EPH });
}
async function runButton(i, t, b) { // a configurable ticket button
  const env = { ...envFor(i, t), btn: b }, A = tickets;
  if (b.action === 'rename') { need(env, 'rename', b); return i.showModal(new ModalBuilder().setCustomId('tt:rn').setTitle('Rename ticket').addComponents(new Row().addComponents(new TextInputBuilder().setCustomId('name').setLabel('New channel name').setStyle(TS.Short).setRequired(true).setMaxLength(90)))); }
  if (b.action === 'add' || b.action === 'remove' || b.action === 'transfer') { need(env, b.action, b); return i.reply(userPicker(b.action, b.action === 'transfer' ? 'Choose the staff member to transfer this ticket to:' : `Choose the member to ${b.action}:`)); }
  if (b.action === 'message') { need(env, 'info', b); return i.reply({ content: clip(fill(b.text || '…', lower(vars(i.guild, t, env.cat, { username: i.user.username }))), 2000), allowedMentions: { parse: [] } }); }
  if (b.action === 'closereason') { need(env, 'close', b); open_(env); return i.showModal(new ModalBuilder().setCustomId('tt:cr').setTitle('Close ticket').addComponents(new Row().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason for closing').setStyle(TS.Paragraph).setRequired(true).setMaxLength(500)))); }
  await i.deferReply({ flags: EPH });
  const map = { claim: () => A.claim(env), unclaim: () => A.unclaim(env), close: () => A.requestClose(env), reopen: () => A.reopen(env), delete: () => A.remove_ticket(env), transcript: () => A.transcript(env), notify: () => A.notify(env) };
  return send(i, await map[b.action]?.());
}
async function route(i) {
  const [, act, arg] = i.customId.split(':'), g = i.guild;
  if (act === 'open') return open(i, arg); if (act === 'sel') return open(i, i.values[0]); if (act === 'modal') return submitModal(i, arg);
  if (act === 'pb') return panelButton(i, arg, i.customId.split(':')[3]); if (act === 'lb') return leaderboardButton(i, arg);
  const t = store.tickets.byChannel(i.channelId); if (!t || t.guild_id !== g.id) return i.reply({ content: '❌ This is not a ticket channel.', flags: EPH });
  const env = envFor(i, t);
  try {
    if (act === 'b') { const set = buttonSet(env.cat, S(g.id)), b = set.find(x => x.id === arg) || S(g.id).buttons.find(x => x.id === arg); if (!b) return i.reply({ content: '❌ This button is no longer configured.', flags: EPH }); return await runButton(i, t, b); }
    if (act === 'cr') { need(env, 'close'); open_(env); await i.deferReply({ flags: EPH }); return await send(i, await tickets.close(env, i.fields.getTextInputValue('reason'))); }
    if (act === 'rn') { need(env, 'rename'); await i.deferReply({ flags: EPH }); return await send(i, await tickets.rename(env, i.fields.getTextInputValue('name'))); }
    if (act === 'us') { const user = i.users.first(); await i.deferUpdate(); const r = await ({ add: () => tickets.add(env, user), remove: () => tickets.removeMember(env, user), transfer: () => tickets.transfer(env, user) }[arg]?.());
      await i.deleteReply().catch(() => { }); return r && i.followUp({ content: r.text, allowedMentions: { parse: [] }, flags: r.public ? 0 : EPH }); }
    if (act === 'cx') { need(env, 'close'); pending.delete(i.channelId); return i.message.delete().catch(() => i.update({ components: [] })); }
    if (act === 'cc' || act === 'cu') { need(env, 'close'); open_(env); const reason = pending.get(i.channelId) || ''; pending.delete(i.channelId); await i.update({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('🔒 Closing ticket…')], components: [] }); return await tickets.close(env, reason, { unresolved: act === 'cu' }); }
    // buttons on tickets created before the upgrade (old custom ids)
    const legacy = { claim: 'claim', unclaim: 'unclaim', close: 'close', reopen: 'reopen', delete: 'delete', tr: 'transcript' }[act]; if (legacy) return await runButton(i, t, { id: act, action: legacy, subjects: [], roles: [] });
  } catch (e) { if (e instanceof Deny) return (i.deferred || i.replied) ? send(i, { text: e.message }) : i.reply({ content: e.message, flags: EPH }); throw e; }
}
// ---------- tracking staff replies (response time, "managed" count, anti-farming rule for resolved tickets) ----------
function trackMessage(m) {
  const t = store.tickets.byChannel(m.channelId); if (!t || t.guild_id !== m.guildId) return; if (t.status !== 'open') return; store.tickets.touch(m.channelId);
  if (m.author.id === t.user_id || !m.member || !S(m.guildId).features.staffStats) return; const cat = store.categories.get(t.category_id); if (!isStaff(m.member, cat)) return;
  ensureStaff(m.guildId, m.author.id); store.staff.msg(t.id, m.guildId, m.author.id); if (!t.first_response_at) store.tickets.update(t.id, { first_response_at: Date.now(), response_by: m.author.id });
}
// ---------- auto-close ----------
function startAutoClose(client) {
  setInterval(async () => {
    for (const g of client.guilds.cache.values()) { const s = S(g.id), h = Number(s.autoClose.hours); if (!(h > 0) || !s.features.autoClose) continue;
      for (const t of store.tickets.idle(Date.now() - h * 3600 * 1000).filter(x => x.guild_id === g.id)) {
        const ch = g.channels.cache.get(t.channel_id); if (!ch) { store.tickets.update(t.id, { status: 'deleted' }); continue; }
        await tickets.close({ g, channel: ch, t, cat: store.categories.get(t.category_id), force: true }, `No activity for ${h} hours`, { auto: true }).catch(e => console.error('Auto-close failed:', e.message)); }
    }
  }, 10 * 60 * 1000).unref();
}


// ───────────────────────────────────────────── 6. AUTOMATIC PROMOTIONS ─────────────────────────────────────────────
const promoLocks = new Map();
const checkPromotion = (g, uid) => withLock(promoLocks, g.id + ':' + uid, () => doCheck(g, uid));
async function doCheck(g, uid) {
  const s = S(g.id), pr = s.promotion; if (!s.features.promotions || !pr.enabled || !pr.auto) return null;
  const total = store.staff.count('resolved', g.id, uid, 0), lv = levelsOf(g.id).filter(l => l.roleId && g.roles.cache.has(l.roleId)), aw = store.promo.awarded(g.id, uid);
  const top = Math.max(-1, ...lv.filter(l => aw.includes(l.id)).map(l => l.required)), target = [...lv].reverse().find(l => l.required <= total && l.required > top); if (!target) return null;
  const member = await g.members.fetch(uid).catch(() => null); if (!member) return null;
  try { return await applyPromotion(g, member, target, { kind: 'auto', total }); }
  catch (e) { await logEvent(g, 'promotion', null, `⚠️ Could not promote <@${uid}> to **${target.name}**: ${friendly(e)}`); return null; }
}
async function announcePromotion(g, member, level, kind) {
  const s = S(g.id), pr = s.promotion, files = [], v = vars(g, null, null, { staffId: member.id, level: level.name, role: level.roleId ? `<@&${level.roleId}>` : level.name, extra: { user: `<@${member.id}>`, userid: member.id, username: member.user.username, staff_name: member.displayName, staff: `<@${member.id}>` } });
  const e = embed(s.messages.promotion, v, files) || new EmbedBuilder().setColor(0x57F287).setDescription(`🎉 <@${member.id}> is now **${level.name}**!`);
  const ch = pr.announceChannelId && g.channels.cache.get(pr.announceChannelId);
  if (pr.announce && (kind === 'auto' || pr.announceManual) && ch?.isTextBased()) await ch.send({ embeds: [e], files, allowedMentions: { users: [member.id] } }).catch(() => { });
  if (pr.dmStaff) await member.send({ embeds: [e], files }).catch(() => { });
}
async function applyPromotion(g, member, level, { kind, by, total }) {
  const pr = S(g.id).promotion, had = member.roles.cache.has(level.roleId); // never assign a role twice
  if (!had) await member.roles.add(level.roleId, 'Ticket staff promotion');
  if (!pr.retainPrevious) for (const l of levelsOf(g.id)) if (l.id !== level.id && l.roleId && l.required < level.required && member.roles.cache.has(l.roleId)) await member.roles.remove(l.roleId, 'Replaced by a higher staff level').catch(() => { });
  store.promo.add(g.id, member.id, { level_id: level.id, level_name: level.name, role_id: level.roleId, count: total ?? store.staff.count('resolved', g.id, member.id, 0), kind: had ? 'sync' : kind, by_user: by });
  if (!had) { await announcePromotion(g, member, level, kind); await logEvent(g, 'promotion', null, `<@${member.id}> ${kind === 'auto' ? 'was promoted automatically' : `was promoted by ${mention(by)}`} to **${level.name}** (${total ?? '?'} resolved)`); }
  return { level, had };
}
async function manualPromote(g, member, role, by) {
  const me = g.members.me; if (!me.permissions.has(P.ManageRoles)) deny('I need the Manage Roles permission.'); if (role.managed || role.id === g.id || role.position >= me.roles.highest.position) deny('I cannot assign that role — move my role above it.');
  if (member.roles.cache.has(role.id)) deny(`${member} already has ${role}.`);
  const level = levelsOf(g.id).find(l => l.roleId === role.id) || { id: null, name: role.name, roleId: role.id, required: 0 };
  await applyPromotion(g, member, level, { kind: 'manual_promote', by, total: store.staff.count('resolved', g.id, member.id, 0) }); store.staff.register(g.id, member.id); lbSchedule(g); return level;
}
async function manualDemote(g, member, role, by) {
  const me = g.members.me; if (!me.permissions.has(P.ManageRoles)) deny('I need the Manage Roles permission.'); if (role.managed || role.position >= me.roles.highest.position) deny('I cannot remove that role — move my role above it.');
  if (!member.roles.cache.has(role.id)) deny(`${member} does not have ${role}.`); await member.roles.remove(role.id, 'Manual staff demotion');
  const level = levelsOf(g.id).find(l => l.roleId === role.id);
  store.promo.add(g.id, member.id, { level_id: level?.id ?? null, level_name: level?.name || role.name, role_id: role.id, count: store.staff.count('resolved', g.id, member.id, 0), kind: 'manual_demote', by_user: by });
  await logEvent(g, 'promotion', null, `<@${member.id}> was demoted by ${mention(by)} (removed **${role.name}**)`); return level;
}
// shows how far a staff member is from the next level
function eligibility(g, uid, member) {
  const st = userStats(g, uid, member), lv = levelsOf(g.id), aw = store.promo.awarded(g.id, uid), top = Math.max(-1, ...lv.filter(l => aw.includes(l.id)).map(l => l.required));
  const due = lv.filter(l => l.roleId && l.required <= st.total && l.required > top).pop() || null; return { st, due };
}

// ───────────────────────────────────────────── 7. LIVE STAFF LEADERBOARD ─────────────────────────────────────────────
const lbLocks = new Map(), lbTimers = new Map(), lbLast = new Map(), PERIOD_LABEL = { today: 'today', weekly: 'weekly', monthly: 'monthly', alltime: 'all-time' };
const cardsOk = () => !!(DJS.ContainerBuilder && DJS.SectionBuilder && DJS.ThumbnailBuilder && DJS.TextDisplayBuilder);
const lbStyle = lb => (lb.style === 'cards' && cardsOk() ? 'cards' : 'embed');
async function lbData(g, period, top) {
  const s = S(g.id), lb = s.leaderboard, rows = store.staff.board(g.id, s, period).slice(0, top), reset = lb.resetAt || 0;
  const members = rows.length ? await g.members.fetch({ user: rows.map(r => r.id) }).catch(() => null) : null, per = p => Math.max(periodStart(p, s), reset), openNow = store.tickets.openByStaff(g.id), rated = store.tickets.ratingByStaff(g.id);
  return rows.map((r, n) => { const m = members?.get(r.id), me = m || g.members.cache.get(r.id);
    return { ...r, open: openNow.get(r.id) || 0, rating: rated.get(r.id) ? ` • ⭐ **${rated.get(r.id).a.toFixed(1)}** (${rated.get(r.id).n})` : '', rank: n + 1, name: me?.displayName || me?.user?.username || `User ${r.id}`, username: me?.user?.username || r.id, avatar: (me?.displayAvatarURL?.({ extension: 'png', size: 128 })) || '',
      weekly: store.staff.count('resolved', g.id, r.id, per('weekly')), monthly: store.staff.count('resolved', g.id, r.id, per('monthly')), alltime: store.staff.count('resolved', g.id, r.id, per('alltime')) }; });
}
const medal = (lb, n) => (n === 1 ? lb.emojis.first : n === 2 ? lb.emojis.second : n === 3 ? lb.emojis.third : lb.emojis.other);
const rowText = (g, lb, r) => fill(`${lb.rankFormat || '{medal} **#{rank}** {mention}'}\n${lb.rowFormat}${String(lb.rowFormat).includes('{open}') ? '' : '\n📂 **{open}** open now{rating}'}`, lower({ open: r.open, rating: r.rating, medal: etext(medal(lb, r.rank), g), rank: r.rank, name: r.name, mention: `<@${r.id}>`, username: r.username, resolved: r.resolved, claimed: r.claimed, managed: r.managed, weekly: r.weekly, monthly: r.monthly, alltime: r.alltime }));
function lbButtons(period) {
  return [new Row().addComponents(...['weekly', 'monthly', 'alltime'].map(p => new ButtonBuilder().setCustomId('tt:lb:' + p).setLabel({ weekly: 'Weekly', monthly: 'Monthly', alltime: 'All-time' }[p]).setStyle(p === period ? BS.Primary : BS.Secondary)),
    new ButtonBuilder().setCustomId('tt:lb:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(BS.Secondary))];
}
function lbStats(g) { // same numbers as the dashboard: totals, by category, rating, recent activity
  const st = store.tickets.stats(g.id), ra = store.tickets.ratingAvg(g.id), ev = store.events.recent(g.id, 15).filter(e => e.number && e.type !== 'activity' && e.type !== 'transcript').slice(0, 5);
  const top = Math.max(1, ...st.byCategory.map(x => x.n)), bar = n => { const k = Math.max(n ? 1 : 0, Math.round(n / top * 10)); return '▰'.repeat(k) + '▱'.repeat(10 - k); };
  const EV = { create: '🆕', claim: '🙋', unclaim: '↩️', close: '🔒', reopen: '🔓', delete: '🗑️', transfer: '🔀', promotion: '🎉' };
  return {
    summary: `🎫 Total **${st.total}** • 🟢 Open **${st.open}** • 🔒 Closed **${st.closed}** • 🙋 Claimed **${st.claimed}**\n📅 Last 24h **${st.today}** • Last 7 days **${st.week}**${ra?.n ? `\n⭐ Average rating **${ra.a.toFixed(1)}/5** • ${'★'.repeat(Math.round(ra.a))}${'☆'.repeat(5 - Math.round(ra.a))} (${ra.n} rating${ra.n === 1 ? '' : 's'})` : ''}`,
    cats: st.byCategory.map(x => `\`${bar(x.n)}\` **${x.n}** • ${x.name || '—'}`).join('\n'),
    activity: ev.map(e => `${EV[e.type] || '▫️'} \`${e.type}\` **#${padN(g.id, e.number)}** <t:${Math.floor(e.ts / 1000)}:R>${e.user_id && /^\d{15,25}$/.test(String(e.user_id)) ? ` • <@${e.user_id}>` : ''}`).join('\n'),
  };
}
async function lbPayload(g, period, { buttons = true } = {}) {
  const s = S(g.id), lb = s.leaderboard, style = lbStyle(lb), top = Math.min(Math.max(Number(lb.top) || 10, 1), style === 'cards' ? 8 : 15), data = await lbData(g, period, top), files = [];
  const v = lower(vars(g, null, null, { period: PERIOD_LABEL[period] || period })), title = clip(fill(lb.title, v), 256), desc = fill(lb.description, v), foot = fill(lb.footer, v), comps = buttons && lb.showButtons ? lbButtons(period) : [];
  if (style === 'cards') {
    const box = new DJS.ContainerBuilder().setAccentColor(colorInt(lb.color, 0xF1C40F)), TD = c => new DJS.TextDisplayBuilder().setContent(clip(c, 3900)), head = `## ${title}\n${desc}`, th = img(lb.thumbnail, files);
    if (th) box.addSectionComponents(new DJS.SectionBuilder().addTextDisplayComponents(TD(head)).setThumbnailAccessory(new DJS.ThumbnailBuilder().setURL(th))); else box.addTextDisplayComponents(TD(head));
    if (!data.length) box.addTextDisplayComponents(TD(lb.emptyText));
    // Discord allows 40 components in total: keep room for the head, stats, buttons, then fit as many rows (4 components each) as possible
    const used = 1 + (th ? 3 : 1) + (data.length ? 0 : 1) + 2 + comps.reduce((n, r) => n + 1 + (r.components?.length || 0), 0), maxRows = Math.max(0, Math.floor((40 - used) / 4));
    for (const r of data.slice(0, maxRows)) { box.addSeparatorComponents(new DJS.SeparatorBuilder().setDivider(true).setSpacing(DJS.SeparatorSpacingSize.Small));
      const sec = new DJS.SectionBuilder().addTextDisplayComponents(TD(rowText(g, lb, r))); if (r.avatar) sec.setThumbnailAccessory(new DJS.ThumbnailBuilder().setURL(r.avatar)); else sec.setThumbnailAccessory(new DJS.ThumbnailBuilder().setURL(g.client.user.displayAvatarURL({ extension: 'png' }))); box.addSectionComponents(sec); }
    { const x = lbStats(g); box.addSeparatorComponents(new DJS.SeparatorBuilder().setDivider(true).setSpacing(DJS.SeparatorSpacingSize.Small)); box.addTextDisplayComponents(TD(clip(`### 📊 Ticket statistics\n${x.summary}${x.cats ? `\n\n**📂 By category**\n${x.cats}` : ''}${x.activity ? `\n\n**🕒 Recent activity**\n${x.activity}` : ''}`, 1100) + (foot ? `\n\n-# ${foot}` : ''))); }
    return { style, body: { components: [box, ...comps], flags: MessageFlags.IsComponentsV2, files } };
  }
  const e = new EmbedBuilder().setColor(colorInt(lb.color, 0xF1C40F)).setTitle(title); let text = desc ? desc + '\n\n' : '';
  if (!data.length) text += lb.emptyText; else for (const r of data) { const line = rowText(g, lb, r) + '\n\n'; if ((text + line).length > 3200) break; text += line; }
  e.setDescription(clip(text.trim(), 4000)); { const x = lbStats(g); e.addFields({ name: '📊 Ticket statistics', value: clip(x.summary, 1024) }); if (x.cats) e.addFields({ name: '📂 By category', value: clip(x.cats, 1024), inline: true }); if (x.activity) e.addFields({ name: '🕒 Recent activity', value: clip(x.activity, 1024), inline: true }); } const th = img(lb.thumbnail, files) || (lb.useTopAvatar && data[0]?.avatar) || null; if (th) e.setThumbnail(th); if (foot) e.setFooter({ text: clip(foot, 2048) }); if (lb.timestamp) e.setTimestamp();
  return { style, body: { embeds: [e], components: comps, files, content: '' } };
}
// publish = create or EDIT the one leaderboard message (never a duplicate). Moving channel or changing style replaces the old message.
const publishLb = (g, channelId) => withLock(lbLocks, g.id, async () => {
  const s = S(g.id), lb = s.leaderboard, ch = g.channels.cache.get(channelId || lb.channelId); if (!ch?.isTextBased() || ch.type === ChannelType.GuildCategory) throw new Error('Choose a leaderboard channel first.');
  if (!ch.permissionsFor(g.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory])) throw new Error(`I need View Channel, Send Messages, Embed Links and Read Message History in #${ch.name}.`);
  const { style, body } = await lbPayload(g, lb.period); let msg = null; const oldCh = lb.messageChannelId && g.channels.cache.get(lb.messageChannelId);
  if (lb.messageId && oldCh?.isTextBased()) { msg = await oldCh.messages.fetch(lb.messageId).catch(() => null); if (msg && (oldCh.id !== ch.id || lb.messageStyle !== style)) { await msg.delete().catch(() => { }); msg = null; } }
  if (msg) { try { await msg.edit({ ...body, attachments: [] }); } catch (e) { await msg.delete().catch(() => { }); msg = null; } }
  if (!msg) msg = await ch.send(body);
  store.settings.set(g.id, { leaderboard: { channelId: ch.id, messageId: msg.id, messageChannelId: ch.id, messageStyle: style } }); lbLast.set(g.id, Date.now()); return msg;
});
const updateLb = g => { const lb = S(g.id).leaderboard; if (!lb.messageId || !lb.enabled || !S(g.id).features.leaderboard) return Promise.resolve(null); return publishLb(g); };
function lbSchedule(g) { // live update after any ticket activity (debounced, so bursts become one edit)
  const s = S(g.id), lb = s.leaderboard; if (!s.features.leaderboard || !lb.enabled || !lb.updateOnActivity || !lb.messageId) return;
  clearTimeout(lbTimers.get(g.id)); lbTimers.set(g.id, setTimeout(() => { lbTimers.delete(g.id); updateLb(g).catch(e => console.error('Leaderboard update failed:', e.message)); }, 4000));
}
function startLeaderboardTimer(client) {
  setInterval(() => { for (const g of client.guilds.cache.values()) { const lb = S(g.id).leaderboard; if (!lb.messageId || !lb.enabled) continue;
    if (Date.now() - (lbLast.get(g.id) || 0) >= Math.max(1, Number(lb.intervalMinutes) || 10) * 60000 - 5000) { lbLast.set(g.id, Date.now()); updateLb(g).catch(e => console.error('Leaderboard refresh failed:', e.message)); } } }, 60000).unref();
}
const lbCool = new Map();
async function leaderboardButton(i, arg) { // buttons under the published leaderboard: personal period view (ephemeral) or manual refresh
  const g = i.guild, s = S(g.id); if (!s.features.leaderboard) return i.reply({ content: '❌ The leaderboard is disabled.', flags: EPH });
  if (arg === 'refresh') { const k = g.id + ':' + i.user.id; if (Date.now() - (lbCool.get(k) || 0) < 15000) return i.reply({ content: '⏳ Please wait a few seconds before refreshing again.', flags: EPH }); lbCool.set(k, Date.now());
    await i.deferUpdate(); await updateLb(g).catch(() => { }); return; }
  await i.deferReply({ flags: EPH }); const { body } = await lbPayload(g, arg, { buttons: false }); return i.editReply(body);
}


// ───────────────────────────────────────────── 8. PANELS (the message with the ticket buttons / dropdown) ─────────────────────────────────────────────
function panelComponents(p, cats, g) {
  if (p.mode === 'select') {
    return [new Row().addComponents(new StringSelectMenuBuilder().setCustomId(`tt:sel:${p.id}`).setPlaceholder(clip(p.placeholder || 'Choose a ticket type', 150)).addOptions(cats.slice(0, 25).map(c => {
      const o = { label: clip(c.label || c.name, 100), value: String(c.id) }; if (c.description) o.description = clip(c.description, 100); const em = emoji(c.emoji, g); if (em) o.emoji = em; return o; })))];
  }
  const rows = [], per = Math.min(Math.max(Number(p.perRow) || 5, 1), 5);
  for (let n = 0; n < Math.min(cats.length, 25); n += per) rows.push(new Row().addComponents(...cats.slice(n, n + per).map(c => {
    const b = new ButtonBuilder().setCustomId(`tt:open:${c.id}`).setLabel(clip(c.label || c.name, 80)).setStyle(STYLE[c.style] || BS.Primary); const em = emoji(c.emoji, g); if (em) b.setEmoji(em); return b; })));
  return rows;
}
const mcCache = new Map();
async function mcStatus(ip) { // public Minecraft status API (java servers); cached for a minute
  if (!ip) return null; const c = mcCache.get(ip); if (c && Date.now() - c.t < 60000) return c.v; let v = null;
  try { const j = await (await fetch('https://api.mcsrvstat.us/3/' + encodeURIComponent(ip), { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'ticket-bot' } })).json(); v = { online: !!j.online, players: j.players?.online ?? 0, max: j.players?.max ?? 0 }; } catch { }
  mcCache.set(ip, { t: Date.now(), v }); return v;
}

async function statusVars(p, g) {
  const t = store.tickets, mc = await mcStatus(p.serverIp);
  return { open_tickets: t.stats(g.id).open, staff_active: t.staffActive(g.id, 60), avg_reply: fmtMs(t.avgClaimMs(g.id, 7)), players: mc ? mc.players : 'n/a', max_players: mc ? mc.max : 'n/a', server_ip: p.serverIp || 'n/a', server_status: mc ? (mc.online ? '🟢 Online' : '🔴 Offline') : 'n/a', updated: `<t:${Math.floor(Date.now() / 1000)}:R>` };
}
function sectionsBody(p, cats, g, files, sv) {
  const D = DJS; if (!D.ContainerBuilder || !D.SectionBuilder) throw new Error('This panel style needs discord.js 14.19 or newer. Run: npm i discord.js@latest');
  const e = p.embed || {}, vars = { server: g.name, brand: S(g.id).brandName, ...(sv || {}) }, fillT = s => fill(s, vars);
  const box = new D.ContainerBuilder().setAccentColor(colorInt(e.color)), sep = (div = true, big = false) => new D.SeparatorBuilder().setDivider(div).setSpacing(big ? D.SeparatorSpacingSize.Large : D.SeparatorSpacingSize.Small);
  const head = [e.title && `## ${fillT(e.title)}`, e.description && fillT(e.description)].filter(Boolean).join('\n'), th = img(e.thumbnail, files), im = img(e.image, files), blocks = p.blocks || [], pbtn = p.buttons || [], status = p.statusOn && p.status ? fillT(p.status) : '';
  const total = 1 + (head || th ? (th ? 2 : 1) : 0) + (im ? 2 : 0) + cats.slice(0, 10).length * 4 + blocks.length * 2 + (pbtn.length ? 1 + pbtn.length : 0) + (status ? 2 : 0) + (e.footer ? 2 : 0);
  if (total > 40) throw new Error(`This panel is too big for one Discord message (${total} of 40 parts). Remove a ticket type, info block or button.`);
  const gallery = () => new D.MediaGalleryBuilder().addItems(new D.MediaGalleryItemBuilder().setURL(im));
  if (im && p.imagePos === 'top') box.addMediaGalleryComponents(gallery());
  if (head || th) { const t = new D.TextDisplayBuilder().setContent(clip(head || '\u200b', 3500)); if (th) box.addSectionComponents(new D.SectionBuilder().addTextDisplayComponents(t).setThumbnailAccessory(new D.ThumbnailBuilder().setURL(th))); else box.addTextDisplayComponents(t); }
  for (const c of cats.slice(0, 10)) {
    box.addSeparatorComponents(sep());
    const b = new ButtonBuilder().setCustomId(`tt:open:${c.id}`).setLabel('Open').setStyle(STYLE[c.style] || BS.Primary); const em = emoji(c.emoji, g); if (em) b.setEmoji(em);
    box.addSectionComponents(new D.SectionBuilder().addTextDisplayComponents(new D.TextDisplayBuilder().setContent(clip(`**${[etext(c.emoji, g), c.label || c.name].filter(Boolean).join(' ')}**${c.description ? '\n' + c.description : ''}`, 900))).setButtonAccessory(b));
  }
  blocks.forEach((x, n) => { box.addSeparatorComponents(n ? sep(false, true) : sep()); box.addTextDisplayComponents(new D.TextDisplayBuilder().setContent(clip(`**${[etext(x.emoji, g), fillT(x.title)].filter(Boolean).join(' ')}**${x.text ? '\n' + fillT(x.text) : ''}`, 900))); });
  if (pbtn.length) { box.addSeparatorComponents(sep(false)); box.addActionRowComponents(new Row().addComponents(pbtn.map((x, n) => { const b = new ButtonBuilder().setLabel(clip(x.label, 80)).setStyle(x.kind === 'link' ? BS.Link : BS.Secondary); if (x.kind === 'link') b.setURL(x.url); else b.setCustomId(`tt:pb:${p.id}:${n}`); const em = emoji(x.emoji, g); if (em) b.setEmoji(em); return b; }))); }
  if (im && p.imagePos !== 'top') box.addMediaGalleryComponents(gallery());
  if (status) { box.addSeparatorComponents(sep()); box.addTextDisplayComponents(new D.TextDisplayBuilder().setContent(clip(status, 1500))); }
  if (e.footer) { box.addSeparatorComponents(sep()); box.addTextDisplayComponents(new D.TextDisplayBuilder().setContent(`-# ${fillT(e.footer)}`)); }
  return { components: [box], flags: D.MessageFlags.IsComponentsV2 };
}

async function buildPanel(p, g) {
  const cats = store.categories.forPanel(p.id).filter(c => c.enabled !== false), files = [];
  if (p.mode === 'sections') { const sf = [], sv = p.statusOn ? await statusVars(p, g) : {}; return { cats, files: sf, body: cats.length ? sectionsBody(p, cats, g, sf, sv) : {} }; }
  const e = embed(p.embed, { server: g.name, brand: S(g.id).brandName }, files) || new EmbedBuilder().setColor(0x5865F2).setTitle('Support').setDescription('Press a button below to open a ticket.');
  return { cats, files, body: { embeds: [e], components: panelComponents(p, cats, g) } };
}
async function publishPanel(client, id, opts = {}) {
  const p = store.panels.get(id); if (!p) throw new Error('Panel not found.'); const g = client.guilds.cache.get(p.guild_id), ch = g?.channels.cache.get(p.channel_id);
  if (!ch?.isTextBased()) throw new Error('Choose a channel for this panel first.');
  if (!ch.permissionsFor(g.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory])) throw new Error(`I need View Channel, Send Messages, Embed Links and Read Message History in #${ch.name}.`);
  const { cats, files, body } = await buildPanel(p, g); if (!cats.length) throw new Error('Add at least one ticket category to this panel first.');
  let created = []; // Discord category folders are created on an explicit publish only (the fast path just edits the message)
  if (opts.ensure) {
    if (!g.members.me.permissions.has(P.ManageChannels)) throw new Error('I need the Manage Channels permission to create the ticket categories.');
    const isCat = c => c.type === ChannelType.GuildCategory, before = new Set(g.channels.cache.filter(isCat).map(c => c.id));
    for (const c of cats) { try { await ensureParent(g, c); } catch (e) { throw new Error(`Could not create the Discord category for "${c.name}": ${e.message}`); } }
    created = g.channels.cache.filter(c => isCat(c) && !before.has(c.id)).map(c => c.name);
  }
  let msg = p.message_id ? await ch.messages.fetch(p.message_id).catch(() => null) : null;
  try {
    if (msg) { try { await msg.edit({ ...body, files, attachments: [] }); } catch (e) { if (![10008, 50035].includes(e.code) && !/component|form body/i.test(e.message)) throw e; await msg.delete().catch(() => { }); msg = null; } }
    if (!msg) msg = await ch.send({ ...body, files });
  } catch (e) { throw new Error(`Discord rejected the panel: ${e.message}. Check emojis, labels and image files.`); }
  store.panels.setMessage(p.id, ch.id, msg.id); return { url: msg.url, created };
}
async function unpublishPanel(client, id) {
  const p = store.panels.get(id); if (!p?.message_id) return; const g = client.guilds.cache.get(p.guild_id), ch = g?.channels.cache.get(p.channel_id);
  await ch?.messages.delete(p.message_id).catch(() => { }); store.panels.setMessage(p.id, p.channel_id, null);
}


// ───────────────────────────────────────────── 9. COMMANDS — one table drives BOTH the /ticket slash commands and the !ticket prefix commands ─────────────────────────────────────────────
const NAME = (process.env.TICKET_COMMAND || 'ticket').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'ticket';
const o = (n, t, d, x = {}) => ({ n, t, d, ...x }); // option: t = s(tring) i(nteger) b(oolean) u(ser) r(ole) c(hannel)
const ch = a => a.map(v => [v, v]);
const GROUPS = { leaderboard: ['Live staff leaderboard', 'view'], staff: ['Staff management', 'stats'], promotion: ['Automatic promotions', 'list'], config: ['Configuration', 'view'] };
const STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];
const CMDS = [];
const C = (p, d, opts, perm, run) => CMDS.push({ path: p.split(' '), d, opts, perm, run });
const mem = async (c, n) => { const u = c.o[n]; return u ? (await c.g.members.fetch(u.id).catch(() => null)) : null; };
function ticketEnv(c) { const t = store.tickets.byChannel(c.channel.id); if (!t || t.guild_id !== c.g.id) deny('Use this command inside a ticket channel.'); return { g: c.g, channel: c.channel, member: c.member, user: c.user, t, cat: store.categories.get(t.category_id) }; }
const findCat = (gid, k) => { k = String(k || '').trim().toLowerCase(); return store.categories.all(gid).find(c => String(c.id) === k || c.name.toLowerCase() === k); };
const findPanel = (gid, k) => { k = String(k || '').trim().toLowerCase(); return store.panels.all(gid).find(p => String(p.id) === k || p.name.toLowerCase() === k); };
const info = (title, desc, color = 0x5865F2) => ({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(clip(desc, 4000))], allowedMentions: { parse: [] } });
const chanId = v => String(v || '').replace(/[<#>]/g, '').trim();
const parseBool = v => /^(1|true|yes|on|y|enable|enabled)$/i.test(String(v).trim()) ? true : /^(0|false|no|off|n|disable|disabled)$/i.test(String(v).trim()) ? false : deny('Use true or false.');
function setPath(obj, p, v) { const k = p.split('.'); let c = obj; for (const x of k.slice(0, -1)) c = c[x] = c[x] || {}; c[k.at(-1)] = v; return obj; }
// typed setting registry shared by /ticket config set, leaderboard settings and promotion settings
function parseVal(def, raw) {
  const [type, a, b] = def; raw = String(raw ?? '').trim();
  if (type === 'bool') return parseBool(raw);
  if (type === 'int') { const n = parseInt(raw, 10); if (!Number.isFinite(n) || n < a || n > b) deny(`Enter a whole number between ${a} and ${b}.`); return n; }
  if (type === 'enum') { const v = a.find(x => x.toLowerCase() === raw.toLowerCase()); if (!v) deny(`Choose one of: ${a.join(', ')}.`); return v; }
  if (type === 'chan') return raw === '' || /^(none|off|-)$/i.test(raw) ? '' : /^\d{15,25}$/.test(chanId(raw)) ? chanId(raw) : deny('Mention a channel or paste its ID.');
  if (type === 'color') return /^#?[0-9a-f]{6}$/i.test(raw) ? '#' + raw.replace('#', '').toUpperCase() : deny('Use a hex color like #5865F2.');
  return raw.slice(0, a || 2000);
}
const CFG = { prefix: ['prefix', ['str', 5]], usebotprefix: ['useBotPrefix', ['bool']], brand: ['brandName', ['str', 60]], maxperuser: ['maxPerUser', ['int', 0, 100]], cooldown: ['cooldownSeconds', ['int', 0, 3600]], confirmclose: ['confirmClose', ['bool']], showanswers: ['showAnswers', ['bool']],
  staffbypasslimit: ['staffBypassLimit', ['bool']], channelname: ['channelName', ['str', 90]], parentprefix: ['parentPrefix', ['str', 30]], autoclosehours: ['autoClose.hours', ['int', 0, 720]], deletedelay: ['closeBehavior.deleteDelay', ['int', 0, 120]], renameclosed: ['closeBehavior.renameClosed', ['bool']],
  closedprefix: ['closeBehavior.closedPrefix', ['str', 20]], creatorcanview: ['closeBehavior.creatorCanView', ['bool']], transcripts: ['transcript.enabled', ['bool']], transcriptformat: ['transcript.format', ['enum', ['html', 'txt']]], transcriptlimit: ['transcript.limit', ['int', 50, 10000]],
  dmonclose: ['notifications.dmOnClose', ['bool']], pingstaff: ['notifications.pingStaffOnOpen', ['bool']], notifycooldown: ['notifications.notifyCooldownMinutes', ['int', 0, 1440]], weekstart: ['stats.weekStartsOn', ['int', 0, 6]], utcoffset: ['stats.utcOffsetMinutes', ['int', -720, 840]],
  closedcategory: ['closedCategoryId', ['chan']], ratingchannel: ['ratingChannelId', ['chan']], 'feature.tickets': ['features.tickets', ['bool']], 'feature.prefixcommands': ['features.prefixCommands', ['bool']], 'feature.leaderboard': ['features.leaderboard', ['bool']], 'feature.promotions': ['features.promotions', ['bool']],
  'feature.staffstats': ['features.staffStats', ['bool']], 'feature.transcripts': ['features.transcripts', ['bool']], 'feature.autoclose': ['features.autoClose', ['bool']], 'feature.logging': ['features.logging', ['bool']] };
const LBSET = { enabled: ['enabled', ['bool']], channel: ['channelId', ['chan']], title: ['title', ['str', 256]], description: ['description', ['str', 2000]], color: ['color', ['color']], footer: ['footer', ['str', 500]], thumbnail: ['thumbnail', ['str', 300]], interval: ['intervalMinutes', ['int', 1, 1440]], top: ['top', ['int', 1, 15]],
  style: ['style', ['enum', ['embed', 'cards']]], period: ['period', ['enum', ['weekly', 'monthly', 'alltime']]], rankformat: ['rankFormat', ['str', 300]], rowformat: ['rowFormat', ['str', 600]], emoji_first: ['emojis.first', ['str', 80]], emoji_second: ['emojis.second', ['str', 80]], emoji_third: ['emojis.third', ['str', 80]],
  emoji_other: ['emojis.other', ['str', 80]], buttons: ['showButtons', ['bool']], live: ['updateOnActivity', ['bool']], avatar: ['useTopAvatar', ['bool']], timestamp: ['timestamp', ['bool']], empty: ['emptyText', ['str', 300]] };
const PRSET = { enabled: ['enabled', ['bool']], auto: ['auto', ['bool']], retain: ['retainPrevious', ['bool']], announce: ['announce', ['bool']], channel: ['announceChannelId', ['chan']], announcemanual: ['announceManual', ['bool']], dm: ['dmStaff', ['bool']],
  creditmode: ['creditMode', ['enum', ['claimer', 'closer', 'claimer_closer', 'participants']]], closerifunclaimed: ['creditCloserIfUnclaimed', ['bool']], minmessages: ['minStaffMessages', ['int', 0, 1000]], minage: ['minAgeMinutes', ['int', 0, 10080]], countauto: ['countAutoClosed', ['bool']], uncredit: ['uncreditOnReopen', ['bool']] };
function applySetting(gid, section, reg, key, value) {
  const def = reg[String(key).toLowerCase()]; if (!def) deny(`Unknown setting. Available: ${Object.keys(reg).join(', ')}`); const v = parseVal(def[1], value), patch = setPath({}, section ? `${section}.${def[0]}` : def[0], v); store.settings.set(gid, patch); return v;
}

// ----- ticket management -----
C('panel', 'Create and publish a ticket panel', [o('channel', 'c', 'Channel to post the panel in (default: here)'), o('panel', 's', 'Existing panel to re-publish', { ac: 'panels' })], 'admin', async c => {
  const g = c.g, dest = c.o.channel || c.channel; if (!dest?.isTextBased()) deny('Choose a text channel.'); let p;
  if (c.o.panel) { p = findPanel(g.id, c.o.panel); if (!p) deny('Panel not found.'); p = store.panels.save({ ...p, channel_id: dest.id }); }
  else { let cats = store.categories.all(g.id); if (!cats.length) cats = [store.categories.save({ ...clone(CATEGORY), guild_id: g.id, roles: [] })];
    const n = store.panels.all(g.id).length + 1; p = store.panels.save({ ...clone(PANEL), guild_id: g.id, name: `Support Panel ${n}`, channel_id: dest.id, embed: mkEmbed({ title: `${g.name} Support`, description: 'Press a button below to open a ticket.' }) });
    for (const x of cats.filter(x => !x.panel_id)) store.categories.save({ ...x, panel_id: p.id }); }
  const r = await publishPanel(c.client, p.id, { ensure: true }); return { text: `✅ Panel published: ${r.url}\nCustomize it any time in the dashboard.` };
});
C('setup', 'Configure the ticket system (quick setup)', [o('staff_role', 'r', 'Support staff role'), o('admin_role', 'r', 'Ticket admin role'), o('log_channel', 'c', 'Ticket log channel'), o('transcript_channel', 'c', 'Transcript channel'), o('leaderboard_channel', 'c', 'Leaderboard channel'), o('prefix', 's', 'Prefix for !ticket commands', { max: 5 })], 'admin', async c => {
  const g = c.g, s = S(g.id), patch = {};
  if (c.o.staff_role) patch.staffRoles = uniq([...s.staffRoles, c.o.staff_role.id]); if (c.o.admin_role) patch.adminRoles = uniq([...s.adminRoles, c.o.admin_role.id]);
  if (c.o.log_channel) patch.logChannelId = c.o.log_channel.id; if (c.o.transcript_channel) patch.transcriptChannelId = c.o.transcript_channel.id; if (c.o.prefix) patch.prefix = c.o.prefix.replace(/\s/g, '');
  if (c.o.leaderboard_channel) patch.leaderboard = { channelId: c.o.leaderboard_channel.id };
  if (Object.keys(patch).length) store.settings.set(g.id, patch); if (!store.categories.all(g.id).length) store.categories.save({ ...clone(CATEGORY), guild_id: g.id, roles: [] }); const n = S(g.id);
  return info('✅ Ticket setup', [`**Staff roles:** ${n.staffRoles.map(r => `<@&${r}>`).join(' ') || '— (use staff_role)'}`, `**Admin roles:** ${n.adminRoles.map(r => `<@&${r}>`).join(' ') || '—'}`, `**Logs:** ${n.logChannelId ? `<#${n.logChannelId}>` : '—'}  **Transcripts:** ${n.transcriptChannelId ? `<#${n.transcriptChannelId}>` : '—'}`,
    `**Leaderboard channel:** ${n.leaderboard.channelId ? `<#${n.leaderboard.channelId}>` : '—'}  **Prefix:** \`${n.prefix}\``, '', 'Next: `/ticket panel` to publish a panel, `/ticket leaderboard publish`, and `/ticket promotion add` for promotion levels. Everything is also editable in the web dashboard.'].join('\n'));
});
C('add', 'Add a member to this ticket', [o('user', 'u', 'Member to add', { req: 1 })], 'ticket', c => tickets.add(ticketEnv(c), c.o.user));
C('remove', 'Remove a member from this ticket', [o('user', 'u', 'Member to remove', { req: 1 })], 'ticket', c => tickets.removeMember(ticketEnv(c), c.o.user));
C('close', 'Close this ticket', [o('reason', 's', 'Why is it being closed?', { rest: 1, max: 500 }), o('unresolved', 'b', 'Close without counting it as resolved')], 'ticket', c => { const env = ticketEnv(c); return c.o.unresolved ? tickets.close(env, c.o.reason, { unresolved: true }) : tickets.requestClose(env, c.o.reason); });
C('reopen', 'Reopen this ticket', [], 'ticket', c => tickets.reopen(ticketEnv(c)));
C('claim', 'Claim this ticket', [], 'ticket', c => tickets.claim(ticketEnv(c)));
C('unclaim', 'Unclaim this ticket', [], 'ticket', c => tickets.unclaim(ticketEnv(c)));
C('rename', 'Rename this ticket channel', [o('name', 's', 'New channel name', { req: 1, rest: 1, max: 90 })], 'ticket', c => tickets.rename(ticketEnv(c), c.o.name));
C('transfer', 'Transfer this ticket to another staff member', [o('staff', 'u', 'Staff member', { req: 1 })], 'ticket', c => tickets.transfer(ticketEnv(c), c.o.staff));
C('transcript', 'Generate a transcript of this ticket', [], 'ticket', c => tickets.transcript(ticketEnv(c)));
C('delete', 'Delete this ticket', [], 'ticket', c => tickets.remove_ticket(ticketEnv(c)));
C('info', 'Show information about this ticket', [], 'ticket', c => tickets.info(ticketEnv(c)));
C('say', 'Send a message as the bot in this ticket', [o('message', 's', 'What should I say?', { req: 1, rest: 1, max: 2000 })], 'ticket', c => tickets.say(ticketEnv(c), c.o.message));
C('list', 'List tickets', [o('status', 's', 'Which tickets', { choices: ['open', 'closed', 'all'] })], 'staff', c => {
  const list = store.tickets.list({ gid: c.g.id, status: c.o.status || 'open', limit: 25 }); if (!list.length) return { text: 'No tickets found.' };
  return info(`🎫 ${c.o.status || 'open'} tickets`, list.map(t => `**#${padN(c.g.id, t.number)}** ${t.status === 'open' ? `<#${t.channel_id}>` : t.status} • ${t.category_name} • <@${t.user_id}>${t.claimed_by ? ` • ✋ <@${t.claimed_by}>` : ''}`).join('\n'));
});
C('stats', 'Show ticket statistics', [], 'staff', c => {
  const st = store.tickets.stats(c.g.id), avg = store.tickets.avgClaimMs(c.g.id, 30), e = new EmbedBuilder().setColor(0x5865F2).setTitle('📊 Ticket statistics').addFields({ name: 'Total', value: String(st.total), inline: true }, { name: 'Open', value: String(st.open), inline: true }, { name: 'Closed', value: String(st.closed), inline: true },
    { name: 'Resolved (counted)', value: String(st.resolved), inline: true }, { name: 'Last 24h', value: String(st.today), inline: true }, { name: 'Last 7 days', value: String(st.week), inline: true }, { name: 'Avg claim time (30d)', value: fmtMs(avg), inline: true }, { name: 'Active staff (60 min)', value: String(store.tickets.staffActive(c.g.id, 60)), inline: true });
  if (st.byCategory.length) e.addFields({ name: 'By category', value: st.byCategory.map(x => `${x.name || '—'}: **${x.n}**`).join('\n') }); return { embeds: [e] };
});

// ----- leaderboard -----
C('leaderboard view', 'Show the live staff leaderboard', [o('period', 's', 'Ranking period', { choices: ['weekly', 'monthly', 'alltime'] })], 'staff', async c => { if (!S(c.g.id).features.leaderboard) deny('The leaderboard is disabled.'); const { body } = await lbPayload(c.g, c.o.period || S(c.g.id).leaderboard.period, { buttons: false }); return { text: body.content, embeds: body.embeds, components: body.components, files: body.files, flags: body.flags }; });
C('leaderboard publish', 'Publish the leaderboard in a channel', [o('channel', 'c', 'Channel (default: the saved leaderboard channel)')], 'admin', async c => { const dest = c.o.channel || (S(c.g.id).leaderboard.channelId ? null : c.channel); const m = await publishLb(c.g, dest?.id); return { text: `✅ Leaderboard published: ${m.url}` }; });
C('leaderboard update', 'Update the existing leaderboard message', [], 'staff', async c => { if (!S(c.g.id).leaderboard.messageId) deny('Publish the leaderboard first (/ticket leaderboard publish).'); await publishLb(c.g); return { text: '🔄 Leaderboard updated.' }; });
C('leaderboard reset', 'Reset leaderboard statistics', [o('confirm', 'b', 'Set to true to confirm')], 'admin', async c => { if (!c.o.confirm) deny('This resets the leaderboard counts for everyone (promotion progress is kept). Run again with confirm: true.');
  store.settings.set(c.g.id, { leaderboard: { resetAt: Date.now() } }); await activity(c.g, c.user.id, 'reset the leaderboard'); await updateLb(c.g).catch(() => { }); return { text: '♻️ Leaderboard statistics were reset.' }; });
C('leaderboard settings', 'Customize the leaderboard', [o('option', 's', 'Setting', { req: 1, choices: Object.keys(LBSET) }), o('value', 's', 'New value', { req: 1, rest: 1 })], 'admin', async c => {
  const v = applySetting(c.g.id, 'leaderboard', LBSET, c.o.option, c.o.value); await updateLb(c.g).catch(() => { }); return { text: `✅ leaderboard **${c.o.option}** = \`${String(v).slice(0, 200) || '(empty)'}\`` }; });
const staffCard = async (c, user) => {
  const g = c.g, m = await g.members.fetch(user.id).catch(() => null), st = userStats(g, user.id, m), P_ = st.per, row = p => `✋ ${P_[p].claimed} • ✅ ${P_[p].resolved} • 🛠️ ${P_[p].managed}`;
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`📈 ${m?.displayName || user.username}`).setThumbnail(user.displayAvatarURL({ extension: 'png', size: 128 })).setDescription('Format: ✋ claimed • ✅ resolved • 🛠️ managed')
    .addFields({ name: 'Today', value: row('today'), inline: true }, { name: 'This week', value: row('weekly'), inline: true }, { name: 'This month', value: row('monthly'), inline: true }, { name: 'All-time', value: row('alltime'), inline: true },
      { name: 'Rank', value: st.rank ? `#${st.rank}` : '—', inline: true }, { name: 'Avg response', value: fmtMs(st.avgResponse), inline: true }, { name: 'Avg resolution', value: fmtMs(st.avgResolution), inline: true },
      { name: 'Promotion level', value: st.current ? st.current.name : 'none', inline: true }, { name: 'Next level', value: st.next ? `${st.next.name} — ${st.remaining} more resolved (needs ${st.next.required})` : 'Highest level reached / none configured', inline: true });
  return { embeds: [e] };
};
C('leaderboard staff', 'View statistics of one staff member', [o('user', 'u', 'Staff member', { req: 1 })], 'staff', c => staffCard(c, c.o.user));

// ----- staff management -----
C('staff add', 'Register a staff member', [o('user', 'u', 'Member', { req: 1 })], 'admin', c => { store.staff.register(c.g.id, c.o.user.id); lbSchedule(c.g); return { text: `✅ ${c.o.user} registered as staff.`, allowedMentions: { parse: [] } }; });
C('staff remove', 'Remove a staff member (hidden from the leaderboard)', [o('user', 'u', 'Member', { req: 1 })], 'admin', c => { store.staff.remove(c.g.id, c.o.user.id); lbSchedule(c.g); return { text: `✅ ${c.o.user} removed from the staff list. Their history is kept.`, allowedMentions: { parse: [] } }; });
C('staff promote', 'Manually promote a staff member', [o('user', 'u', 'Member', { req: 1 }), o('role', 'r', 'Role to give', { req: 1 })], 'admin', async c => { const m = await mem(c, 'user'); if (!m) deny('That member is not in this server.'); const l = await manualPromote(c.g, m, c.o.role, c.user.id); return { text: `⬆️ ${m} promoted to **${l.name}**.`, allowedMentions: { parse: [] } }; });
C('staff demote', 'Manually demote a staff member', [o('user', 'u', 'Member', { req: 1 }), o('role', 'r', 'Role to remove', { req: 1 })], 'admin', async c => { const m = await mem(c, 'user'); if (!m) deny('That member is not in this server.'); await manualDemote(c.g, m, c.o.role, c.user.id); return { text: `⬇️ Removed **${c.o.role.name}** from ${m}.`, allowedMentions: { parse: [] } }; });
C('staff stats', 'View staff statistics', [o('user', 'u', 'Staff member (default: you)')], 'staff', c => staffCard(c, c.o.user || c.user));
C('staff reset', 'Reset a staff member\'s statistics', [o('user', 'u', 'Member', { req: 1 }), o('confirm', 'b', 'Set to true to confirm')], 'admin', async c => { if (!c.o.confirm) deny('This sets their statistics (and promotion progress) back to 0. Run again with confirm: true.'); store.staff.reset(c.g.id, c.o.user.id); lbSchedule(c.g); return { text: `♻️ Statistics of ${c.o.user} were reset.`, allowedMentions: { parse: [] } }; });

// ----- promotions -----
C('promotion add', 'Create a promotion level', [o('name', 's', 'Level name, e.g. Support', { req: 1, max: 60 }), o('role', 'r', 'Reward role', { req: 1 }), o('required', 'i', 'Resolved tickets needed', { req: 1, min: 1, max: 100000 })], 'admin', c => {
  const s = S(c.g.id), lv = clone(s.promotion.levels); if (lv.length >= 50) deny('Maximum 50 levels.'); if (lv.some(l => l.name.toLowerCase() === c.o.name.toLowerCase())) deny('A level with that name exists.');
  lv.push({ id: rid(), name: c.o.name, roleId: c.o.role.id, required: c.o.required }); store.settings.set(c.g.id, { promotion: { levels: lv } }); return { text: `✅ Level **${c.o.name}** → ${c.o.role} at **${c.o.required}** resolved tickets.`, allowedMentions: { parse: [] } }; });
C('promotion remove', 'Remove a promotion level', [o('level', 's', 'Level name or ID', { req: 1, ac: 'levels', rest: 1 })], 'admin', c => { const lv = S(c.g.id).promotion.levels, k = c.o.level.toLowerCase(), l = lv.find(x => x.id === k || x.name.toLowerCase() === k); if (!l) deny('Level not found.');
  store.settings.set(c.g.id, { promotion: { levels: lv.filter(x => x.id !== l.id) } }); return { text: `🗑️ Level **${l.name}** removed (members keep their roles).` }; });
C('promotion list', 'Display the promotion levels', [], 'staff', c => { const lv = levelsOf(c.g.id), pr = S(c.g.id).promotion;
  return info('🎖️ Promotion levels', (lv.length ? lv.map(l => `**${l.required}** resolved → **${l.name}** ${l.roleId ? `<@&${l.roleId}>` : '⚠️ no role'}`).join('\n') : 'No levels yet. Use `/ticket promotion add`.') + `\n\nAutomatic promotions: **${pr.enabled && pr.auto ? 'on' : 'off'}** • Keep previous roles: **${pr.retainPrevious ? 'yes' : 'no'}** • Credit rule: **${pr.creditMode}**`); });
C('promotion settings', 'Configure automatic promotions', [o('option', 's', 'Setting', { req: 1, choices: Object.keys(PRSET) }), o('value', 's', 'New value', { req: 1, rest: 1 })], 'admin', c => { const v = applySetting(c.g.id, 'promotion', PRSET, c.o.option, c.o.value); return { text: `✅ promotion **${c.o.option}** = \`${v === '' ? '(empty)' : v}\`` }; });
C('promotion check', 'Check promotion eligibility', [o('user', 'u', 'Staff member (default: you)')], 'staff', async c => {
  const u = c.o.user || c.user, m = await c.g.members.fetch(u.id).catch(() => null), { st, due } = eligibility(c.g, u.id, m), hist = store.promo.forUser(c.g.id, u.id).slice(0, 5);
  return info(`🎖️ ${m?.displayName || u.username}`, [`Resolved tickets: **${st.total}**`, `Current level: **${st.current?.name || 'none'}**`, st.next ? `Next: **${st.next.name}** at ${st.next.required} (**${st.remaining}** to go)` : 'No higher level.', due ? `✅ Eligible now for **${due.name}** (will be applied on the next resolved ticket).` : '',
    hist.length ? '\n**History**\n' + hist.map(h => `<t:${Math.floor(h.ts / 1000)}:d> ${h.kind} → ${h.level_name || '—'}`).join('\n') : ''].filter(Boolean).join('\n')); });

// ----- configuration -----
C('config view', 'View the configuration', [], 'admin', c => { const s = S(c.g.id);
  return info('⚙️ Ticket configuration', [`**Prefix:** \`${s.prefix}\` • **Max/user:** ${s.maxPerUser || '∞'} • **Cooldown:** ${s.cooldownSeconds}s • **Confirm close:** ${s.confirmClose}`, `**Staff roles:** ${s.staffRoles.map(r => `<@&${r}>`).join(' ') || '—'}`, `**Admin roles:** ${s.adminRoles.map(r => `<@&${r}>`).join(' ') || '—'}`,
    `**Features:** ${Object.entries(s.features).map(([k, v]) => `${v ? '✅' : '❌'} ${k}`).join(' • ')}`, `**Transcripts:** ${s.transcript.enabled ? s.transcript.format : 'off'} • **Auto-close:** ${s.autoClose.hours ? s.autoClose.hours + 'h' : 'off'}`,
    `**Leaderboard:** ${s.leaderboard.enabled ? 'on' : 'off'} (${s.leaderboard.channelId ? `<#${s.leaderboard.channelId}>` : 'no channel'}) • **Promotions:** ${s.promotion.enabled ? 'on' : 'off'} (${s.promotion.levels.length} levels)`, `**Categories:** ${store.categories.all(c.g.id).length} • **Panels:** ${store.panels.all(c.g.id).length}`, '', `Change values with \`/ticket config set\`. Keys: ${Object.keys(CFG).join(', ')}`].join('\n')); });
C('config set', 'Change a configuration value', [o('key', 's', 'Setting name', { req: 1, ac: 'cfgkeys' }), o('value', 's', 'New value', { req: 1, rest: 1 })], 'admin', c => { const v = applySetting(c.g.id, '', CFG, c.o.key, c.o.value); return { text: `✅ **${c.o.key}** = \`${v === '' ? '(empty)' : v}\`` }; });
C('config reset', 'Reset configuration to defaults', [o('section', 's', 'Section (or all)', { choices: ['all', 'features', 'perms', 'messages', 'buttons', 'logging', 'leaderboard', 'promotion', 'transcript', 'closeBehavior', 'notifications', 'stats'] }), o('confirm', 'b', 'Set to true to confirm')], 'admin', c => {
  const sec = c.o.section || 'all'; if (!c.o.confirm) deny(`This resets **${sec}** to defaults. Run again with confirm: true.`); const s = S(c.g.id);
  if (sec === 'all') { const keep = clone(s); store.settings.resetAll(c.g.id); store.settings.set(c.g.id, { leaderboard: { channelId: keep.leaderboard.channelId, messageId: keep.leaderboard.messageId, messageChannelId: keep.leaderboard.messageChannelId, messageStyle: keep.leaderboard.messageStyle } }); }
  else { const keep = sec === 'leaderboard' ? { channelId: s.leaderboard.channelId, messageId: s.leaderboard.messageId, messageChannelId: s.leaderboard.messageChannelId, messageStyle: s.leaderboard.messageStyle } : null; store.settings.reset(c.g.id, sec); if (keep) store.settings.set(c.g.id, { leaderboard: keep }); }
  return { text: `♻️ **${sec}** reset to defaults.` }; });
C('buttons', 'Manage ticket buttons', [o('op', 's', 'What to do', { req: 1, choices: ['list', 'add', 'edit', 'remove', 'move', 'reset'] }), o('id', 's', 'Button id', { ac: 'buttons' }), o('label', 's', 'Button label', { max: 80 }), o('emoji', 's', 'Emoji'), o('style', 's', 'Color', { choices: STYLES }), o('action', 's', 'What it does', { choices: BTN_ACTIONS }),
  o('when', 's', 'Shown when the ticket is…', { choices: ['open', 'closed', 'always'] }), o('claimstate', 's', 'Only when…', { choices: ['any', 'claimed', 'unclaimed'] }), o('position', 'i', 'New position (1 = first)', { min: 1, max: 25 }), o('text', 's', 'Text for the "message" action', { max: 1500 }), o('url', 's', 'URL for the "link" action'),
  o('role', 'r', 'Restrict to this role'), o('category', 's', 'Category override (empty = default for all)', { ac: 'cats' })], 'admin', c => {
  const g = c.g, s = S(g.id), cat = c.o.category ? findCat(g.id, c.o.category) : null; if (c.o.category && !cat) deny('Category not found.');
  const list = clone(buttonSet(cat, s)), save = arr => { if (cat) store.categories.save({ ...cat, buttons: arr }); else store.settings.set(g.id, { buttons: arr }); }, scope = cat ? `category **${cat.name}**` : 'the default set', op = c.o.op;
  const show = arr => arr.map((b, n) => `**${n + 1}.** \`${b.id}\` ${b.emoji || ''} ${b.label || ''} — ${b.action} (${b.style}, ${b.when}${b.claimState !== 'any' ? ', ' + b.claimState : ''})`).join('\n') || '*(no buttons — tickets will only be closable with commands)*';
  if (op === 'list') return info(`🔘 Buttons — ${scope}`, show(list));
  if (op === 'reset') { if (cat) store.categories.save({ ...cat, buttons: null }); else store.settings.set(g.id, { buttons: DEFAULT_BUTTONS() }); return { text: `♻️ Buttons of ${scope} reset.` }; }
  const apply = b => { if (c.o.label !== undefined) b.label = c.o.label; if (c.o.emoji !== undefined) b.emoji = c.o.emoji; if (c.o.style) b.style = c.o.style; if (c.o.action) b.action = c.o.action; if (c.o.when) b.when = c.o.when; if (c.o.claimstate) b.claimState = c.o.claimstate; if (c.o.text !== undefined) b.text = c.o.text; if (c.o.url !== undefined) b.url = c.o.url; if (c.o.role) b.roles = [c.o.role.id];
    if (b.action === 'link' && !/^https?:\/\//i.test(b.url || '')) deny('The link action needs a url starting with https://'); if (b.action === 'message' && !b.text) deny('The message action needs text.'); if (!b.label && !b.emoji) deny('A button needs a label or an emoji.'); return b; };
  if (op === 'add') { if (list.length >= 25) deny('Discord allows at most 25 buttons.'); if (!c.o.action) deny('Choose an action.'); let id = slug(c.o.label || c.o.action).slice(0, 30); while (list.some(b => b.id === id)) id += '-' + rid().slice(0, 2);
    const b = apply(btn(id, c.o.label || '', c.o.emoji || '', c.o.style || (['close', 'delete'].includes(c.o.action) ? 'Danger' : 'Secondary'), c.o.action, c.o.when || (['reopen', 'delete', 'transcript'].includes(c.o.action) ? 'closed' : 'open'), c.o.claimstate || 'any')); list.push(b); save(list); return { text: `✅ Button \`${id}\` added to ${scope}.` }; }
  const idx = list.findIndex(b => b.id === String(c.o.id || '').toLowerCase()); if (idx < 0) deny('Button not found. Use `/ticket buttons list`.');
  if (op === 'remove') { const [b] = list.splice(idx, 1); save(list); return { text: `🗑️ Button \`${b.id}\` removed from ${scope}.${b.action === 'close' ? ' Tickets can still be closed with `/ticket close`.' : ''}` }; }
  if (op === 'move') { if (!c.o.position) deny('Give a position.'); const [b] = list.splice(idx, 1); list.splice(Math.min(c.o.position - 1, list.length), 0, b); save(list); return { text: `↕️ Moved \`${b.id}\` to position ${Math.min(c.o.position, list.length)}.` }; }
  apply(list[idx]); save(list); return { text: `✅ Button \`${list[idx].id}\` updated in ${scope}.` }; });
C('categories', 'Manage ticket categories', [o('op', 's', 'What to do', { req: 1, choices: ['list', 'add', 'edit', 'remove'] }), o('name', 's', 'Category name or id', { ac: 'cats' }), o('rename', 's', 'New name', { max: 80 }), o('emoji', 's', 'Emoji'), o('description', 's', 'Description', { max: 100 }), o('style', 's', 'Button color', { choices: STYLES }),
  o('parent', 'c', 'Discord category for the tickets'), o('role', 'r', 'Support role'), o('role_action', 's', 'Add or remove the role', { choices: ['add', 'remove'] }), o('max', 'i', 'Max open tickets per user', { min: 0, max: 100 }), o('format', 's', 'Channel name format, e.g. {type}-{number}'), o('panel', 's', 'Panel it belongs to', { ac: 'panels' }),
  o('enabled', 'b', 'Enable / disable'), o('question', 's', 'Add a question to the form', { max: 45 })], 'admin', async c => {
  const g = c.g, op = c.o.op; if (op === 'list') return info('🗂️ Categories', store.categories.all(g.id).map(x => `**${x.id}.** ${x.emoji || ''} ${x.name} — panel ${x.panel_id || '—'} • max ${x.maxPerUser ?? 'global'} • ${(x.roles || []).map(r => `<@&${r}>`).join(' ') || 'global staff'} ${x.enabled === false ? '• ⛔ disabled' : ''}`).join('\n') || 'No categories.');
  let cat = c.o.name ? findCat(g.id, c.o.name) : null;
  if (op === 'add') { if (!c.o.name) deny('Give a name.'); if (cat) deny('That category exists.'); cat = { ...clone(CATEGORY), guild_id: g.id, name: c.o.name, label: c.o.name, questions: [], roles: [] }; } else if (!cat) deny('Category not found.');
  if (op === 'remove') { store.categories.remove(cat.id); if (cat.panel_id) await publishPanel(c.client, cat.panel_id).catch(() => { }); return { text: `🗑️ Category **${cat.name}** removed.` }; }
  if (c.o.rename) { cat.name = c.o.rename; cat.label = c.o.rename; } if (c.o.emoji !== undefined) cat.emoji = c.o.emoji; if (c.o.description !== undefined) cat.description = c.o.description; if (c.o.style) cat.style = c.o.style; if (c.o.parent) cat.parentId = c.o.parent.id; if (c.o.max !== undefined) cat.maxPerUser = c.o.max;
  if (c.o.format !== undefined) cat.channelName = c.o.format; if (c.o.enabled !== undefined) cat.enabled = c.o.enabled; if (c.o.panel) { const p = findPanel(g.id, c.o.panel); if (!p) deny('Panel not found.'); cat.panel_id = p.id; }
  if (c.o.role) cat.roles = c.o.role_action === 'remove' ? (cat.roles || []).filter(r => r !== c.o.role.id) : uniq([...(cat.roles || []), c.o.role.id]);
  if (c.o.question) { if ((cat.questions || []).length >= 5) deny('Discord forms allow at most 5 questions.'); cat.questions = [...(cat.questions || []), { label: c.o.question, style: 'paragraph', required: true, placeholder: '', kind: 'text' }]; }
  const saved = store.categories.save(cat); if (saved.panel_id) await publishPanel(c.client, saved.panel_id).catch(() => { }); return { text: `✅ Category **${saved.name}** ${op === 'add' ? 'created' : 'updated'}. Edit forms, embeds and buttons in more detail in the dashboard.` }; });
C('logs', 'Configure logging', [o('event', 's', 'Which log', { req: 1, choices: ['all', ...LOG_EVENTS] }), o('channel', 'c', 'Channel for this log'), o('enabled', 'b', 'Turn this log on/off')], 'admin', c => {
  const g = c.g, ev = c.o.event; if (!c.o.channel && c.o.enabled === undefined) { const s = S(g.id); return info('📜 Logging', `Default channel: ${s.logChannelId ? `<#${s.logChannelId}>` : '—'}\n` + LOG_EVENTS.map(e => `${s.logging.enabled[e] === false ? '❌' : '✅'} **${e}** → ${s.logging.channels[e] ? `<#${s.logging.channels[e]}>` : '*default*'}`).join('\n')); }
  const patch = { logging: { channels: {}, enabled: {} } }; if (ev === 'all') { if (c.o.channel) patch.logChannelId = c.o.channel.id; if (c.o.enabled !== undefined) for (const e of LOG_EVENTS) patch.logging.enabled[e] = c.o.enabled; }
  else { if (c.o.channel) patch.logging.channels[ev] = c.o.channel.id; if (c.o.enabled !== undefined) patch.logging.enabled[ev] = c.o.enabled; } store.settings.set(g.id, patch); return { text: `✅ Logging updated for **${ev}**.` }; });
C('permissions', 'Configure permissions', [o('op', 's', 'What to do', { req: 1, choices: ['view', 'staff_role_add', 'staff_role_remove', 'admin_role_add', 'admin_role_remove', 'allow', 'deny'] }), o('role', 'r', 'Role'), o('action', 's', 'Ticket action', { choices: ACTIONS }), o('subject', 's', 'Who', { choices: ['creator', 'staff', 'admin'] })], 'admin', c => {
  const g = c.g, s = S(g.id), op = c.o.op; if (op === 'view') return info('🔐 Permissions', [`**Staff roles:** ${s.staffRoles.map(r => `<@&${r}>`).join(' ') || '—'}`, `**Admin roles:** ${s.adminRoles.map(r => `<@&${r}>`).join(' ') || '—'}`, '', ...ACTIONS.map(a => `**${a}:** ${(s.perms[a] || []).join(', ') || 'nobody (admins only)'}`)].join('\n'));
  if (op.endsWith('_add') || op.endsWith('_remove')) { if (!c.o.role) deny('Choose a role.'); const key = op.startsWith('staff') ? 'staffRoles' : 'adminRoles', cur = s[key]; store.settings.set(g.id, { [key]: op.endsWith('_add') ? uniq([...cur, c.o.role.id]) : cur.filter(r => r !== c.o.role.id) }); return { text: `✅ ${key} updated.` }; }
  if (!c.o.action || !c.o.subject) deny('Choose an action and a subject.'); const cur = s.perms[c.o.action] || []; store.settings.set(g.id, { perms: { [c.o.action]: op === 'allow' ? uniq([...cur, c.o.subject]) : cur.filter(x => x !== c.o.subject) } }); return { text: `✅ **${c.o.action}**: ${op === 'allow' ? 'allowed' : 'denied'} for **${c.o.subject}**.` }; });

// ----- slash builder (generated from the table above) -----
function addOpt(sb, x) {
  const set = ob => { ob.setName(x.n).setDescription(clip(x.d, 100)).setRequired(!!x.req); return ob; };
  if (x.t === 's') return sb.addStringOption(ob => { set(ob); if (x.max) ob.setMaxLength(x.max); if (x.choices) ob.addChoices(...x.choices.map(v => ({ name: v, value: v }))); else if (x.ac) ob.setAutocomplete(true); return ob; });
  if (x.t === 'i') return sb.addIntegerOption(ob => { set(ob); if (x.min !== undefined) ob.setMinValue(x.min); if (x.max !== undefined) ob.setMaxValue(x.max); return ob; });
  if (x.t === 'b') return sb.addBooleanOption(set); if (x.t === 'u') return sb.addUserOption(set); if (x.t === 'r') return sb.addRoleOption(set);
  return sb.addChannelOption(ob => { set(ob); if (x.n === 'parent') ob.addChannelTypes(ChannelType.GuildCategory); else ob.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement); return ob; });
}
function buildSlash() {
  const b = new SlashCommandBuilder().setName(NAME).setDescription('Advanced ticket system'), sorted = c => [...c.opts].sort((a, z) => !!z.req - !!a.req), mk = (sb, c) => { sb.setName(c.path.at(-1)).setDescription(clip(c.d, 100)); sorted(c).forEach(x => addOpt(sb, x)); return sb; };
  for (const c of CMDS.filter(c => c.path.length === 1)) b.addSubcommand(sb => mk(sb, c));
  for (const [gname, [gdesc]] of Object.entries(GROUPS)) b.addSubcommandGroup(gb => { gb.setName(gname).setDescription(gdesc); for (const c of CMDS.filter(c => c.path[0] === gname && c.path.length === 2)) gb.addSubcommand(sb => mk(sb, c)); return gb; });
  return b;
}
const slashData = buildSlash();
// ----- permission gate + shared runner -----
function gate(c, cmd) {
  const m = c.member; if (!m) deny('Servers only.');
  if (cmd.perm === 'admin' && !isAdmin(m)) deny('❌ Only ticket admins (Administrator permission or an admin role) can use this.');
  if (cmd.perm === 'staff' && !isStaffAnywhere(m)) deny(S(c.g.id).messages.noPermText);
}
async function execute(c, cmd) { gate(c, cmd); return cmd.run(c); }
async function autocomplete(i) {
  const f = i.options.getFocused(true), v = String(f.value || '').toLowerCase(), g = i.guild, opt = CMDS.find(c => c.path.join(' ') === [i.options.getSubcommandGroup(false), i.options.getSubcommand()].filter(Boolean).join(' '))?.opts.find(x => x.n === f.name); let list = [];
  const kind = opt?.ac, s = S(g.id);
  if (kind === 'panels') list = store.panels.all(g.id).map(p => [p.name, String(p.id)]); else if (kind === 'cats') list = store.categories.all(g.id).map(x => [x.name, String(x.id)]); else if (kind === 'levels') list = s.promotion.levels.map(l => [`${l.name} (${l.required})`, l.id]);
  else if (kind === 'cfgkeys') list = Object.keys(CFG).map(k => [k, k]); else if (kind === 'buttons') { const cat = i.options.getString('category') ? findCat(g.id, i.options.getString('category')) : null; list = buttonSet(cat, s).map(b => [`${b.label || b.action} (${b.id})`, b.id]); }
  return i.respond(list.filter(([n]) => n.toLowerCase().includes(v)).slice(0, 25).map(([name, value]) => ({ name: clip(name, 100), value: clip(value, 100) }))).catch(() => { });
}
// ----- slash dispatch -----
async function runSlash(i) {
  const grp = i.options.getSubcommandGroup(false), sub = i.options.getSubcommand(), key = [grp, sub].filter(Boolean).join(' '), cmd = CMDS.find(c => c.path.join(' ') === key); if (!cmd) return i.reply({ content: '❌ Unknown command.', flags: EPH });
  await i.deferReply({ flags: EPH });
  const c = { slash: true, i, client: i.client, g: i.guild, member: i.member, channel: i.channel, user: i.user, o: {} };
  for (const x of cmd.opts) { const n = x.n; c.o[n] = x.t === 's' ? i.options.getString(n) : x.t === 'i' ? i.options.getInteger(n) : x.t === 'b' ? i.options.getBoolean(n) : x.t === 'u' ? i.options.getUser(n) : x.t === 'r' ? i.options.getRole(n) : i.options.getChannel(n); if (c.o[n] === null) delete c.o[n]; }
  try { await send(i, await execute(c, cmd)); }
  catch (e) { if (e instanceof Deny) return send(i, { text: e.message }); console.error('Command error:', key, e); return send(i, { text: '❌ ' + friendly(e) }); }
}
// ----- prefix dispatch -----
const tokenize = s => (s.match(/[\w]+="[^"]*"|"[^"]*"|\S+/g) || []);
const unq = s => String(s).replace(/^"|"$/g, '');
const usage = (prefix, cmd) => `Usage: \`${prefix}${NAME} ${cmd.path.join(' ')}${cmd.opts.map(x => x.req ? ` <${x.n}>` : ` [${x.n}]`).join('')}\``;
async function parsePrefixArgs(m, cmd, toks, prefix) {
  const named = {}, pos = [], names = new Set(cmd.opts.map(x => x.n));
  for (const t of toks) { const mm = t.match(/^(\w+)="?([^"]*)"?$/); if (mm && names.has(mm[1])) named[mm[1]] = mm[2]; else pos.push(t); }
  const out = {}; let pi = 0;
  for (const x of cmd.opts) { let raw = named[x.n]; if (raw === undefined) { if (pi >= pos.length) continue; raw = x.rest ? pos.slice(pi).map(unq).join(' ') : unq(pos[pi]); pi = x.rest ? pos.length : pi + 1; }
    const id = String(raw).replace(/[<@&#!>]/g, '');
    if (x.t === 's') { if (x.choices) { const v = x.choices.find(z => z.toLowerCase() === String(raw).toLowerCase()); if (!v) deny(`\`${x.n}\` must be one of: ${x.choices.join(', ')}`); out[x.n] = v; } else out[x.n] = x.max ? raw.slice(0, x.max) : raw; }
    else if (x.t === 'i') { const n = parseInt(raw, 10); if (!Number.isFinite(n)) deny(`\`${x.n}\` must be a number.`); out[x.n] = n; } else if (x.t === 'b') out[x.n] = parseBool(raw);
    else if (x.t === 'u') { const u = await m.client.users.fetch(id).catch(() => null); if (!u) deny(`I could not find the user for \`${x.n}\` (mention them or paste their ID).`); out[x.n] = u; }
    else if (x.t === 'r') { const r = m.guild.roles.cache.get(id) || m.guild.roles.cache.find(z => z.name.toLowerCase() === String(raw).toLowerCase()); if (!r) deny(`I could not find the role for \`${x.n}\`.`); out[x.n] = r; }
    else { const c2 = m.guild.channels.cache.get(id); if (!c2) deny(`I could not find the channel for \`${x.n}\`.`); out[x.n] = c2; } }
  for (const x of cmd.opts) if (x.req && out[x.n] === undefined) deny(usage(prefix, cmd)); return out;
}
function prefixesFor(gid) { const s = S(gid), p = [s.prefix || '!']; if (s.useBotPrefix) { try { const bp = require(path.join(process.cwd(), 'lib', 'db')).get(gid)?.prefix; if (bp) p.push(bp); } catch { } } return p; }
async function executePrefix(m) {
  if (!m.guild || m.author.bot || !m.content) return false; const s = S(m.guild.id); if (!s.features.prefixCommands) return false;
  const pre = prefixesFor(m.guild.id).find(p => m.content.toLowerCase().startsWith((p + NAME).toLowerCase()) || m.content.toLowerCase().startsWith((p + 'ticket').toLowerCase())); if (!pre) return false;
  const body = m.content.slice(pre.length), name = body.split(/\s/)[0].toLowerCase(); if (name !== NAME && name !== 'ticket') return false;
  const toks = tokenize(body.slice(name.length).trim()), reply = o2 => m.reply({ ...o2, content: o2.text ?? o2.content, allowedMentions: o2.allowedMentions || { repliedUser: false, parse: [] } }).catch(() => m.channel.send({ ...o2, content: o2.text ?? o2.content, allowedMentions: { parse: [] } }).catch(() => { }));
  m.member ??= await m.guild.members.fetch(m.author.id).catch(() => null);
  try {
    let path_; const first = (toks[0] || '').toLowerCase();
    if (GROUPS[first]) { const sub = (toks[1] || '').toLowerCase(), has = CMDS.some(c => c.path[0] === first && c.path[1] === sub); path_ = has ? [first, sub] : [first, GROUPS[first][1]]; toks.splice(0, has ? 2 : 1); } else { path_ = [first]; toks.splice(0, 1); }
    const cmd = CMDS.find(c => c.path.join(' ') === path_.join(' ')); if (!cmd) { await reply({ embeds: info('🎫 Ticket commands', [...new Set(CMDS.map(c => c.path.length === 2 ? `${c.path[0]} …` : c.path[0]))].map(x => `\`${pre}${NAME} ${x}\``).join('\n')).embeds }); return true; }
    const c = { slash: false, m, client: m.client, g: m.guild, member: m.member, channel: m.channel, user: m.author, o: {} };
    gate(c, cmd); c.o = await parsePrefixArgs(m, cmd, toks, pre); const res = await cmd.run(c); if (res) await reply(res);
  } catch (e) { if (e instanceof Deny) await reply({ text: e.message }); else { console.error('Prefix command error:', e); await reply({ text: '❌ ' + friendly(e) }); } }
  return true;
}


// ───────────────────────────────────────────── 10. BOT WIRING (uses YOUR existing client — never creates another one) ─────────────────────────────────────────────
function backfill(client) { // migrates data from the old single-server version: every old row is assigned to the server it belongs to
  const primary = process.env.GUILD_ID && client.guilds.cache.has(process.env.GUILD_ID) ? process.env.GUILD_ID : client.guilds.cache.first()?.id; if (!primary) return;
  const gOf = (chId, def) => client.channels.cache.get(chId)?.guildId || def;
  for (const r of raw.prepare('SELECT id, channel_id FROM panels WHERE guild_id IS NULL').all()) raw.prepare('UPDATE panels SET guild_id = ? WHERE id = ?').run(gOf(r.channel_id, primary), r.id);
  for (const r of raw.prepare('SELECT c.id, p.guild_id g FROM categories c LEFT JOIN panels p ON p.id = c.panel_id WHERE c.guild_id IS NULL').all()) raw.prepare('UPDATE categories SET guild_id = ? WHERE id = ?').run(r.g || primary, r.id);
  for (const r of raw.prepare('SELECT id, channel_id FROM tickets WHERE guild_id IS NULL').all()) raw.prepare('UPDATE tickets SET guild_id = ? WHERE id = ?').run(gOf(r.channel_id, primary), r.id);
  raw.prepare('UPDATE events SET guild_id = ? WHERE guild_id IS NULL').run(primary);
  if (!store.settings.has(primary)) { const l = store.settings.legacy(); if (l) store.settings.save(primary, l); }
  raw.exec('INSERT OR IGNORE INTO ticket_staff(ticket_id, guild_id, user_id, claimed, claimed_at, managed_at) SELECT id, guild_id, claimed_by, 1, claimed_at, claimed_at FROM tickets WHERE claimed_by IS NOT NULL AND guild_id IS NOT NULL');
}
async function applyBranding(client, g) {
  const s = S(g.id), st = ['online', 'idle', 'dnd', 'invisible'].includes(s.presenceStatus) ? s.presenceStatus : 'online', ty = ActivityType[s.presenceType] ?? ActivityType.Custom, txt = String(s.presence || '').replace(/\{members\}/gi, g.memberCount).replace(/\{server\}/gi, g.name).trim().slice(0, 128);
  if (txt || st !== 'online') client.user.setPresence({ status: st, activities: txt ? [ty === ActivityType.Custom ? { name: 'Custom Status', type: ty, state: txt } : { name: txt, type: ty }] : client.user.presence.activities.map(a => ({ name: a.name, type: a.type, state: a.state ?? undefined })) });
  if (s.botNickname) await g.members.me?.setNickname(s.botNickname).catch(() => { });
}
async function registerCommands(client) { // adds ONLY our command to each server (never overwrites your other commands)
  const json = slashData.toJSON();
  for (const g of client.guilds.cache.values()) { try { const have = await g.commands.fetch(), same = have.find(c => c.name === NAME); if (!same) await g.commands.create(json); else await g.commands.edit(same.id, json); } catch (e) { console.error(`Ticket command registration failed in ${g.name}:`, e.message); } }
}
async function handleInteraction(i) { // the ONE centralized router: slash, autocomplete, buttons, select menus, user menus, modals
  if (!i.guild) { if (i.isButton() && i.customId.startsWith('tt:rt:')) { await handleRating(i).catch(e => console.error('Rating error:', e)); return true; } return false; }
  try {
    if (i.isChatInputCommand() && i.commandName === NAME) { await runSlash(i); return true; }
    if (i.isAutocomplete() && i.commandName === NAME) { await autocomplete(i); return true; }
    if ((i.isButton() || i.isStringSelectMenu() || i.isUserSelectMenu() || i.isModalSubmit()) && i.customId.startsWith('tt:')) { await route(i); return true; }
  } catch (e) { console.error('Ticket interaction error:', e); const o2 = { content: '❌ Something went wrong.', flags: EPH }; (i.deferred || i.replied ? i.followUp(o2) : i.reply(o2)).catch(() => { }); return true; }
  return false;
}
function registerEvents(client) { // safe to call many times: listeners are only added once
  if (client.__ticketEvents) return; client.__ticketEvents = true;
  const init = async () => {
    console.log(`✅ Ticket system ready as ${client.user.tag} (${client.guilds.cache.size} server(s))`);
    for (const g of client.guilds.cache.values()) { await g.channels.fetch().catch(() => { }); await g.roles.fetch().catch(() => { }); await g.emojis.fetch().catch(() => { }); }
    try { backfill(client); } catch (e) { console.error('Ticket data migration failed:', e); }
    setTimeout(() => registerCommands(client), 10000); // after your own bot has registered its commands
    for (const g of client.guilds.cache.values()) applyBranding(client, g).catch(() => { });
    startAutoClose(client); startLeaderboardTimer(client);
    const lastRef = new Map(); setInterval(async () => { for (const g of client.guilds.cache.values()) for (const p of store.panels.all(g.id)) { if (p.mode !== 'sections' || !p.statusOn || !p.message_id) continue; if (Date.now() - (lastRef.get(p.id) || 0) < Math.max(1, Number(p.refreshMinutes) || 5) * 60000 - 5000) continue; lastRef.set(p.id, Date.now()); await publishPanel(client, p.id).catch(e => console.error('Panel refresh failed:', e.message)); } }, 60000).unref();
  };
  if (client.isReady()) init(); else client.once(Events.ClientReady, init);
  client.on(Events.ShardReady, () => setTimeout(() => { for (const g of client.guilds.cache.values()) applyBranding(client, g).catch(() => { }); }, 3000));
  client.on(Events.GuildCreate, g => setTimeout(() => registerCommands(client), 3000));
  client.on(Events.InteractionCreate, i => { handleInteraction(i); });
  client.on(Events.MessageCreate, async m => { if (!m.guildId || m.author.bot) return; try { if (await executePrefix(m)) return; trackMessage(m); } catch (e) { console.error('Ticket message handler error:', e); } });
  client.on(Events.ChannelDelete, c => { const t = store.tickets.byChannel(c.id); if (t && t.status !== 'deleted') store.tickets.update(t.id, { status: 'deleted', closed_at: t.closed_at || Date.now() }); });
}
// what the website can ask the bot to do
function makeApi(client) {
  const guild = gid => client.guilds.cache.get(String(gid));
  const ticketEnv_ = (gid, id, userId) => { const t = store.tickets.byId(id); if (!t || t.guild_id !== String(gid)) throw new Error('Ticket not found'); const g = guild(gid), channel = g?.channels.cache.get(t.channel_id); if (!channel) throw new Error('The ticket channel no longer exists'); return { g, channel, t, cat: store.categories.get(t.category_id), force: true, userId }; };
  const api = {
    client, guild,
    guilds: () => [...client.guilds.cache.values()],
    async info(gid) { const g = guild(gid); if (!g) return null;
      return { id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), botName: client.user.username, botTag: client.user.tag, features: { components: cardsOk() },
        channels: [...g.channels.cache.values()].filter(c => [0, 4, 5].includes(c.type)).sort((a, b) => a.rawPosition - b.rawPosition).map(c => ({ id: c.id, name: c.name, type: c.type })),
        roles: [...g.roles.cache.values()].filter(r => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position).map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
        emojis: [...g.emojis.cache.values()].map(e => ({ id: e.id, name: e.name, animated: e.animated, url: e.imageURL({ size: 64 }), code: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` })) }; },
    async isDashboardUser(gid, userId) { const m = await guild(gid)?.members.fetch(userId).catch(() => null); return !!m && (m.permissions.has(P.Administrator) || m.permissions.has(P.ManageGuild) || isAdmin(m)); },
    async userName(id) { const u = await client.users.fetch(id).catch(() => null); return u ? { id, name: u.username, avatar: u.displayAvatarURL({ size: 32 }) } : { id, name: id, avatar: '' }; },
    applyBranding: gid => { const g = guild(gid); return g ? applyBranding(client, g) : null; },
    publishPanel: (id, o2) => publishPanel(client, id, o2), unpublishPanel: id => unpublishPanel(client, id),
    async ticketAction(gid, id, action, userId, arg) { const env = ticketEnv_(gid, id, userId), A = tickets;
      if (action === 'close') return A.close(env, arg || 'Closed from the dashboard'); if (action === 'reopen') return A.reopen(env); if (action === 'delete') return A.remove_ticket(env); if (action === 'say') return A.say(env, arg); if (action === 'claim') return A.claim(env); if (action === 'unclaim') return A.unclaim(env); throw new Error('Unknown action'); },
    async transcript(gid, id) { const env = ticketEnv_(gid, id), tr = await TR.generate(env.channel, env.t, S(gid).transcript); store.tickets.update(id, { transcript: tr.name }); return tr; },
    publishLeaderboard: (gid, channelId) => publishLb(guild(gid), channelId), updateLeaderboard: gid => updateLb(guild(gid)), leaderboardRows: async (gid, period) => lbData(guild(gid), period, 50),
    async staffList(gid) { const g = guild(gid), s = S(gid), seen = new Map(store.staff.board(gid, s, 'alltime', false).map(r => [r.id, r])), out = [];
      for (const r of seen.values()) { const m = g.members.cache.get(r.id) || await g.members.fetch(r.id).catch(() => null), st = userStats(g, r.id, m), reg = store.staff.get(gid, r.id);
        out.push({ id: r.id, name: m?.displayName || (await api.userName(r.id)).name, avatar: m?.displayAvatarURL({ size: 64 }) || '', ...r, per: st.per, rank: st.rank, level: st.current?.name || '', next: st.next ? `${st.next.name} (${st.remaining} to go)` : '', avgResponse: st.avgResponse, avgResolution: st.avgResolution, registered: !!reg && !reg.removed }); }
      return out; },
    async staffOp(gid, uid, op, arg, by) { const g = guild(gid); if (!g) throw new Error('Server not found');
      if (op === 'add') return store.staff.register(gid, uid); if (op === 'remove') return store.staff.remove(gid, uid); if (op === 'reset') return store.staff.reset(gid, uid);
      const m = await g.members.fetch(uid).catch(() => null), role = g.roles.cache.get(arg); if (!m || !role) throw new Error('Member or role not found');
      try { if (op === 'promote') await manualPromote(g, m, role, by || 'dashboard'); else if (op === 'demote') await manualDemote(g, m, role, by || 'dashboard'); } catch (e) { throw new Error(e.message); } },
    async recheckPromotions(gid) { const g = guild(gid); let n = 0; for (const r of store.staff.board(gid, S(gid), 'alltime', false)) { const x = await checkPromotion(g, r.id).catch(() => null); if (x && !x.had) n++; } lbSchedule(g); return n; },
    scheduleLeaderboard: gid => { const g = guild(gid); if (g) lbSchedule(g); },
  };
  return api;
}
let ATTACHED = null;
function attach(client, opts = {}) {
  if (client.__ticketApi) return client.__ticketApi; registerEvents(client); const api = makeApi(client); client.__ticketApi = api; ATTACHED = api;
  if (!process.env.TICKET_NO_WEB && opts.web !== false) startWeb(api); return api;
}


// ───────────────────────────────────────────── 11. WEB DASHBOARD SERVER (built-in http; shares the port with website.js /admin) ─────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
const SUBJECTS = ['creator', 'staff', 'admin'];
const snow = s => (/^\d{15,22}$/.test(String(s)) ? String(s) : ''), hexc = s => (/^#[0-9a-f]{6}$/i.test(String(s)) ? String(s) : '#5865F2'), str = (s, n = 4000) => String(s ?? '').slice(0, n);
function conform(def, val) { // keeps only known keys with the right type
  if (Array.isArray(def)) return Array.isArray(val) ? val.filter(x => typeof x === 'string').slice(0, 200) : def;
  if (def && typeof def === 'object') { const r = {}; for (const k of Object.keys(def)) r[k] = conform(def[k], val?.[k]); return r; }
  if (typeof def === 'number') { const n = Number(val); return Number.isFinite(n) ? Math.min(Math.max(n, -1e6), 1e15) : def; }
  if (typeof def === 'boolean') return typeof val === 'boolean' ? val : def; return val == null ? def : str(val);
}
const cleanEmbed = e => ({ title: str(e?.title, 256), description: str(e?.description, 4000), color: hexc(e?.color), image: str(e?.image, 300), thumbnail: str(e?.thumbnail, 300), footer: str(e?.footer, 2048), footerIcon: str(e?.footerIcon, 300), author: str(e?.author, 256), authorIcon: str(e?.authorIcon, 300), timestamp: !!e?.timestamp,
  fields: (Array.isArray(e?.fields) ? e.fields : []).slice(0, 10).map(f => ({ name: str(f?.name, 256), value: str(f?.value, 1024), inline: !!f?.inline })).filter(f => f.name || f.value) });
function cleanButtons(a) {
  const seen = new Set(); return (Array.isArray(a) ? a : []).slice(0, 25).map(x => { let id = String(x?.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || slug(x?.label || x?.action || 'btn').slice(0, 30); while (seen.has(id)) id += '-' + rid().slice(0, 2); seen.add(id);
    return { id, label: str(x?.label, 80), emoji: str(x?.emoji, 80), style: STYLES.includes(x?.style) ? x.style : 'Secondary', action: BTN_ACTIONS.includes(x?.action) ? x.action : 'message', when: ['open', 'closed', 'always'].includes(x?.when) ? x.when : 'open', claimState: ['any', 'claimed', 'unclaimed'].includes(x?.claimState) ? x.claimState : 'any',
      subjects: (Array.isArray(x?.subjects) ? x.subjects : []).filter(v => SUBJECTS.includes(v)), roles: (Array.isArray(x?.roles) ? x.roles : []).map(snow).filter(Boolean), text: str(x?.text, 1500), url: /^https?:\/\/\S{1,500}$/i.test(x?.url || '') ? x.url : '' }; }).filter(b => b.label || b.emoji);
}
function cleanSettings(b, old) {
  const s = conform(SETTINGS, b), ids = a => (Array.isArray(a) ? a : []).map(snow).filter(Boolean);
  for (const k of ['logChannelId', 'transcriptChannelId', 'closedCategoryId']) s[k] = snow(b?.[k]); s.staffRoles = ids(b?.staffRoles); s.adminRoles = ids(b?.adminRoles); s.prefix = str(b?.prefix, 5).replace(/\s/g, '') || '!';
  s.transcript.format = s.transcript.format === 'txt' ? 'txt' : 'html'; s.numbering.pad = Math.min(Math.max(Math.round(s.numbering.pad), 1), 8); s.numbering.start = Math.max(Math.round(s.numbering.start), 1);
  s.autoClose.hours = Math.min(Math.max(Math.round(s.autoClose.hours), 0), 720); s.closeBehavior.deleteDelay = Math.min(Math.max(Math.round(s.closeBehavior.deleteDelay), 0), 120); s.maxPerUser = Math.min(Math.max(Math.round(s.maxPerUser), 0), 100); s.cooldownSeconds = Math.min(Math.max(Math.round(s.cooldownSeconds), 0), 3600);
  s.stats.weekStartsOn = Math.min(Math.max(Math.round(s.stats.weekStartsOn), 0), 6); s.stats.utcOffsetMinutes = Math.min(Math.max(Math.round(Number(b?.stats?.utcOffsetMinutes) || 0), -720), 840);
  for (const a of ACTIONS) s.perms[a] = (Array.isArray(b?.perms?.[a]) ? b.perms[a] : s.perms[a]).filter(x => SUBJECTS.includes(x));
  for (const k of ['welcome', 'confirm', 'closed', 'reopened', 'claimed', 'unclaimed', 'transcript', 'promotion']) s.messages[k] = cleanEmbed(b?.messages?.[k]);
  for (const e of LOG_EVENTS) { s.logging.channels[e] = snow(b?.logging?.channels?.[e]); s.logging.enabled[e] = b?.logging?.enabled?.[e] !== false && !!(b?.logging?.enabled?.[e] ?? true); }
  s.buttons = Array.isArray(b?.buttons) ? cleanButtons(b.buttons) : old.buttons;
  const L = s.leaderboard, ob = b?.leaderboard || {}; L.channelId = snow(ob.channelId); L.style = ob.style === 'embed' ? 'embed' : 'cards'; L.period = ['weekly', 'monthly', 'alltime'].includes(ob.period) ? ob.period : 'alltime'; L.color = hexc(ob.color); L.top = Math.min(Math.max(Math.round(L.top) || 10, 1), 15); L.intervalMinutes = Math.min(Math.max(Math.round(L.intervalMinutes) || 10, 1), 1440);
  for (const k of ['messageId', 'messageChannelId', 'messageStyle', 'resetAt']) L[k] = old.leaderboard[k]; // server-managed
  const R = s.promotion, pb = b?.promotion || {}; R.announceChannelId = snow(pb.announceChannelId); R.creditMode = ['claimer', 'closer', 'claimer_closer', 'participants'].includes(pb.creditMode) ? pb.creditMode : 'claimer';
  R.minStaffMessages = Math.min(Math.max(Math.round(R.minStaffMessages), 0), 1000); R.minAgeMinutes = Math.min(Math.max(Math.round(R.minAgeMinutes), 0), 10080);
  const seen = new Set(); R.levels = (Array.isArray(pb.levels) ? pb.levels : []).slice(0, 50).map(l => { let id = /^[\w-]{4,24}$/.test(l?.id || '') ? l.id : rid(); while (seen.has(id)) id = rid(); seen.add(id); return { id, name: str(l?.name, 60) || 'Level', roleId: snow(l?.roleId), required: Math.min(Math.max(Math.round(Number(l?.required)) || 1, 1), 100000) }; });
  return s;
}
function cleanPanel(b, gid) {
  return { id: b.id ? Number(b.id) : undefined, guild_id: gid, name: str(b.name || 'Panel', 100), channel_id: snow(b.channel_id) || null, mode: ['select', 'sections'].includes(b.mode) ? b.mode : 'buttons', placeholder: str(b.placeholder, 150), perRow: Math.min(Math.max(Number(b.perRow) || 5, 1), 5), embed: cleanEmbed(b.embed), imagePos: b.imagePos === 'top' ? 'top' : 'bottom',
    blocks: (Array.isArray(b.blocks) ? b.blocks : []).slice(0, 5).map(x => ({ emoji: str(x?.emoji, 64), title: str(x?.title, 80), text: str(x?.text, 600) })).filter(x => x.title || x.text),
    buttons: (Array.isArray(b.buttons) ? b.buttons : []).slice(0, 5).map(x => ({ label: str(x?.label, 80), emoji: str(x?.emoji, 64), kind: ['link', 'text', 'tickets'].includes(x?.kind) ? x.kind : 'text', url: /^https?:\/\/\S{1,500}$/i.test(x?.url || '') ? x.url : '', text: str(x?.text, 1500) })).filter(x => x.label && (x.kind !== 'link' || x.url)),
    statusOn: !!b.statusOn, status: str(b.status, 1500), serverIp: str(b.serverIp, 100).replace(/[^\w.:-]/g, ''), refreshMinutes: Math.min(Math.max(Number(b.refreshMinutes) || 5, 1), 60) };
}
function cleanCategory(b, gid) {
  const perms = {}; for (const a of ACTIONS) if (Array.isArray(b.perms?.[a])) perms[a] = b.perms[a].filter(x => SUBJECTS.includes(x));
  const mx = b.maxPerUser === null || b.maxPerUser === '' || b.maxPerUser === undefined ? null : Math.min(Math.max(Math.round(Number(b.maxPerUser)) || 0, 0), 100), cd = b.cooldownSeconds === null || b.cooldownSeconds === '' || b.cooldownSeconds === undefined ? null : Math.min(Math.max(Math.round(Number(b.cooldownSeconds)) || 0, 0), 3600);
  return { id: b.id ? Number(b.id) : undefined, guild_id: gid, panel_id: b.panel_id ? Number(b.panel_id) : null, position: Number(b.position) || 0, name: str(b.name || 'Support', 80), label: str(b.label || b.name || 'Support', 80), emoji: str(b.emoji, 80), style: STYLES.includes(b.style) ? b.style : 'Primary', description: str(b.description, 100),
    roles: (b.roles || []).map(snow).filter(Boolean), maxPerUser: mx, cooldownSeconds: cd, channelName: str(b.channelName, 90), parentId: snow(b.parentId), enabled: b.enabled !== false, openingMessage: str(b.openingMessage, 1500), welcome: b.welcome ? cleanEmbed(b.welcome) : null, perms,
    buttons: Array.isArray(b.buttons) ? cleanButtons(b.buttons) : null, logChannelId: snow(b.logChannelId), transcriptChannelId: snow(b.transcriptChannelId),
    questions: (b.questions || []).slice(0, 5).map(x => ({ label: str(x.label || 'Question', 45), style: x.style === 'paragraph' ? 'paragraph' : 'short', required: x.required !== false, placeholder: str(x.placeholder, 100), kind: x.kind === 'ign' ? 'ign' : 'text' })) };
}
const json = (res, code, obj, headers = {}) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(b); };
const readBody = (req, max = 16 * 1024 * 1024) => new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > max) { no(new Error('Payload too large')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString()) : {}); } catch { no(new Error('Invalid JSON')); } }); req.on('error', no); });
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const b64 = s => Buffer.from(s).toString('base64url');

function startWeb(bot) {
  const secret = store.settings.secret(), PORT = Number(process.env.DASHBOARD_PORT || process.env.PORT) || 3000, PUBLIC = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, ''), secure = PUBLIC.startsWith('https');
  const sign = p => crypto.createHmac('sha256', secret).update(p).digest('base64url'), makeSession = u => { const p = b64(JSON.stringify({ ...u, exp: Date.now() + 7 * 864e5 })); return `${p}.${sign(p)}`; };
  const session = req => { const c = cookies(req).tsid; if (!c) return null; const [p, s] = c.split('.'); if (!p || !s) return null; const a = Buffer.from(sign(p)), b = Buffer.from(s); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; try { const u = JSON.parse(Buffer.from(p, 'base64url').toString()); return u.exp > Date.now() ? u : null; } catch { return null; } };
  const setCookie = (res, name, val, maxAge) => res.setHeader('Set-Cookie', [...[].concat(res.getHeader('Set-Cookie') || []), `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`]);
  const admins = () => (process.env.DASHBOARD_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean), names = new Map(), nameOf = async id => { if (!id || id === 'auto' || !/^\d+$/.test(id)) return { id, name: id === 'auto' ? 'Auto-close' : (id || '—'), avatar: '' }; if (!names.has(id)) names.set(id, await bot.userName(id)); return names.get(id); };
  const fails = new Map(), accessCache = new Map();
  const canAccess = async (me, gid) => { if (!bot.guild(gid)) return false; if (me.id === 'password' || admins().includes(me.id)) return true; const k = me.id + ':' + gid, c = accessCache.get(k); if (c && Date.now() - c.t < 60000) return c.v; const v = await bot.isDashboardUser(gid, me.id); accessCache.set(k, { t: Date.now(), v }); return v; };
  const routes = [], route = (m, p, h, open) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h, open });
  const resync = async ids => { let err = ''; for (const id of new Set(ids.filter(Boolean))) { const p = store.panels.get(id); if (p?.message_id) await bot.publishPanel(id).catch(e => { err = e.message; }); } return err; };
  const own = (gid, rec) => { if (!rec || rec.guild_id !== gid) throw new Error('Not found'); return rec; };

  route('GET', '/auth/config', (q, r) => json(r, 200, { oauth: !!(process.env.CLIENT_ID && process.env.CLIENT_SECRET), password: !!process.env.DASHBOARD_PASSWORD }), true);
  route('GET', '/auth/login', (q, r) => { if (!process.env.CLIENT_SECRET) return json(r, 400, { error: 'Discord login is not configured' }); const state = crypto.randomBytes(12).toString('hex'); setCookie(r, 'tstate', state, 600);
    const u = new URL('https://discord.com/oauth2/authorize'); Object.entries({ client_id: process.env.CLIENT_ID, redirect_uri: `${PUBLIC}/auth/callback`, response_type: 'code', scope: 'identify', state, prompt: 'none' }).forEach(([k, v]) => u.searchParams.set(k, v)); r.writeHead(302, { Location: u.toString(), 'Set-Cookie': r.getHeader('Set-Cookie') }); r.end(); }, true);
  route('GET', '/auth/callback', async (q, r, u) => { try {
    if (!u.searchParams.get('code') || u.searchParams.get('state') !== cookies(q).tstate) throw new Error('Login expired. Try again.');
    const tok = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: `${PUBLIC}/auth/callback` }) })).json();
    if (!tok.access_token) throw new Error('Discord refused the login.'); const me = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
    let ok = admins().includes(me.id); if (!ok) for (const g of bot.guilds()) if (await bot.isDashboardUser(g.id, me.id)) { ok = true; break; }
    if (!ok) throw new Error('Your Discord account is not allowed to use this dashboard (needs Administrator or Manage Server).');
    setCookie(r, 'tsid', makeSession({ id: me.id, name: me.global_name || me.username, avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : '' }), 7 * 86400); r.writeHead(302, { Location: '/', 'Set-Cookie': r.getHeader('Set-Cookie') }); r.end();
  } catch (e) { r.writeHead(302, { Location: '/?error=' + encodeURIComponent(e.message) }); r.end(); } }, true);
  route('POST', '/auth/password', async (q, r) => { const ip = q.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: 0 }; if (f.n >= 5 && Date.now() - f.t < 600000) return json(r, 429, { error: 'Too many attempts. Wait 10 minutes.' });
    const body = await readBody(q, 4096), pw = process.env.DASHBOARD_PASSWORD || '', a = Buffer.from(String(body.password || '')), b = Buffer.from(pw);
    if (!pw || a.length !== b.length || !crypto.timingSafeEqual(a, b)) { fails.set(ip, { n: f.n + 1, t: Date.now() }); return json(r, 401, { error: 'Wrong password' }); }
    fails.delete(ip); setCookie(r, 'tsid', makeSession({ id: 'password', name: 'Admin', avatar: '' }), 7 * 86400); json(r, 200, { ok: true }, { 'Set-Cookie': r.getHeader('Set-Cookie') }); }, true);
  route('POST', '/auth/logout', (q, r) => { setCookie(r, 'tsid', '', 0); json(r, 200, { ok: true }, { 'Set-Cookie': r.getHeader('Set-Cookie') }); }, true);

  // ----- data (every route receives the selected server id: gid) -----
  route('GET', '/api/bootstrap', async (q, r, u, p, me, gid) => { const gl = []; for (const g of bot.guilds()) if (await canAccess(me, g.id)) gl.push({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) });
    json(r, 200, { me, guilds: gl, gid, guild: await bot.info(gid), settings: store.settings.get(gid), defaults: { settings: SETTINGS, panel: PANEL, category: CATEGORY, question: QUESTION, embed: mkEmbed(), button: btn('new', 'New button', '', 'Secondary', 'claim', 'open') },
      panels: store.panels.all(gid), categories: store.categories.all(gid), actions: ACTIONS, btnActions: BTN_ACTIONS, logEvents: LOG_EVENTS }); });
  route('PUT', '/api/settings', async (q, r, u, p, me, gid) => { const old = store.settings.get(gid), s = cleanSettings(await readBody(q), old); store.settings.save(gid, s); await bot.applyBranding(gid)?.catch?.(() => { }); bot.scheduleLeaderboard(gid); json(r, 200, { settings: store.settings.get(gid) }); });
  route('POST', '/api/reset/:section', (q, r, u, p, me, gid) => { try { const keep = p.section === 'leaderboard' ? { ...store.settings.get(gid).leaderboard } : null; store.settings.reset(gid, p.section); if (keep) store.settings.set(gid, { leaderboard: { channelId: keep.channelId, messageId: keep.messageId, messageChannelId: keep.messageChannelId, messageStyle: keep.messageStyle } }); json(r, 200, { settings: store.settings.get(gid) }); } catch (e) { json(r, 400, { error: e.message }); } });
  route('GET', '/api/stats', async (q, r, u, p, me, gid) => { const s = store.tickets.stats(gid), days = Array.from({ length: 14 }, (_, n) => { const d = new Date(Date.now() - (13 - n) * 864e5); d.setHours(0, 0, 0, 0); return { t: d.getTime(), n: 0 }; });
    for (const t of s.perDay) { const d = [...days].reverse().find(x => t >= x.t); if (d) d.n++; } delete s.perDay;
    const staff = await Promise.all(store.staff.board(gid, S(gid), 'monthly', false).slice(0, 10).map(async x => ({ ...(await nameOf(x.id)), handled: x.managed, open: x.resolved })));
    const events = await Promise.all(store.events.recent(gid, 20).map(async e => ({ ...e, user: await nameOf(e.user_id) }))); json(r, 200, { ...s, days, staff, events }); });
  route('GET', '/api/tickets', async (q, r, u, p, me, gid) => { const list = store.tickets.list({ gid, status: u.searchParams.get('status') || 'all', limit: 200 }); json(r, 200, await Promise.all(list.map(async t => ({ ...t, creator: await nameOf(t.user_id), claimer: t.claimed_by ? await nameOf(t.claimed_by) : null })))); });
  route('POST', '/api/tickets/:id/:action', async (q, r, u, p, me, gid) => { const body = await readBody(q, 8192);
    try { if (p.action === 'transcript') { const tr = await bot.transcript(gid, p.id); return json(r, 200, { url: `/transcripts/${tr.name}` }); }
      const res = await bot.ticketAction(gid, p.id, p.action, me.id === 'password' ? undefined : me.id, body.text); json(r, 200, { ok: true, text: res?.text || 'Done' }); } catch (e) { json(r, 400, { error: e.message }); } });
  route('POST', '/api/panels', async (q, r, u, p, me, gid) => json(r, 200, store.panels.save({ ...cleanPanel(await readBody(q), gid), id: undefined })));
  route('PUT', '/api/panels/:id', async (q, r, u, p, me, gid) => { own(gid, store.panels.get(p.id)); const sv = store.panels.save(cleanPanel({ ...(await readBody(q)), id: p.id }, gid)), syncError = await resync([sv.id]); json(r, 200, { ...store.panels.get(sv.id), ...(syncError && { syncError }) }); });
  route('DELETE', '/api/panels/:id', async (q, r, u, p, me, gid) => { own(gid, store.panels.get(p.id)); await bot.unpublishPanel(p.id).catch(() => { }); store.panels.remove(p.id); json(r, 200, { ok: true }); });
  route('POST', '/api/panels/:id/save', async (q, r, u, p, me, gid) => { const b = await readBody(q); if (p.id !== 'new') own(gid, store.panels.get(p.id));
    const sv = store.panels.save(cleanPanel({ ...(b.panel || {}), id: p.id === 'new' ? undefined : p.id }, gid)); for (const cid of (b.removed || [])) { const c = store.categories.get(cid); if (c?.guild_id === gid) store.categories.remove(c.id); }
    const cats = (b.categories || []).map((c, n) => { if (c.id) own(gid, store.categories.get(c.id)); return store.categories.save({ ...cleanCategory({ ...c, panel_id: sv.id, position: n }, gid), id: c.id ? Number(c.id) : undefined }); });
    let out = { panel: store.panels.get(sv.id), categories: cats, created: [] };
    if (b.publish || store.panels.get(sv.id).message_id) { try { out = { ...out, ...(await bot.publishPanel(sv.id, { ensure: !!b.publish })), panel: store.panels.get(sv.id) }; } catch (e) { out.syncError = e.message; } } json(r, 200, out); });
  route('POST', '/api/panels/:id/publish', async (q, r, u, p, me, gid) => { own(gid, store.panels.get(p.id)); try { json(r, 200, { ...(await bot.publishPanel(p.id, { ensure: true })), panel: store.panels.get(p.id) }); } catch (e) { json(r, 400, { error: e.message }); } });
  route('POST', '/api/categories', async (q, r, u, p, me, gid) => { const c = store.categories.save({ ...cleanCategory(await readBody(q), gid), id: undefined }), syncError = await resync([c.panel_id]); json(r, 200, { ...c, ...(syncError && { syncError }) }); });
  route('PUT', '/api/categories/:id', async (q, r, u, p, me, gid) => { const old = own(gid, store.categories.get(p.id)), c = store.categories.save(cleanCategory({ ...(await readBody(q)), id: p.id }, gid)), syncError = await resync([old.panel_id, c.panel_id]); json(r, 200, { ...c, ...(syncError && { syncError }) }); });
  route('DELETE', '/api/categories/:id', async (q, r, u, p, me, gid) => { const old = own(gid, store.categories.get(p.id)); store.categories.remove(p.id); const syncError = await resync([old.panel_id]); json(r, 200, { ok: true, ...(syncError && { syncError }) }); });
  // ----- leaderboard / staff / promotions -----
  route('GET', '/api/leaderboard', async (q, r, u, p, me, gid) => json(r, 200, { rows: await bot.leaderboardRows(gid, u.searchParams.get('period') || S(gid).leaderboard.period) }));
  route('POST', '/api/leaderboard/publish', async (q, r, u, p, me, gid) => { const b = await readBody(q, 4096); try { const m = await bot.publishLeaderboard(gid, snow(b.channel) || undefined); json(r, 200, { url: m.url, settings: store.settings.get(gid) }); } catch (e) { json(r, 400, { error: e.message }); } });
  route('POST', '/api/leaderboard/update', async (q, r, u, p, me, gid) => { try { await bot.updateLeaderboard(gid); json(r, 200, { ok: true }); } catch (e) { json(r, 400, { error: e.message }); } });
  route('POST', '/api/leaderboard/reset', async (q, r, u, p, me, gid) => { store.settings.set(gid, { leaderboard: { resetAt: Date.now() } }); bot.updateLeaderboard(gid)?.catch?.(() => { }); json(r, 200, { settings: store.settings.get(gid) }); });
  route('GET', '/api/staff', async (q, r, u, p, me, gid) => json(r, 200, { staff: await bot.staffList(gid), history: await Promise.all(store.promo.recent(gid, 30).map(async h => ({ ...h, user: await nameOf(h.user_id), by: h.by_user ? await nameOf(h.by_user) : null }))) }));
  route('POST', '/api/staff/:id/:op', async (q, r, u, p, me, gid) => { const b = await readBody(q, 4096); try { await bot.staffOp(gid, snow(p.id), p.op, snow(b.role), me.id === 'password' ? 'dashboard' : me.id); bot.scheduleLeaderboard(gid); json(r, 200, { ok: true }); } catch (e) { json(r, 400, { error: e.message }); } });
  route('POST', '/api/staff', async (q, r, u, p, me, gid) => { const b = await readBody(q, 4096), id = snow(b.id); if (!id) return json(r, 400, { error: 'Paste a valid Discord user ID.' }); store.staff.register(gid, id); bot.scheduleLeaderboard(gid); json(r, 200, { ok: true }); });
  route('POST', '/api/promotion/recheck', async (q, r, u, p, me, gid) => json(r, 200, { promoted: await bot.recheckPromotions(gid) }));
  route('POST', '/api/upload', async (q, r) => { const b = await readBody(q), m = String(b.data || '').match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/); if (!m) return json(r, 400, { error: 'Only png, jpg, gif or webp images.' });
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 8 * 1024 * 1024) return json(r, 400, { error: 'Image is too large (max 8 MB).' }); const name = crypto.randomBytes(8).toString('hex') + '.' + m[1].replace('jpeg', 'jpg'); fs.writeFileSync(path.join(DATA, 'uploads', name), buf); json(r, 200, { value: `upload:${name}`, url: `/uploads/${name}` }); });
  route('GET', '/api/uploads', (q, r) => json(r, 200, fs.readdirSync(path.join(DATA, 'uploads')).filter(f => /\.(png|jpg|gif|webp)$/.test(f)).slice(-60).reverse().map(f => ({ value: `upload:${f}`, url: `/uploads/${f}` }))));

  const file = (res, p, auth) => { if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': auth ? 'no-store' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', ...(path.extname(p) === '.html' && auth ? { 'Content-Security-Policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline'" } : {}) }); fs.createReadStream(p).pipe(res); };
  global.__TICKET_HTTP = true; global.__ticketStats = () => store.tickets.allStats(); // lets website.js share this port (/admin) and show ticket stats
  const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket Dashboard</title><link rel="stylesheet" href="/style.css"><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎫</text></svg>"></head><body><div id="app"></div><div id="toasts"></div><script src="/app.js"></script></body></html>`;
  const server = http.createServer(async (req, res) => {
    try {
      if (global.__EXTRA_HTTP && await global.__EXTRA_HTTP(req, res)) return;
      const u = new URL(req.url, PUBLIC), pn = decodeURIComponent(u.pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') { const og = req.headers.origin; if (og && new URL(og).host !== req.headers.host && new URL(og).host !== new URL(PUBLIC).host) return json(res, 403, { error: 'Bad origin' }); }
      for (const rt of routes) { if (rt.m !== req.method) continue; const m = pn.match(rt.re); if (!m) continue; const me = session(req); if (!rt.open && !me) return json(res, 401, { error: 'Not logged in' });
        let gid = null; if (pn.startsWith('/api/')) { gid = u.searchParams.get('g') || ''; if (!gid || !(await canAccess(me, gid))) { gid = null; for (const g of bot.guilds()) if (await canAccess(me, g.id)) { gid = g.id; break; } } if (!gid) return json(res, 403, { error: 'No server available. Is the bot online and are you an admin there?' }); if (u.searchParams.get('g') && u.searchParams.get('g') !== gid) return json(res, 403, { error: 'No access to that server.' }); }
        return await rt.h(req, res, u, m.groups || {}, me, gid); }
      if (pn.startsWith('/uploads/')) return file(res, path.join(DATA, 'uploads', path.basename(pn)), false);
      if (pn.startsWith('/transcripts/')) { const me = session(req); if (!me) { res.writeHead(401); return res.end('Login required'); } const mg = path.basename(pn).match(/^ticket-(\d+)-/); if (mg && !(await canAccess(me, mg[1]))) { res.writeHead(403); return res.end('No access'); } return file(res, path.join(DATA, 'transcripts', path.basename(pn)), true); }
      if (pn === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(`(${DASH.toString()})();`); }
      if (pn === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(DASH_CSS); }
      if (pn === '/' || pn === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(PAGE); }
      res.writeHead(404); return res.end('Not found');
    } catch (e) { console.error('Web error:', e.message); if (!res.headersSent) json(res, e.message === 'Not found' ? 404 : 500, { error: e.message }); else res.end(); }
  });
  server.on('error', e => console.error(`❌ Dashboard could not start on port ${PORT}: ${e.message}. If your bot already uses this port, set DASHBOARD_PORT.`));
  server.listen(PORT, () => console.log(`🌐 Ticket dashboard: ${PUBLIC}  (port ${PORT})`)); return server;
}

// ───────────────────────────────────────────── 11b. DASHBOARD FRONT-END (served to the browser; plain JavaScript) ─────────────────────────────────────────────
function DASH() {
/* Ticket dashboard — vanilla JS single page app. Everything is saved to the bot's database through /api. */
const $ = (s, el = document) => el.querySelector(s);
function h(tag, a, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(a || {})) { if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat(9)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
async function api(method, url, body) {
  if (GID && url.startsWith('/api/')) url += (url.includes('?') ? '&' : '?') + 'g=' + encodeURIComponent(GID);
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (r.status === 401 && !url.startsWith('/auth') && S) { location.reload(); throw new Error('Logged out'); } if (!r.ok) throw new Error(d.error || 'Request failed'); if (d.syncError) toast('Saved, but the Discord message was not updated: ' + d.syncError, true); return d;
}
function toast(msg, bad) { const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); $('#toasts').append(t); setTimeout(() => t.remove(), 4200); }
async function busy(btn, fn) { const t = btn.textContent; btn.disabled = true; btn.textContent = '…'; try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = t; } }

let S = null; // bootstrap state
let GID = ''; try { GID = localStorage.getItem('tgid') || ''; } catch { }
const chan = id => S.guild?.channels.find(c => c.id === id), role = id => S.guild?.roles.find(r => r.id === id);

// ---------- controls (each edits obj[key] directly) ----------
const field = (label, control, hint) => h('label', { class: 'f' }, h('span', {}, label), control, hint && h('div', { class: 'hint' }, hint));
const text = (o, k, { ph, rows, max, onc } = {}) => { const e = rows ? h('textarea', { rows, placeholder: ph || '', maxlength: max }) : h('input', { type: 'text', placeholder: ph || '', maxlength: max }); e.value = o[k] ?? ''; e.addEventListener('input', () => { o[k] = e.value; onc?.(); }); return e; };
const num = (o, k, { min = 0, max = 9999, onc, blank } = {}) => { const e = h('input', { type: 'number', min, max }); e.value = o[k] ?? ''; e.addEventListener('input', () => { o[k] = e.value === '' ? (blank ? null : 0) : Number(e.value); onc?.(); }); return e; };
const check = (o, k, label, onc) => { const e = h('input', { type: 'checkbox' }); e.checked = !!o[k]; e.addEventListener('change', () => { o[k] = e.checked; onc?.(); }); return h('label', { class: 'sw' }, e, label); };
const select = (o, k, opts, onc) => { const e = h('select', {}, opts.map(([v, l]) => h('option', { value: v }, l))); e.value = o[k] ?? ''; e.addEventListener('change', () => { o[k] = e.value; onc?.(); }); return e; };
const chanSel = (o, k, types = [0, 5], onc) => select(o, k, [['', '— none —'], ...S.guild.channels.filter(c => types.includes(c.type)).map(c => [c.id, (c.type === 4 ? '📁 ' : '# ') + c.name])], onc);
function roleMulti(o, k, onc) {
  o[k] = o[k] || []; const box = h('div', { class: 'chips' });
  const draw = () => { box.replaceChildren(...S.guild.roles.map(r => h('span', { class: 'chip' + (o[k].includes(r.id) ? ' on' : ''), onclick: () => { o[k] = o[k].includes(r.id) ? o[k].filter(x => x !== r.id) : [...o[k], r.id]; draw(); onc?.(); } }, '@' + r.name))); if (!S.guild.roles.length) box.append('No roles found'); };
  draw(); return box;
}
// image: paste a link OR upload a file from your device
const imgUrl = v => (!v ? '' : String(v).startsWith('upload:') ? '/uploads/' + v.slice(7) : v);
function imgField(o, k, onc) {
  const prev = h('img', { class: 'thumb', style: 'display:none' }), inp = h('input', { type: 'text', placeholder: 'https://… or upload →' }), file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: 'display:none' });
  const sync = () => { inp.value = String(o[k] || '').startsWith('upload:') ? '📎 uploaded image' : (o[k] || ''); const u = imgUrl(o[k]); prev.style.display = u ? '' : 'none'; if (u) prev.src = u; };
  inp.addEventListener('input', () => { o[k] = inp.value.startsWith('📎') ? o[k] : inp.value.trim(); const u = imgUrl(o[k]); prev.style.display = u ? '' : 'none'; if (u) prev.src = u; onc?.(); });
  file.addEventListener('change', async () => { const f = file.files[0]; if (!f) return; if (f.size > 8 * 1024 * 1024) return toast('Image is larger than 8 MB', true);
    const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
    try { const d = await api('POST', '/api/upload', { data }); o[k] = d.value; sync(); onc?.(); toast('Image uploaded'); } catch (e) { toast(e.message, true); } file.value = ''; });
  sync(); return h('div', { class: 'row' }, prev, h('div', { class: 'grow' }, inp), h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, '⬆ Upload'), h('button', { class: 'btn sm', type: 'button', onclick: () => { o[k] = ''; sync(); onc?.(); } }, 'Clear'), file);
}
// emoji: unicode picker, server emojis, or a custom emoji ID
const UNI = { Smileys: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😎 🤩 🥳 😏 😌 🤔 🤨 😐 😑 🙄 😬 😴 😷 🤒 🤕 🤢 🥵 🥶 😱 😨 😢 😭 😤 😡 🤬 😈 💀 👻 🤖', Hands: '👍 👎 👌 ✌️ 🤞 🤟 🤘 👊 ✊ 🙌 👏 🙏 💪 👋 ✋ 🤝', Symbols: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ✨ ⭐ 🌟 🔥 💥 ⚡ ❗ ❓ ✅ ❌ ⚠️ 🔒 🔓 🔔 🔕 📌 🎫 📩 📨 🎟️ 💬 📝 📋 📣 🆘 🆗 🆕 🔰 ♻️ 💯', Objects: '🎮 🕹️ 🎧 🎁 🎉 🏆 🥇 👑 💎 💰 💳 🛒 🛡️ ⚔️ 🗡️ 🔧 🔨 ⚙️ 🧰 🔑 🗝️ 📦 📎 🔗 🧪 📚 💡 🔍 🛠️', Nature: '🌍 🌙 ☀️ ⛅ 🌈 🌊 🌲 🌵 🍀 🍎 🍕 🍔 🍰 ☕ 🐶 🐱 🐉 🦊 🐺 🦁 🐸 🐧' };
function emojiField(o, k, onc) {
  const inp = text(o, k, { ph: '🎫 or <:name:id> or emoji ID', onc }), pv = h('span', { style: 'font-size:20px;min-width:24px' });
  const show = () => { pv.replaceChildren(emojiNode(o[k])); }; inp.addEventListener('input', show); show();
  const pick = v => { o[k] = v; inp.value = v; show(); onc?.(); };
  const open = () => { const bg = h('div', { class: 'modalbg', onclick: ev => ev.target === bg && bg.remove() });
    const body = h('div', { class: 'modal' }, h('div', { class: 'row', style: 'margin-bottom:10px' }, h('b', { class: 'grow' }, 'Pick an emoji'), h('button', { class: 'btn sm', onclick: () => bg.remove() }, 'Close')));
    if (S.guild.emojis.length) body.append(h('div', { class: 'hint' }, 'This server'), h('div', { class: 'eg' }, S.guild.emojis.map(e => h('button', { title: e.name, onclick: () => { pick(e.code); bg.remove(); } }, h('img', { src: e.url })))));
    for (const [g, list] of Object.entries(UNI)) body.append(h('div', { class: 'hint', style: 'margin-top:10px' }, g), h('div', { class: 'eg' }, list.split(' ').map(e => h('button', { onclick: () => { pick(e); bg.remove(); } }, e))));
    body.append(h('div', { class: 'hint', style: 'margin-top:12px' }, 'Emoji from another server: paste its ID or <:name:id> in the box. The bot must share that server.')); bg.append(body); document.body.append(bg); };
  return h('div', { class: 'row' }, pv, h('div', { class: 'grow' }, inp), h('button', { class: 'btn sm', type: 'button', onclick: open }, '😀 Pick'));
}
function emojiNode(v) { v = String(v || '').trim(); const m = v.match(/^<(a?):(\w+):(\d+)>$/); if (m) return h('img', { class: 'ce', src: `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'png'}?size=32` }); if (/^\d{15,22}$/.test(v)) return h('img', { class: 'ce', src: `https://cdn.discordapp.com/emojis/${v}.png?size=32` }); return document.createTextNode(v); }

// ---------- discord-style preview ----------
const SAMPLE = { user: '@Steve', username: 'Steve', userid: '1234', server: () => S.guild?.name || 'My Server', category: 'General Support', type: 'general-support', number: '0042', ticket: '#0042', staff: '@Alex', closer: '@Alex', reason: 'Issue solved', brand: () => S.settings.brandName, channel: '#ticket-0042', date: 'Today', time: '12:00', timestamp: '2 minutes ago', ign: 'Steve123', max: '3', count: '3', answer1: 'Steve123', answer2: 'Example answer', answer3: '', answer4: '', answer5: '', ticket_id: '0042', staff_name: 'Alex', claimer: '@Alex', resolved_tickets: '42', claimed_tickets: '50', managed_tickets: '60', weekly: '5', monthly: '18', rank: '2', level: 'Support', next_level: 'Senior Support (18 to go)', remaining: '18', role: '@Support', messages: '24', period: 'all-time', updated: 'just now', seconds: '8' };
const fillv = s => String(s || '').replace(/\{(\w+)\}/g, (m, k) => { const v = SAMPLE[k.toLowerCase()]; return v === undefined ? m : typeof v === 'function' ? v() : v; });
function mdHtml(s) { return esc(fillv(s)).replace(/&lt;a?:(\w+):(\d+)&gt;/g, (m, n, id) => `<img class="ce" src="https://cdn.discordapp.com/emojis/${id}.png?size=32">`).replace(/&lt;t:\d+(:\w)?&gt;/g, '<span class="ment">time</span>').replace(/&lt;@&amp;?\d+&gt;|&lt;#\d+&gt;/g, '<span class="ment">@mention</span>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<u>$1</u>').replace(/\*([^*]+)\*/g, '<i>$1</i>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^&gt; (.*)$/gm, '<span style="border-left:3px solid #4e5058;padding-left:8px">$1</span>').replace(/(^|\s)(@\w+)/g, '$1<span class="ment">$2</span>'); }
function embedPrev(e) {
  const box = h('div', { class: 'embed', style: `border-left-color:${e.color || '#5865f2'}` }), inner = h('div', { class: 'in' });
  if (e.author || e.authorIcon) inner.append(h('div', { class: 'au' }, e.authorIcon && h('img', { src: imgUrl(e.authorIcon) }), h('span', { html: mdHtml(e.author) })));
  if (e.title) inner.append(h('div', { class: 'ti', html: mdHtml(e.title) })); if (e.description) inner.append(h('div', { class: 'ds', html: mdHtml(e.description) }));
  for (const f of e.fields || []) inner.append(h('div', { style: 'margin-top:6px' }, h('b', { html: mdHtml(f.name) }), h('div', { class: 'ds', html: mdHtml(f.value) })));
  if (e.image) inner.append(h('img', { class: 'im', src: imgUrl(e.image) }));
  if (e.footer || e.footerIcon || e.timestamp) inner.append(h('div', { class: 'ft' }, e.footerIcon && h('img', { src: imgUrl(e.footerIcon) }), h('span', {}, [fillv(e.footer), e.timestamp ? 'Today at 12:00' : ''].filter(Boolean).join(' • '))));
  box.append(inner); if (e.thumbnail) box.append(h('img', { class: 'th', src: imgUrl(e.thumbnail) })); return box;
}
const dcBox = (label, ...kids) => h('div', { class: 'dc' }, h('div', { class: 'lbl' }, label), ...kids);

// embed editor = form + live preview
function embedEditor(e, { label = 'Preview', extra } = {}) {
  const prev = h('div'), draw = () => prev.replaceChildren(dcBox(label, embedPrev(e), extra?.())), c = draw;
  const form = h('div', {}, h('div', { class: 'grid g2' }, field('Title', text(e, 'title', { ph: '{category} • {ticket}', max: 256, onc: c })), field('Color', (() => { const w = h('div', { class: 'row' }), p = h('input', { type: 'color', value: e.color || '#5865F2', style: 'width:46px;height:36px;border:0;background:none' }); p.addEventListener('input', () => { e.color = p.value.toUpperCase(); t.value = e.color; c(); }); const t = text(e, 'color', { ph: '#5865F2', onc: () => { if (/^#[0-9a-f]{6}$/i.test(e.color)) p.value = e.color; c(); } }); w.append(p, h('div', { class: 'grow' }, t)); return w; })())),
    field('Description', text(e, 'description', { rows: 5, max: 4000, onc: c }), 'Variables: {user} {username} {userid} {server} {category} {ticket} {ticket_id} {staff} {closer} {reason} {ign} {brand} {date} {time} {timestamp} {resolved_tickets} {rank} {level} {next_level} {messages} {answer1}…{answer5}'),
    h('div', { class: 'grid g2' }, field('Image', imgField(e, 'image', c)), field('Thumbnail', imgField(e, 'thumbnail', c))),
    h('div', { class: 'grid g2' }, field('Author name', text(e, 'author', { onc: c })), field('Author icon', imgField(e, 'authorIcon', c))),
    h('div', { class: 'grid g2' }, field('Footer text', text(e, 'footer', { onc: c })), field('Footer icon', imgField(e, 'footerIcon', c))), check(e, 'timestamp', 'Show timestamp', c), fieldsEditor(e, c));
  draw(); return { form, prev, redraw: draw };
}
const split = (form, prev) => h('div', { class: 'split' }, form, h('div', { class: 'sticky' }, prev));
const saveBar = (...btns) => h('div', { class: 'savebar' }, ...btns);
const Card = (title, sub, ...kids) => h('div', { class: 'card' }, h('h3', {}, title), sub && h('p', { class: 'sub' }, sub), ...kids);
const when = t => (t ? new Date(t).toLocaleString() : '—');
const ago = t => { if (!t) return '—'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
async function reload() { const d = await api('GET', '/api/bootstrap'); S = d; GID = d.gid; try { localStorage.setItem('tgid', GID); } catch { } }

// ---------- pages ----------
const pages = {};
pages.dashboard = async () => {
  const s = await api('GET', '/api/stats'), max = Math.max(1, ...s.days.map(d => d.n));
  const st = [['Total tickets', s.total], ['Open', s.open], ['Closed', s.closed], ['Claimed (open)', s.claimed], ['Resolved (counted)', s.resolved], ['Last 24h', s.today], ['Last 7 days', s.week]];
  return h('div', {}, h('div', { class: 'grid stats', style: 'margin-bottom:16px' }, st.map(([l, v]) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l)))),
    h('div', { class: 'grid g2' }, Card('Tickets, last 14 days', null, h('div', { class: 'bar' }, s.days.map(d => h('div', { style: `height:${Math.max(2, d.n / max * 100)}%`, 'data-t': `${new Date(d.t).toLocaleDateString()}: ${d.n}` })))),
      Card('By category', null, s.byCategory.length ? h('table', {}, s.byCategory.map(c => h('tr', {}, h('td', {}, c.name || '—'), h('td', {}, c.n)))) : 'No tickets yet')),
    h('div', { class: 'grid g2' }, Card('Top staff (this month)', null, s.staff.length ? h('table', {}, h('tr', {}, h('th', {}, 'Staff'), h('th', {}, 'Handled'), h('th', {}, 'Resolved')), s.staff.map(x => h('tr', {}, h('td', {}, x.avatar && h('img', { class: 'av', src: x.avatar }), x.name), h('td', {}, x.handled), h('td', {}, x.open)))) : 'Nobody has claimed a ticket yet'),
      Card('Recent activity', null, s.events.length ? h('ul', { class: 'act' }, s.events.map(e => h('li', {}, h('span', { class: 'pill' }, e.type), ' ', e.number != null ? '#' + String(e.number).padStart(4, '0') + ' ' : '', h('span', { class: 'hint' }, ago(e.ts) + ' • ' + (e.user?.name || ''))))) : 'Nothing yet')));
};

function panelPreview(p, cats) {
  if (p.mode === 'sections') {
    const ee = p.embed || {}, box = h('div', { class: 'embed', style: `border-left-color:${ee.color || '#5865f2'}` }), inner = h('div', { class: 'in' }), rule = 'border-top:1px solid #4e5058;margin-top:10px;padding-top:10px';
    const SV = { open_tickets: '0', staff_active: '2', avg_reply: '<1 min', players: '12', max_players: '300', server_ip: p.serverIp || 'play.example.net', server_status: '🟢 Online', updated: 'just now', server: 'Your Server' }, fillS = s => String(s || '').replace(/\{(\w+)\}/g, (m, k) => SV[k] ?? m);
    if (ee.image && p.imagePos === 'top') inner.append(h('img', { class: 'im', src: imgUrl(ee.image), style: 'margin:0 0 8px' }));
    if (ee.title) inner.append(h('div', { class: 'ti', html: mdHtml(fillS(ee.title)) })); if (ee.description) inner.append(h('div', { class: 'ds', html: mdHtml(fillS(ee.description)) }));
    for (const c of cats) inner.append(h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;' + rule }, h('div', {}, h('b', {}, emojiNode(c.emoji), ' ', c.label || c.name), c.description && h('div', { class: 'hint' }, c.description)), h('span', { class: 'dbtn ' + (c.style || 'Primary') }, emojiNode(c.emoji), 'Open')));
    for (const x of p.blocks || []) inner.append(h('div', { style: rule }, h('b', {}, emojiNode(x.emoji), ' ', fillS(x.title)), x.text && h('div', { class: 'hint' }, fillS(x.text))));
    if ((p.buttons || []).length) inner.append(h('div', { class: 'btns', style: 'margin-top:10px' }, p.buttons.map(x => h('span', { class: 'dbtn Secondary' }, emojiNode(x.emoji), x.label))));
    if (ee.image && p.imagePos !== 'top') inner.append(h('img', { class: 'im', src: imgUrl(ee.image) }));
    if (p.statusOn && p.status) inner.append(h('div', { style: rule }, h('div', { class: 'ds', html: mdHtml(fillS(p.status).replace(/^-# /gm, '')) })));
    if (ee.footer) inner.append(h('div', { class: 'hint', style: rule }, fillS(ee.footer)));
    box.append(inner); if (ee.thumbnail) box.append(h('img', { class: 'th', src: imgUrl(ee.thumbnail) })); if (!cats.length) return h('div', {}, box, h('div', { class: 'hint', style: 'margin-top:8px' }, 'No ticket types yet.')); return box; }
  const e = embedPrev(p.embed || {}), wrap = [e];
  if (p.mode === 'select') wrap.push(h('div', { class: 'sel' }, p.placeholder || 'Choose a ticket type', ' ▾'));
  else wrap.push(h('div', { class: 'btns' }, cats.map(c => h('span', { class: 'dbtn ' + (c.style || 'Primary') }, emojiNode(c.emoji), c.label || c.name))));
  if (!cats.length) wrap.push(h('div', { class: 'hint', style: 'margin-top:8px' }, 'No categories assigned yet. Add them under Categories.')); return h('div', {}, ...wrap);
}
// ---------- one-click ready-made panel (DynastySMP Support) ----------
// ---------- one-click ready-made panels ----------
const TEMPLATES = {
  dynasty: { label: 'DynastySMP style — 5 types, red', name: 'DynastySMP Support', embed: { title: '🏆 DynastySMP Support', description: 'Need a hand? Pick a category below and a staff member will be with you shortly.', color: '#E0393E', footer: 'Spam tickets or false reports may lead to a punishment.' }, cats: () => PRESETS },
  decay: { label: 'DecaySMP style — 6 types incl. Refunds', name: 'Support Panel (Decay style)', embed: { title: '🎟️ {server} Support', description: 'Choose a ticket type below. Reports and ban appeals are handled here.', color: '#D7403B', footer: '' },
    cats: () => [['General Support', '✅', 'Success', 'Get help with the server or your account.', PRESETS[0][4]], ['Player Reports', '⚠️', 'Danger', 'Report a player with clear evidence.', PRESETS[1][4]], ['Bug Reports', '🐞', 'Primary', 'Report a bug, exploit, or glitch.', PRESETS[2][4]], ['Claims & Perks', '🪙', 'Secondary', 'Ask about an existing claim or reward request.', PRESETS[3][4]], ['Ban Appeal', '⚖️', 'Secondary', 'Ask staff to review a ban decision.', PRESETS[4][4]],
      ['Refunds', '🔁', 'Primary', 'Request a refund through the existing review process.', [IGN, Q('Order / transaction ID', 'short', true, 'From your store receipt'), Q('Why are you requesting a refund?', 'paragraph', true, 'Explain what happened'), Q('Additional details', 'paragraph', false, 'Anything else staff should know?')]]] },
  mace: { label: 'MACE SMP style — banner, guidelines, buttons, live status', name: 'Support Panel (MACE style)', imagePos: 'top', embed: { title: '', description: '', color: '#8A2BE2', footer: '' }, statusOn: true, refreshMinutes: 5,
    blocks: [{ emoji: '🎫', title: 'Ticket Guidelines', text: 'Keep your ticket relevant, provide accurate details, and avoid unnecessary staff pings. Choose the correct category and include your Minecraft username.' }, { emoji: '❓', title: 'Need Quick Help?', text: 'Check the quick-help button below for tips before opening a ticket.' }, { emoji: '🛡️', title: 'Staff Availability', text: 'Staff availability can vary. Please allow the team time to respond.' }],
    buttons: [{ label: 'Need Quick Help?', emoji: '❓', kind: 'text', url: '', text: '**Quick help**\n• Read the server rules first\n• Include your Minecraft username\n• Pick the right category\n• Add screenshots or clips if you can' }, { label: 'Rules', emoji: '⭐', kind: 'text', url: '', text: 'Please read the server rules before opening a ticket. Breaking them can lead to a punishment.' }, { label: 'Your Tickets', emoji: '🎫', kind: 'tickets', url: '', text: '' }],
    status: '-# 🎫 {server} • SUPPORT STATUS • Updated {updated}\n**Staff active:** `{staff_active}` • **Avg reply:** `{avg_reply}` • **Open tickets:** `{open_tickets}`\n**Server:** `{server_ip}` • **Status:** `{players}/{max_players} players online`',
    cats: () => [['General Support', '🌐', 'Secondary', 'Get help with the server, account, technical issues, or general questions.', PRESETS[0][4]], ['Player Reports', '⚔️', 'Secondary', 'Report cheating, rule violations, abuse, or misconduct.', PRESETS[1][4]], ['Bug Reports', '🔧', 'Secondary', 'Report bugs, glitches, exploits, or unexpected behavior.', PRESETS[2][4]], ['Claims & Rewards', '🏆', 'Secondary', 'Claim rewards, perks, or report reward issues.', PRESETS[3][4]],
      ['Purchase Ticket', '💲', 'Secondary', 'Need help with a purchase, rank, or store issue?', [IGN, Q('What did you buy / need help with?', 'short', true, 'e.g. VIP rank'), Q('Order / transaction ID', 'short', false, 'From your store receipt'), Q('What is the problem?', 'paragraph', true, 'Explain what happened')]]] },
};
let QW = null;
function quickCard() {
  const W = QW ||= { tpl: 'dynasty', channel_id: (S.guild.channels.find(c => [0, 5].includes(c.type) && /ticket/i.test(c.name) && !/log|transcript/i.test(c.name)) || {}).id || '', prefix: 'DynastySMP • ', ip: '', logs: S.settings.transcriptChannelId || S.settings.logChannelId || (S.guild.channels.find(c => [0, 5].includes(c.type) && /ticket[-_ ]?logs?|transcripts?/i.test(c.name)) || {}).id || '' };
  const T = TEMPLATES[W.tpl] || TEMPLATES.dynasty, existing = S.panels.find(x => x.name === T.name);
  const applySettings = async () => { const s = clone(S.settings); let ch = false;
    if (W.prefix !== (s.parentPrefix || '')) { s.parentPrefix = W.prefix; ch = true; }
    if (W.logs && (s.transcriptChannelId !== W.logs || !s.logChannelId)) { s.transcriptChannelId = W.logs; s.logChannelId = s.logChannelId || W.logs; ch = true; }
    if (ch) { await api('PUT', '/api/settings', s); await reload(); } };
  const go = async () => {
    if (!W.channel_id) throw new Error('Choose the channel for the panel first.');
    await applySettings();
    const r = await api('POST', '/api/panels/new/save', { panel: { ...clone(S.defaults.panel), name: T.name, mode: 'sections', channel_id: W.channel_id, embed: { ...clone(S.defaults.embed), ...T.embed }, imagePos: T.imagePos || 'bottom', blocks: clone(T.blocks || []), buttons: clone(T.buttons || []), statusOn: !!T.statusOn, status: T.status || '', serverIp: W.ip, refreshMinutes: T.refreshMinutes || 5 },
      categories: T.cats().map(([name, emoji, style, description, questions]) => ({ ...clone(S.defaults.category), name, label: name, emoji, style, description, questions: clone(questions) })), removed: [], publish: true });
    await reload(); if (!r.syncError) toast(r.created?.length ? 'Panel published. Created Discord categories: ' + r.created.join(', ') : 'Panel published');
    const p = r.panel; location.hash = '#/panels/' + p.id; route();
  };
  const addForms = async () => {
    if (!confirm('This sets the default forms (IGN + problem questions) on this panel\'s ticket types and updates the panel in Discord. Your other settings stay. Continue?')) return;
    await applySettings();
    const cats = S.categories.filter(x => x.panel_id === existing.id).sort((x, y) => (x.position || 0) - (y.position || 0)).map(c => { const t = T.cats().find(x => x[0] === c.name); return t ? { ...clone(c), questions: clone(t[4]) } : clone(c); });
    const r = await api('POST', '/api/panels/' + existing.id + '/save', { panel: clone(existing), categories: cats, removed: [], publish: true });
    await reload(); toast('Forms added. Open a ticket from the panel to test it.'); route();
  };
  return Card('⚡ One-click ready-made panels', 'Pick a style, then create it in one tap. Everything stays editable afterwards (texts, colors, emojis, images, buttons, live status).',
    h('div', { class: 'grid g2' }, field('Panel style', select(W, 'tpl', Object.entries(TEMPLATES).map(([k, v]) => [k, v.label]), () => route())), field('Channel to post in', chanSel(W, 'channel_id', [0, 5]))),
    h('div', { class: 'grid g2' }, field('Discord category name prefix', text(W, 'prefix', { max: 20 }), 'Categories are created as "prefix + type". Existing ones with the same name are reused.'), field('Minecraft server address (optional)', text(W, 'ip', { max: 100, ph: 'play.example.net' }), 'Used by the live status line (players online). Leave empty to hide it.')),
    h('div', { class: 'grid g2' }, field('Logs & transcripts channel', chanSel(W, 'logs', [0, 5]), 'Transcripts and ticket logs are posted here, never inside the ticket.')),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn ok', onclick: e => busy(e.target, go) }, existing ? 'Create another copy' : 'Create & publish'), existing && h('button', { class: 'btn pri', onclick: e => busy(e.target, addForms) }, 'Add forms to my existing panel')));
}
pages.panels = async (id) => {
  if (id) return panelEditor(id === 'new' ? { ...clone(S.defaults.panel), name: 'New panel', channel_id: '' } : clone(S.panels.find(p => p.id == id)));
  return h('div', {}, quickCard(), h('div', { class: 'row', style: 'margin-bottom:14px' }, h('button', { class: 'btn pri', onclick: () => location.hash = '#/panels/new' }, '+ New panel')),
    S.panels.length ? h('div', { class: 'grid g2' }, S.panels.map(p => { const cats = S.categories.filter(c => c.panel_id === p.id); return Card(p.name, `${chan(p.channel_id) ? '#' + chan(p.channel_id).name : 'No channel'} • ${p.mode} • ${cats.length} categories • ${p.message_id ? '✅ published' : '⏳ not published'}`,
      panelPreview(p, cats), h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn pri sm', onclick: () => location.hash = '#/panels/' + p.id }, 'Edit'),
        h('button', { class: 'btn ok sm', onclick: e => busy(e.target, async () => { const r = await api('POST', `/api/panels/${p.id}/publish`); await reload(); toast(r.created?.length ? 'Published. Created Discord categories: ' + r.created.join(', ') : 'Panel published'); route(); }) }, p.message_id ? 'Update in Discord' : 'Publish'),
        h('button', { class: 'btn bad sm', onclick: async () => { if (!confirm('Delete this panel and its Discord message?')) return; await api('DELETE', '/api/panels/' + p.id); await reload(); route(); } }, 'Delete'))); })) : Card('No panels yet', 'Create your first ticket panel.'));
};
const Q = (label, style = 'short', required = true, placeholder = '', kind = 'text') => ({ label, style, required, placeholder, kind });
const IGN = Q('Minecraft IGN', 'short', true, 'Enter your Minecraft username...', 'ign');
// [name, emoji, button color, description, questions shown in the form before the ticket opens]
const PRESETS = [
  ['General Support', '✅', 'Success', 'Questions about the server, your account or anything else.', [IGN, Q('How can we help?', 'paragraph', true, 'Explain your issue or request...'), Q('Additional details', 'paragraph', false, 'Anything else staff should know?')]],
  ['Player Reports', '🚨', 'Danger', 'Report cheaters, griefers or rule breakers. Evidence required.', [IGN, Q('Player you are reporting (IGN)', 'short', true, 'Their Minecraft name'), Q('What did they do?', 'paragraph', true, 'What happened, where and when?'), Q('Evidence (video / screenshot links)', 'paragraph', true, 'Paste YouTube, Imgur or Medal links')]],
  ['Bug Reports', '⚠️', 'Primary', 'Found a bug, glitch or exploit? Let us know.', [IGN, Q('Short title of the bug', 'short', true, 'e.g. Chest duplicates items'), Q('Describe the bug', 'paragraph', true, 'What happens and what should happen?'), Q('Steps to reproduce', 'paragraph', false, '1. Go to... 2. Click...')]],
  ['Claims & Perks', '🎁', 'Secondary', 'Rewards, ranks and store perks you have not received.', [IGN, Q('What did you buy / what perk is missing?', 'short', true, 'e.g. VIP rank'), Q('Order / transaction ID', 'short', false, 'From your store receipt'), Q('What went wrong?', 'paragraph', true, 'Tell us what you expected and what you got')]],
  ['Ban Appeal', '📕', 'Secondary', 'Think a punishment was a mistake? Ask for a review.', [IGN, Q('Why were you banned / muted?', 'short', true, 'The reason you were given'), Q('Staff member or ban ID (if known)', 'short', false, ''), Q('Why should we remove your punishment?', 'paragraph', true, 'Be honest and explain your side')]],
];
function panelEditor(p) {
  // everything for one panel on ONE page: message, buttons (ticket types) and live preview. Save & publish also creates the Discord categories.
  const isNew = !p.id, removed = [], synced = new WeakSet();
  let list = isNew ? [] : S.categories.filter(c => c.panel_id === p.id).sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id).map(clone);
  const prevBox = h('div'), catBox = h('div'), redraw = () => prevBox.replaceChildren(dcBox('Panel preview', panelPreview(p, list)));
  const ed = embedEditor(p.embed, { label: 'Embed preview' }); const orig = ed.redraw; ed.redraw = () => { orig(); redraw(); };
  const emb = ed.form; emb.addEventListener('input', redraw); emb.addEventListener('change', redraw);
  const newCat = o => { const c = { ...clone(S.defaults.category), panel_id: p.id || null, ...o }; c.label = c.label || c.name; synced.add(c); return c; };
  const drawCats = () => {
    catBox.replaceChildren(h('div', {}, list.map((c, n) => {
      const hd = h('b'), setHd = () => hd.replaceChildren(`${n + 1}. `, emojiNode(c.emoji), ' ' + (c.label || c.name || 'Ticket type'));
      setHd();
      const mv = d => { const j = n + d; if (j < 0 || j >= list.length) return; [list[n], list[j]] = [list[j], list[n]]; drawCats(); };
      return h('div', { class: 'card', style: 'background:var(--bg3);margin-bottom:10px' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, hd, h('span', { class: 'row' },
          h('button', { class: 'btn sm', disabled: n === 0, onclick: () => mv(-1) }, '▲'), h('button', { class: 'btn sm', disabled: n === list.length - 1, onclick: () => mv(1) }, '▼'),
          c.id && h('button', { class: 'btn sm', onclick: () => { if (confirm('Open the full settings of this ticket type? Unsaved changes on this page will be lost.')) location.hash = '#/categories/' + c.id; } }, 'Questions & permissions'),
          h('button', { class: 'btn bad sm', onclick: () => { if (c.id && !confirm('Remove this ticket type? It is deleted when you press Save.')) return; if (c.id) removed.push(c.id); list.splice(n, 1); drawCats(); } }, 'Remove'))),
        h('div', { class: 'grid g2' }, field('Button label', text(c, 'label', { max: 80, onc: () => { if (synced.has(c)) c.name = c.label; setHd(); redraw(); } })), field('Emoji', emojiField(c, 'emoji', () => { setHd(); redraw(); }))),
        h('div', { class: 'grid g2' }, field('Button color', select(c, 'style', [['Primary', 'Blue'], ['Secondary', 'Gray'], ['Success', 'Green'], ['Danger', 'Red']], redraw)), field('Short description', text(c, 'description', { max: 100 }), 'Shown in the dropdown style.')),
        h('div', { class: 'grid g2' }, field('Name (also the Discord category name)', text(c, 'name', { max: 80, onc: () => synced.delete(c) }), 'Created automatically when you publish.'), field('Staff roles for this type', roleMulti(c, 'roles'))));
    }),
      list.length ? null : h('div', { class: 'hint', style: 'margin-bottom:10px' }, 'No ticket types yet. Tap a quick-add below.'),
      h('div', { class: 'chips', style: 'margin-bottom:10px' }, PRESETS.filter(x => !list.some(c => c.name === x[0])).map(([name, emoji, style, description, questions]) => h('span', { class: 'chip', onclick: () => { list.push(newCat({ name, label: name, emoji, style, description, questions: clone(questions) })); drawCats(); } }, emoji + ' ' + name))),
      h('button', { class: 'btn sm', onclick: () => { list.push(newCat({ name: 'New ticket type', label: 'New ticket type', emoji: '🎫', questions: [clone(IGN), Q('Describe your problem', 'paragraph', true, '')] })); drawCats(); } }, '+ Blank ticket type')));
    redraw();
  };

  p.blocks ||= []; p.buttons ||= []; p.imagePos ||= 'bottom'; p.refreshMinutes ||= 5; p.status ||= ''; p.serverIp ||= '';
  const blocksBox = h('div'), btnsBox = h('div');
  const drawBlocks = () => { blocksBox.replaceChildren(...p.blocks.map((b, n) => h('div', { class: 'card', style: 'background:var(--bg3);margin-bottom:10px' }, h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('b', {}, 'Block ' + (n + 1)), h('button', { class: 'btn bad sm', onclick: () => { p.blocks.splice(n, 1); drawBlocks(); redraw(); } }, 'Remove')), h('div', { class: 'grid g2' }, field('Emoji', emojiField(b, 'emoji', redraw)), field('Title', text(b, 'title', { max: 80, onc: redraw }))), field('Text', text(b, 'text', { rows: 3, max: 600, onc: redraw })))), p.blocks.length < 5 ? h('button', { class: 'btn sm', onclick: () => { p.blocks.push({ emoji: '', title: 'New block', text: '' }); drawBlocks(); redraw(); } }, '+ Add info block') : null); redraw(); };
  const drawBtns = () => { btnsBox.replaceChildren(...p.buttons.map((b, n) => h('div', { class: 'card', style: 'background:var(--bg3);margin-bottom:10px' }, h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('b', {}, 'Button ' + (n + 1)), h('button', { class: 'btn bad sm', onclick: () => { p.buttons.splice(n, 1); drawBtns(); } }, 'Remove')), h('div', { class: 'grid g2' }, field('Label', text(b, 'label', { max: 80, onc: redraw })), field('Emoji', emojiField(b, 'emoji', redraw))),
    field('What it does', select(b, 'kind', [['text', 'Shows a private message (tips, rules…)'], ['link', 'Opens a link'], ['tickets', 'Shows the user\'s open tickets']], drawBtns)), b.kind === 'link' ? field('Link (https://…)', text(b, 'url', { max: 500 })) : null, b.kind === 'text' ? field('Message', text(b, 'text', { rows: 4, max: 1500 })) : null)), p.buttons.length < 5 ? h('button', { class: 'btn sm', onclick: () => { p.buttons.push({ label: 'New button', emoji: '', kind: 'text', url: '', text: '' }); drawBtns(); } }, '+ Add button') : null); redraw(); };
  const sectionCards = () => { drawBlocks(); drawBtns(); return h('div', {},
    Card('Banner & info (rows style)', 'Used by the "Rows with an Open button" style. The large image is set in Panel message above.', field('Large image position', select(p, 'imagePos', [['bottom', 'Bottom (under the rows)'], ['top', 'Top (banner above everything)']], redraw)), h('div', { class: 'hint', style: 'margin:8px 0' }, 'Info blocks are texts without a button, such as guidelines or staff availability.'), blocksBox),
    Card('Buttons under the rows', 'Optional buttons such as Quick Help, Rules or Your Tickets.', btnsBox),
    Card('Live status footer', 'A small block at the bottom that updates by itself.', check(p, 'statusOn', 'Show the live status block', redraw), h('div', { class: 'grid g2', style: 'margin-top:10px' }, field('Minecraft server address', text(p, 'serverIp', { max: 100, ph: 'play.example.net', onc: redraw }), 'For players online. Java servers only.'), field('Refresh every (minutes)', num(p, 'refreshMinutes', { min: 1, max: 60 }))), field('Status text', text(p, 'status', { rows: 5, max: 1500, onc: redraw }), 'Variables: {updated} {open_tickets} {staff_active} {avg_reply} {players} {max_players} {server_ip} {server_status} {server}. Lines starting with -# are small text.'))); };
  const form = h('div', {}, Card('Panel settings', null, h('div', { class: 'grid g2' }, field('Panel name', text(p, 'name', { max: 100 })), field('Channel to post in', chanSel(p, 'channel_id', [0, 5]))),
    h('div', { class: 'grid g2' }, field('Style', select(p, 'mode', [['buttons', 'Buttons under the message'], ['sections', 'Rows with an Open button (like DynastySMP)'], ['select', 'Dropdown menu']], redraw)), field('Buttons per row', num(p, 'perRow', { min: 1, max: 5, onc: redraw }))), field('Dropdown placeholder', text(p, 'placeholder', { onc: redraw }))),
    Card('Panel message', 'Title, text, colors and pictures of the message that holds the buttons.', emb),
    sectionCards(),
    Card('Ticket types (buttons)', 'Add, edit, reorder and remove the buttons here. When you press Save & publish, the Discord category for each type is created automatically.', catBox));
  drawCats();
  const save = async publish => {
    const rm = [...removed], r = await api('POST', '/api/panels/' + (isNew ? 'new' : p.id) + '/save', { panel: p, categories: list.map(c => ({ ...c, maxPerUser: c.maxPerUser === '' ? null : c.maxPerUser })), removed: rm, publish });
    removed.length = 0; await reload();
    if (!r.syncError) toast(r.created?.length ? 'Saved & published. Created Discord categories: ' + r.created.join(', ') : publish || r.panel.message_id ? 'Saved & updated in Discord' : 'Saved');
    location.hash = '#/panels/' + r.panel.id; if (!isNew) route();
  };
  return h('div', {}, split(form, h('div', {}, ed.prev, h('div', { style: 'height:12px' }), prevBox)), saveBar(h('button', { class: 'btn', onclick: () => location.hash = '#/panels' }, 'Back'), !p.message_id && h('button', { class: 'btn pri', onclick: e => busy(e.target, () => save(false)) }, 'Save'), h('button', { class: 'btn ok', onclick: e => busy(e.target, () => save(true)) }, p.message_id ? 'Save & update Discord' : 'Save & publish')));
}

const PERM_LABEL = { claim: 'Claim', unclaim: 'Unclaim', close: 'Close', reopen: 'Reopen', delete: 'Delete', add: 'Add member', remove: 'Remove member', rename: 'Rename', transfer: 'Transfer', transcript: 'Transcript', say: 'Send as bot', info: 'View info', notify: 'Notify staff' };
function permMatrix(perms, { inherit } = {}) {
  const t = h('table', {}, h('tr', {}, h('th', {}, 'Action'), ['creator', 'staff', 'admin'].map(x => h('th', {}, x === 'creator' ? 'Ticket creator' : x === 'staff' ? 'Support staff' : 'Admin roles'))));
  for (const a of S.actions) t.append(h('tr', {}, h('td', {}, PERM_LABEL[a] || a), ['creator', 'staff', 'admin'].map(x => { const c = h('input', { type: 'checkbox' }); c.checked = (perms[a] || []).includes(x); c.addEventListener('change', () => { const s = new Set(perms[a] || []); c.checked ? s.add(x) : s.delete(x); perms[a] = [...s]; }); return h('td', {}, c); })));
  return t;
}
pages.categories = async (id, query) => {
  if (id) { const c = id === 'new' ? { ...clone(S.defaults.category), name: 'New category', label: 'New category', panel_id: Number(query.get('panel')) || (S.panels[0]?.id ?? null) } : clone(S.categories.find(x => x.id == id)); return catEditor(c); }
  return h('div', {}, h('div', { class: 'row', style: 'margin-bottom:14px' }, h('button', { class: 'btn pri', onclick: () => location.hash = '#/categories/new' }, '+ New category')),
    S.categories.length ? h('div', { class: 'grid g2' }, S.categories.map(c => { const p = S.panels.find(x => x.id === c.panel_id); return Card(h('span', {}, emojiNode(c.emoji), ' ', c.name), `${p ? 'Panel: ' + p.name : 'Not on a panel'} • max/user: ${c.maxPerUser ?? 'global'} • ${c.questions.length} questions`,
      h('div', { class: 'chips', style: 'margin-bottom:10px' }, (c.roles || []).map(r => h('span', { class: 'chip on' }, '@' + (role(r)?.name || 'deleted')))),
      h('div', { class: 'row' }, h('button', { class: 'btn pri sm', onclick: () => location.hash = '#/categories/' + c.id }, 'Edit'), h('button', { class: 'btn bad sm', onclick: async () => { if (!confirm('Delete this category?')) return; await api('DELETE', '/api/categories/' + c.id); await reload(); route(); } }, 'Delete'))); })) : Card('No categories yet', 'Create ticket types such as Support, Reports or Appeals.'));
};
function catEditor(c) {
  const isNew = !c.id; c.perms = c.perms || {}; c.questions = c.questions || []; let override = !!c.welcome; const wBox = h('div'), qBox = h('div'), permBox = h('div');
  const drawWelcome = () => { wBox.replaceChildren(); if (override) { c.welcome = c.welcome || clone(S.settings.messages.welcome); const ed = embedEditor(c.welcome, { label: 'Welcome preview' }); wBox.append(split(ed.form, ed.prev)); } else c.welcome = null; };
  const drawQ = () => { qBox.replaceChildren(...c.questions.map((q, n) => h('div', { class: 'card', style: 'background:var(--bg3)' }, h('div', { class: 'grid g2' }, field('Question', text(q, 'label', { max: 45 })), field('Placeholder', text(q, 'placeholder', { max: 100 }))),
    h('div', { class: 'row' }, select(q, 'style', [['short', 'Short answer'], ['paragraph', 'Paragraph']]), select(q, 'kind', [['text', 'Normal'], ['ign', 'Minecraft IGN (validated)']]), check(q, 'required', 'Required'), h('button', { class: 'btn bad sm', onclick: () => { c.questions.splice(n, 1); drawQ(); } }, 'Remove')))),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: c.questions.length >= 5, onclick: () => { c.questions.push({ ...clone(S.defaults.question), kind: c.questions.some(q => q.kind === 'ign') ? 'text' : 'ign', label: c.questions.some(q => q.kind === 'ign') ? 'Question' : 'Minecraft IGN' }); drawQ(); } }, '+ Add question'), h('span', { class: 'hint' }, 'Up to 5 questions (Discord limit).'))); };
  const drawPerm = () => { permBox.replaceChildren(); const on = Object.keys(c.perms).length > 0; const sw = check({ v: on }, 'v', 'Override global permissions for this category', () => { }); sw.querySelector('input').addEventListener('change', e => { c.perms = e.target.checked ? clone(S.settings.perms) : {}; drawPerm(); }); permBox.append(sw); if (on) permBox.append(permMatrix(c.perms)); };
  const ov = h('input', { type: 'checkbox' }); ov.checked = override; ov.addEventListener('change', () => { override = ov.checked; drawWelcome(); });
  const prevB = h('div'), redrawB = () => prevB.replaceChildren(dcBox('Button preview', h('div', { class: 'btns' }, h('span', { class: 'dbtn ' + c.style }, emojiNode(c.emoji), c.label || c.name))));
  const form = h('div', {}, Card('Category', 'How this ticket type looks on the panel.', h('div', { class: 'grid g2' }, field('Name', text(c, 'name', { max: 80, onc: redrawB })), field('Button / menu label', text(c, 'label', { max: 80, onc: redrawB }))),
    h('div', { class: 'grid g2' }, field('Emoji', emojiField(c, 'emoji', redrawB)), field('Button color', select(c, 'style', [['Primary', 'Blue'], ['Secondary', 'Gray'], ['Success', 'Green'], ['Danger', 'Red']], redrawB))),
    h('div', { class: 'grid g2' }, field('Menu description', text(c, 'description', { max: 100 }), 'Shown under the label when the panel is a dropdown.'), field('Panel', select(c, 'panel_id', [['', '— none —'], ...S.panels.map(p => [p.id, p.name])], () => { c.panel_id = c.panel_id ? Number(c.panel_id) : null; }))), prevB),
    Card('Staff & limits', null, field('Support roles for this category', roleMulti(c, 'roles'), 'These roles can see and handle tickets of this type (plus the global staff/admin roles).'),
      h('div', { class: 'grid g2' }, field('Max open tickets per user (this category)', num(c, 'maxPerUser', { min: 0, max: 100, blank: true }), 'Leave empty to use only the global limit. 0 = unlimited here.'),
        field('Channel name format', text(c, 'channelName', { ph: S.settings.channelName }), 'Variables: {type} {number} {username} {ign}. Empty = global format.'))),
    Card('Discord category & logs', null, h('div', { class: 'grid g2' }, field('Discord category for these tickets', chanSel(c, 'parentId', [4]), 'Empty = created automatically once and reused.'), field('Log channel', chanSel(c, 'logChannelId')), field('Transcript channel', chanSel(c, 'transcriptChannelId')))),
    Card('Questions (form shown before the ticket opens)', 'Ask for the Minecraft IGN, a reason, etc.', qBox),
    Card('Welcome message', 'Use the global welcome message or write a custom one for this category.', h('label', { class: 'sw' }, ov, 'Custom welcome message for this category'), wBox),
    Card('Permissions', 'Who may close, claim, reopen, delete… in this category.', permBox), Card('Ticket buttons', 'Different buttons for this category (claim, close, add member, transfer, notify staff…).', catButtons(c)), Card('Opening message & more', null, check(c, 'enabled', 'Category enabled (members can open it)'), field('Opening message (above the embed)', text(c, 'openingMessage', { rows: 2, max: 1500 }), 'Variables as in embeds.'), field('Cooldown override (seconds)', num(c, 'cooldownSeconds', { max: 3600, blank: true }), 'Empty = global cooldown.')));
  drawQ(); drawWelcome(); drawPerm(); redrawB();
  const save = async () => { c.maxPerUser = c.maxPerUser === '' ? null : c.maxPerUser; const d = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/categories' : '/api/categories/' + c.id, c); await reload(); toast('Saved'); location.hash = '#/categories/' + d.id; if (!isNew) route(); };
  return h('div', {}, form, saveBar(h('button', { class: 'btn', onclick: () => location.hash = '#/categories' }, 'Back'), h('button', { class: 'btn pri', onclick: e => busy(e.target, save) }, 'Save category')));
}

function settingsPage(sections) {
  const W = clone(S.settings);
  const resetBtn = (key, label) => h('button', { class: 'btn sm', onclick: async () => { if (!confirm(`Reset "${label}" to defaults?`)) return; try { await api('POST', '/api/reset/' + key); await reload(); toast('Reset'); route(); } catch (e) { toast(e.message, true); } } }, 'Reset ' + label);
  return h('div', {}, ...sections(W, resetBtn), saveBar(h('button', { class: 'btn', onclick: () => route() }, 'Discard changes'), h('button', { class: 'btn pri', onclick: e => busy(e.target, async () => { const d = await api('PUT', '/api/settings', W); S.settings = d.settings; toast('Saved. The bot uses it immediately.'); }) }, 'Save')));
}
pages.settings = async () => settingsPage((W, rb) => [
  generalCard(W),
  Card('Branding', 'Name and look of the bot in your server.', h('div', { class: 'grid g2' }, field('Brand name', text(W, 'brandName', { max: 60 }), 'Use {brand} in any message.'), field('Bot nickname in server', text(W, 'botNickname', { max: 32 }), 'Empty = unchanged.')), h('div', { class: 'grid g2' }, field('Bot status', select(W, 'presenceStatus', [['online', '🟢 Online'], ['idle', '🌙 Idle'], ['dnd', '⛔ Do Not Disturb'], ['invisible', '⚫ Invisible']])), field('Status type', select(W, 'presenceType', [['Custom', 'Custom text'], ['Playing', 'Playing …'], ['Watching', 'Watching …'], ['Listening', 'Listening to …'], ['Competing', 'Competing in …']]))),
    field('Status text', text(W, 'presence', { max: 128 }), 'Variables: {members} {server}. Empty = keep the bot\'s current text. Saved settings apply immediately.')),
  Card('Channels', null, h('div', { class: 'grid g3' }, field('Log channel', chanSel(W, 'logChannelId'), 'Ticket opened / claimed / closed…'), field('Transcript channel', chanSel(W, 'transcriptChannelId'), 'Empty = log channel'), field('Move closed tickets to', chanSel(W, 'closedCategoryId', [4]), 'Optional Discord category'))),
  Card('Tickets', null, h('div', { class: 'grid g3' }, field('Max open tickets per user', num(W, 'maxPerUser', { max: 100 }), '0 = unlimited. Categories can set their own limit.'), field('Channel name format', text(W, 'channelName'), '{type} {number} {username} {ign}'), field('Discord category prefix', text(W, 'parentPrefix', { max: 30 }))),
    h('div', { class: 'grid g3' }, field('First ticket number', num(W.numbering, 'start', { min: 1 })), field('Number padding (digits)', num(W.numbering, 'pad', { min: 1, max: 8 })), field('Delete delay (seconds)', num(W.closeBehavior, 'deleteDelay', { max: 120 }))),
    check(W, 'staffBypassLimit', 'Staff can bypass the ticket limit'), check(W, 'confirmClose', 'Ask for confirmation before closing'), check(W, 'showAnswers', 'Show form answers in the welcome message')),
  Card('When a ticket is closed', null, check(W.closeBehavior, 'creatorCanView', 'Creator keeps read access (cannot send messages)'), check(W.closeBehavior, 'renameClosed', 'Rename channel with a prefix'), field('Closed prefix', text(W.closeBehavior, 'closedPrefix', { max: 20 }))),
  Card('Transcripts', null, check(W.transcript, 'enabled', 'Save a transcript when a ticket closes'), check(W.transcript, 'sendToLog', 'Post transcript to the transcript/log channel'), check(W.transcript, 'dmCreator', 'DM the transcript to the ticket creator'),
    h('div', { class: 'grid g2' }, field('Format', select(W.transcript, 'format', [['html', 'HTML (looks like Discord)'], ['txt', 'Plain text']])), field('Max messages', num(W.transcript, 'limit', { min: 50, max: 10000 })))),
  Card('Automatic closing', null, field('Close tickets with no messages for (hours)', num(W.autoClose, 'hours', { max: 720 }), '0 = never.')),
  Card('Notifications', null, check(W.notifications, 'pingStaffOnOpen', 'Ping support roles when a ticket opens'), check(W.notifications, 'dmOnClose', 'DM the creator when their ticket closes'), field('Staff notify cooldown (minutes)', num(W.notifications, 'notifyCooldownMinutes', { max: 1440 }))),
  h('div', { class: 'row' }, rb('closeBehavior', 'close behavior'), rb('transcript', 'transcripts'), rb('notifications', 'notifications'))]);
pages.permissions = async () => settingsPage((W, rb) => [
  Card('Staff roles', 'Can see every ticket and use staff actions.', field('Support roles', roleMulti(W, 'staffRoles'))),
  Card('Administrator roles', 'Can do everything in tickets (Discord Administrators always can).', field('Admin roles', roleMulti(W, 'adminRoles'))),
  Card('Permission matrix', 'Choose who may do each action. The ticket creator can close their own ticket by default; they never need a staff role.', permMatrix(W.perms), h('div', { style: 'margin-top:12px' }, rb('perms', 'permissions')))]);
pages.embeds = async () => {
  const keys = [['welcome', 'Welcome'], ['confirm', 'Close confirmation'], ['closed', 'Ticket closed'], ['reopened', 'Reopened'], ['claimed', 'Claimed'], ['unclaimed', 'Unclaimed'], ['transcript', 'Transcript log'], ['promotion', 'Staff promotion']]; let cur = keys[0][0];
  return settingsPage((W, rb) => { const area = h('div'), tabs = h('div', { class: 'tabs' });
    const draw = () => { tabs.replaceChildren(...keys.map(([k, l]) => h('span', { class: 'tab' + (k === cur ? ' on' : ''), onclick: () => { cur = k; draw(); } }, l))); const ed = embedEditor(W.messages[cur], { label: 'Preview' }); area.replaceChildren(split(ed.form, ed.prev)); };
    draw(); return [Card('Messages', 'Every message the bot sends inside tickets. Supports variables, Discord timestamps, custom emoji and uploaded images.', tabs, area),
      Card('Text messages', null, field('Ticket limit reached', text(W.messages, 'limitText', { rows: 2 }), 'Variables: {max} {count}'), field('No permission', text(W.messages, 'noPermText', { rows: 2 })), field('Open cooldown', text(W.messages, 'cooldownText', { rows: 2 }), 'Variable: {seconds}'), field('System disabled', text(W.messages, 'disabledText', { rows: 2 })), rb('messages', 'all messages'))]; });
};
pages.tickets = async () => {
  let status = 'all'; const box = h('div');
  const load = async () => { const list = await api('GET', '/api/tickets?status=' + status);
    box.replaceChildren(list.length ? h('div', { style: 'overflow:auto' }, h('table', {}, h('tr', {}, ['#', 'Category', 'Creator', 'Status', 'Claimed by', 'Opened', ''].map(x => h('th', {}, x))), list.map(t => h('tr', {}, h('td', {}, String(t.number).padStart(4, '0')), h('td', {}, t.category_name), h('td', {}, t.creator.name), h('td', {}, h('span', { class: 'pill ' + t.status }, t.status)), h('td', {}, t.claimer?.name || '—'), h('td', {}, ago(t.created_at)),
      h('td', {}, h('div', { class: 'row' }, t.status !== 'deleted' && h('button', { class: 'btn sm', onclick: e => busy(e.target, async () => { const d = await api('POST', `/api/tickets/${t.id}/transcript`); window.open(d.url, '_blank'); }) }, 'Transcript'),
        t.status === 'open' && h('button', { class: 'btn sm', onclick: () => { const x = prompt('Message to send in the ticket as the bot:'); if (x) api('POST', `/api/tickets/${t.id}/say`, { text: x }).then(() => toast('Sent')).catch(e => toast(e.message, true)); } }, 'Message'),
        t.status === 'open' && h('button', { class: 'btn bad sm', onclick: e => busy(e.target, async () => { if (!confirm('Close this ticket?')) return; await api('POST', `/api/tickets/${t.id}/close`, { text: 'Closed from the dashboard' }); toast('Closed'); load(); }) }, 'Close'),
        t.status === 'closed' && h('button', { class: 'btn ok sm', onclick: e => busy(e.target, async () => { await api('POST', `/api/tickets/${t.id}/reopen`); toast('Reopened'); load(); }) }, 'Reopen'),
        t.status === 'closed' && h('button', { class: 'btn bad sm', onclick: e => busy(e.target, async () => { if (!confirm('Delete this ticket channel?')) return; await api('POST', `/api/tickets/${t.id}/delete`); toast('Deleting'); load(); }) }, 'Delete'))))))) : h('p', { class: 'sub' }, 'No tickets.')); };
  const tabs = h('div', { class: 'tabs' }, ['all', 'open', 'closed', 'deleted'].map(s => h('span', { class: 'tab' + (s === status ? ' on' : ''), onclick: ev => { status = s; [...tabs.children].forEach(c => c.classList.toggle('on', c === ev.target)); load(); } }, s[0].toUpperCase() + s.slice(1))));
  await load(); return h('div', {}, tabs, h('div', { class: 'card' }, box));
};

// ---------- embed fields editor ----------
function fieldsEditor(e, c) {
  e.fields = e.fields || []; const box = h('div');
  const draw = () => { box.replaceChildren(h('div', { class: 'hint', style: 'margin:10px 0 4px' }, 'Extra fields (up to 10)'), ...e.fields.map((f, n) => h('div', { class: 'card', style: 'background:var(--bg3);padding:10px;margin-bottom:8px' },
    h('div', { class: 'grid g2' }, field('Field name', text(f, 'name', { max: 256, onc: c })), field('Field value', text(f, 'value', { max: 1024, onc: c }))),
    h('div', { class: 'row' }, check(f, 'inline', 'Inline', c), h('button', { class: 'btn bad sm', onclick: () => { e.fields.splice(n, 1); draw(); c(); } }, 'Remove')))),
    e.fields.length < 10 ? h('button', { class: 'btn sm', onclick: () => { e.fields.push({ name: 'Field', value: 'Value', inline: false }); draw(); c(); } }, '+ Add field') : null); };
  draw(); return box;
}
// ---------- buttons editor (used for the default set and for per-category sets) ----------
const SUBJ = [['creator', 'Ticket creator'], ['staff', 'Support staff'], ['admin', 'Admins']];
function subjMulti(o) { o.subjects = o.subjects || []; const box = h('div', { class: 'chips' }), draw = () => box.replaceChildren(...SUBJ.map(([k, l]) => h('span', { class: 'chip' + (o.subjects.includes(k) ? ' on' : ''), onclick: () => { o.subjects = o.subjects.includes(k) ? o.subjects.filter(x => x !== k) : [...o.subjects, k]; draw(); } }, l))); draw(); return box; }
function buttonsEditor(list) {
  const box = h('div'), prev = h('div'), A = S.btnActions;
  const drawPrev = () => prev.replaceChildren(dcBox('Button preview', ...['open', 'closed'].map(v => h('div', { class: 'btns', style: 'margin-bottom:6px' }, h('span', { class: 'hint' }, 'Ticket ' + v + ':'), list.filter(b => b.when === v || b.when === 'always').map(b => h('span', { class: 'dbtn ' + (b.style || 'Secondary') }, emojiNode(b.emoji), ' ', b.label))))));
  const draw = () => {
    drawPrev(); box.replaceChildren(...list.map((b, n) => h('div', { class: 'card', style: 'background:var(--bg3)' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('b', {}, `${n + 1}. ${b.label || b.action}  `, h('span', { class: 'hint' }, b.id)), h('span', { class: 'row' },
        h('button', { class: 'btn sm', disabled: n === 0, onclick: () => { [list[n - 1], list[n]] = [list[n], list[n - 1]]; draw(); } }, '▲'), h('button', { class: 'btn sm', disabled: n === list.length - 1, onclick: () => { [list[n + 1], list[n]] = [list[n], list[n + 1]]; draw(); } }, '▼'),
        h('button', { class: 'btn bad sm', onclick: () => { list.splice(n, 1); draw(); } }, 'Remove'))),
      h('div', { class: 'grid g3' }, field('Label', text(b, 'label', { max: 80, onc: () => draw2() })), field('Emoji', emojiField(b, 'emoji', () => draw2())), field('Color', select(b, 'style', [['Primary', 'Blue'], ['Secondary', 'Gray'], ['Success', 'Green'], ['Danger', 'Red']], () => draw2()))),
      h('div', { class: 'grid g3' }, field('Action', select(b, 'action', A.map(a => [a, a]), draw)), field('Shown when ticket is', select(b, 'when', [['open', 'Open'], ['closed', 'Closed'], ['always', 'Always']], draw)), field('Claim state', select(b, 'claimState', [['any', 'Any'], ['unclaimed', 'Only if unclaimed'], ['claimed', 'Only if claimed']]))),
      b.action === 'message' ? field('Message text', text(b, 'text', { rows: 3, max: 1500 }), 'Variables: {user} {ticket} {category} {staff} {server}…') : null, b.action === 'link' ? field('Link (https://…)', text(b, 'url', { max: 500 })) : null,
      h('div', { class: 'grid g2' }, field('Who may press it (subjects)', subjMulti(b), 'Leave everything empty to use the Permissions page for this action.'), field('Extra roles allowed', roleMulti(b, 'roles'))))),
      list.length ? null : h('div', { class: 'hint', style: 'margin-bottom:10px' }, 'No buttons. Tickets will have no buttons at all — they can still be handled with /ticket commands.'),
      h('div', { class: 'row' }, list.length < 25 ? h('button', { class: 'btn sm', onclick: () => { list.push({ ...clone(S.defaults.button), id: 'btn-' + Math.random().toString(36).slice(2, 6), label: 'New button' }); draw(); } }, '+ Add button') : null,
        h('span', { class: 'hint' }, 'Max 25 buttons (Discord limit: 5 rows × 5).')));
  }, draw2 = drawPrev;
  draw(); return { box, prev };
}
pages.buttons = async () => settingsPage((W, rb) => { const ed = buttonsEditor(W.buttons);
  return [Card('Default ticket buttons', 'Shown inside every new ticket (categories can use their own set). Add, remove, rename, restyle and reorder freely. The Close button is optional — tickets can always be closed with /ticket close (or !ticket close). Custom emojis, per-button permissions and different buttons per state are supported.', h('div', { class: 'split' }, ed.box, h('div', { class: 'sticky' }, ed.prev)),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: async () => { if (!confirm('Restore the default buttons?')) return; await api('POST', '/api/reset/buttons'); await reload(); route(); } }, 'Restore default buttons'))),
  h('div', { class: 'hint' }, 'Buttons already posted in existing tickets update the next time that ticket changes (claim, close, reopen).')]; });
function catButtons(c) {
  const box = h('div'), sw = h('input', { type: 'checkbox' }); sw.checked = Array.isArray(c.buttons);
  const draw = () => { box.replaceChildren(); if (Array.isArray(c.buttons)) { const ed = buttonsEditor(c.buttons); box.append(ed.box, ed.prev); } };
  sw.addEventListener('change', () => { c.buttons = sw.checked ? clone(S.settings.buttons) : null; draw(); }); draw();
  return h('div', {}, h('label', { class: 'sw' }, sw, 'Use a custom button set for this category (otherwise the default set is used)'), box);
}
// ---------- leaderboard ----------
pages.leaderboard = async () => settingsPage((W, rb) => {
  const L = W.leaderboard, fillLB = (s, r, n) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => ({ medal: [L.emojis.first, L.emojis.second, L.emojis.third][n] || L.emojis.other, rank: n + 1, name: r.name, mention: '@' + r.name, username: r.name, resolved: r.resolved, claimed: r.claimed, managed: r.managed, weekly: r.weekly, monthly: r.monthly, alltime: r.alltime }[k] ?? m));
  const rowsBox = h('div'), prev = h('div'); let period = L.period, rows = [];
  const drawPrev = () => { const lines = rows.slice(0, L.top).map((r, n) => fillLB(L.rankFormat + '\n' + L.rowFormat, r, n)).join('\n\n') || L.emptyText;
    prev.replaceChildren(dcBox('Leaderboard preview (' + L.style + ' style)', embedPrev({ title: L.title, description: fillv(L.description).replace('{period}', period).replace('{updated}', 'just now') + '\n\n' + lines, color: L.color, footer: fillv(L.footer), thumbnail: L.thumbnail || (L.useTopAvatar && rows[0]?.avatar) || '', timestamp: L.timestamp }), h('div', { class: 'btns' }, ['Weekly', 'Monthly', 'All-time', '🔄 Refresh'].map(x => h('span', { class: 'dbtn Secondary' }, x))),
      L.style === 'cards' ? h('div', { class: 'hint', style: 'margin-top:8px' }, 'Cards style shows each staff member with their avatar next to their stats (top 8).') : null)); };
  const load = async () => { const d = await api('GET', '/api/leaderboard?period=' + period); rows = d.rows; drawPrev(); rowsBox.replaceChildren(rows.length ? h('div', { style: 'overflow:auto' }, h('table', {}, h('tr', {}, ['#', 'Staff', 'Resolved', 'Claimed', 'Managed', 'Week', 'Month', 'All-time'].map(x => h('th', {}, x))), rows.map(r => h('tr', {}, h('td', {}, r.rank), h('td', {}, r.avatar && h('img', { class: 'av', src: r.avatar }), r.name), h('td', {}, r.resolved), h('td', {}, r.claimed), h('td', {}, r.managed), h('td', {}, r.weekly), h('td', {}, r.monthly), h('td', {}, r.alltime))))) : h('p', { class: 'sub' }, 'No staff activity yet.')); };
  const act = (label, cls, fn) => h('button', { class: 'btn ' + cls, onclick: e => busy(e.target, async () => { await api('PUT', '/api/settings', W); const d = await fn(); await reload(); if (d?.msg) toast(d.msg); load(); }) }, label);
  load().catch(() => { });
  return [Card('Live staff leaderboard', 'One message that is edited automatically whenever a ticket is claimed, transferred, resolved or reopened (never a duplicate), and also on a timer. Members can switch Weekly / Monthly / All-time and refresh with the buttons.',
      h('div', { class: 'grid g3' }, field('Leaderboard channel', chanSel(L, 'channelId')), field('Style', select(L, 'style', [['cards', 'Cards (avatar per staff member, top 8)'], ['embed', 'Classic embed (top 15)']], drawPrev), S.guild.features?.components ? '' : 'Cards need discord.js 14.19+; otherwise the embed style is used.'), field('Default ranking', select(L, 'period', [['weekly', 'Weekly'], ['monthly', 'Monthly'], ['alltime', 'All-time']], () => { period = L.period; load(); }))),
      h('div', { class: 'grid g3' }, field('Staff shown', num(L, 'top', { min: 1, max: 15, onc: drawPrev })), field('Update every (minutes)', num(L, 'intervalMinutes', { min: 1, max: 1440 })), h('div', {}, check(L, 'enabled', 'Leaderboard enabled'), check(L, 'updateOnActivity', 'Update instantly on ticket activity'), check(L, 'showButtons', 'Show Weekly / Monthly / All-time / Refresh buttons'))),
      h('div', { class: 'row' }, act(L.messageId ? 'Save & update message' : 'Save & publish', 'ok', async () => { const d = await api('POST', '/api/leaderboard/publish', { channel: L.channelId }); return { msg: 'Leaderboard published: ' + d.url }; }),
        h('button', { class: 'btn bad', onclick: e => busy(e.target, async () => { if (!confirm('Reset leaderboard statistics for everyone? Promotion progress is kept.')) return; await api('POST', '/api/leaderboard/reset'); await reload(); toast('Statistics reset'); load(); }) }, 'Reset statistics'))),
    Card('Look', 'Title, colors, emojis and the format of each row. Variables: {server} {brand} {period} {updated} — rows: {medal} {rank} {name} {mention} {username} {resolved} {claimed} {managed} {weekly} {monthly} {alltime}',
      split(h('div', {}, h('div', { class: 'grid g2' }, field('Title', text(L, 'title', { max: 256, onc: drawPrev })), field('Color', text(L, 'color', { ph: '#F1C40F', onc: drawPrev }))), field('Description', text(L, 'description', { rows: 3, max: 2000, onc: drawPrev })),
        h('div', { class: 'grid g2' }, field('Footer', text(L, 'footer', { onc: drawPrev })), field('Thumbnail', imgField(L, 'thumbnail', drawPrev), 'Empty = avatar of the #1 staff member (classic style).')), check(L, 'useTopAvatar', 'Use the top staff avatar as thumbnail', drawPrev), check(L, 'timestamp', 'Show timestamp', drawPrev),
        h('div', { class: 'grid g2' }, field('Rank line', text(L, 'rankFormat', { onc: drawPrev })), field('Stats line', text(L, 'rowFormat', { rows: 2, onc: drawPrev }))), field('Text when empty', text(L, 'emptyText', { onc: drawPrev })),
        h('div', { class: 'grid g3' }, field('1st place emoji', emojiField(L.emojis, 'first', drawPrev)), field('2nd place emoji', emojiField(L.emojis, 'second', drawPrev)), field('3rd place emoji', emojiField(L.emojis, 'third', drawPrev))), field('Other ranks emoji', emojiField(L.emojis, 'other', drawPrev))), prev)),
    Card('Current ranking', null, rowsBox), h('div', { class: 'row' }, rb('leaderboard', 'leaderboard look'))];
});
// ---------- promotions ----------
pages.promotions = async () => {
  const hist = await api('GET', '/api/staff');
  return settingsPage((W, rb) => { const R = W.promotion, lvBox = h('div');
    const drawLv = () => lvBox.replaceChildren(...R.levels.map((l, n) => h('div', { class: 'card', style: 'background:var(--bg3);margin-bottom:8px' }, h('div', { class: 'grid g3' }, field('Level name', text(l, 'name', { max: 60 })), field('Reward role', select(l, 'roleId', [['', '— choose a role —'], ...S.guild.roles.map(r => [r.id, '@' + r.name])])), field('Resolved tickets required', num(l, 'required', { min: 1, max: 100000 }))),
      h('div', { class: 'row' }, l.roleId ? null : h('span', { class: 'hint' }, '⚠️ No role selected — this level is ignored until you pick one.'), h('button', { class: 'btn bad sm', onclick: () => { R.levels.splice(n, 1); drawLv(); } }, 'Remove')))), R.levels.length ? null : h('p', { class: 'sub' }, 'No levels yet. Add your own or load the example.'));
    drawLv(); const ed = embedEditor(W.messages.promotion, { label: 'Announcement preview' });
    return [Card('Automatic promotions', 'Only successfully resolved tickets count, each ticket is counted once, and roles are never assigned twice.',
      h('div', { class: 'grid g2' }, h('div', {}, check(R, 'enabled', 'Promotion system enabled'), check(R, 'auto', 'Promote automatically after a ticket is resolved'), check(R, 'retainPrevious', 'Keep previous level roles'), check(R, 'announce', 'Announce promotions'), check(R, 'announceManual', 'Also announce manual promotions'), check(R, 'dmStaff', 'DM the promoted staff member')),
        h('div', {}, field('Announcement channel', chanSel(R, 'announceChannelId')), field('Who gets credit for a shared ticket', select(R, 'creditMode', [['claimer', 'Only the staff member who has it claimed'], ['closer', 'Only the staff member who closed it'], ['claimer_closer', 'Claimer and closer'], ['participants', 'Everyone who replied (each gets 1)']])),
          check(R, 'creditCloserIfUnclaimed', 'If nobody claimed it, credit the closer'))),
      h('div', { class: 'grid g3' }, field('Staff messages required', num(R, 'minStaffMessages', { max: 1000 }), 'Anti-farming: a ticket only counts if staff wrote at least this many messages.'), field('Minimum ticket age (minutes)', num(R, 'minAgeMinutes', { max: 10080 })), h('div', {}, check(R, 'countAutoClosed', 'Count auto-closed tickets'), check(R, 'uncreditOnReopen', 'Un-count a ticket when it is reopened')))),
    Card('Promotion levels', 'Unlimited levels. Staff are promoted to the highest level they qualify for and never to the same level twice.', lvBox,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: () => { R.levels.push({ id: '', name: 'New level', roleId: '', required: (R.levels.at(-1)?.required || 0) + 10 }); drawLv(); } }, '+ Add level'),
        h('button', { class: 'btn sm', onclick: () => { for (const [n, r] of [['Trial Support', 10], ['Support', 20], ['Senior Support', 40], ['Moderator', 75], ['Senior Moderator', 100]]) R.levels.push({ id: '', name: n, roleId: '', required: r }); drawLv(); } }, 'Load example (10 / 20 / 40 / 75 / 100)'),
        h('button', { class: 'btn sm', onclick: e => busy(e.target, async () => { await api('PUT', '/api/settings', W); const d = await api('POST', '/api/promotion/recheck'); await reload(); toast(d.promoted + ' staff member(s) promoted'); }) }, 'Save & re-check everyone now'))),
    Card('Announcement message', 'Variables: {user} {username} {level} {role} {resolved_tickets} {rank} {next_level} {remaining} {server} {brand}', split(ed.form, ed.prev)),
    Card('Recent promotions', null, hist.history.length ? h('table', {}, h('tr', {}, ['When', 'Staff', 'Type', 'Level', 'Resolved'].map(x => h('th', {}, x))), hist.history.map(x => h('tr', {}, h('td', {}, ago(x.ts)), h('td', {}, x.user.name), h('td', {}, x.kind), h('td', {}, x.level_name || '—'), h('td', {}, x.count)))) : 'Nothing yet'), rb('promotion', 'promotion settings')]; });
};
// ---------- staff ----------
pages.staff = async () => {
  const box = h('div'), idIn = h('input', { type: 'text', placeholder: 'Discord user ID to register as staff' });
  const roleSel = () => h('select', {}, h('option', { value: '' }, 'Role…'), S.guild.roles.map(r => h('option', { value: r.id }, '@' + r.name)));
  const load = async () => { const d = await api('GET', '/api/staff'), op = (id, o, body) => api('POST', `/api/staff/${id}/${o}`, body || {}).then(() => { toast('Done'); load(); }).catch(e => toast(e.message, true));
    box.replaceChildren(d.staff.length ? h('div', { style: 'overflow:auto' }, h('table', {}, h('tr', {}, ['#', 'Staff', 'Level', 'Today ✅', 'Week ✅', 'Month ✅', 'All ✅', 'Claimed', 'Managed', 'Avg reply', 'Avg resolve', ''].map(x => h('th', {}, x))),
      d.staff.map(r => { const rs = roleSel(); return h('tr', {}, h('td', {}, r.rank || '—'), h('td', {}, r.avatar && h('img', { class: 'av', src: r.avatar }), r.name, r.registered ? '' : h('span', { class: 'hint' }, ' (auto)')), h('td', {}, r.level || '—', r.next ? h('div', { class: 'hint' }, 'next: ' + r.next) : null),
        h('td', {}, r.per.today.resolved), h('td', {}, r.per.weekly.resolved), h('td', {}, r.per.monthly.resolved), h('td', {}, r.per.alltime.resolved), h('td', {}, r.per.alltime.claimed), h('td', {}, r.per.alltime.managed),
        h('td', {}, r.avgResponse == null ? '—' : (r.avgResponse / 60000).toFixed(1) + ' min'), h('td', {}, r.avgResolution == null ? '—' : (r.avgResolution / 3600000).toFixed(1) + ' h'),
        h('td', {}, h('div', { class: 'row' }, rs, h('button', { class: 'btn ok sm', onclick: () => rs.value && op(r.id, 'promote', { role: rs.value }) }, 'Promote'), h('button', { class: 'btn sm', onclick: () => rs.value && op(r.id, 'demote', { role: rs.value }) }, 'Demote'),
          h('button', { class: 'btn sm', onclick: () => confirm('Reset all statistics of ' + r.name + '?') && op(r.id, 'reset') }, 'Reset'), h('button', { class: 'btn bad sm', onclick: () => confirm('Remove ' + r.name + ' from the staff list / leaderboard?') && op(r.id, 'remove') }, 'Remove')))); }))) : h('p', { class: 'sub' }, 'No staff yet. Staff appear automatically when they claim or answer tickets.')); };
  await load();
  return h('div', {}, Card('Staff statistics', 'Claimed / resolved / managed per staff member, response and resolution times, level and next requirement. Promote and demote manually with any role.', box,
    h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { class: 'grow' }, idIn), h('button', { class: 'btn pri', onclick: () => api('POST', '/api/staff', { id: idIn.value.trim() }).then(() => { idIn.value = ''; toast('Registered'); load(); }).catch(e => toast(e.message, true)) }, 'Register staff'))));
};
// ---------- logging ----------
pages.logging = async () => settingsPage((W, rb) => { const NAMES = { create: 'Ticket created', claim: 'Ticket claimed', unclaim: 'Ticket unclaimed', close: 'Ticket closed', reopen: 'Ticket reopened', delete: 'Ticket deleted', transfer: 'Ticket transferred', promotion: 'Staff promotions', activity: 'Staff activity feed', transcript: 'Transcripts' };
  return [Card('Logging', 'Choose a separate channel for every kind of log. Events without their own channel use the default log channel (a category can also have its own log channel).', check(W.features, 'logging', 'Logging enabled'),
    h('div', { class: 'grid g2', style: 'margin-top:10px' }, field('Default log channel', chanSel(W, 'logChannelId')), field('Default transcript channel', chanSel(W, 'transcriptChannelId'), 'Used when "Transcripts" has no channel of its own.'))),
  Card('Per-event channels', null, h('table', {}, h('tr', {}, ['Event', 'On', 'Channel'].map(x => h('th', {}, x))), S.logEvents.map(e => h('tr', {}, h('td', {}, NAMES[e] || e), h('td', {}, check(W.logging.enabled, e, '')), h('td', {}, chanSel(W.logging.channels, e))))), h('div', { style: 'margin-top:12px' }, rb('logging', 'logging')))]; });
// ---------- general settings card (prefix, features, cooldown, timezone) ----------
function generalCard(W) {
  return Card('General', 'Prefix for text commands (!ticket …), feature switches, cooldown and the week/month boundaries used by the leaderboard.', h('div', { class: 'grid g3' }, field('Command prefix', text(W, 'prefix', { max: 5 }), 'e.g. !ticket claim'), field('Ticket open cooldown (seconds)', num(W, 'cooldownSeconds', { max: 3600 })), check(W, 'useBotPrefix', 'Also accept my bot\'s own prefix')),
    h('div', { class: 'grid g3' }, field('Week starts on', select(W.stats, 'weekStartsOn', [[1, 'Monday'], [0, 'Sunday'], [6, 'Saturday']].map(([v, l]) => [String(v), l]))), field('Timezone offset (minutes from UTC)', num(W.stats, 'utcOffsetMinutes', { min: -720, max: 840 }), 'e.g. 60 = UTC+1'), h('div')),
    h('div', { class: 'hint', style: 'margin:8px 0' }, 'Features:'), h('div', { class: 'row' }, Object.keys(W.features).map(k => check(W.features, k, k))));
}

// ---------- shell ----------
const NAV = [['dashboard', '📊', 'Dashboard'], ['panels', '🧩', 'Panels'], ['categories', '🗂️', 'Categories'], ['buttons', '🔘', 'Buttons'], ['embeds', '✉️', 'Embeds & messages'], ['leaderboard', '🏆', 'Leaderboard'], ['promotions', '🎖️', 'Promotions'], ['staff', '👥', 'Staff'], ['logging', '📜', 'Logging'], ['permissions', '🔐', 'Permissions & roles'], ['settings', '⚙️', 'Settings'], ['tickets', '🎫', 'Tickets']];
async function route() {
  const [, page = 'dashboard', id] = (location.hash.split('?')[0] || '#/dashboard').split('/'), query = new URLSearchParams(location.hash.split('?')[1] || ''), name = pages[page] ? page : 'dashboard';
  $('.side')?.classList.remove('open'); document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.p === name));
  const main = $('#page'); $('#title').textContent = (NAV.find(n => n[0] === name) || [])[2] || ''; main.replaceChildren(h('p', { class: 'sub' }, 'Loading…'));
  try { main.replaceChildren(await pages[name](id, query)); } catch (e) { main.replaceChildren(Card('Error', e.message)); console.error(e); }
}
function shell() {
  const app = $('#app'); app.replaceChildren(h('div', { class: 'layout' },
    h('aside', { class: 'side' }, h('div', { class: 'brand' }, S.guild?.icon ? h('img', { src: S.guild.icon }) : '🎫', h('span', {}, S.guild?.name || 'Tickets')), S.guilds.length > 1 ? h('select', { style: 'margin:0 0 10px', onchange: e => { GID = e.target.value; try { localStorage.setItem('tgid', GID); } catch { } location.hash = '#/dashboard'; location.reload(); } }, S.guilds.map(g => h('option', { value: g.id, selected: g.id === GID }, g.name))) : null, h('nav', { class: 'nav' }, NAV.map(([k, i, l]) => h('a', { href: '#/' + k, 'data-p': k }, i, ' ', l))),
      h('div', { class: 'me' }, S.me.avatar && h('img', { src: S.me.avatar }), h('span', { class: 'grow' }, S.me.name), h('a', { href: '#', onclick: async e => { e.preventDefault(); await api('POST', '/auth/logout'); location.reload(); } }, 'Log out'))),
    h('main', { class: 'main' }, h('div', { class: 'top' }, h('button', { class: 'btn menu', onclick: () => $('.side').classList.toggle('open') }, '☰'), h('h1', { id: 'title' }), S.guild ? null : h('span', { class: 'pill closed' }, 'Bot is offline / wrong GUILD_ID')), h('div', { id: 'page' }))));
  addEventListener('hashchange', route); route();
}
async function login() {
  const cfg = await api('GET', '/auth/config'), err = new URLSearchParams(location.search).get('error'), pw = h('input', { type: 'password', placeholder: 'Dashboard password' });
  const doPw = async () => { try { await api('POST', '/auth/password', { password: pw.value }); location.href = '/'; } catch (e) { toast(e.message, true); } }; pw.addEventListener('keydown', e => e.key === 'Enter' && doPw());
  $('#app').replaceChildren(h('div', { class: 'login' }, h('div', { style: 'font-size:44px' }, '🎫'), h('h2', {}, 'Ticket Dashboard'), h('div', { class: 'card' }, err && h('p', { style: 'color:#f66' }, err),
    cfg.oauth && h('a', { class: 'btn pri', style: 'display:block;text-align:center;text-decoration:none;margin-bottom:12px', href: '/auth/login' }, 'Log in with Discord'),
    cfg.password && h('div', {}, pw, h('button', { class: 'btn pri', style: 'width:100%;margin-top:10px', onclick: doPw }, 'Log in')), !cfg.oauth && !cfg.password && h('p', {}, 'Set CLIENT_SECRET or DASHBOARD_PASSWORD in .env to enable login.'))));
}
(async () => { try { await reload(); shell(); } catch (e) { await login(); } })();

}
const DASH_CSS = String.raw`:root{--bg:#1e1f22;--bg2:#2b2d31;--bg3:#313338;--bg4:#383a40;--line:#3f4147;--tx:#dbdee1;--mut:#949ba4;--acc:#5865f2;--acc2:#4752c4;--ok:#23a559;--bad:#da373c;--warn:#f0b232;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:#00a8fc}button,input,select,textarea{font:inherit;color:inherit}
.layout{display:flex;min-height:100%}.side{width:232px;background:var(--bg2);border-right:1px solid var(--line);padding:14px 10px;position:sticky;top:0;height:100vh;overflow:auto;flex:none;display:flex;flex-direction:column}
.brand{display:flex;gap:10px;align-items:center;padding:6px 8px 14px;font-weight:700;font-size:16px}.brand img{width:32px;height:32px;border-radius:50%}
.nav a{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:6px;color:var(--mut);text-decoration:none;margin-bottom:2px}.nav a:hover{background:var(--bg4);color:var(--tx)}.nav a.on{background:var(--acc);color:#fff}
.me{margin-top:auto;display:flex;gap:8px;align-items:center;padding:10px 8px;border-top:1px solid var(--line);color:var(--mut)}.me img{width:28px;height:28px;border-radius:50%}
.main{flex:1;min-width:0;padding:22px 26px 80px;max-width:1280px}.top{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}.top h1{margin:0;font-size:22px;flex:1}.menu{display:none}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}.card h3{margin:0 0 4px;font-size:15px}.card .sub{color:var(--mut);margin:0 0 12px}
.grid{display:grid;gap:14px}.g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}.stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.stat{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:14px}.stat b{display:block;font-size:26px}.stat span{color:var(--mut)}
label.f{display:block;margin-bottom:12px}label.f>span{display:block;font-weight:600;margin-bottom:5px;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--mut)}.hint{color:var(--mut);font-size:12px;margin-top:4px}
input[type=text],input[type=number],input[type=password],select,textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:9px 10px;outline:none}input:focus,select:focus,textarea:focus{border-color:var(--acc)}textarea{resize:vertical;min-height:84px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row>*{flex:0 0 auto}.row .grow{flex:1;min-width:140px}
.btn{background:var(--bg4);border:0;border-radius:6px;padding:9px 14px;cursor:pointer;font-weight:600}.btn:hover{filter:brightness(1.15)}.btn.pri{background:var(--acc);color:#fff}.btn.ok{background:var(--ok);color:#fff}.btn.bad{background:var(--bad);color:#fff}.btn.sm{padding:5px 10px;font-size:12px}.btn:disabled{opacity:.5;cursor:default}
.chips{display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow:auto;padding:2px}.chip{border:1px solid var(--line);border-radius:999px;padding:4px 10px;cursor:pointer;background:var(--bg);user-select:none}.chip.on{background:var(--acc);border-color:var(--acc);color:#fff}
.sw{display:flex;gap:10px;align-items:center;margin-bottom:10px;cursor:pointer}.sw input{width:18px;height:18px;accent-color:var(--acc)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}th{color:var(--mut);font-size:12px;text-transform:uppercase}
.pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;background:var(--bg4)}.pill.open{background:#23a55933;color:#3ba55d}.pill.closed{background:#da373c33;color:#f66}.pill.deleted{background:#4e505833;color:var(--mut)}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:18px;align-items:start}.sticky{position:sticky;top:14px}
.dc{background:var(--bg3);border-radius:8px;padding:14px;border:1px solid var(--line)}.dc .lbl{color:var(--mut);font-size:11px;text-transform:uppercase;margin-bottom:8px}
.embed{display:flex;max-width:440px;background:var(--bg2);border-radius:4px;border-left:4px solid var(--acc);overflow:hidden}.embed .in{padding:8px 14px 12px 12px;min-width:0;flex:1}.embed .th{width:72px;height:72px;object-fit:cover;border-radius:4px;margin:10px 10px 0 0}
.embed .au{display:flex;gap:6px;align-items:center;font-size:13px;font-weight:600;margin-bottom:4px}.embed .au img,.embed .ft img{width:20px;height:20px;border-radius:50%}.embed .ti{font-weight:700;font-size:15px;margin-bottom:4px;color:#fff}.embed .ds{font-size:13.5px;white-space:pre-wrap;word-break:break-word}.embed .im{max-width:100%;border-radius:4px;margin-top:10px;display:block}
.embed .ft{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--mut);margin-top:8px}.ment{background:#5865f24d;color:#c9cdfb;border-radius:3px;padding:0 2px}.ce{height:1.2em;vertical-align:-3px}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.dbtn{display:inline-flex;align-items:center;gap:6px;border-radius:3px;padding:6px 14px;font-weight:600;font-size:13px;color:#fff}.dbtn.Primary{background:#5865f2}.dbtn.Secondary{background:#4e5058}.dbtn.Success{background:#248046}.dbtn.Danger{background:#da373c}
.sel{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:9px 12px;margin-top:10px;color:var(--mut)}
.thumb{width:84px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--line);background:var(--bg)}
.modalbg{position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:50;padding:14px}.modal{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:16px;width:min(560px,100%);max-height:86vh;overflow:auto}
.eg{display:grid;grid-template-columns:repeat(auto-fill,minmax(38px,1fr));gap:4px}.eg button{background:none;border:0;font-size:22px;border-radius:6px;padding:4px;cursor:pointer}.eg button:hover{background:var(--bg4)}.eg img{width:28px;height:28px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.tab{padding:6px 12px;border-radius:6px;background:var(--bg4);cursor:pointer}.tab.on{background:var(--acc);color:#fff}
.bar{display:flex;align-items:flex-end;gap:5px;height:100px}.bar div{flex:1;background:var(--acc);border-radius:3px 3px 0 0;min-height:2px;position:relative}.bar div:hover::after{content:attr(data-t);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#000;padding:2px 6px;border-radius:4px;font-size:11px;white-space:nowrap}
.act li{padding:8px 0;border-bottom:1px solid var(--line);list-style:none}.act{padding:0;margin:0}.av{width:22px;height:22px;border-radius:50%;vertical-align:middle;margin-right:6px}
.login{max-width:380px;margin:12vh auto;padding:0 16px;text-align:center}.login .card{text-align:left}
#toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:99}.toast{background:var(--bg4);border-left:4px solid var(--ok);padding:10px 14px;border-radius:6px;box-shadow:0 4px 16px #0008;max-width:340px}.toast.bad{border-color:var(--bad)}
.savebar{position:fixed;left:232px;right:0;bottom:0;background:#1e1f22ee;border-top:1px solid var(--line);padding:10px 26px;display:flex;gap:10px;justify-content:flex-end;z-index:20;backdrop-filter:blur(6px)}
@media(max-width:900px){.split{grid-template-columns:1fr}.sticky{position:static}}
@media(max-width:760px){.side{position:fixed;left:-250px;z-index:40;transition:left .2s}.side.open{left:0}.menu{display:inline-block}.main{padding:16px 14px 90px}.savebar{left:0;padding:10px 14px}}

table select,table input[type=text]{width:auto;min-width:120px}.av{width:22px;height:22px;border-radius:50%;vertical-align:middle;margin-right:6px}
`;

// ───────────────────────────────────────────── 12. EXPORTS (integration surface) ─────────────────────────────────────────────
module.exports = {
  attach,                       // attach(client): registers every listener once + starts the dashboard. The only call you need.
  registerEvents,               // registerEvents(client): listeners only (no dashboard), safe to call repeatedly
  commandName: NAME,
  data: slashData,              // SlashCommandBuilder for /ticket (all subcommands + groups)
  toJSON: () => slashData.toJSON(),
  execute: runSlash,            // execute(interaction)         — slash command execution
  executePrefix,                // executePrefix(message)       — prefix command execution, resolves true if the message was a ticket command
  handleInteraction,            // handleInteraction(interaction) — ONE router for slash, autocomplete, buttons, selects, user menus, modals
  onMessage: async m => { if (!m.guildId || m.author.bot) return false; if (await executePrefix(m)) return true; trackMessage(m); return false; },
  registerCommands,             // registerCommands(client): adds/updates only /ticket in every server
  startWeb,
};
if (require.main === module) { // standalone: node ticket.js  (needs DISCORD_TOKEN or TOKEN)
  try { require('dotenv').config(); } catch { }
  const { Client, GatewayIntentBits: G, Partials } = DJS, client = new Client({ intents: [G.Guilds, G.GuildMembers, G.GuildMessages, G.MessageContent], partials: [Partials.Channel] });
  attach(client); client.login(process.env.DISCORD_TOKEN || process.env.TOKEN).catch(e => { console.error('Login failed:', e.message); process.exit(1); }); process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
}
