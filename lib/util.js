const { EmbedBuilder, PermissionFlagsBits: P, AuditLogEvent, MessageFlags } = require('discord.js');
const db = require('./db');
const EPH = MessageFlags.Ephemeral;
const BRAND = process.env.BRAND || 'DynastySMP';
const BRAND_EMOJI = process.env.PANEL_EMOJI || '<:22:1533158304501596260>';
// Turns '<:name:id>' / '<a:name:id>' / unicode into the object buttons need
function toEmoji(s) { const m = /^<(a?):(\w+):(\d+)>$/.exec(s || ''); return m ? { id: m[3], name: m[2], animated: !!m[1] } : { name: s }; }
const validEmoji = s => /^<a?:\w+:\d+>$/.test(s) || !/[a-z0-9]/i.test(s);
const COLORS = { red: 0xED4245, blue: 0x3498DB, green: 0x57F287, yellow: 0xFEE75C, orange: 0xE67E22, purple: 0x9B59B6, pink: 0xFF73FA, cyan: 0x1ABC9C, black: 0x010101, white: 0xFFFFFF, grey: 0x95A5A6, gray: 0x95A5A6 };
// 'none'/empty -> no color. returns {ok,color}
function parseColor(s) {
  if (!s) return { ok: true, color: null }; s = s.trim().toLowerCase();
  if (s === 'none' || s === 'no') return { ok: true, color: null };
  if (COLORS[s]) return { ok: true, color: COLORS[s] };
  if (/^#?[0-9a-f]{6}$/.test(s)) return { ok: true, color: parseInt(s.replace('#', ''), 16) };
  return { ok: false };
}
const COLOR_HELP = 'none, ' + Object.keys(COLORS).join(', ') + ' or a hex like #ff0000';
const isAdmin = m => m.permissions.has(P.Administrator) || m.permissions.has(P.ManageGuild);
const isStaff = (m, s) => isAdmin(m) || s.ticket.roles.some(r => m.roles.cache.has(r));
const say = (t, c = 0x5865F2) => ({ embeds: [new EmbedBuilder().setColor(c).setDescription(t)] });
const dur = ms => { if (!ms || ms < 0) return 'n/a'; const m = Math.round(ms / 60000); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`; };
const logE = (color, title) => new EmbedBuilder().setColor(color).setTitle(title);
function logSend(guild, type, embed) {
  const l = db.get(guild.id).logs; if (l.off.includes(type)) return;
  const ch = guild.channels.cache.get(l.channels[type] || l.channel); if (ch) ch.send({ embeds: [embed.setTimestamp()] }).catch(() => { });
}
async function audit(guild, type, targetId) {
  try { const r = await guild.fetchAuditLogs({ type, limit: 6 }); const e = r.entries.find(e => e.target?.id === targetId && Date.now() - e.createdTimestamp < 15000); return e ? { by: e.executor, reason: e.reason } : {}; } catch { return {}; }
}
module.exports = { EPH, BRAND, BRAND_EMOJI, toEmoji, validEmoji, COLORS, parseColor, COLOR_HELP, isAdmin, isStaff, say, dur, logE, logSend, audit, AuditLogEvent };
