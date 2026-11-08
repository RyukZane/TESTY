'use strict';
/*
 * website.js — complete control panel for your Discord bot (zero extra dependencies).
 *
 * Add to index.js, after `client` is created and before `client.login(...)`:
 *     require('./website')(client);
 *
 * Environment variables (Railway → Variables):
 *   DASHBOARD_PASSWORD  (or WEBSITE_PASSWORD)  password login (owner access to every server)
 *   CLIENT_ID, CLIENT_SECRET                    Discord OAuth2 login (optional)
 *   PUBLIC_URL                                  https://your-app.up.railway.app
 *   DASHBOARD_ADMINS                            comma separated Discord user IDs with full access (optional)
 *   WEBSITE_PORT                                only if you want a separate port; otherwise it shares the ticket dashboard at /admin
 *   WEBSITE_DATA_DIR                            where settings are stored (default: next to DATA_DIR, e.g. /data/website)
 * OAuth redirect to add in the Discord developer portal:  PUBLIC_URL/admin/auth/callback
 */
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
let D = {}; try { D = require('discord.js'); } catch { }
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionFlagsBits: PF, ActivityType } = D;
const ENV = process.env, rid = () => crypto.randomBytes(4).toString('hex');

// ───────────────────────────── storage (JSON files, survive restarts) ─────────────────────────────
const VOL = ENV.RAILWAY_VOLUME_MOUNT_PATH || '', ON_RAILWAY = !!(ENV.RAILWAY_ENVIRONMENT || ENV.RAILWAY_PROJECT_ID || ENV.RAILWAY_SERVICE_ID);
const DATA = ENV.WEBSITE_DATA_DIR || (VOL ? path.join(VOL, 'website') : ENV.DATA_DIR ? path.join(path.dirname(ENV.DATA_DIR), 'website') : path.join(process.cwd(), 'data', 'website'));
const PERSIST_WARN = ON_RAILWAY && !(VOL && path.resolve(DATA).startsWith(path.resolve(VOL))) ? `Settings are NOT saved permanently. This bot runs on Railway without a Volume covering ${DATA}, so every redeploy erases them. In Railway add a Volume (mount path /data) to this service, then set DATA_DIR=/data/tickets and WEBSITE_DATA_DIR=/data/website.` : '';
if (PERSIST_WARN) console.error('❌ website.js: ' + PERSIST_WARN);
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) { console.error('[website] cannot create', DATA, e.message); }
const fp = n => path.join(DATA, n), timers = {};
const load = (n, d) => { try { return JSON.parse(fs.readFileSync(fp(n), 'utf8')); } catch { return d; } };
const save = (n, v, now) => { const w = () => { try { const t = fp(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, fp(n)); } catch (e) { console.error('[website] save failed', n, e.message); } }; clearTimeout(timers[n]); if (now) w(); else timers[n] = setTimeout(w, 300); };
const db = { configs: load('configs.json', {}), history: load('history.json', []), warns: load('warnings.json', {}), modlog: load('modlog.json', []), activity: load('activity.json', []), usage: load('usage.json', {}), errors: load('errors.json', []), meta: load('meta.json', {}) };
const err = (where, e) => { db.errors.unshift({ t: Date.now(), where, msg: String(e?.message || e).slice(0, 300) }); db.errors.length = Math.min(db.errors.length, 100); save('errors.json', db.errors); console.error('[website]', where + ':', e?.message || e); };
const act = (g, text) => { db.activity.unshift({ t: Date.now(), g, text: String(text).slice(0, 200) }); db.activity.length = Math.min(db.activity.length, 300); save('activity.json', db.activity); };

// ───────────────────────────── validation helpers ─────────────────────────────
const S = {
  str: (v, m = 200) => String(v ?? '').slice(0, m), bool: v => v === true || v === 'true',
  int: (v, a, b, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, a), b) : d; },
  snow: v => /^\d{15,25}$/.test(String(v ?? '')) ? String(v) : '', color: v => /^#[0-9a-f]{6}$/i.test(String(v ?? '')) ? String(v) : '',
  url: v => /^https?:\/\/[^\s]{1,500}$/i.test(String(v ?? '')) ? String(v) : '', enum: (v, a, d) => a.includes(v) ? v : d,
  ids: v => [...new Set((Array.isArray(v) ? v : []).map(S.snow).filter(Boolean))].slice(0, 50),
  list: (v, n = 100, m = 100) => [...new Set((Array.isArray(v) ? v : []).map(x => S.str(x, m).trim()).filter(Boolean))].slice(0, n),
  id: v => /^[\w-]{4,24}$/.test(String(v ?? '')) ? String(v) : rid(),
};
const PERMS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'MentionEveryone'];
const FEATURES = ['customCommands', 'autoResponses', 'automod', 'logging', 'welcome', 'scheduled', 'roles', 'triggers'];
const LOGS = { messageDelete: ['Message deleted', '#ED4245'], messageEdit: ['Message edited', '#FEE75C'], memberJoin: ['Member joined', '#57F287'], memberLeave: ['Member left', '#ED4245'], roleChange: ['Role changes', '#5865F2'], channelChange: ['Channel changes', '#5865F2'], voice: ['Voice activity', '#99AAB5'], moderation: ['Moderation action', '#EB459E'], command: ['Command used', '#99AAB5'] };
const ACT = ['sendMessage', 'dm', 'addRole', 'removeRole', 'toggleRole', 'react', 'timeout', 'kick', 'ban', 'nickname', 'deleteTrigger'];
const EMBED0 = () => ({ title: '', description: '', url: '', color: '', author: { name: '', icon: '', url: '' }, footer: { text: '', icon: '' }, thumbnail: '', image: '', timestamp: false, fields: [] });
const defaults = () => ({
  general: { prefix: '*', language: 'en', embedColor: '#5865F2', footer: '', errorMessage: '❌ Something went wrong. Please try again.', permMessage: '❌ You do not have permission to use this.', cooldownMessage: '⏳ Slow down! Try again in {seconds}s.', defaultCooldown: 3, utcOffset: 0, features: Object.fromEntries(FEATURES.map(f => [f, true])) },
  welcome: { enabled: false, channel: '', content: 'Welcome {mention} to **{server}**! You are member #{members}.', embedOn: false, embed: EMBED0(), dm: false, dmText: 'Welcome to {server}!' },
  goodbye: { enabled: false, channel: '', content: '**{username}** has left {server}.', embedOn: false, embed: EMBED0() },
  autoRoles: { enabled: false, roles: [], botRoles: [], delaySeconds: 0 },
  verification: { enabled: false, channel: '', messageId: '', role: '', removeRole: '', title: 'Verification', description: 'Press the button below to verify yourself and unlock the server.', button: 'Verify', color: '' },
  access: { adminRoles: [], modRoles: [] },
  logging: Object.fromEntries(Object.entries(LOGS).map(([k, [t, c]]) => [k, { enabled: false, channel: '', color: c, title: t, footer: '' }])),
  moderation: { logChannel: '', dmUser: true, notice: '{mention}, that is not allowed here.', noticeSeconds: 6, staffRoles: [], ignoredRoles: [], ignoredChannels: [],
    automod: { words: { enabled: false, list: [], action: 'delete', minutes: 10 }, links: { enabled: false, list: [], action: 'delete', minutes: 10 }, invites: { enabled: false, list: [], action: 'delete', minutes: 10 }, spam: { enabled: false, max: 5, seconds: 6, action: 'timeout', minutes: 5 }, caps: { enabled: false, percent: 70, minLength: 12, action: 'delete', minutes: 10 } },
    punishments: [{ warns: 3, action: 'timeout', minutes: 60 }, { warns: 5, action: 'kick', minutes: 0 }] },
  automation: { autoResponses: [], scheduled: [], triggers: [] },
  roles: { panels: [] },
  commands: [], embeds: [],
  bot: { statusOn: false, status: 'online', activityType: 'Custom', activityText: '' },
});
const SECTIONS = Object.keys(defaults());
const deepFill = (def, v) => { if (Array.isArray(def)) return Array.isArray(v) ? v : def; if (def && typeof def === 'object') { const o = {}; for (const k of Object.keys(def)) o[k] = deepFill(def[k], v?.[k]); return o; } return v === undefined ? def : v; };

// ───────────────────────────── sanitizers: one per config section ─────────────────────────────
const embedS = e => { e = e || {}; return { title: S.str(e.title, 256), description: S.str(e.description, 4000), url: S.url(e.url), color: S.color(e.color), author: { name: S.str(e.author?.name, 256), icon: S.url(e.author?.icon), url: S.url(e.author?.url) }, footer: { text: S.str(e.footer?.text, 2048), icon: S.url(e.footer?.icon) }, thumbnail: S.url(e.thumbnail), image: S.url(e.image), timestamp: S.bool(e.timestamp), fields: (Array.isArray(e.fields) ? e.fields : []).slice(0, 25).map(f => ({ name: S.str(f?.name, 256), value: S.str(f?.value, 1024), inline: S.bool(f?.inline) })).filter(f => f.name && f.value) }; };
const actionsS = a => (Array.isArray(a) ? a : []).slice(0, 10).map(x => ({ type: S.enum(x?.type, ACT, 'sendMessage'), text: S.str(x?.text, 1000), channel: S.snow(x?.channel), role: S.snow(x?.role), minutes: S.int(x?.minutes, 1, 40320, 10), emoji: S.str(x?.emoji, 64) }));
const byId = (arr, id) => (Array.isArray(arr) ? arr : []).find(x => x?.id === id) || {};
const ACTM = ['delete', 'warn', 'timeout', 'kick', 'ban'];
const rule = (r, d) => ({ enabled: S.bool(r?.enabled), list: S.list(r?.list, 500, 100), action: S.enum(r?.action, ACTM, d || 'delete'), minutes: S.int(r?.minutes, 1, 40320, 10) });
const NAMEOK = /^[\p{L}\p{N}_-]{1,32}$/u;
const SAN = {
  general: v => ({ prefix: S.str(v?.prefix, 5).replace(/\s/g, '') || '*', language: S.enum(v?.language, ['en', 'es', 'fr', 'de', 'pt', 'hi', 'ar', 'tr', 'ru', 'id'], 'en'), embedColor: S.color(v?.embedColor) || '#5865F2', footer: S.str(v?.footer, 200), errorMessage: S.str(v?.errorMessage, 300), permMessage: S.str(v?.permMessage, 300), cooldownMessage: S.str(v?.cooldownMessage, 300), defaultCooldown: S.int(v?.defaultCooldown, 0, 3600, 3), utcOffset: S.int(v?.utcOffset, -12, 14, 0), features: Object.fromEntries(FEATURES.map(f => [f, v?.features?.[f] === undefined ? true : S.bool(v.features[f])])) }),
  welcome: v => ({ enabled: S.bool(v?.enabled), channel: S.snow(v?.channel), content: S.str(v?.content, 2000), embedOn: S.bool(v?.embedOn), embed: embedS(v?.embed), dm: S.bool(v?.dm), dmText: S.str(v?.dmText, 2000) }),
  goodbye: v => ({ enabled: S.bool(v?.enabled), channel: S.snow(v?.channel), content: S.str(v?.content, 2000), embedOn: S.bool(v?.embedOn), embed: embedS(v?.embed) }),
  autoRoles: v => ({ enabled: S.bool(v?.enabled), roles: S.ids(v?.roles), botRoles: S.ids(v?.botRoles), delaySeconds: S.int(v?.delaySeconds, 0, 3600, 0) }),
  verification: (v, o) => ({ enabled: S.bool(v?.enabled), channel: S.snow(v?.channel), messageId: o?.messageId || '', role: S.snow(v?.role), removeRole: S.snow(v?.removeRole), title: S.str(v?.title, 256), description: S.str(v?.description, 2000), button: S.str(v?.button, 80) || 'Verify', color: S.color(v?.color) }),
  access: v => ({ adminRoles: S.ids(v?.adminRoles), modRoles: S.ids(v?.modRoles) }),
  logging: v => Object.fromEntries(Object.entries(LOGS).map(([k, [t, c]]) => [k, { enabled: S.bool(v?.[k]?.enabled), channel: S.snow(v?.[k]?.channel), color: S.color(v?.[k]?.color) || c, title: S.str(v?.[k]?.title, 256) || t, footer: S.str(v?.[k]?.footer, 200) }])),
  moderation: v => ({ logChannel: S.snow(v?.logChannel), dmUser: S.bool(v?.dmUser), notice: S.str(v?.notice, 300), noticeSeconds: S.int(v?.noticeSeconds, 0, 60, 6), staffRoles: S.ids(v?.staffRoles), ignoredRoles: S.ids(v?.ignoredRoles), ignoredChannels: S.ids(v?.ignoredChannels),
    automod: { words: rule(v?.automod?.words), links: rule(v?.automod?.links), invites: rule(v?.automod?.invites), spam: { enabled: S.bool(v?.automod?.spam?.enabled), max: S.int(v?.automod?.spam?.max, 2, 30, 5), seconds: S.int(v?.automod?.spam?.seconds, 2, 120, 6), action: S.enum(v?.automod?.spam?.action, ACTM, 'timeout'), minutes: S.int(v?.automod?.spam?.minutes, 1, 40320, 5) }, caps: { enabled: S.bool(v?.automod?.caps?.enabled), percent: S.int(v?.automod?.caps?.percent, 30, 100, 70), minLength: S.int(v?.automod?.caps?.minLength, 5, 200, 12), action: S.enum(v?.automod?.caps?.action, ACTM, 'delete'), minutes: S.int(v?.automod?.caps?.minutes, 1, 40320, 10) } },
    punishments: (Array.isArray(v?.punishments) ? v.punishments : []).slice(0, 10).map(p => ({ warns: S.int(p?.warns, 1, 50, 3), action: S.enum(p?.action, ['timeout', 'kick', 'ban'], 'timeout'), minutes: S.int(p?.minutes, 0, 40320, 60) })) }),
  automation: (v, o) => ({
    autoResponses: (Array.isArray(v?.autoResponses) ? v.autoResponses : []).slice(0, 100).map(r => ({ id: S.id(r?.id), enabled: S.bool(r?.enabled), trigger: S.str(r?.trigger, 200), match: S.enum(r?.match, ['contains', 'exact', 'starts', 'regex'], 'contains'), response: S.str(r?.response, 2000), embedOn: S.bool(r?.embedOn), embed: embedS(r?.embed), channels: S.ids(r?.channels), cooldown: S.int(r?.cooldown, 0, 3600, 5), reply: S.bool(r?.reply) })).filter(r => r.trigger),
    scheduled: (Array.isArray(v?.scheduled) ? v.scheduled : []).slice(0, 50).map(r => { const id = S.id(r?.id); return { id, enabled: S.bool(r?.enabled), name: S.str(r?.name, 60), channel: S.snow(r?.channel), mode: S.enum(r?.mode, ['interval', 'daily'], 'interval'), everyMinutes: S.int(r?.everyMinutes, 1, 43200, 60), time: /^([01]\d|2[0-3]):[0-5]\d$/.test(r?.time) ? r.time : '12:00', content: S.str(r?.content, 2000), embedOn: S.bool(r?.embedOn), embed: embedS(r?.embed), last: byId(o?.scheduled, id).last || 0 }; }),
    triggers: (Array.isArray(v?.triggers) ? v.triggers : []).slice(0, 50).map(r => ({ id: S.id(r?.id), enabled: S.bool(r?.enabled), name: S.str(r?.name, 60), event: S.enum(r?.event, ['memberJoin', 'memberLeave', 'voiceJoin', 'roleAdded', 'boost'], 'memberJoin'), role: S.snow(r?.role), actions: actionsS(r?.actions) })) }),
  roles: (v, o) => ({ panels: (Array.isArray(v?.panels) ? v.panels : []).slice(0, 25).map(p => { const id = S.id(p?.id), old = byId(o?.panels, id); return { id, name: S.str(p?.name, 60), type: S.enum(p?.type, ['button', 'select', 'reaction'], 'button'), channel: S.snow(p?.channel), messageId: old.messageId || '', title: S.str(p?.title, 256), description: S.str(p?.description, 2000), color: S.color(p?.color), exclusive: S.bool(p?.exclusive), items: (Array.isArray(p?.items) ? p.items : []).slice(0, 25).map(i => ({ label: S.str(i?.label, 80), emoji: S.str(i?.emoji, 64), role: S.snow(i?.role), description: S.str(i?.description, 100) })).filter(i => i.role) }; }) }),
  commands: v => (Array.isArray(v) ? v : []).slice(0, 100).map(c => ({ id: S.id(c?.id), enabled: S.bool(c?.enabled), name: S.str(c?.name, 32).toLowerCase().replace(/\s/g, ''), description: S.str(c?.description, 100) || 'Custom command', type: S.enum(c?.type, ['text', 'slash', 'both'], 'both'), aliases: S.list(c?.aliases, 10, 32).map(a => a.toLowerCase()), response: S.str(c?.response, 2000), embedOn: S.bool(c?.embedOn), embed: embedS(c?.embed), ephemeral: S.bool(c?.ephemeral), perms: (Array.isArray(c?.perms) ? c.perms : []).filter(p => PERMS.includes(p)), roles: S.ids(c?.roles), cooldown: S.int(c?.cooldown, 0, 3600, 3), args: (Array.isArray(c?.args) ? c.args : []).slice(0, 5).map(a => ({ name: S.str(a?.name, 32).toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, ''), description: S.str(a?.description, 100) || 'Argument', type: S.enum(a?.type, ['string', 'integer', 'boolean', 'user', 'channel', 'role'], 'string'), required: S.bool(a?.required) })).filter(a => a.name), actions: actionsS(c?.actions) })),
  embeds: (v, o) => (Array.isArray(v) ? v : []).slice(0, 100).map(e => { const id = S.id(e?.id), old = byId(o, id); return { id, name: S.str(e?.name, 60) || 'Untitled', channel: S.snow(e?.channel) || old.channel || '', messageId: old.messageId || '', content: S.str(e?.content, 2000), embed: embedS(e?.embed), buttons: (Array.isArray(e?.buttons) ? e.buttons : []).slice(0, 10).map(b => ({ label: S.str(b?.label, 80), emoji: S.str(b?.emoji, 64), style: S.enum(b?.style, ['Primary', 'Secondary', 'Success', 'Danger', 'Link'], 'Primary'), url: S.url(b?.url), role: S.snow(b?.role) })).filter(b => b.label || b.emoji), select: { enabled: S.bool(e?.select?.enabled), placeholder: S.str(e?.select?.placeholder, 100), options: (Array.isArray(e?.select?.options) ? e.select.options : []).slice(0, 25).map(x => ({ label: S.str(x?.label, 100), description: S.str(x?.description, 100), role: S.snow(x?.role) })).filter(x => x.label && x.role) } }; }),
  bot: v => ({ statusOn: S.bool(v?.statusOn), status: S.enum(v?.status, ['online', 'idle', 'dnd', 'invisible'], 'online'), activityType: S.enum(v?.activityType, ['Custom', 'Playing', 'Watching', 'Listening', 'Competing'], 'Custom'), activityText: S.str(v?.activityText, 128) }),
};
// extra validation that must reject (not just coerce): returns an error string or ''
function check(section, v) {
  if (section === 'commands') { const seen = new Set(); for (const c of v) { if (!c.name) return 'Every command needs a name.'; if (!NAMEOK.test(c.name)) return `Command "${c.name}": use letters, numbers, - and _ only.`; if (seen.has(c.name)) return `Duplicate command name "${c.name}".`; seen.add(c.name); } }
  if (section === 'automation') for (const r of v.autoResponses) if (r.match === 'regex') { try { new RegExp(r.trigger); } catch { return `Invalid regex: ${r.trigger}`; } }
  if (section === 'commands') for (const c of v) { const n = new Set(); for (const a of c.args) { if (n.has(a.name)) return `Command "${c.name}": duplicate argument "${a.name}".`; n.add(a.name); } }
  if (section === 'embeds') for (const e of v) { for (const b of e.buttons) { if (b.style === 'Link' && !b.url) return `Embed "${e.name}": link button "${b.label}" needs a URL (https://…).`; if (b.style !== 'Link' && !b.role) return `Embed "${e.name}": button "${b.label}" needs a role to toggle (or use the Link style).`; } }
  return '';
}
const sanitize = (section, val, old) => SAN[section](val, old);

// ───────────────────────────── message / embed helpers ─────────────────────────────
const cache = {}, cfg = gid => (cache[gid] ||= (db.configs[gid] = deepFill(defaults(), db.configs[gid])));
const fill = (s, v) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => v[k] !== undefined ? v[k] : m);
const vars = (guild, user, extra = {}) => { const n = new Date(); return { user: user ? `<@${user.id}>` : '', mention: user ? `<@${user.id}>` : '', username: user?.username || '', tag: user?.tag || user?.username || '', id: user?.id || '', server: guild?.name || '', language: guild ? cfg(guild.id).general.language : '', members: guild?.memberCount || '', date: n.toISOString().slice(0, 10), time: n.toISOString().slice(11, 16) + ' UTC', ...extra }; };
const hex = s => parseInt((S.color(s) || '#5865F2').slice(1), 16);
const emptyEmbed = e => !e || !(e.title || e.description || e.image || e.thumbnail || e.fields?.length || e.author?.name || e.footer?.text);
function mkEmbed(e, v, c) {
  if (emptyEmbed(e)) return null; const b = new EmbedBuilder().setColor(hex(e.color || c.general.embedColor));
  if (e.title) b.setTitle(fill(e.title, v).slice(0, 256)); if (e.url && e.title) b.setURL(e.url); if (e.description) b.setDescription(fill(e.description, v).slice(0, 4000));
  if (e.author?.name) b.setAuthor({ name: fill(e.author.name, v).slice(0, 256), iconURL: e.author.icon || undefined, url: e.author.url || undefined });
  const ft = e.footer?.text || c.general.footer; if (ft) b.setFooter({ text: fill(ft, v).slice(0, 2048), iconURL: e.footer?.icon || undefined });
  if (e.thumbnail) b.setThumbnail(e.thumbnail); if (e.image) b.setImage(e.image);
  for (const f of e.fields || []) b.addFields({ name: fill(f.name, v).slice(0, 256), value: fill(f.value, v).slice(0, 1024), inline: !!f.inline });
  if (e.timestamp) b.setTimestamp(); return b;
}
const payload = (c, content, embedOn, embed, v) => { const text = fill(content, v).slice(0, 2000), em = embedOn ? mkEmbed(embed, v, c) : null; if (!text && !em) return null; return { content: text || undefined, embeds: em ? [em] : [], allowedMentions: { parse: ['users'] } }; };
const friendly = e => ({ 50013: 'I am missing permissions (or my role is below the target role/member).', 50001: 'I cannot access that channel or server.', 10003: 'Unknown channel.', 10008: 'Unknown message.', 10011: 'Unknown role.', 10013: 'Unknown user.', 10007: 'That user is not in the server.', 50007: 'That user has DMs closed.', 30010: 'Too many reactions.', 50035: 'Discord rejected the content: ' + String(e?.message || '').slice(0, 160) }[e?.code] || e?.message || 'Unknown error');
const chan = async (g, id) => id ? (g.channels.cache.get(id) || await g.channels.fetch(id).catch(() => null)) : null;
const tokenize = s => (s.match(/"[^"]*"|\S+/g) || []).map(x => x.replace(/^"|"$/g, ''));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseEmoji = s => String(s || '').trim();
const emojiKey = e => e.id || e.name;
const emojiOf = s => { const m = String(s || '').match(/^<a?:(\w+):(\d+)>$/); return m ? m[2] : String(s || '').trim(); };

function attach(client, opts = {}) {
  const guilds = () => [...client.guilds.cache.values()];
  const usage = n => { db.usage[n] = (db.usage[n] || 0) + 1; save('usage.json', db.usage); };

  // ── actions that dashboard users can attach to commands/triggers (validated list, never raw code) ──
  async function runActions(actions, ctx) {
    const errs = [];
    for (const a of actions || []) {
      try {
        const txt = fill(a.text, ctx.v), tm = ctx.target || ctx.member;
        switch (a.type) {
          case 'sendMessage': { const ch = (await chan(ctx.guild, a.channel)) || ctx.channel; if (ch?.send && txt) await ch.send({ content: txt, allowedMentions: { parse: ['users'] } }); break; }
          case 'dm': if (tm?.user && txt) await tm.user.send(txt).catch(() => { }); break;
          case 'addRole': if (tm && a.role) await tm.roles.add(a.role); break;
          case 'removeRole': if (tm && a.role) await tm.roles.remove(a.role); break;
          case 'toggleRole': if (tm && a.role) await (tm.roles.cache.has(a.role) ? tm.roles.remove(a.role) : tm.roles.add(a.role)); break;
          case 'react': if (ctx.message && a.emoji) await ctx.message.react(a.emoji.replace(/^<a?:(\w+:\d+)>$/, '$1')); break;
          case 'timeout': if (tm) await tm.timeout(a.minutes * 60000, 'Custom action'); break;
          case 'kick': if (tm) await tm.kick('Custom action'); break;
          case 'ban': if (tm) await ctx.guild.members.ban(tm.id, { reason: 'Custom action' }); break;
          case 'nickname': if (tm) await tm.setNickname(txt.slice(0, 32) || null); break;
          case 'deleteTrigger': if (ctx.message) await ctx.message.delete().catch(() => { }); break;
        }
      } catch (e) { errs.push(`${a.type}: ${friendly(e)}`); }
    }
    return errs;
  }

  // ── logging ──
  async function postLog(guild, key, desc, extra = {}) {
    try {
      const c = cfg(guild.id), l = c.logging[key], chId = (c.general.features.logging && l?.enabled && l.channel) || extra.channel; if (!chId) return;
      const ch = await chan(guild, chId); if (!ch?.send) return;
      const b = new EmbedBuilder().setColor(hex(l?.color)).setTitle((l?.title || key).slice(0, 256)).setDescription(String(desc).slice(0, 4000)).setTimestamp();
      if (l?.footer) b.setFooter({ text: fill(l.footer, vars(guild)).slice(0, 2048) });
      await ch.send({ embeds: [b], allowedMentions: { parse: [] } });
    } catch (e) { err('log:' + key, e); }
  }

  // ── moderation ──
  async function recordMod(guild, entry) {
    const e = { id: rid(), t: Date.now(), g: guild.id, ...entry }; db.modlog.unshift(e); db.modlog.length = Math.min(db.modlog.length, 3000); save('modlog.json', db.modlog);
    act(guild.id, `${e.type}: ${e.user?.tag || e.user?.id || ''} by ${e.mod}`);
    await postLog(guild, 'moderation', `**${e.type.toUpperCase()}** • ${e.user?.tag || ''} ${e.user?.id ? '(' + e.user.id + ')' : ''}\nModerator: ${e.mod}\nReason: ${e.reason}${e.minutes ? `\nDuration: ${e.minutes} min` : ''}`, { channel: cfg(guild.id).moderation.logChannel });
    return e;
  }
  async function addWarn(guild, user, reason, mod) {
    const w = ((db.warns[guild.id] ||= {})[user.id] ||= []); w.push({ id: rid(), t: Date.now(), reason, mod }); save('warnings.json', db.warns);
    const pun = cfg(guild.id).moderation.punishments.find(p => p.warns === w.length); let applied = '';
    if (pun) { try { await modAction(guild, pun.action, { userId: user.id, reason: `Reached ${w.length} warnings`, minutes: pun.minutes, mod: 'AutoMod' }); applied = pun.action; } catch (e) { err('auto-punish', e); } }
    return { count: w.length, applied };
  }
  async function modAction(guild, type, o) {
    const c = cfg(guild.id), reason = S.str(o.reason, 400) || 'No reason given', mod = o.mod || 'Dashboard', uid = S.snow(o.userId);
    if (type !== 'clear' && !uid) throw new Error('Enter a valid user ID (numbers only).');
    const mem = uid ? await guild.members.fetch(uid).catch(() => null) : null, user = mem?.user || (uid ? await client.users.fetch(uid).catch(() => null) : null);
    const entry = { type, user: { id: uid, tag: user?.tag || user?.username || uid }, mod, reason, minutes: 0 };
    const dm = async text => { if (c.moderation.dmUser && user) await user.send(text).catch(() => { }); };
    switch (type) {
      case 'warn': { if (!user) throw new Error('User not found.'); const r = await addWarn(guild, user, reason, mod); entry.reason = `${reason} (warning #${r.count}${r.applied ? ', ' + r.applied + ' applied' : ''})`; await dm(`⚠️ You were warned in **${guild.name}**: ${reason}`); break; }
      case 'kick': if (!mem) throw new Error('That member is not in the server.'); if (!mem.kickable) throw new Error('I cannot kick that member (their role is above mine).'); await dm(`👢 You were kicked from **${guild.name}**: ${reason}`); await mem.kick(`${reason} (by ${mod})`); break;
      case 'ban': if (mem && !mem.bannable) throw new Error('I cannot ban that member (their role is above mine).'); await dm(`🔨 You were banned from **${guild.name}**: ${reason}`); await guild.members.ban(uid, { reason: `${reason} (by ${mod})` }); break;
      case 'unban': await guild.members.unban(uid, reason); break;
      case 'timeout': { if (!mem) throw new Error('That member is not in the server.'); if (!mem.moderatable) throw new Error('I cannot timeout that member.'); entry.minutes = S.int(o.minutes, 1, 40320, 10); await mem.timeout(entry.minutes * 60000, reason); await dm(`🔇 You were timed out in **${guild.name}** for ${entry.minutes} min: ${reason}`); break; }
      case 'untimeout': if (!mem) throw new Error('That member is not in the server.'); await mem.timeout(null, reason); break;
      case 'clear': { const ch = await chan(guild, o.channelId); if (!ch?.bulkDelete) throw new Error('Choose a text channel.'); const n = await ch.bulkDelete(S.int(o.count, 1, 100, 10), true); entry.user = { id: '', tag: '#' + ch.name }; entry.reason = `${n.size} messages deleted`; break; }
      default: throw new Error('Unknown action.');
    }
    return recordMod(guild, entry);
  }

  // ── auto moderation ──
  const spam = new Map(), wordRe = {};
  const exempt = (m, c, chId) => { const mo = c.moderation; return m.permissions.has(PF.Administrator) || m.permissions.has(PF.ManageMessages) || mo.ignoredChannels.includes(chId) || mo.ignoredRoles.some(r => m.roles.cache.has(r)) || mo.staffRoles.some(r => m.roles.cache.has(r)); };
  async function automod(m, c) {
    const a = c.moderation.automod, txt = m.content || ''; let hit = null;
    if (a.words.enabled && a.words.list.length) { const key = a.words.list.join('\n'); if (wordRe[m.guild.id]?.key !== key) wordRe[m.guild.id] = { key, re: new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${a.words.list.map(esc).join('|')})(?:$|[^\\p{L}\\p{N}])`, 'iu') }; if (wordRe[m.guild.id].re.test(txt)) hit = ['Blocked word', a.words]; }
    if (!hit && a.invites.enabled) { const mm = txt.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)/i); if (mm && !a.invites.list.map(x => x.toLowerCase()).includes(mm[1].toLowerCase())) hit = ['Discord invite', a.invites]; }
    if (!hit && a.links.enabled) { for (const u of txt.match(/https?:\/\/[^\s]+|www\.[^\s]+/gi) || []) { let host = ''; try { host = new URL(u.startsWith('www.') ? 'http://' + u : u).hostname.toLowerCase(); } catch { } if (host && !a.links.list.some(d => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()))) { hit = ['Link', a.links]; break; } } }
    if (!hit && a.caps.enabled) { const L = txt.replace(/[^\p{L}]/gu, ''); if (L.length >= a.caps.minLength && (L.replace(/[^\p{Lu}]/gu, '').length / L.length) * 100 >= a.caps.percent) hit = ['Too many capitals', a.caps]; }
    if (!hit && a.spam.enabled) { const k = m.guild.id + m.author.id, now = Date.now(), arr = (spam.get(k) || []).filter(t => now - t < a.spam.seconds * 1000); arr.push(now); spam.set(k, arr); if (arr.length >= a.spam.max) { spam.delete(k); hit = ['Spam', a.spam]; } }
    if (!hit) return false;
    const [why, rule] = hit; await m.delete().catch(() => { });
    try { if (rule.action === 'warn') await modAction(m.guild, 'warn', { userId: m.author.id, reason: 'AutoMod: ' + why, mod: 'AutoMod' }); else if (['timeout', 'kick', 'ban'].includes(rule.action)) await modAction(m.guild, rule.action, { userId: m.author.id, reason: 'AutoMod: ' + why, minutes: rule.minutes, mod: 'AutoMod' }); else await recordMod(m.guild, { type: 'automod', user: { id: m.author.id, tag: m.author.tag || m.author.username }, mod: 'AutoMod', reason: why, minutes: 0 }); } catch (e) { err('automod', e); }
    if (c.moderation.notice) { const n = await m.channel.send({ content: fill(c.moderation.notice, vars(m.guild, m.author)), allowedMentions: { users: [m.author.id] } }).catch(() => null); if (n && c.moderation.noticeSeconds) setTimeout(() => n.delete().catch(() => { }), c.moderation.noticeSeconds * 1000); }
    return true;
  }

  // ── custom commands (text + slash) ──
  const cd = new Map(), reserved = () => new Set([...(client.commands?.keys?.() || []), 'ticket']);
  const memberOk = (m, cmd) => !!m && (!cmd.perms.length || cmd.perms.every(p => m.permissions.has(PF[p]))) && (!cmd.roles.length || m.permissions.has(PF.Administrator) || cmd.roles.some(r => m.roles.cache.has(r)));
  const cool = (gid, uid, cmd) => { if (!cmd.cooldown) return 0; const k = gid + uid + cmd.id, left = (cd.get(k) || 0) - Date.now(); if (left > 0) return Math.ceil(left / 1000); cd.set(k, Date.now() + cmd.cooldown * 1000); return 0; };
  async function runCommand(cmd, ctx, reply, c) {
    const out = payload(c, cmd.response, cmd.embedOn, cmd.embed, ctx.v); await reply(out || { content: cmd.actions.length ? '✅ Done.' : '\u200b' });
    const errs = await runActions(cmd.actions, ctx); usage('custom:' + cmd.name); postLog(ctx.guild, 'command', `<@${ctx.user.id}> used \`${cmd.name}\` in <#${ctx.channel?.id}>`);
    if (errs.length) err('command ' + cmd.name, errs.join('; '));
  }
  async function onText(m, c) {
    const p = c.general.prefix; if (!p || !m.content.startsWith(p)) return false; const toks = tokenize(m.content.slice(p.length)), name = (toks.shift() || '').toLowerCase(); if (!name || reserved().has(name)) return false;
    const cmd = c.commands.find(x => x.enabled && x.type !== 'slash' && (x.name === name || x.aliases.includes(name))); if (!cmd) return false;
    const reply = o => m.reply({ ...o, allowedMentions: { parse: ['users'], repliedUser: false } });
    if (!memberOk(m.member, cmd)) { await reply({ content: c.general.permMessage }); return true; }
    const left = cool(m.guild.id, m.author.id, cmd); if (left) { await reply({ content: fill(c.general.cooldownMessage, { seconds: left }) }); return true; }
    const req = cmd.args.filter(a => a.required).length; if (toks.length < req) { await reply({ content: `Usage: \`${p}${cmd.name} ${cmd.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')}\`` }); return true; }
    const v = vars(m.guild, m.author, { args: toks.join(' '), channel: `<#${m.channelId}>` }); let target = null;
    cmd.args.forEach((a, n) => { let val = toks[n] ?? ''; if (n === cmd.args.length - 1 && a.type === 'string') val = toks.slice(n).join(' '); const id = (val.match(/\d{15,25}/) || [])[0]; v[a.name] = a.type === 'user' && id ? `<@${id}>` : a.type === 'role' && id ? `<@&${id}>` : a.type === 'channel' && id ? `<#${id}>` : val; v['arg' + (n + 1)] = v[a.name]; if (a.type === 'user' && id && !target) target = id; });
    cmd.args.length || toks.forEach((t, n) => { v['arg' + (n + 1)] = t; });
    const tm = target ? await m.guild.members.fetch(target).catch(() => null) : null;
    await runCommand(cmd, { guild: m.guild, member: m.member, user: m.author, channel: m.channel, message: m, v, target: tm }, reply, c); return true;
  }
  async function onSlash(i, c) {
    const cmd = c.commands.find(x => x.enabled && x.type !== 'text' && x.name === i.commandName); if (!cmd) return;
    const reply = o => i.reply({ ...o, allowedMentions: { parse: ['users'] }, flags: cmd.ephemeral ? 64 : undefined });
    if (!memberOk(i.member, cmd)) return i.reply({ content: c.general.permMessage, flags: 64 });
    const left = cool(i.guild.id, i.user.id, cmd); if (left) return i.reply({ content: fill(c.general.cooldownMessage, { seconds: left }), flags: 64 });
    const v = vars(i.guild, i.user, { channel: `<#${i.channelId}>` }); let target = null, all = [];
    for (const a of cmd.args) { const o = i.options.get(a.name); if (!o) { v[a.name] = ''; continue; } const val = a.type === 'user' ? `<@${o.value}>` : a.type === 'role' ? `<@&${o.value}>` : a.type === 'channel' ? `<#${o.value}>` : String(o.value); v[a.name] = val; v['arg' + (all.length + 1)] = val; all.push(val); if (a.type === 'user' && !target) target = o.value; }
    v.args = all.join(' '); const tm = target ? await i.guild.members.fetch(target).catch(() => null) : null;
    await runCommand(cmd, { guild: i.guild, member: i.member, user: i.user, channel: i.channel, v, target: tm }, reply, c);
  }
  async function onAutoResponse(m, c) {
    const txt = m.content; if (!txt) return;
    for (const r of c.automation.autoResponses) {
      if (!r.enabled || (r.channels.length && !r.channels.includes(m.channelId))) continue; const lo = txt.toLowerCase(), t = r.trigger.toLowerCase();
      const ok = r.match === 'exact' ? lo === t : r.match === 'starts' ? lo.startsWith(t) : r.match === 'regex' ? (() => { try { return new RegExp(r.trigger, 'i').test(txt); } catch { return false; } })() : lo.includes(t); if (!ok) continue;
      const k = 'ar' + m.guild.id + r.id + (r.cooldown ? '' : m.id); if (r.cooldown) { const left = (cd.get(k) || 0) - Date.now(); if (left > 0) continue; cd.set(k, Date.now() + r.cooldown * 1000); }
      const out = payload(c, r.response, r.embedOn, r.embed, vars(m.guild, m.author, { channel: `<#${m.channelId}>` })); if (out) await (r.reply ? m.reply({ ...out, allowedMentions: { parse: ['users'], repliedUser: false } }) : m.channel.send(out)); return;
    }
  }

  // ── roles: panels, verification ──
  async function toggleRole(i, roleId) { const has = i.member.roles.cache.has(roleId); await (has ? i.member.roles.remove(roleId) : i.member.roles.add(roleId)); return !has; }
  async function onComponent(i) {
    const c = cfg(i.guild.id), id = i.customId, ok = t => i.reply({ content: t, flags: 64 }); if (!c.general.features.roles && id !== 'ws:verify') return ok('This feature is turned off.');
    try {
      if (id === 'ws:verify') { const v = c.verification; if (!v.enabled || !v.role) return ok('Verification is not set up.'); if (i.member.roles.cache.has(v.role)) return ok('✅ You are already verified.'); await i.member.roles.add(v.role); if (v.removeRole) await i.member.roles.remove(v.removeRole).catch(() => { }); return ok('✅ You are verified! Welcome.'); }
      const [, kind, pid, rid2] = id.split(':');
      if (kind === 'rr') { const p = c.roles.panels.find(x => x.id === pid); if (!p || !p.items.some(x => x.role === rid2)) return ok('This role menu no longer exists.'); const added = await toggleRole(i, rid2); if (added && p.exclusive) for (const o of p.items) if (o.role !== rid2 && i.member.roles.cache.has(o.role)) await i.member.roles.remove(o.role).catch(() => { }); return ok(`${added ? '✅ Added' : '➖ Removed'} <@&${rid2}>`); }
      if (kind === 'rs') { const p = c.roles.panels.find(x => x.id === pid); if (!p) return ok('This role menu no longer exists.'); const chosen = new Set(i.values.filter(v => p.items.some(x => x.role === v))); for (const o of p.items) { const has = i.member.roles.cache.has(o.role); if (chosen.has(o.role) && !has) await i.member.roles.add(o.role); if (!chosen.has(o.role) && has) await i.member.roles.remove(o.role); } return ok('✅ Roles updated.'); }
      if (kind === 'eb') { const e = c.embeds.find(x => x.id === pid); if (!e || !e.buttons.some(x => x.role === rid2)) return ok('This button is no longer active.'); return ok(`${await toggleRole(i, rid2) ? '✅ Added' : '➖ Removed'} <@&${rid2}>`); }
      if (kind === 'es') { const e = c.embeds.find(x => x.id === pid); if (!e) return ok('This menu is no longer active.'); const v = i.values[0]; if (!e.select.options.some(x => x.role === v)) return ok('Unknown option.'); return ok(`${await toggleRole(i, v) ? '✅ Added' : '➖ Removed'} <@&${v}>`); }
    } catch (e) { return ok('❌ ' + friendly(e)); }
  }
  const rowsOf = btns => { const rows = []; for (let n = 0; n < btns.length; n += 5) rows.push(new ActionRowBuilder().addComponents(btns.slice(n, n + 5))); return rows; };
  async function sendOrEdit(guild, chId, msgId, body) {
    const ch = await chan(guild, chId); if (!ch?.send) throw new Error('Choose a text channel I can send messages in.');
    if (msgId) { const m = await ch.messages.fetch(msgId).catch(() => null); if (m && m.author.id === client.user.id) return m.edit(body); }
    return ch.send(body);
  }
  async function publishRolePanel(guild, pid) {
    const c = cfg(guild.id), p = c.roles.panels.find(x => x.id === pid); if (!p) throw new Error('Role menu not found.'); if (!p.channel) throw new Error('Choose a channel first.'); if (!p.items.length) throw new Error('Add at least one role first.');
    const emb = new EmbedBuilder().setColor(hex(p.color || c.general.embedColor)).setTitle(p.title || p.name || 'Roles').setDescription((p.description || 'Pick your roles below.') + (p.type === 'reaction' ? '\n\n' + p.items.map(x => `${x.emoji || '•'} → <@&${x.role}>`).join('\n') : ''));
    const body = { embeds: [emb], components: [] };
    if (p.type === 'button') body.components = rowsOf(p.items.slice(0, 25).map(x => { const b = new ButtonBuilder().setCustomId(`ws:rr:${p.id}:${x.role}`).setStyle(ButtonStyle.Secondary).setLabel(x.label || 'Role'); if (x.emoji) b.setEmoji(parseEmoji(x.emoji)); return b; }));
    if (p.type === 'select') body.components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ws:rs:${p.id}`).setPlaceholder('Choose your roles').setMinValues(0).setMaxValues(p.exclusive ? 1 : p.items.length).addOptions(p.items.map(x => ({ label: (x.label || 'Role').slice(0, 100), value: x.role, description: x.description || undefined, emoji: x.emoji ? parseEmoji(x.emoji) : undefined }))))];
    const m = await sendOrEdit(guild, p.channel, p.messageId, body); p.messageId = m.id; save('configs.json', db.configs);
    if (p.type === 'reaction') { await m.reactions.removeAll().catch(() => { }); for (const x of p.items) if (x.emoji) await m.react(x.emoji.replace(/^<a?:(\w+:\d+)>$/, '$1')).catch(() => { }); }
    return m;
  }
  async function publishVerification(guild) {
    const c = cfg(guild.id), v = c.verification; if (!v.channel || !v.role) throw new Error('Choose a channel and the verified role first.');
    const emb = new EmbedBuilder().setColor(hex(v.color || c.general.embedColor)).setTitle(v.title || 'Verification').setDescription(v.description || 'Press the button to verify.');
    const m = await sendOrEdit(guild, v.channel, v.messageId, { embeds: [emb], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ws:verify').setStyle(ButtonStyle.Success).setLabel(v.button || 'Verify'))] }); v.messageId = m.id; save('configs.json', db.configs); return m;
  }
  async function publishEmbed(guild, eid, channelId) {
    const c = cfg(guild.id), e = c.embeds.find(x => x.id === eid); if (!e) throw new Error('Embed not found.'); const chId = channelId || e.channel; if (!chId) throw new Error('Choose a channel first.');
    if (channelId && channelId !== e.channel) { e.channel = channelId; e.messageId = ''; }
    const v = vars(guild, client.user), em = mkEmbed(e.embed, v, c), text = fill(e.content, v).slice(0, 2000); if (!em && !text) throw new Error('The embed is empty. Add a title, description or message text.');
    const comps = [], btns = e.buttons.map(b => { const x = new ButtonBuilder().setLabel(b.label || '\u200b'); if (b.emoji) x.setEmoji(parseEmoji(b.emoji)); if (b.style === 'Link') return x.setStyle(ButtonStyle.Link).setURL(b.url); return x.setStyle(ButtonStyle[b.style]).setCustomId(`ws:eb:${e.id}:${b.role}`); });
    if (btns.length) comps.push(...rowsOf(btns)); if (e.select.enabled && e.select.options.length) comps.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ws:es:${e.id}`).setPlaceholder(e.select.placeholder || 'Choose…').addOptions(e.select.options.map(o => ({ label: o.label, value: o.role, description: o.description || undefined })))));
    const m = await sendOrEdit(guild, e.channel, e.messageId, { content: text || null, embeds: em ? [em] : [], components: comps, allowedMentions: { parse: [] } }); e.messageId = m.id; save('configs.json', db.configs); return m;
  }

  // ── slash command registration (never replaces other commands) ──
  async function syncSlash(guild) {
    const c = cfg(guild.id), meta = (db.meta[guild.id] ||= { slash: {} }), res = { created: [], updated: [], deleted: [], skipped: [] }, res2 = reserved();
    const want = c.general.features.customCommands ? c.commands.filter(x => x.enabled && x.type !== 'text') : [], have = await guild.commands.fetch(), T = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8 };
    for (const x of want) {
      if (res2.has(x.name)) { res.skipped.push(`${x.name} (name already used by an existing command)`); continue; }
      if (!/^[\p{Ll}\p{N}_-]{1,32}$/u.test(x.name)) { res.skipped.push(`${x.name} (slash names must be lowercase)`); continue; }
      const data = { name: x.name, description: x.description.slice(0, 100), options: [...x.args].sort((a, b) => b.required - a.required).map(a => ({ name: a.name, description: a.description.slice(0, 100), type: T[a.type], required: a.required })) }, ex = have.find(h => h.name === x.name);
      try { if (ex) { await guild.commands.edit(ex.id, data); res.updated.push(x.name); meta.slash[x.name] = ex.id; } else { const n = await guild.commands.create(data); res.created.push(x.name); meta.slash[x.name] = n.id; } } catch (e) { res.skipped.push(`${x.name} (${friendly(e)})`); }
    }
    for (const [name, id] of Object.entries(meta.slash)) if (!want.some(x => x.name === name)) { await guild.commands.delete(id).catch(() => { }); delete meta.slash[name]; res.deleted.push(name); }
    save('meta.json', db.meta); return res;
  }
  async function applyPresence() {
    for (const g of guilds()) { const b = cfg(g.id).bot; if (!b.statusOn) continue; const txt = fill(b.activityText, { members: g.memberCount, server: g.name }).slice(0, 128), AT = { Custom: 4, Playing: 0, Watching: 3, Listening: 2, Competing: 5 }[b.activityType] ?? 4;
      client.user.setPresence({ status: b.status, activities: txt ? [AT === 4 ? { name: 'Custom Status', type: 4, state: txt } : { name: txt, type: AT }] : [] }); return; }
  }

  // ── events ──
  const guard = (name, fn) => client.on(name, async (...a) => { try { await fn(...a); } catch (e) { err(name, e); } });
  async function fireTriggers(guild, event, x) {
    const c = cfg(guild.id); if (!c.general.features.triggers) return;
    for (const t of c.automation.triggers) { if (!t.enabled || t.event !== event || (event === 'roleAdded' && t.role !== x.roleId)) continue; const errs = await runActions(t.actions, { guild, member: x.member, user: x.user, v: vars(guild, x.user) }); if (errs.length) err('trigger ' + (t.name || t.id), errs.join('; ')); }
  }
  guard('guildMemberAdd', async m => {
    const c = cfg(m.guild.id), v = vars(m.guild, m.user);
    if (c.general.features.welcome) {
      const ar = c.autoRoles; if (ar.enabled) { const roles = m.user.bot ? ar.botRoles : ar.roles, go = async () => { for (const r of roles) await m.roles.add(r).catch(e => err('auto role', e)); }; ar.delaySeconds ? setTimeout(go, ar.delaySeconds * 1000) : await go(); }
      const w = c.welcome; if (w.enabled && w.channel) { const ch = await chan(m.guild, w.channel), p = payload(c, w.content, w.embedOn, w.embed, v); if (ch?.send && p) await ch.send(p).catch(e => err('welcome', e)); }
      if (w.enabled && w.dm && w.dmText && !m.user.bot) await m.send(fill(w.dmText, v)).catch(() => { });
    }
    await postLog(m.guild, 'memberJoin', `${m.user} (${m.user.tag}) joined. Account created <t:${Math.floor(m.user.createdTimestamp / 1000)}:R>. Members: ${m.guild.memberCount}`);
    await fireTriggers(m.guild, 'memberJoin', { member: m, user: m.user });
  });
  guard('guildMemberRemove', async m => {
    const c = cfg(m.guild.id), g = c.goodbye, v = vars(m.guild, m.user);
    if (c.general.features.welcome && g.enabled && g.channel) { const ch = await chan(m.guild, g.channel), p = payload(c, g.content, g.embedOn, g.embed, v); if (ch?.send && p) await ch.send(p).catch(e => err('goodbye', e)); }
    await postLog(m.guild, 'memberLeave', `${m.user} (${m.user.tag}) left. Members: ${m.guild.memberCount}`);
    await fireTriggers(m.guild, 'memberLeave', { member: null, user: m.user });
  });
  guard('messageCreate', async m => {
    if (m.author.bot || !m.guild) return; const c = cfg(m.guild.id), f = c.general.features; m.member ??= await m.guild.members.fetch(m.author.id).catch(() => null); if (!m.member) return;
    if (f.automod && !exempt(m.member, c, m.channelId) && await automod(m, c)) return;
    if (f.customCommands && await onText(m, c)) return;
    if (f.autoResponses) await onAutoResponse(m, c);
  });
  client.on('interactionCreate', async i => {
    try { if (!i.guild) return; if (i.isChatInputCommand()) { const c = cfg(i.guild.id); if (c.general.features.customCommands) await onSlash(i, c); } else if ((i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('ws:')) await onComponent(i); }
    catch (e) { err('interaction', e); if (!i.replied && !i.deferred) i.reply({ content: cfg(i.guild.id).general.errorMessage, flags: 64 }).catch(() => { }); }
  });
  const reactRole = async (r, u, add) => {
    if (u.bot) return; if (r.partial) await r.fetch().catch(() => { }); const g = r.message.guild; if (!g) return; const c = cfg(g.id); if (!c.general.features.roles) return;
    const p = c.roles.panels.find(x => x.type === 'reaction' && x.messageId === r.message.id); if (!p) return; const it = p.items.find(x => emojiOf(x.emoji) === emojiKey(r.emoji) || emojiOf(x.emoji) === r.emoji.name); if (!it) return;
    const m = await g.members.fetch(u.id).catch(() => null); if (m) await (add ? m.roles.add(it.role) : m.roles.remove(it.role)).catch(e => err('reaction role', e));
  };
  guard('messageReactionAdd', (r, u) => reactRole(r, u, true)); guard('messageReactionRemove', (r, u) => reactRole(r, u, false));
  const clip = (s, n = 900) => String(s || '').slice(0, n).replace(/`/g, "'");
  guard('messageDelete', async m => { if (!m.guild || m.author?.bot) return; await postLog(m.guild, 'messageDelete', `Message by ${m.author ? `${m.author} (${m.author.tag})` : 'unknown'} deleted in <#${m.channelId}>\n${m.content ? '```' + clip(m.content, 1500) + '```' : '*content was not cached*'}`); });
  guard('messageUpdate', async (o, n) => { if (!n.guild || n.author?.bot || o.content == null || o.content === n.content) return; await postLog(n.guild, 'messageEdit', `${n.author} edited a message in <#${n.channelId}> ([jump](${n.url}))\n**Before:** ${clip(o.content)}\n**After:** ${clip(n.content)}`); });
  guard('roleCreate', r => postLog(r.guild, 'roleChange', `Role created: **${r.name}**`));
  guard('roleDelete', r => postLog(r.guild, 'roleChange', `Role deleted: **${r.name}**`));
  guard('roleUpdate', (o, n) => { if (o.name !== n.name || o.permissions.bitfield !== n.permissions.bitfield) return postLog(n.guild, 'roleChange', `Role updated: **${o.name}**${o.name !== n.name ? ` → **${n.name}**` : ''}${o.permissions.bitfield !== n.permissions.bitfield ? '\nPermissions changed' : ''}`); });
  guard('guildMemberUpdate', async (o, n) => {
    const add = n.roles.cache.filter(r => !o.roles.cache.has(r.id)), rem = o.roles.cache.filter(r => !n.roles.cache.has(r.id));
    if (add.size || rem.size) await postLog(n.guild, 'roleChange', `${n.user} roles changed${add.size ? '\n➕ ' + add.map(r => r.name).join(', ') : ''}${rem.size ? '\n➖ ' + rem.map(r => r.name).join(', ') : ''}`);
    for (const r of add.values()) await fireTriggers(n.guild, 'roleAdded', { member: n, user: n.user, roleId: r.id });
    if (!o.premiumSince && n.premiumSince) await fireTriggers(n.guild, 'boost', { member: n, user: n.user });
  });
  guard('channelCreate', ch => ch.guild && postLog(ch.guild, 'channelChange', `Channel created: **#${ch.name}**`));
  guard('channelDelete', ch => ch.guild && postLog(ch.guild, 'channelChange', `Channel deleted: **#${ch.name}**`));
  guard('channelUpdate', (o, n) => n.guild && (o.name !== n.name || o.topic !== n.topic || o.parentId !== n.parentId) && postLog(n.guild, 'channelChange', `Channel updated: <#${n.id}>${o.name !== n.name ? `\nName: ${o.name} → ${n.name}` : ''}${o.topic !== n.topic ? '\nTopic changed' : ''}${o.parentId !== n.parentId ? '\nMoved to another category' : ''}`));
  guard('voiceStateUpdate', async (o, n) => {
    const u = n.member?.user || o.member?.user; if (!u || u.bot || o.channelId === n.channelId) return;
    await postLog(n.guild, 'voice', !o.channelId ? `${u} joined <#${n.channelId}>` : !n.channelId ? `${u} left <#${o.channelId}>` : `${u} moved <#${o.channelId}> → <#${n.channelId}>`);
    if (!o.channelId && n.channelId) await fireTriggers(n.guild, 'voiceJoin', { member: n.member, user: u });
  });
  const seen = (g, id) => db.modlog.some(e => e.g === g && e.user?.id === id && Date.now() - e.t < 8000);
  guard('guildBanAdd', b => !seen(b.guild.id, b.user.id) && postLog(b.guild, 'moderation', `**BAN** • ${b.user.tag} (${b.user.id})\nReason: ${b.reason || 'none'}`, { channel: cfg(b.guild.id).moderation.logChannel }));
  guard('guildBanRemove', b => !seen(b.guild.id, b.user.id) && postLog(b.guild, 'moderation', `**UNBAN** • ${b.user.tag} (${b.user.id})`, { channel: cfg(b.guild.id).moderation.logChannel }));
  client.on('error', e => err('client', e));

  // ── scheduled announcements ──
  async function tick() {
    const now = Date.now();
    for (const g of guilds()) {
      const c = cfg(g.id); if (!c.general.features.scheduled) continue; let dirty = false;
      for (const s of c.automation.scheduled) {
        if (!s.enabled || !s.channel) continue; let due = false; const off = c.general.utcOffset * 3600e3, loc = new Date(now + off);
        if (s.mode === 'interval') { if (!s.last) { s.last = now; dirty = true; continue; } due = now - s.last >= s.everyMinutes * 60000; }
        else due = loc.toISOString().slice(11, 16) === s.time && !(s.last && new Date(s.last + off).toISOString().slice(0, 10) === loc.toISOString().slice(0, 10));
        if (!due) continue; s.last = now; dirty = true; const ch = await chan(g, s.channel), p = payload(c, s.content, s.embedOn, s.embed, vars(g));
        if (ch?.send && p) { await ch.send(p).catch(e => err('scheduled ' + (s.name || s.id), e)); act(g.id, `Scheduled message sent: ${s.name || s.id}`); }
      }
      if (dirty) save('configs.json', db.configs);
    }
  }
  const wrapCommands = () => { try { for (const c of client.commands?.values?.() || []) if (typeof c.run === 'function' && !c.__ws) { const o = c.run, n = c.data?.name || 'command'; c.run = function (...a) { usage(n); return o.apply(this, a); }; c.__ws = true; } } catch (e) { err('wrapCommands', e); } };
  const boot = () => { wrapCommands(); setInterval(tick, 30000); setTimeout(async () => { for (const g of guilds()) await syncSlash(g).catch(e => err('slash sync', e)); applyPresence(); }, 14000); };
  client.isReady() ? boot() : client.once(D.Events?.ClientReady || 'ready', boot);
  client.on(D.Events?.ShardReady || 'shardReady', () => setTimeout(applyPresence, 4000));

  // ───────────────────────────── web server ─────────────────────────────
  const PUBLIC = (ENV.PUBLIC_URL || '').replace(/\/$/, ''), secure = PUBLIC.startsWith('https'), PASS = ENV.WEBSITE_PASSWORD || ENV.DASHBOARD_PASSWORD || '';
  const sessions = new Map(), limits = new Map(); let own = false;
  const sha = s => crypto.createHash('sha256').update(String(s)).digest();
  const json = (r, code, o) => { r.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); r.end(JSON.stringify(o)); };
  const cookies = q => Object.fromEntries((q.headers.cookie || '').split(';').map(x => x.trim().split(/=(.*)/s)).filter(x => x[0]).map(x => [x[0], decodeURIComponent(x[1] || '')]));
  // One login for everything: also signs the person in to the ticket dashboard (same server) so the Tickets page opens without a second login.
  const ticketLogin = async (r, password) => { if (!global.__TICKET_HTTP) return; try { const port = Number(ENV.DASHBOARD_PORT || ENV.PORT) || 3000, res = await fetch(`http://127.0.0.1:${port}/auth/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); if (!res.ok) return; const ck = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).filter(c => c.startsWith('tsid=')); if (!ck.length) return; r.setHeader('Set-Cookie', [].concat(r.getHeader('Set-Cookie') || [], `${ck[0]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`)); } catch { } };
  const setCookie = (r, n, v, age) => { const a = r.getHeader('Set-Cookie') || []; r.setHeader('Set-Cookie', [].concat(a, `${n}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`)); };
  const ipOf = q => String(q.headers['x-forwarded-for'] || q.socket.remoteAddress || '').split(',')[0].trim();
  const limit = (key, max, ms) => { const now = Date.now(), e = limits.get(key); if (!e || e.reset < now) { limits.set(key, { n: 1, reset: now + ms }); return true; } return ++e.n <= max; };
  setInterval(() => { const now = Date.now(); for (const [k, v] of limits) if (v.reset < now) limits.delete(k); for (const [k, s] of sessions) if (now - s.created > 7 * 864e5) sessions.delete(k); }, 60000).unref?.();
  const readBody = (q, max = 3e6) => new Promise((ok, no) => { let n = 0; const b = []; q.on('data', c => { n += c.length; if (n > max) { no(Object.assign(new Error('Request too large'), { status: 413 })); q.destroy(); } else b.push(c); }); q.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString()) : {}); } catch { no(Object.assign(new Error('Invalid JSON'), { status: 400 })); } }); q.on('error', no); });
  async function accessFor(uid) {
    const owners = (ENV.DASHBOARD_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean), isOwner = owners.includes(uid), out = {};
    for (const g of guilds()) { const m = await g.members.fetch(uid).catch(() => null), c = cfg(g.id); let lv = isOwner ? 'admin' : ''; if (m) { if (m.permissions.has(PF.Administrator) || c.access.adminRoles.some(r => m.roles.cache.has(r))) lv = 'admin'; else if (!lv && c.access.modRoles.some(r => m.roles.cache.has(r))) lv = 'mod'; } if (lv) out[g.id] = lv; }
    return out;
  }
  const levels = s => s.pw ? Object.fromEntries(guilds().map(g => [g.id, 'admin'])) : s.guilds || {};
  const session = async q => { const s = sessions.get(cookies(q).ws_sid); if (!s) return null; if (!s.pw && Date.now() - s.t > 600000) { s.guilds = await accessFor(s.user.id).catch(() => s.guilds); s.t = Date.now(); } return s; };

  // history / backups
  function snapshot(gid, user, section, name, manual) {
    const snap = JSON.stringify(cfg(gid)), list = db.history, last = list.find(h => h.g === gid);
    if (!manual && last && last.snap === snap) return; if (!manual && last && !last.manual && last.user === user && last.section === section && Date.now() - last.t < 60000) { last.snap = snap; last.t = Date.now(); }
    else list.unshift({ g: gid, t: Date.now(), user, section, name: name || '', manual: !!manual, snap });
    let a = 0, b = 0; db.history = list.filter(h => h.g !== gid || (h.manual ? ++b <= 15 : ++a <= 25)); save('history.json', db.history);
  }
  const commit = (gid, section, value, user) => { cfg(gid)[section] = value; db.configs[gid] = cache[gid]; save('configs.json', db.configs, true); snapshot(gid, user, section); };
  const applyAll = (gid, src, user) => { const c = cfg(gid), n = []; for (const k of SECTIONS) if (src?.[k] !== undefined) { const v = sanitize(k, src[k], c[k]), bad = check(k, v); if (bad) throw new Error(bad); c[k] = v; n.push(k); } db.configs[gid] = c; save('configs.json', db.configs, true); return n; };
  let slashT = {}; const queueSlash = g => { clearTimeout(slashT[g.id]); slashT[g.id] = setTimeout(() => syncSlash(g).catch(e => err('slash sync', e)), 2500); };

  // ── API ──
  const H = {}, MODOK = new Set(['GET /status', 'GET /overview', 'GET /guild', 'GET /config', 'GET /mod/warnings', 'GET /mod/log', 'POST /mod/action', 'DELETE /mod/warnings']);
  H['GET /status'] = () => ({ online: client.isReady(), ping: client.ws?.ping, uptime: Math.floor(process.uptime()), tag: client.user?.tag, avatar: client.user?.displayAvatarURL?.({ size: 64 }), status: client.user?.presence?.status || 'online' });
  H['GET /overview'] = ({ guild: g, s }) => { const c = cfg(g.id), usageTop = Object.entries(db.usage).sort((a, b) => b[1] - a[1]).slice(0, 10); let tickets = null; try { tickets = global.__ticketStats?.() || null; } catch { }
    return { bot: { tag: client.user?.tag, avatar: client.user?.displayAvatarURL?.({ size: 128 }), online: client.isReady(), status: client.user?.presence?.status || 'online', uptime: Math.floor(process.uptime()), ping: client.ws?.ping }, guilds: guilds().length, members: g.memberCount, totalMembers: guilds().reduce((a, x) => a + (x.memberCount || 0), 0), commands: (client.commands?.size || 0) + c.commands.filter(x => x.enabled).length, customCommands: c.commands.length, tickets, usage: usageTop, activity: db.activity.filter(a => a.g === g.id).slice(0, 15), errors: db.errors.slice(0, 10), ticketUrl: global.__TICKET_HTTP ? '/' : '', persistWarn: PERSIST_WARN }; };
  H['GET /guild'] = ({ guild: g }) => ({ id: g.id, name: g.name, icon: g.iconURL?.({ size: 64 }), members: g.memberCount,
    channels: [...g.channels.cache.values()].map(c => ({ id: c.id, name: c.name, type: c.type, parent: c.parent?.name || '' })).sort((a, b) => a.name.localeCompare(b.name)),
    roles: [...g.roles.cache.values()].filter(r => r.id !== g.id).map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed })).sort((a, b) => b.position - a.position),
    emojis: [...g.emojis.cache.values()].slice(0, 250).map(e => ({ id: e.id, name: e.name, code: e.toString() })),
    botPerms: Object.fromEntries(['ManageRoles', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages', 'ManageChannels', 'SendMessages', 'EmbedLinks'].map(p => [p, !!g.members.me?.permissions.has(PF[p])])) });
  H['GET /config'] = ({ guild: g, level }) => { const c = cfg(g.id); return { config: level === 'mod' ? { general: c.general, moderation: c.moderation } : c, defaults: defaults(), meta: { perms: PERMS, features: FEATURES, logs: Object.fromEntries(Object.entries(LOGS).map(([k, v]) => [k, v[0]])), acts: ACT, level, prefixTaken: [...reserved()] } }; };
  H['PUT /config/'] = async ({ guild: g, body, s, section }) => {
    if (!SECTIONS.includes(section)) throw Object.assign(new Error('Unknown section'), { status: 400 });
    const v = sanitize(section, body, cfg(g.id)[section]), bad = check(section, v); if (bad) throw Object.assign(new Error(bad), { status: 400 });
    commit(g.id, section, v, s.user?.name || 'password'); if (section === 'commands') queueSlash(g); if (section === 'bot') applyPresence().catch(() => { }); return { ok: true };
  };
  H['POST /config/reset'] = ({ guild: g, body, s }) => { const sec = body.section; if (!SECTIONS.includes(sec)) throw new Error('Unknown section'); const d = defaults()[sec]; let v = d; if (body.key && d && !Array.isArray(d) && body.key in d) v = { ...cfg(g.id)[sec], [body.key]: d[body.key] }; commit(g.id, sec, sanitize(sec, v, cfg(g.id)[sec]), s.user?.name || 'password'); return { ok: true }; };
  H['GET /export'] = ({ guild: g }) => ({ __download: `${g.name.replace(/\W+/g, '_')}-config.json`, version: 1, exportedAt: new Date().toISOString(), guild: { id: g.id, name: g.name }, config: cfg(g.id) });
  H['POST /import'] = ({ guild: g, body, s }) => { if (!body.config || typeof body.config !== 'object') throw new Error('This file is not a valid configuration export.'); snapshot(g.id, s.user?.name || 'password', 'import', 'Before import', true); const n = applyAll(g.id, body.config, s.user?.name || 'password'); snapshot(g.id, s.user?.name || 'password', 'import', 'Imported', true); queueSlash(g); return { imported: n }; };
  H['GET /history'] = ({ guild: g }) => ({ items: db.history.filter(h => h.g === g.id).map(({ t, user, section, name, manual }) => ({ t, user, section, name, manual })) });
  H['POST /backup'] = ({ guild: g, body, s }) => { snapshot(g.id, s.user?.name || 'password', 'backup', S.str(body.name, 60) || 'Backup', true); return { ok: true }; };
  H['POST /history/restore'] = ({ guild: g, body, s }) => { const h = db.history.find(x => x.g === g.id && x.t === Number(body.t)); if (!h) throw new Error('Backup not found.'); snapshot(g.id, s.user?.name || 'password', 'restore', 'Before restore', true); const n = applyAll(g.id, JSON.parse(h.snap), s.user?.name || 'password'); queueSlash(g); return { restored: n }; };
  H['DELETE /history'] = ({ guild: g, body }) => { db.history = db.history.filter(x => !(x.g === g.id && x.t === Number(body.t))); save('history.json', db.history); return { ok: true }; };
  H['POST /embeds/publish'] = async ({ guild: g, body }) => { const m = await publishEmbed(g, body.id, S.snow(body.channel)); return { url: m.url, messageId: m.id }; };
  H['POST /embeds/delete-message'] = async ({ guild: g, body }) => { const e = cfg(g.id).embeds.find(x => x.id === body.id); if (!e?.messageId) throw new Error('This embed is not published.'); const ch = await chan(g, e.channel); await ch?.messages.delete(e.messageId).catch(() => { }); e.messageId = ''; save('configs.json', db.configs, true); return { ok: true }; };
  H['POST /roles/publish'] = async ({ guild: g, body }) => { const m = await publishRolePanel(g, body.id); return { url: m.url }; };
  H['POST /verification/publish'] = async ({ guild: g }) => { const m = await publishVerification(g); return { url: m.url }; };
  H['POST /test'] = async ({ guild: g, body }) => { const c = cfg(g.id), k = body.kind === 'goodbye' ? c.goodbye : c.welcome, ch = await chan(g, k.channel); if (!ch?.send) throw new Error('Choose a channel first.'); const p = payload(c, k.content, k.embedOn, k.embed, vars(g, client.user)); if (!p) throw new Error('The message is empty.'); await ch.send(p); return { ok: true }; };
  H['POST /commands/sync'] = async ({ guild: g }) => syncSlash(g);
  H['POST /mod/action'] = async ({ guild: g, body, s }) => { const e = await modAction(g, S.enum(body.type, ['warn', 'kick', 'ban', 'unban', 'timeout', 'untimeout', 'clear'], ''), { ...body, mod: s.user?.name || 'Dashboard' }); return { entry: e }; };
  H['GET /mod/warnings'] = ({ guild: g, u }) => { const all = db.warns[g.id] || {}, uid = u.searchParams.get('user'); return uid ? { user: uid, warnings: all[uid] || [] } : { users: Object.entries(all).filter(([, w]) => w.length).map(([id, w]) => ({ id, count: w.length, last: w[w.length - 1].t })).sort((a, b) => b.count - a.count).slice(0, 100) }; };
  H['DELETE /mod/warnings'] = ({ guild: g, body }) => { const all = db.warns[g.id] ||= {}, uid = S.snow(body.user); if (!uid) throw new Error('Invalid user.'); all[uid] = body.id ? (all[uid] || []).filter(w => w.id !== body.id) : []; save('warnings.json', db.warns); return { ok: true }; };
  H['GET /mod/log'] = ({ guild: g, u }) => { const q = (u.searchParams.get('q') || '').toLowerCase(); return { items: db.modlog.filter(e => e.g === g.id && (!q || JSON.stringify(e).toLowerCase().includes(q))).slice(0, 200) }; };

  async function handle(q, r, isOwn) {
    const u = new URL(q.url, 'http://x'); let pn = u.pathname; const base = isOwn ? '' : '/admin';
    if (!isOwn) { if (pn !== base && !pn.startsWith(base + '/')) return false; pn = pn.slice(base.length) || '/'; }
    try {
      r.setHeader('X-Frame-Options', 'DENY'); r.setHeader('Referrer-Policy', 'same-origin'); const ip = ipOf(q);
      if (!limit('g' + ip, 300, 60000)) return json(r, 429, { error: 'Too many requests. Slow down.' }), true;
      if (q.method !== 'GET' && q.method !== 'HEAD') { const o = q.headers.origin; if ((o && new URL(o).host !== q.headers.host) || q.headers['x-ws'] !== '1') return json(r, 403, { error: 'Bad request origin' }), true; }
      if (pn === '/') { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); r.end(PAGE(base)); return true; }
      if (pn === '/auth/info' ) { json(r, 200, { password: !!PASS, oauth: !!(ENV.CLIENT_ID && ENV.CLIENT_SECRET && PUBLIC) }); return true; }
      if (pn === '/auth/login' && q.method === 'POST') { if (!limit('l' + ip, 8, 600000)) return json(r, 429, { error: 'Too many attempts. Try again in 10 minutes.' }), true; const b = await readBody(q, 1e4); if (!PASS || !crypto.timingSafeEqual(sha(b.password), sha(PASS))) return json(r, 401, { error: 'Wrong password.' }), true; const id = crypto.randomBytes(32).toString('hex'); sessions.set(id, { pw: true, user: { id: 'password', name: 'Admin' }, created: Date.now(), t: Date.now() }); setCookie(r, 'ws_sid', id, 604800); await ticketLogin(r, b.password); json(r, 200, { ok: true }); return true; }
      if (pn === '/auth/discord') { if (!(ENV.CLIENT_ID && ENV.CLIENT_SECRET && PUBLIC)) { r.writeHead(400); r.end('Set CLIENT_ID, CLIENT_SECRET and PUBLIC_URL first.'); return true; } const st = crypto.randomBytes(16).toString('hex'); setCookie(r, 'ws_state', st, 600); r.writeHead(302, { Location: `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: ENV.CLIENT_ID, response_type: 'code', scope: 'identify', redirect_uri: `${PUBLIC}${base}/auth/callback`, state: st, prompt: 'none' })}` }); r.end(); return true; }
      if (pn === '/auth/callback') {
        const code = u.searchParams.get('code'), st = u.searchParams.get('state'); if (!code || !st || st !== cookies(q).ws_state) { r.writeHead(400); r.end('Invalid login state. Go back and try again.'); return true; }
        const tk = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: ENV.CLIENT_ID, client_secret: ENV.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${PUBLIC}${base}/auth/callback` }) })).json();
        const me = tk.access_token ? await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tk.access_token } })).json() : null; if (!me?.id) { r.writeHead(400); r.end('Discord login failed.'); return true; }
        const gl = await accessFor(me.id); if (!Object.keys(gl).length) { r.writeHead(403, { 'Content-Type': 'text/plain' }); r.end('You do not have dashboard access in any server where this bot is. Ask an admin to add your role under Server → Dashboard access.'); return true; }
        const id = crypto.randomBytes(32).toString('hex'); sessions.set(id, { user: { id: me.id, name: me.global_name || me.username, avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : '' }, guilds: gl, created: Date.now(), t: Date.now() }); setCookie(r, 'ws_sid', id, 604800); r.writeHead(302, { Location: base + '/' }); r.end(); return true;
      }
      if (pn === '/auth/logout') { sessions.delete(cookies(q).ws_sid); setCookie(r, 'ws_sid', '', 0); json(r, 200, { ok: true }); return true; }
      if (!pn.startsWith('/api/')) { r.writeHead(404); r.end('Not found'); return true; }
      const s = await session(q); if (!s) return json(r, 401, { error: 'Not logged in' }), true;
      const lv = levels(s), route = pn.slice(4);
      if (route === '/me') { json(r, 200, { user: s.user, guilds: guilds().filter(g => lv[g.id]).map(g => ({ id: g.id, name: g.name, icon: g.iconURL?.({ size: 64 }), level: lv[g.id] })), ticketUrl: global.__TICKET_HTTP ? '/' : '' }); return true; }
      let key = q.method + ' ' + route, section = '';
      if (q.method === 'PUT' && route.startsWith('/config/') && route !== '/config/reset') { key = 'PUT /config/'; section = route.slice(8); }
      const fn = H[key]; if (!fn) { json(r, 404, { error: 'Unknown endpoint' }); return true; }
      const g = client.guilds.cache.get(u.searchParams.get('g') || ''), level = g && lv[g.id]; if (!g || !level) { json(r, 403, { error: 'You have no access to this server.' }); return true; }
      if (level === 'mod' && !MODOK.has(key)) { json(r, 403, { error: 'Your role only allows moderation tools.' }); return true; }
      const body = q.method === 'GET' || q.method === 'HEAD' ? {} : await readBody(q), out = await fn({ guild: g, body, s, u, level, section });
      if (out?.__download) { const { __download, ...rest } = out; r.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${__download}"` }); r.end(JSON.stringify(rest, null, 2)); return true; }
      json(r, 200, out ?? { ok: true }); return true;
    } catch (e) { if (ENV.WS_DEBUG) console.error(e.stack); if (!e.status) err('http ' + q.url.split('?')[0], e); if (!r.headersSent) json(r, e.status || 400, { error: friendly(e) }); return true; }
  }
  global.__EXTRA_HTTP = (q, r) => own ? false : handle(q, r, false);
  const decide = () => { if (ENV.WEBSITE_PORT || !global.__TICKET_HTTP) { own = true; const port = Number(ENV.WEBSITE_PORT || ENV.PORT) || 3000, srv = http.createServer((q, r) => handle(q, r, true)); srv.on('error', e => console.error(`❌ Website could not start on port ${port}: ${e.message}. Set WEBSITE_PORT to a free port.`)); srv.listen(port, () => console.log(`🌐 Bot dashboard: ${PUBLIC || 'http://localhost:' + port} (port ${port})`)); } else console.log(`🌐 Bot dashboard: ${PUBLIC || ''}/admin (shares the ticket dashboard port)`); if (!PASS && !(ENV.CLIENT_ID && ENV.CLIENT_SECRET)) console.warn('⚠️ website.js: set DASHBOARD_PASSWORD (or CLIENT_ID + CLIENT_SECRET) — nobody can log in yet.'); };
  setTimeout(decide, 1500);
  return { cfg, modAction, syncSlash };
}

// ───────────────────────────── the web interface (served by this file, nothing else to install) ─────────────────────────────
const CSS = `
:root{--bg:#1e1f22;--bg2:#2b2d31;--bg3:#313338;--bg4:#383a40;--tx:#f2f3f5;--mut:#b5bac1;--acc:#5865f2;--ok:#23a559;--bad:#da373c;--warn:#f0b232;--bd:#3f4147;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:#00a8fc}button,input,select,textarea{font:inherit;color:inherit}
.app{display:flex;min-height:100%}.side{width:240px;background:var(--bg2);border-right:1px solid var(--bd);padding:14px 10px;position:fixed;top:0;bottom:0;overflow:auto;z-index:30;transition:transform .2s}
.side h1{font-size:16px;margin:4px 8px 12px;display:flex;gap:8px;align-items:center}.nav a{display:flex;gap:10px;align-items:center;padding:9px 12px;border-radius:8px;color:var(--mut);text-decoration:none;cursor:pointer;margin-bottom:2px}.nav a:hover{background:var(--bg4);color:var(--tx)}.nav a.on{background:var(--acc);color:#fff}
.main{margin-left:240px;flex:1;min-width:0}.top{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--bd);display:flex;gap:10px;align-items:center;padding:10px 16px;flex-wrap:wrap}
.top .grow{flex:1}.content{padding:18px;max-width:1100px;margin:0 auto}.burger{display:none}
.card{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:16px}.card>h2{margin:0 0 2px;font-size:17px}.card>.hint{margin-bottom:12px}
.hint{color:var(--mut);font-size:13px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}.stat{background:var(--bg3);border-radius:10px;padding:14px}.stat b{display:block;font-size:22px}
input,select,textarea{background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;width:100%}textarea{min-height:80px;resize:vertical}input:focus,select:focus,textarea:focus{outline:2px solid var(--acc);border-color:transparent}
input[type=checkbox]{width:auto}.row{margin-bottom:12px}.row>label.l{display:flex;justify-content:space-between;gap:8px;font-weight:600;margin-bottom:4px;font-size:13px;color:var(--mut);text-transform:uppercase;letter-spacing:.02em}
.btn{background:var(--bg4);border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600}.btn:hover{filter:brightness(1.15)}.btn.pri{background:var(--acc);color:#fff}.btn.ok{background:var(--ok);color:#fff}.btn.bad{background:var(--bad);color:#fff}.btn.sm{padding:4px 9px;font-size:13px}.btn:disabled{opacity:.5;cursor:default}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.rst{background:none;border:0;color:var(--mut);cursor:pointer;padding:0 4px}
.sw{position:relative;display:inline-block;width:42px;height:24px}.sw input{opacity:0;width:0;height:0}.sw span{position:absolute;inset:0;background:#4e5058;border-radius:24px;cursor:pointer;transition:.2s}.sw span:before{content:"";position:absolute;height:18px;width:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}.sw input:checked+span{background:var(--ok)}.sw input:checked+span:before{transform:translateX(18px)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.chip{background:var(--bg4);border-radius:14px;padding:3px 10px;font-size:13px;cursor:pointer}.chips select{width:auto;min-width:130px}
details.item{background:var(--bg3);border:1px solid var(--bd);border-radius:10px;margin-bottom:10px}details.item>summary{cursor:pointer;padding:10px 12px;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:8px}details.item>summary::-webkit-details-marker{display:none}details.item>.body{padding:4px 12px 12px;border-top:1px solid var(--bd)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#80848e;margin-right:6px}.dot.on{background:var(--ok)}.dot.bad{background:var(--bad)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}.tabs .btn.on{background:var(--acc);color:#fff}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--bd);vertical-align:top}th{color:var(--mut);font-size:12px;text-transform:uppercase}.tw{overflow-x:auto}
.dc{background:#313338;border-radius:8px;padding:12px;margin:8px 0;border:1px solid var(--bd)}.dct{white-space:pre-wrap;word-break:break-word;margin-bottom:6px}.dce{background:#2b2d31;border-left:4px solid var(--acc);border-radius:4px;padding:10px 12px;max-width:520px;position:relative}
.dce .t{font-weight:700;margin:2px 0}.dce .d{white-space:pre-wrap;word-break:break-word;font-size:14px}.dce .f{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px;font-size:13px}.dce .f .n{font-weight:700}.dce img.im{max-width:100%;border-radius:4px;margin-top:8px}.dce img.th{position:absolute;right:10px;top:10px;width:64px;height:64px;object-fit:cover;border-radius:4px}.dce .ft{font-size:12px;color:var(--mut);margin-top:8px}.men{background:#3c4270;color:#c9cdfb;border-radius:3px;padding:0 2px}code{background:var(--bg);padding:1px 4px;border-radius:4px}
.ed{display:grid;gap:16px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:99;max-width:92vw}.toast div{background:var(--bg4);border-left:4px solid var(--ok);padding:10px 14px;border-radius:8px;box-shadow:0 4px 16px #0008}.toast .bad{border-color:var(--bad)}
.login{max-width:380px;margin:12vh auto;padding:0 16px}.spin{width:18px;height:18px;border:3px solid var(--bd);border-top-color:var(--acc);border-radius:50%;animation:s .8s linear infinite;display:inline-block}@keyframes s{to{transform:rotate(360deg)}}
.compact .card{padding:10px}.compact .row{margin-bottom:6px}
@media(max-width:860px){.side{transform:translateX(-100%)}.side.open{transform:none}.main{margin-left:0}.burger{display:inline-block}.ed{grid-template-columns:1fr}.content{padding:12px}}
`;
const PAGE = base => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot Dashboard</title><style>${CSS}</style></head><body><div id="root"></div><div class="toast" id="toast"></div><script>window.__BASE=${JSON.stringify(base)};(${CLIENT.toString()})();</script></body></html>`;

function CLIENT() {
  'use strict';
  const BASE = window.__BASE || '', $ = s => document.querySelector(s);
  const h = (tag, a, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(a || {})) { if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat(9)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };
  const clone = o => JSON.parse(JSON.stringify(o)), rid = () => Math.random().toString(16).slice(2, 10);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let ME, G = '', CFG, DEF, META, GD, SEARCH = '', page = 'overview', INFO = {}, mainEl;
  const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };

  // ── network, toast, autosave ──
  async function api(method, url, body) {
    const r = await fetch(BASE + '/api' + url + (url.includes('?') ? '&' : '?') + 'g=' + G, { method, headers: { 'Content-Type': 'application/json', 'X-WS': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch { }
    if (r.status === 401 && ME) { showLogin(); throw new Error('Please log in again.'); } if (!r.ok) throw new Error(d.error || 'Request failed (' + r.status + ')'); return d;
  }
  const toast = (m, bad) => { const t = h('div', { class: bad ? 'bad' : '' }, m); $('#toast').append(t); setTimeout(() => t.remove(), bad ? 6000 : 2800); };
  const saveT = {}; let inflight = 0, saveErr = '';
  const setSave = () => { const el = $('#savest'); if (!el) return; el.textContent = saveErr ? '⚠ Not saved: ' + saveErr : inflight ? '⏳ Saving…' : '✓ All changes saved'; el.style.color = saveErr ? 'var(--bad)' : 'var(--mut)'; };
  function dirty(sec) { inflight++; setSave(); clearTimeout(saveT[sec]); saveT[sec] = setTimeout(async () => { try { await api('PUT', '/config/' + sec, CFG[sec]); saveErr = ''; } catch (e) { saveErr = e.message; toast(e.message, true); } inflight = Math.max(0, inflight - 1); setSave(); }, 700); }
  async function saveNow(sec) { clearTimeout(saveT[sec]); await api('PUT', '/config/' + sec, CFG[sec]); }
  const reloadCfg = async () => { const c = await api('GET', '/config'); CFG = c.config; DEF = c.defaults; META = c.meta; };

  // ── discord-style markdown + preview ──
  const sample = () => ({ user: '@Steve', mention: '@Steve', username: 'Steve', tag: 'Steve#0001', id: '123456789', server: GD?.name || 'My Server', members: String(GD?.members || 100), date: new Date().toISOString().slice(0, 10), time: '12:00 UTC', args: 'example', channel: '#general', seconds: '3' });
  const md = s => { const v = sample(); return esc(String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m)).replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>').replace(/\*(.+?)\*/gs, '<i>$1</i>').replace(/__(.+?)__/gs, '<u>$1</u>').replace(/~~(.+?)~~/gs, '<s>$1</s>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/&lt;@[&!]?\d+&gt;/g, '<span class="men">@mention</span>').replace(/&lt;#\d+&gt;/g, '<span class="men">#channel</span>').replace(/\n/g, '<br>'); };
  const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '';
  function preview(content, e) {
    const box = h('div', { class: 'dc' }); if (content) box.append(h('div', { class: 'dct', html: md(content) }));
    if (e && (e.title || e.description || e.image || e.thumbnail || e.fields?.length || e.author?.name || e.footer?.text)) {
      const em = h('div', { class: 'dce', style: 'border-left-color:' + (e.color || CFG?.general?.embedColor || '#5865f2') });
      if (e.author?.name) em.append(h('div', { class: 'ft', html: md(e.author.name) })); if (e.title) em.append(h('div', { class: 't', html: md(e.title) })); if (e.description) em.append(h('div', { class: 'd', html: md(e.description) }));
      if (e.fields?.length) em.append(h('div', { class: 'f' }, e.fields.map(f => h('div', { style: f.inline ? '' : 'grid-column:1/-1' }, h('div', { class: 'n', html: md(f.name) }), h('div', { html: md(f.value) })))));
      if (safeUrl(e.image)) em.append(h('img', { class: 'im', src: e.image })); if (safeUrl(e.thumbnail)) em.append(h('img', { class: 'th', src: e.thumbnail }));
      const ft = e.footer?.text || CFG?.general?.footer; if (ft || e.timestamp) em.append(h('div', { class: 'ft', html: md(ft || '') + (e.timestamp ? ' • today' : '') })); box.append(em);
    } return box;
  }

  // ── form controls ──
  const selectEl = (items, value, on) => { const s = h('select'); for (const [v, t] of items) s.append(h('option', { value: v }, t)); s.value = value ?? ''; s.onchange = () => on(s.value); return s; };
  const chItems = kind => [['', '— none —'], ...GD.channels.filter(c => kind === 'category' ? c.type === 4 : kind === 'voice' ? [2, 13].includes(c.type) : [0, 5].includes(c.type)).map(c => [c.id, (kind === 'category' ? '' : '#') + c.name + (c.parent ? '  (' + c.parent + ')' : '')])];
  const roleItems = () => GD.roles.map(r => [r.id, '@' + r.name]);
  function chips(sel, items, on) {
    const box = h('div', { class: 'chips' }), draw = () => box.replaceChildren(...sel.map(v => h('span', { class: 'chip', onclick: () => { sel.splice(sel.indexOf(v), 1); on(); draw(); } }, (items.find(i => i[0] === v) || [v, v])[1] + ' ✕')), selectEl([['', '+ add…'], ...items.filter(i => !sel.includes(i[0]))], '', v => { if (v) { sel.push(v); on(); draw(); } })); draw(); return box;
  }
  const dl = (name, obj) => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })), download: name }); document.body.append(a); a.click(); a.remove(); };
  function form(o, spec, X) {
    const root = h('div', { class: 'form' });
    for (const f of spec) {
      if (f.show && !f.show(o)) continue; const t = f.t || 'str', ch = () => { X.ch && X.ch(); if (f.re && X.redraw) X.redraw(); }; let c;
      if (t === 'info') { root.append(h('div', { class: 'hint row' }, f.l)); continue; }
      if (t === 'btn') { root.append(h('div', { class: 'btns' }, h('button', { class: 'btn ' + (f.cls || ''), onclick: async e => { const b = e.currentTarget; b.disabled = true; try { await f.run(o); } catch (x) { toast(x.message, true); } b.disabled = false; } }, f.l))); continue; }
      if (t === 'embed') { o[f.k] ||= {}; root.append(embedEditor(o[f.k], ch)); continue; }
      if (t === 'list') { root.append(listCtl(o, f, X)); continue; }
      if (t === 'obj') { root.append(h('details', { class: 'row' }, h('summary', { style: 'cursor:pointer;font-weight:600' }, f.l), form(o[f.k] ||= {}, f.item, X))); continue; }
      if (t === 'bool') { const i = h('input', { type: 'checkbox' }); i.checked = !!o[f.k]; i.onchange = () => { o[f.k] = i.checked; ch(); }; c = h('label', { class: 'sw' }, i, h('span')); }
      else if (t === 'area') { c = h('textarea', { placeholder: f.ph || '' }); c.value = o[f.k] ?? ''; c.oninput = () => { o[f.k] = c.value; ch(); }; }
      else if (t === 'int') { c = h('input', { type: 'number', min: f.min, max: f.max }); c.value = o[f.k] ?? 0; c.oninput = () => { o[f.k] = c.value === '' ? 0 : Number(c.value); ch(); }; }
      else if (t === 'color') { const tx = h('input', { type: 'text', placeholder: '#5865F2', maxlength: 7 }), pk = h('input', { type: 'color', style: 'width:54px;padding:2px' }); tx.value = o[f.k] || ''; pk.value = /^#[0-9a-f]{6}$/i.test(o[f.k]) ? o[f.k] : '#5865f2'; tx.oninput = () => { o[f.k] = tx.value; if (/^#[0-9a-f]{6}$/i.test(tx.value)) pk.value = tx.value; ch(); }; pk.oninput = () => { tx.value = o[f.k] = pk.value; ch(); }; c = h('div', { style: 'display:flex;gap:8px' }, pk, tx); }
      else if (t === 'channel') c = selectEl(chItems(f.kind), o[f.k], v => { o[f.k] = v; ch(); });
      else if (t === 'role') c = selectEl([['', '— none —'], ...roleItems()], o[f.k], v => { o[f.k] = v; ch(); });
      else if (t === 'roles') c = chips(o[f.k] ||= [], roleItems(), ch);
      else if (t === 'channels') c = chips(o[f.k] ||= [], chItems('text').slice(1), ch);
      else if (t === 'multi') c = chips(o[f.k] ||= [], f.options.map(x => [x, x]), ch);
      else if (t === 'enum') c = selectEl(f.options, o[f.k], v => { o[f.k] = v; ch(); });
      else if (t === 'tags') { c = h('textarea', { placeholder: f.ph || 'One per line' }); c.value = (o[f.k] || []).join('\n'); c.oninput = () => { o[f.k] = c.value.split('\n').map(x => x.trim()).filter(Boolean); ch(); }; }
      else { c = h('input', { type: 'text', placeholder: f.ph || '', maxlength: f.max }); c.value = o[f.k] ?? ''; c.oninput = () => { o[f.k] = c.value; ch(); }; }
      const rst = X.def && f.k in X.def && !f.noreset ? h('button', { class: 'rst', title: 'Reset to default', onclick: async () => { try { await api('POST', '/config/reset', { section: X.sec, key: f.k }); await reloadCfg(); render(); toast('Reset to default'); } catch (e) { toast(e.message, true); } } }, '↺') : null;
      root.append(h('div', { class: 'row' }, h('label', { class: 'l' }, h('span', {}, f.l), rst), c, f.hint && h('div', { class: 'hint' }, f.hint)));
    } return root;
  }
  function listCtl(o, f, X) {
    const arr = o[f.k] ||= [], box = h('div', { class: 'row' }); let sec = X.sec;
    const draw = () => {
      box.replaceChildren(h('label', { class: 'l', style: 'font-weight:600;color:var(--mut);font-size:13px;text-transform:uppercase' }, f.l + ' (' + arr.length + ')'));
      arr.forEach((it, n) => {
        const ttl = () => String(f.title ? f.title(it) : '#' + (n + 1)); if (SEARCH && !ttl().toLowerCase().includes(SEARCH)) return;
        const sum = h('span', {}, ttl()), d = h('details', { class: 'item' }); d.open = !!it.__open || arr.length === 1; d.addEventListener('toggle', () => { it.__open = d.open; });
        const body = h('div', { class: 'body' }, h('div', { style: 'height:10px' }), form(it, f.item, { ch: () => { sum.textContent = ttl(); X.ch && X.ch(); }, redraw: draw, sec: null }),
          h('div', { class: 'btns' }, h('button', { class: 'btn sm', onclick: () => { if (n) { [arr[n - 1], arr[n]] = [arr[n], arr[n - 1]]; X.ch && X.ch(); draw(); } } }, '▲'), h('button', { class: 'btn sm', onclick: () => { if (n < arr.length - 1) { [arr[n + 1], arr[n]] = [arr[n], arr[n + 1]]; X.ch && X.ch(); draw(); } } }, '▼'),
            ...(f.extra ? f.extra(it, draw) : []), h('button', { class: 'btn bad sm', onclick: () => { if (confirm('Remove this item?')) { arr.splice(n, 1); X.ch && X.ch(); draw(); } } }, 'Remove')));
        d.append(h('summary', {}, sum, 'enabled' in it ? h('span', {}, h('span', { class: 'dot' + (it.enabled ? ' on' : '') }), it.enabled ? 'on' : 'off') : null), body); box.append(d);
      });
      if (arr.length < (f.max || 100)) box.append(h('button', { class: 'btn sm', onclick: () => { const it = f.blank(); it.__open = true; arr.push(it); X.ch && X.ch(); draw(); } }, '+ ' + (f.add || 'Add')));
    };
    draw(); return box;
  }
  function embedEditor(e, ch) {
    e.author ||= { name: '', icon: '', url: '' }; e.footer ||= { text: '', icon: '' }; e.fields ||= []; const pv = h('div'), redraw = () => pv.replaceChildren(preview('', e)), fch = () => { ch(); redraw(); };
    const main = form(e, [{ k: 'title', l: 'Title' }, { k: 'description', l: 'Description', t: 'area' }, { k: 'url', l: 'Title link (https://…)' }, { k: 'color', l: 'Color', t: 'color' }, { k: 'thumbnail', l: 'Thumbnail image URL' }, { k: 'image', l: 'Large image URL' }, { k: 'timestamp', l: 'Show timestamp', t: 'bool' }], { ch: fch });
    const au = form(e.author, [{ k: 'name', l: 'Author name' }, { k: 'icon', l: 'Author icon URL' }, { k: 'url', l: 'Author link URL' }], { ch: fch }), fo = form(e.footer, [{ k: 'text', l: 'Footer text' }, { k: 'icon', l: 'Footer icon URL' }], { ch: fch });
    const fl = form(e, [{ k: 'fields', l: 'Fields', t: 'list', max: 25, add: 'Add field', blank: () => ({ name: '', value: '', inline: false }), title: x => x.name || 'Field', item: [{ k: 'name', l: 'Name' }, { k: 'value', l: 'Value', t: 'area' }, { k: 'inline', l: 'Inline', t: 'bool' }] }], { ch: fch });
    redraw(); return h('div', { class: 'ed row' }, h('div', {}, main, h('details', {}, h('summary', {}, 'Author, footer & fields'), au, fo, fl)), h('div', {}, h('label', { class: 'l hint' }, 'Live preview'), pv));
  }
  const card = (title, hint, ...kids) => h('div', { class: 'card' }, h('h2', {}, title), hint && h('div', { class: 'hint' }, hint), ...kids);
  const secForm = (sec, spec) => form(CFG[sec], spec, { ch: () => dirty(sec), sec, def: DEF[sec], redraw: () => render() });
  const tabs = (items, cur, set) => h('div', { class: 'tabs' }, items.map(([k, l]) => h('button', { class: 'btn' + (k === cur ? ' on' : ''), onclick: () => set(k) }, l)));
  const ago = t => { const s = Math.floor((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
  const dur = s => { const d = Math.floor(s / 86400), hr = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (hr ? hr + 'h ' : '') + m + 'm'; };
  const VARS = 'Variables: {user} {username} {server} {members} {date}';
  const ACTSPEC = [{ k: 'type', l: 'Action', t: 'enum', re: true, options: [['sendMessage', 'Send a message'], ['dm', 'DM the user'], ['addRole', 'Add role'], ['removeRole', 'Remove role'], ['toggleRole', 'Toggle role'], ['react', 'React to message'], ['timeout', 'Timeout'], ['kick', 'Kick'], ['ban', 'Ban'], ['nickname', 'Set nickname'], ['deleteTrigger', 'Delete triggering message']] },
    { k: 'text', l: 'Text', t: 'area', show: a => ['sendMessage', 'dm', 'nickname'].includes(a.type), hint: VARS + ' {args}' }, { k: 'channel', l: 'Channel (empty = same channel)', t: 'channel', show: a => a.type === 'sendMessage' }, { k: 'role', l: 'Role', t: 'role', show: a => ['addRole', 'removeRole', 'toggleRole'].includes(a.type) },
    { k: 'minutes', l: 'Minutes', t: 'int', min: 1, max: 40320, show: a => a.type === 'timeout' }, { k: 'emoji', l: 'Emoji', show: a => a.type === 'react' }];
  const actList = (k = 'actions') => ({ k, l: 'Actions (run in order)', t: 'list', max: 10, add: 'Add action', blank: () => ({ type: 'sendMessage', text: '', channel: '', role: '', minutes: 10, emoji: '' }), title: a => a.type, item: ACTSPEC });
  const bar = (v, max) => h('div', { style: 'background:var(--bg);border-radius:6px;overflow:hidden;height:8px;margin-top:4px' }, h('div', { style: `width:${Math.max(3, v / max * 100)}%;height:8px;background:var(--acc)` }));

  // ───── pages ─────
  const PAGES = {}, stat = (l, v) => h('div', { class: 'stat' }, h('b', {}, String(v)), h('span', { class: 'hint' }, l));
  const FEATURE_L = { customCommands: 'Custom commands', autoResponses: 'Auto responses', automod: 'Auto moderation', logging: 'Logging', welcome: 'Welcome, goodbye & auto roles', scheduled: 'Scheduled messages', roles: 'Role menus & reaction roles', triggers: 'Event triggers' };
  const TIMES = [['Primary', 'Blue'], ['Secondary', 'Gray'], ['Success', 'Green'], ['Danger', 'Red'], ['Link', 'Link (opens a URL)']];
  PAGES.overview = async () => {
    const o = await api('GET', '/overview'), b = o.bot, warn = Object.entries(GD.botPerms).filter(([, v]) => !v).map(([k]) => k);
    return h('div', {},
      card(b.tag || 'Bot', null, h('div', { style: 'display:flex;gap:14px;align-items:center' }, b.avatar ? h('img', { src: b.avatar, width: 56, height: 56, style: 'border-radius:50%' }) : null, h('div', {}, h('div', {}, h('span', { class: 'dot ' + (b.online ? 'on' : 'bad') }), b.online ? 'Online (' + b.status + ')' : 'Offline'), h('div', { class: 'hint' }, 'Uptime ' + dur(b.uptime) + ' • ping ' + b.ping + ' ms')))),
      o.persistWarn ? card('❌ Your settings are not being saved permanently', o.persistWarn) : null,
      warn.length ? card('⚠ Missing bot permissions', 'Some features need these permissions in ' + GD.name + ': ' + warn.join(', ')) : null,
      h('div', { class: 'grid', style: 'margin-bottom:16px' }, stat('Servers', o.guilds), stat('Members (this server)', o.members), stat('Members (all)', o.totalMembers), stat('Commands', o.commands), stat('Tickets', o.tickets ? o.tickets.total + ' (' + o.tickets.open + ' open)' : '—')),
      h('div', { class: 'grid' },
        card('Command usage', null, o.usage.length ? o.usage.map(([n, c]) => h('div', {}, n + ' — ' + c, bar(c, o.usage[0][1]))) : h('div', { class: 'hint' }, 'No commands used yet.')),
        card('Recent activity', null, o.activity.length ? o.activity.map(a => h('div', { class: 'hint' }, ago(a.t) + ' — ' + a.text)) : h('div', { class: 'hint' }, 'Nothing yet.')),
        card('Recent errors', null, o.errors.length ? o.errors.map(a => h('div', { class: 'hint', style: 'color:var(--bad)' }, ago(a.t) + ' — ' + a.where + ': ' + a.msg)) : h('div', { class: 'hint' }, 'No errors. 🎉'))));
  };
  PAGES.server = () => h('div', {},
    card('Welcome message', 'Sent in a channel when someone joins.', secForm('welcome', [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'channel', l: 'Channel', t: 'channel' }, { k: 'content', l: 'Message text', t: 'area', hint: VARS }, { k: 'embedOn', l: 'Send as embed', t: 'bool', re: true }, { k: 'embed', t: 'embed', show: w => w.embedOn }, { k: 'dm', l: 'Also DM the new member', t: 'bool', re: true }, { k: 'dmText', l: 'DM text', t: 'area', show: w => w.dm }, { t: 'btn', l: 'Send a test message now', run: async () => { await saveNow('welcome'); await api('POST', '/test', { kind: 'welcome' }); toast('Test message sent'); } }])),
    card('Goodbye message', 'Sent when someone leaves.', secForm('goodbye', [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'channel', l: 'Channel', t: 'channel' }, { k: 'content', l: 'Message text', t: 'area', hint: VARS }, { k: 'embedOn', l: 'Send as embed', t: 'bool', re: true }, { k: 'embed', t: 'embed', show: w => w.embedOn }, { t: 'btn', l: 'Send a test message now', run: async () => { await saveNow('goodbye'); await api('POST', '/test', { kind: 'goodbye' }); toast('Test message sent'); } }])),
    card('Auto roles', 'Roles given automatically to new members. The bot’s role must be above these roles.', secForm('autoRoles', [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'roles', l: 'Roles for members', t: 'roles' }, { k: 'botRoles', l: 'Roles for bots', t: 'roles' }, { k: 'delaySeconds', l: 'Delay (seconds)', t: 'int', min: 0, max: 3600 }])),
    card('Verification', 'A button members press to receive the verified role.', secForm('verification', [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'channel', l: 'Channel for the verify message', t: 'channel' }, { k: 'role', l: 'Role given when verified', t: 'role' }, { k: 'removeRole', l: 'Role removed when verified (optional)', t: 'role' }, { k: 'title', l: 'Title' }, { k: 'description', l: 'Description', t: 'area' }, { k: 'button', l: 'Button text' }, { k: 'color', l: 'Color', t: 'color' }, { t: 'btn', l: CFG.verification.messageId ? 'Update verify message' : 'Publish verify message', cls: 'ok', run: async () => { await saveNow('verification'); const r = await api('POST', '/verification/publish'); toast('Published ✓'); await reloadCfg(); } }])),
    card('Dashboard access', 'People with the Administrator permission always have full access. Add roles here to give others access: Admin roles see everything, Moderator roles only get the Moderation page.', secForm('access', [{ k: 'adminRoles', l: 'Dashboard admin roles', t: 'roles' }, { k: 'modRoles', l: 'Dashboard moderator roles', t: 'roles' }])));
  PAGES.tickets = async () => { let o = {}; try { o = await api('GET', '/overview'); } catch { } const t = o.tickets;
    return h('div', {}, t ? h('div', { class: 'grid', style: 'margin-bottom:12px' }, stat('Total tickets', t.total), stat('Open', t.open), stat('Closed', t.closed), stat('Today', t.today)) : null,
      ME.ticketUrl ? h('div', { class: 'card', style: 'padding:0;overflow:hidden' }, h('iframe', { src: ME.ticketUrl, style: 'width:100%;height:calc(100vh - 190px);min-height:520px;border:0;display:block;background:#1e1f22', title: 'Ticket dashboard' }), h('div', { class: 'hint', style: 'padding:8px 12px' }, 'Ticket panels, categories, forms, transcripts and ratings are managed here. ', h('a', { href: ME.ticketUrl, target: '_blank' }, 'Open in a new tab'))) : card('🎫 Ticket system', 'The ticket system is not running. Make sure ticket.js is next to index.js and loaded before client.login(...).')); };
  const EMBEDITEM = [{ k: 'name', l: 'Template name' }, { k: 'channel', l: 'Channel to publish in', t: 'channel' }, { k: 'content', l: 'Message text (above the embed)', t: 'area' }, { k: 'embed', t: 'embed' },
    { k: 'buttons', l: 'Buttons', t: 'list', max: 10, add: 'Add button', blank: () => ({ label: 'Button', emoji: '', style: 'Primary', url: '', role: '' }), title: b => b.label || b.emoji || 'Button', item: [{ k: 'label', l: 'Label' }, { k: 'emoji', l: 'Emoji' }, { k: 'style', l: 'Style', t: 'enum', re: true, options: TIMES }, { k: 'url', l: 'Link URL (https://…)', show: b => b.style === 'Link' }, { k: 'role', l: 'Role to toggle when clicked', t: 'role', show: b => b.style !== 'Link' }] },
    { k: 'select', l: 'Role select menu', t: 'obj', item: [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'placeholder', l: 'Placeholder' }, { k: 'options', l: 'Options (each toggles a role)', t: 'list', max: 25, add: 'Add option', blank: () => ({ label: 'Option', description: '', role: '' }), title: o => o.label || 'Option', item: [{ k: 'label', l: 'Label' }, { k: 'description', l: 'Description' }, { k: 'role', l: 'Role', t: 'role' }] }] }];
  PAGES.embeds = () => {
    const X = { ch: () => dirty('embeds'), sec: 'embeds' }, ta = h('textarea', { placeholder: 'Paste exported embed JSON here', style: 'min-height:90px' });
    const spec = [{ k: 'embeds', l: 'Embeds', t: 'list', add: 'New embed', blank: () => ({ id: rid(), name: 'New embed', channel: '', messageId: '', content: '', embed: { title: 'Title', description: 'Description', color: '', url: '', author: { name: '', icon: '', url: '' }, footer: { text: '', icon: '' }, thumbnail: '', image: '', timestamp: false, fields: [] }, buttons: [], select: { enabled: false, placeholder: '', options: [] } }), title: e => e.name + (e.messageId ? ' ✅' : ''), item: EMBEDITEM,
      extra: (e, draw) => [h('button', { class: 'btn ok sm', onclick: async ev => { const b = ev.currentTarget; b.disabled = true; try { await saveNow('embeds'); const r = await api('POST', '/embeds/publish', { id: e.id, channel: e.channel }); e.messageId = r.messageId; toast(e.messageId ? 'Published ✓' : 'Done'); draw(); } catch (x) { toast(x.message, true); } b.disabled = false; } }, 'Publish / update message'),
        h('button', { class: 'btn sm', onclick: () => { const c = clone(e); c.id = rid(); c.name += ' (copy)'; c.messageId = ''; c.__open = true; CFG.embeds.push(c); dirty('embeds'); draw(); } }, 'Duplicate'), h('button', { class: 'btn sm', onclick: () => dl((e.name || 'embed') + '.json', e) }, 'Export'),
        e.messageId ? h('button', { class: 'btn sm', onclick: async () => { try { await saveNow('embeds'); await api('POST', '/embeds/delete-message', { id: e.id }); e.messageId = ''; toast('Message deleted'); draw(); } catch (x) { toast(x.message, true); } } }, 'Delete Discord message') : null] }];
    return h('div', {}, card('Embed builder', 'Build embeds with a live preview, publish them to any channel, and press Publish again to edit the same message. Buttons and select menus can give or remove roles.', form(CFG, spec, X)),
      card('Import an embed', 'Paste JSON exported from this page.', ta, h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { try { const j = JSON.parse(ta.value), e = Array.isArray(j) ? j : [j]; for (const x of e) { const c = { id: rid(), name: x.name || 'Imported', channel: '', messageId: '', content: x.content || '', embed: x.embed || x, buttons: x.buttons || [], select: x.select || { enabled: false, placeholder: '', options: [] } }; CFG.embeds.push(c); } dirty('embeds'); toast('Imported ' + e.length); render(); } catch (x) { toast('Invalid JSON: ' + x.message, true); } } }, 'Import'))));
  };
  PAGES.commands = () => {
    const spec = [{ k: 'commands', l: 'Commands', t: 'list', add: 'New command', blank: () => ({ id: rid(), enabled: true, name: 'hello', description: 'Say hello', type: 'both', aliases: [], response: 'Hello {mention}!', embedOn: false, embed: { title: '', description: '', color: '', url: '', author: { name: '', icon: '', url: '' }, footer: { text: '', icon: '' }, thumbnail: '', image: '', timestamp: false, fields: [] }, ephemeral: false, perms: [], roles: [], cooldown: CFG.general.defaultCooldown, args: [], actions: [] }), title: c => (c.type === 'text' ? CFG.general.prefix : c.type === 'slash' ? '/' : '/ or ' + CFG.general.prefix) + c.name,
      item: [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'name', l: 'Name (letters, numbers, - _ )', max: 32 }, { k: 'type', l: 'Works as', t: 'enum', options: [['both', 'Slash + text command'], ['slash', 'Slash command only'], ['text', 'Text command only']] }, { k: 'description', l: 'Description (slash menu)', max: 100 }, { k: 'aliases', l: 'Aliases (text commands)', t: 'tags' },
        { k: 'response', l: 'Response', t: 'area', hint: VARS + ' {args} {arg1} {<argument name>}' }, { k: 'embedOn', l: 'Respond with an embed', t: 'bool', re: true }, { k: 'embed', t: 'embed', show: c => c.embedOn }, { k: 'ephemeral', l: 'Only visible to the user (slash)', t: 'bool' },
        { k: 'perms', l: 'Required permissions', t: 'multi', options: META.perms }, { k: 'roles', l: 'Allowed roles (empty = everyone)', t: 'roles' }, { k: 'cooldown', l: 'Cooldown (seconds)', t: 'int', min: 0, max: 3600 },
        { k: 'args', l: 'Arguments', t: 'list', max: 5, add: 'Add argument', blank: () => ({ name: 'target', description: 'Argument', type: 'string', required: false }), title: a => a.name, item: [{ k: 'name', l: 'Name' }, { k: 'description', l: 'Description' }, { k: 'type', l: 'Type', t: 'enum', options: [['string', 'Text'], ['integer', 'Number'], ['boolean', 'True/False'], ['user', 'User'], ['channel', 'Channel'], ['role', 'Role']] }, { k: 'required', l: 'Required', t: 'bool' }] }, actList()],
      extra: (c, draw) => [h('button', { class: 'btn sm', onclick: () => { const d = clone(c); d.id = rid(); d.name += '2'; d.__open = true; CFG.commands.push(d); dirty('commands'); draw(); } }, 'Duplicate')] }];
    return h('div', {}, card('Custom commands', 'Create commands that reply, run safe actions (roles, messages, timeouts…) or both. Slash commands are registered automatically a few seconds after you change something. Your existing bot commands are never touched; a custom command can not reuse their names.',
      h('div', { class: 'btns' }, h('button', { class: 'btn pri', onclick: async e => { const b = e.currentTarget; b.disabled = true; try { await saveNow('commands'); const r = await api('POST', '/commands/sync'); toast(`Slash commands: ${r.created.length} created, ${r.updated.length} updated, ${r.deleted.length} removed${r.skipped.length ? ' — skipped: ' + r.skipped.join('; ') : ''}`, !!r.skipped.length); } catch (x) { toast(x.message, true); } b.disabled = false; } }, 'Sync slash commands now')),
      form(CFG, spec, { ch: () => dirty('commands'), sec: 'commands' })));
  };
  let modTab = 'actions', autoTab = 'responses', WARNU = '', MA = { type: 'warn', userId: '', reason: '', minutes: 10, channelId: '', count: 10 }, MQ = '';
  const ACTM = [['delete', 'Delete message'], ['warn', 'Delete + warn'], ['timeout', 'Delete + timeout'], ['kick', 'Delete + kick'], ['ban', 'Delete + ban']];
  const ruleSpec = extra => [{ k: 'enabled', l: 'Enabled', t: 'bool' }, ...extra, { k: 'action', l: 'Punishment', t: 'enum', options: ACTM, re: true }, { k: 'minutes', l: 'Timeout minutes', t: 'int', min: 1, max: 40320, show: r => r.action === 'timeout' }];
  PAGES.moderation = async () => {
    const root = h('div'), set = k => { modTab = k; render(); }, M = CFG.moderation, X = { ch: () => dirty('moderation'), sec: 'moderation', redraw: () => render() };
    root.append(tabs([['actions', 'Actions'], ['warnings', 'Warnings'], ['log', 'Mod log'], ['automod', 'Auto moderation'], ['settings', 'Settings & punishments']], modTab, set));
    if (modTab === 'actions') {
      root.append(card('Moderate a member', 'Ban, kick, timeout, warn or clear messages right from the dashboard. Everything is logged.', form(MA, [{ k: 'type', l: 'Action', t: 'enum', re: true, options: [['warn', 'Warn'], ['timeout', 'Timeout'], ['untimeout', 'Remove timeout'], ['kick', 'Kick'], ['ban', 'Ban'], ['unban', 'Unban'], ['clear', 'Clear messages']] }, { k: 'userId', l: 'User ID', ph: 'Right-click user → Copy ID', show: a => a.type !== 'clear' }, { k: 'minutes', l: 'Timeout minutes', t: 'int', min: 1, max: 40320, show: a => a.type === 'timeout' }, { k: 'channelId', l: 'Channel', t: 'channel', show: a => a.type === 'clear' }, { k: 'count', l: 'How many messages (max 100, newer than 14 days)', t: 'int', min: 1, max: 100, show: a => a.type === 'clear' }, { k: 'reason', l: 'Reason', show: a => a.type !== 'clear' },
        { t: 'btn', l: 'Run action', cls: 'bad', run: async () => { if (!confirm('Run this action?')) return; await api('POST', '/mod/action', MA); toast('Done ✓'); render(); } }], { redraw: () => render() })));
      const l = await api('GET', '/mod/log'); root.append(card('Latest actions', null, logTable(l.items.slice(0, 10))));
    }
    if (modTab === 'warnings') {
      const inp = h('input', { placeholder: 'User ID', value: WARNU }), box = h('div');
      const show = async () => { WARNU = inp.value.trim(); if (!WARNU) { const r = await api('GET', '/mod/warnings'); box.replaceChildren(r.users.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'User ID'), h('th', {}, 'Warnings'), h('th', {}, 'Last'), h('th', {}))), h('tbody', {}, r.users.map(u => h('tr', {}, h('td', {}, u.id), h('td', {}, u.count), h('td', {}, ago(u.last)), h('td', {}, h('button', { class: 'btn sm', onclick: () => { inp.value = u.id; show(); } }, 'View')))))) ) : h('div', { class: 'hint' }, 'No warnings yet.')); return; }
        const r = await api('GET', '/mod/warnings?user=' + encodeURIComponent(WARNU)); box.replaceChildren(h('div', { class: 'btns' }, h('button', { class: 'btn bad sm', onclick: async () => { if (confirm('Clear all warnings of this user?')) { await api('DELETE', '/mod/warnings', { user: WARNU }); show(); } } }, 'Clear all')), r.warnings.length ? r.warnings.map(w => h('div', { class: 'card' }, h('div', {}, w.reason), h('div', { class: 'hint' }, ago(w.t) + ' • by ' + w.mod), h('button', { class: 'btn sm', onclick: async () => { await api('DELETE', '/mod/warnings', { user: WARNU, id: w.id }); show(); } }, 'Remove'))) : h('div', { class: 'hint' }, 'This user has no warnings.')); };
      root.append(card('Warning history', 'Leave empty and press Search to list everyone with warnings.', h('div', { style: 'display:flex;gap:8px' }, inp, h('button', { class: 'btn pri', onclick: () => show().catch(e => toast(e.message, true)) }, 'Search')), box)); show().catch(() => { });
    }
    if (modTab === 'log') { const box = h('div'), inp = h('input', { placeholder: 'Search the moderation log…', value: MQ }); const load = async () => { MQ = inp.value; const l = await api('GET', '/mod/log?q=' + encodeURIComponent(MQ)); box.replaceChildren(logTable(l.items)); }; inp.oninput = () => { clearTimeout(inp._t); inp._t = setTimeout(() => load().catch(() => { }), 300); }; root.append(card('Moderation log', null, inp, h('div', { style: 'height:10px' }), box)); load().catch(e => toast(e.message, true)); }
    if (modTab === 'automod') {
      const A = M.automod;
      root.append(card('Blocked words', 'Whole words/phrases, not case sensitive.', form(A.words, ruleSpec([{ k: 'list', l: 'Words', t: 'tags' }]), X)), card('Links', 'Block links except these domains (e.g. youtube.com).', form(A.links, ruleSpec([{ k: 'list', l: 'Allowed domains', t: 'tags' }]), X)), card('Discord invites', 'Block invites except these invite codes.', form(A.invites, ruleSpec([{ k: 'list', l: 'Allowed invite codes', t: 'tags' }]), X)),
        card('Spam', 'Too many messages in a short time.', form(A.spam, ruleSpec([{ k: 'max', l: 'Messages', t: 'int', min: 2, max: 30 }, { k: 'seconds', l: 'Within (seconds)', t: 'int', min: 2, max: 120 }]), X)), card('Too many capitals', null, form(A.caps, ruleSpec([{ k: 'percent', l: 'Capitals % to trigger', t: 'int', min: 30, max: 100 }, { k: 'minLength', l: 'Minimum letters', t: 'int', min: 5, max: 200 }]), X)));
    }
    if (modTab === 'settings') root.append(card('Moderation settings', 'Staff roles, ignored roles and channels are never touched by auto moderation. Members with Manage Messages are always ignored.', form(M, [{ k: 'logChannel', l: 'Moderation log channel', t: 'channel' }, { k: 'dmUser', l: 'DM users when they are moderated', t: 'bool' }, { k: 'staffRoles', l: 'Staff roles', t: 'roles' }, { k: 'ignoredRoles', l: 'Ignored roles', t: 'roles' }, { k: 'ignoredChannels', l: 'Ignored channels', t: 'channels' }, { k: 'notice', l: 'Notice shown when a message is removed', t: 'area', hint: VARS }, { k: 'noticeSeconds', l: 'Delete notice after (seconds, 0 = keep)', t: 'int', min: 0, max: 60 }], X)),
      card('Warning punishments', 'What happens automatically when a member reaches a number of warnings.', listCtl(M, { k: 'punishments', l: 'Punishments', max: 10, add: 'Add punishment', blank: () => ({ warns: 3, action: 'timeout', minutes: 60 }), title: p => `At ${p.warns} warnings → ${p.action}`, item: [{ k: 'warns', l: 'Warnings', t: 'int', min: 1, max: 50 }, { k: 'action', l: 'Action', t: 'enum', re: true, options: [['timeout', 'Timeout'], ['kick', 'Kick'], ['ban', 'Ban']] }, { k: 'minutes', l: 'Timeout minutes', t: 'int', min: 1, max: 40320, show: p => p.action === 'timeout' }] }, X)));
    return root;
  };
  const logTable = items => items.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Action', 'User', 'By', 'Reason'].map(x => h('th', {}, x)))), h('tbody', {}, items.map(e => h('tr', {}, h('td', {}, ago(e.t)), h('td', {}, e.type + (e.minutes ? ' (' + e.minutes + 'm)' : '')), h('td', {}, (e.user?.tag || '') + ' ' + (e.user?.id || '')), h('td', {}, e.mod), h('td', {}, e.reason)))))) : h('div', { class: 'hint' }, 'Nothing here yet.');
  PAGES.automation = () => {
    const root = h('div'), A = CFG.automation, X = { ch: () => dirty('automation'), sec: null };
    root.append(tabs([['responses', 'Auto responses'], ['scheduled', 'Scheduled messages'], ['triggers', 'Event triggers']], autoTab, k => { autoTab = k; render(); }));
    const emb = () => ({ title: '', description: '', color: '', url: '', author: { name: '', icon: '', url: '' }, footer: { text: '', icon: '' }, thumbnail: '', image: '', timestamp: false, fields: [] });
    if (autoTab === 'responses') root.append(card('Auto responses', 'The bot answers when a message matches.', listCtl(A, { k: 'autoResponses', l: 'Auto responses', add: 'New auto response', blank: () => ({ id: rid(), enabled: true, trigger: 'hello', match: 'contains', response: 'Hi {mention}!', embedOn: false, embed: emb(), channels: [], cooldown: 5, reply: true }), title: r => r.trigger, item: [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'trigger', l: 'When a message…', hint: 'Text or regular expression' }, { k: 'match', l: 'Match type', t: 'enum', options: [['contains', 'Contains'], ['exact', 'Is exactly'], ['starts', 'Starts with'], ['regex', 'Regular expression']] }, { k: 'response', l: 'Response', t: 'area', hint: VARS }, { k: 'embedOn', l: 'Respond with an embed', t: 'bool', re: true }, { k: 'embed', t: 'embed', show: r => r.embedOn }, { k: 'reply', l: 'Reply to the message', t: 'bool' }, { k: 'channels', l: 'Only in channels (empty = all)', t: 'channels' }, { k: 'cooldown', l: 'Cooldown (seconds)', t: 'int', min: 0, max: 3600 }] }, X)));
    if (autoTab === 'scheduled') root.append(card('Scheduled messages', 'Repeating announcements. Daily times use the UTC offset from Bot settings (currently UTC' + (CFG.general.utcOffset >= 0 ? '+' : '') + CFG.general.utcOffset + ').', listCtl(A, { k: 'scheduled', l: 'Scheduled messages', add: 'New scheduled message', blank: () => ({ id: rid(), enabled: true, name: 'Announcement', channel: '', mode: 'interval', everyMinutes: 60, time: '12:00', content: 'Hello everyone!', embedOn: false, embed: emb(), last: 0 }), title: s => s.name || 'Scheduled', item: [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'name', l: 'Name' }, { k: 'channel', l: 'Channel', t: 'channel' }, { k: 'mode', l: 'Repeat', t: 'enum', re: true, options: [['interval', 'Every N minutes'], ['daily', 'Every day at a time']] }, { k: 'everyMinutes', l: 'Every (minutes)', t: 'int', min: 1, max: 43200, show: s => s.mode === 'interval' }, { k: 'time', l: 'Time (HH:MM, 24h)', show: s => s.mode === 'daily' }, { k: 'content', l: 'Message', t: 'area', hint: VARS }, { k: 'embedOn', l: 'Send as embed', t: 'bool', re: true }, { k: 'embed', t: 'embed', show: s => s.embedOn }] }, X)));
    if (autoTab === 'triggers') root.append(card('Event triggers', 'Run actions automatically when something happens.', listCtl(A, { k: 'triggers', l: 'Triggers', add: 'New trigger', blank: () => ({ id: rid(), enabled: true, name: 'New trigger', event: 'memberJoin', role: '', actions: [] }), title: t => t.name, item: [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'name', l: 'Name' }, { k: 'event', l: 'When', t: 'enum', re: true, options: [['memberJoin', 'A member joins'], ['memberLeave', 'A member leaves'], ['voiceJoin', 'A member joins a voice channel'], ['roleAdded', 'A member receives a role'], ['boost', 'A member boosts the server']] }, { k: 'role', l: 'Role', t: 'role', show: t => t.event === 'roleAdded' }, actList()] }, X)));
    return root;
  };
  PAGES.logging = () => h('div', {}, card('Logging', 'Turn on the events you want, choose a channel and customize the look of each log. Ticket logs and transcripts are configured in the ticket dashboard.'), ...Object.entries(META.logs).map(([k, name]) => card(name, null, form(CFG.logging[k], [{ k: 'enabled', l: 'Enabled', t: 'bool' }, { k: 'channel', l: 'Channel', t: 'channel' }, { k: 'title', l: 'Embed title' }, { k: 'color', l: 'Embed color', t: 'color' }, { k: 'footer', l: 'Embed footer (optional)' }], { ch: () => dirty('logging') }))));
  PAGES.roles = () => card('Role menus', 'Let members pick roles with buttons, a select menu or reactions. Press Publish to post it; press it again after editing to update the same message. The bot’s role must be above the roles you offer.',
    listCtl(CFG.roles, { k: 'panels', l: 'Role menus', add: 'New role menu', max: 25, blank: () => ({ id: rid(), name: 'New menu', type: 'button', channel: '', messageId: '', title: 'Pick your roles', description: 'Choose the roles you want.', color: '', exclusive: false, items: [] }), title: p => p.name + (p.messageId ? ' ✅' : ''),
      item: [{ k: 'name', l: 'Name (only you see this)' }, { k: 'type', l: 'Style', t: 'enum', options: [['button', 'Buttons'], ['select', 'Select menu'], ['reaction', 'Reactions']] }, { k: 'channel', l: 'Channel', t: 'channel' }, { k: 'title', l: 'Embed title' }, { k: 'description', l: 'Embed description', t: 'area' }, { k: 'color', l: 'Color', t: 'color' }, { k: 'exclusive', l: 'Only one role at a time', t: 'bool' },
        { k: 'items', l: 'Roles', t: 'list', max: 25, add: 'Add role', blank: () => ({ label: 'Role', emoji: '', role: '', description: '' }), title: i => i.label || 'Role', item: [{ k: 'label', l: 'Label' }, { k: 'emoji', l: 'Emoji (required for reactions)' }, { k: 'role', l: 'Role', t: 'role' }, { k: 'description', l: 'Description (select menu)' }] }],
      extra: (p, draw) => [h('button', { class: 'btn ok sm', onclick: async ev => { const b = ev.currentTarget; b.disabled = true; try { await saveNow('roles'); await api('POST', '/roles/publish', { id: p.id }); p.messageId = p.messageId || 'x'; toast('Published ✓'); draw(); } catch (x) { toast(x.message, true); } b.disabled = false; } }, 'Publish / update message')] }, { ch: () => dirty('roles') }));
  PAGES.bot = () => h('div', {},
    card('Status & activity', 'Turn this on to let the dashboard control the bot’s status. (If your ticket dashboard also sets a status, the last one saved wins — use one of them.)', secForm('bot', [{ k: 'statusOn', l: 'Control the bot status from here', t: 'bool' }, { k: 'status', l: 'Status', t: 'enum', options: [['online', '🟢 Online'], ['idle', '🌙 Idle'], ['dnd', '⛔ Do Not Disturb'], ['invisible', '⚫ Invisible']] }, { k: 'activityType', l: 'Activity type', t: 'enum', options: [['Custom', 'Custom text'], ['Playing', 'Playing'], ['Watching', 'Watching'], ['Listening', 'Listening to'], ['Competing', 'Competing in']] }, { k: 'activityText', l: 'Activity text', hint: 'Variables: {members} {server}' }])),
    card('General', 'Defaults used by commands, embeds and messages.', secForm('general', [{ k: 'prefix', l: 'Custom command prefix', max: 5, hint: 'For text commands created on the Commands page. Your existing bot keeps its own prefix.' }, { k: 'language', l: 'Language tag', t: 'enum', options: [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['hi', 'हिन्दी'], ['ar', 'العربية'], ['tr', 'Türkçe'], ['ru', 'Русский'], ['id', 'Indonesia']], hint: 'Use {language} in any message to show it.' }, { k: 'embedColor', l: 'Default embed color', t: 'color' }, { k: 'footer', l: 'Default embed footer' }, { k: 'defaultCooldown', l: 'Default command cooldown (seconds)', t: 'int', min: 0, max: 3600 }, { k: 'utcOffset', l: 'Timezone (UTC offset, hours)', t: 'int', min: -12, max: 14 }, { k: 'errorMessage', l: 'Error message', t: 'area' }, { k: 'permMessage', l: 'No-permission message', t: 'area' }, { k: 'cooldownMessage', l: 'Cooldown message', t: 'area', hint: 'Use {seconds}' }])),
    card('Features', 'Turn whole systems on or off.', form(CFG.general.features, META.features.map(k => ({ k, l: FEATURE_L[k] || k, t: 'bool' })), { ch: () => dirty('general') })));
  PAGES.config = async () => {
    const hist = await api('GET', '/history'), name = h('input', { placeholder: 'Backup name (optional)' }), ta = h('textarea', { placeholder: 'Or paste exported JSON here' }), file = h('input', { type: 'file', accept: '.json,application/json' }), acc = h('input', { type: 'color', value: ls.get('ws_acc') || '#5865f2', style: 'width:70px' });
    const doImport = async txt => { const j = JSON.parse(txt); if (!confirm('Import this configuration? Your current settings are backed up first.')) return; const r = await api('POST', '/import', { config: j.config || j }); await reloadCfg(); toast('Imported: ' + r.imported.join(', ')); render(); };
    acc.oninput = () => { ls.set('ws_acc', acc.value); document.documentElement.style.setProperty('--acc', acc.value); };
    return h('div', {},
      card('Export & import', 'Download all settings of this server, or load them from a file (also works for another server).', h('div', { class: 'btns' }, h('button', { class: 'btn pri', onclick: async () => { try { const r = await fetch(BASE + '/api/export?g=' + G, { headers: { 'X-WS': '1' } }), j = await r.json(); dl((GD.name || 'bot') + '-config.json', j); } catch (e) { toast(e.message, true); } } }, '⬇ Export')), file, h('div', { style: 'height:8px' }), ta, h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => { try { if (file.files[0]) await doImport(await file.files[0].text()); else await doImport(ta.value); } catch (e) { toast(e.message, true); } } }, 'Import'))),
      card('Backups & history', 'Every change is saved to the history automatically. Create named backups before big changes.', h('div', { style: 'display:flex;gap:8px' }, name, h('button', { class: 'btn ok', onclick: async () => { await api('POST', '/backup', { name: name.value }); toast('Backup created'); render(); } }, 'Create backup')), h('div', { style: 'height:10px' }),
        hist.items.length ? h('div', { class: 'tw' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'What', 'By', ''].map(x => h('th', {}, x)))), h('tbody', {}, hist.items.map(i => h('tr', {}, h('td', {}, ago(i.t)), h('td', {}, (i.manual ? '💾 ' : '') + (i.name || i.section)), h('td', {}, i.user), h('td', {}, h('button', { class: 'btn sm', onclick: async () => { if (!confirm('Restore this version? The current settings are backed up first.')) return; try { const r = await api('POST', '/history/restore', { t: i.t }); await reloadCfg(); toast('Restored'); render(); } catch (e) { toast(e.message, true); } } }, 'Restore'), ' ', h('button', { class: 'btn bad sm', onclick: async () => { await api('DELETE', '/history', { t: i.t }); render(); } }, '✕'))))))) : h('div', { class: 'hint' }, 'No history yet.')),
      card('Reset', 'Reset a whole section back to its defaults (you can undo it from the history).', h('div', { class: 'btns' }, ['general', 'welcome', 'goodbye', 'autoRoles', 'verification', 'access', 'logging', 'moderation', 'automation', 'roles', 'commands', 'embeds', 'bot'].map(s => h('button', { class: 'btn sm bad', onclick: async () => { if (!confirm('Reset "' + s + '" to defaults?')) return; await api('POST', '/config/reset', { section: s }); await reloadCfg(); toast('Reset ' + s); } }, s)))),
      card('Theme', 'Only changes how this dashboard looks in your browser.', h('div', { class: 'row' }, h('label', { class: 'l' }, 'Accent color'), acc), h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { const on = document.body.classList.toggle('compact'); ls.set('ws_compact', on ? '1' : ''); } }, 'Toggle compact mode'), h('button', { class: 'btn', onclick: () => { ls.set('ws_acc', ''); document.documentElement.style.removeProperty('--acc'); toast('Theme reset'); } }, 'Reset theme'))));
  };

  // ───── shell, login, init ─────
  const NAV = [['overview', '📊', 'Overview'], ['server', '⚙️', 'Server'], ['tickets', '🎫', 'Tickets'], ['embeds', '🧩', 'Embeds'], ['commands', '⌨️', 'Commands'], ['moderation', '🔨', 'Moderation'], ['automation', '🤖', 'Automation'], ['logging', '📜', 'Logging'], ['roles', '🎭', 'Roles'], ['bot', '🛠️', 'Bot settings'], ['config', '💾', 'Backup & config']];
  const navFor = () => META.level === 'mod' ? NAV.filter(n => ['overview', 'moderation'].includes(n[0])) : NAV;
  async function render() { const y = window.scrollY; if (!mainEl) return; mainEl.replaceChildren(h('div', { class: 'spin' })); try { const el = await PAGES[page](); mainEl.replaceChildren(el); } catch (e) { mainEl.replaceChildren(card('Something went wrong', e.message)); } window.scrollTo(0, y); drawNav(); }
  let navEl;
  function drawNav() { if (!navEl) return; const q = SEARCH, list = navFor(), hit = list.filter(n => n[2].toLowerCase().includes(q)); navEl.replaceChildren(...(q && hit.length ? hit : list).map(([k, i, l]) => h('a', { class: k === page ? 'on' : '', onclick: () => { page = k; ls.set('ws_page', k); $('.side').classList.remove('open'); render(); } }, i + '  ' + l))); }
  async function pollStatus() { try { const s = await api('GET', '/status'), el = $('#botst'); if (el) el.replaceChildren(h('span', { class: 'dot ' + (s.online ? 'on' : 'bad') }), (s.tag || 'Bot') + ' • ' + (s.online ? s.ping + ' ms' : 'offline')); } catch { } }
  function buildShell() {
    navEl = h('div', { class: 'nav' }); mainEl = h('div', { class: 'content' });
    const guildSel = ME.guilds.length > 1 ? selectEl(ME.guilds.map(g => [g.id, g.name]), G, async v => { G = v; ls.set('ws_g', v); await loadGuild(); page = navFor().some(n => n[0] === page) ? page : 'overview'; render(); }) : h('b', {}, GD.name);
    const search = h('input', { placeholder: '🔍 Search pages & lists', style: 'max-width:240px' }); search.oninput = () => { SEARCH = search.value.trim().toLowerCase(); clearTimeout(search._t); search._t = setTimeout(() => { drawNav(); if (!['overview', 'config'].includes(page)) render(); }, 250); };
    search.onkeydown = e => { if (e.key === 'Enter' && SEARCH) { const hit = navFor().find(n => n[2].toLowerCase().includes(SEARCH)); if (hit) { page = hit[0]; SEARCH = ''; search.value = ''; render(); } } };
    $('#root').replaceChildren(h('div', { class: 'app' }, h('div', { class: 'side' }, h('h1', {}, '🤖 Bot Dashboard'), navEl, h('div', { class: 'hint', style: 'padding:12px 8px' }, 'Signed in as ' + (ME.user?.name || '')), h('button', { class: 'btn sm', style: 'margin:0 8px', onclick: async () => { await fetch(BASE + '/auth/logout', { headers: { 'X-WS': '1' } }); location.reload(); } }, 'Log out')),
      h('div', { class: 'main' }, h('div', { class: 'top' }, h('button', { class: 'btn burger', onclick: () => $('.side').classList.toggle('open') }, '☰'), guildSel, search, h('div', { class: 'grow' }), h('span', { id: 'savest', class: 'hint' }, '✓ All changes saved'), h('span', { id: 'botst', class: 'hint' })), mainEl)));
    pollStatus();
  }
  async function loadGuild() { GD = await api('GET', '/guild'); await reloadCfg(); }
  function showLogin() {
    ME = null; const pw = h('input', { type: 'password', placeholder: 'Password' }), go = async () => { const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WS': '1' }, body: JSON.stringify({ password: pw.value }) }); if (r.ok) init(); else toast((await r.json().catch(() => ({}))).error || 'Login failed', true); }; pw.onkeydown = e => { if (e.key === 'Enter') go(); };
    $('#root').replaceChildren(h('div', { class: 'login' }, card('🤖 Bot Dashboard', 'Sign in to manage your bot.', INFO.password ? h('div', {}, pw, h('div', { class: 'btns' }, h('button', { class: 'btn pri', onclick: go }, 'Log in'))) : null, INFO.oauth ? h('div', { class: 'btns' }, h('a', { class: 'btn pri', href: BASE + '/auth/discord', style: 'text-decoration:none' }, 'Login with Discord')) : null, !INFO.password && !INFO.oauth ? h('div', { class: 'hint' }, 'No login method is configured yet. Set DASHBOARD_PASSWORD (or CLIENT_ID + CLIENT_SECRET + PUBLIC_URL) in your environment variables and restart the bot.') : null)));
  }
  async function init() {
    try {
      const acc = ls.get('ws_acc'); if (acc) document.documentElement.style.setProperty('--acc', acc);
      INFO = await (await fetch(BASE + '/auth/info')).json().catch(() => ({}));
      const r = await fetch(BASE + '/api/me', { headers: { 'X-WS': '1' } }); if (r.status === 401) return showLogin(); ME = await r.json();
      if (!ME.guilds.length) { $('#root').replaceChildren(h('div', { class: 'login' }, card('No servers', 'The bot is not in any server you can manage.'))); return; }
      G = ls.get('ws_g'); if (!ME.guilds.some(g => g.id === G)) G = ME.guilds[0].id; await loadGuild(); if (ls.get('ws_compact')) document.body.classList.add('compact');
      const p = ls.get('ws_page'); page = navFor().some(n => n[0] === p) ? p : 'overview'; buildShell(); render();
      setInterval(pollStatus, 20000); setInterval(() => { if (page === 'overview' && !document.hidden) render(); }, 30000);
    } catch (e) { $('#root').replaceChildren(h('div', { class: 'login' }, card('Could not load', e.message))); }
  }
  if (window.__WS_TEST) window.__WS_TEST({ PAGES, init, h, api, state: () => ({ CFG, GD, META, G }), setPage: p => { page = p; }, setTab: (a, b) => { modTab = a; autoTab = b; }, dirty, form });
  else init();
}
module.exports = attach; module.exports.attach = attach;
