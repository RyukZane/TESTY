// Automod + media-only channels (runs on every message)
const { PermissionFlagsBits: P } = require('discord.js');
const db = require('./db'); const { logSend, logE } = require('./util');
const hist = new Map();
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const norm = t => t.toLowerCase().replace(/[013457@$!]/g, c => LEET[c]);
const rx = w => new RegExp('(?<![a-z0-9])' + [...norm(w)].filter(c => c !== ' ').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]{0,2}') + '(?![a-z0-9])');
const notice = async (m, t) => { const x = await m.channel.send(t).catch(() => null); setTimeout(() => x?.delete().catch(() => { }), 5000); };

async function punish(m, a, why) {
  let act = a.action;
  try {
    if (act === 'warn') db.raw.prepare('INSERT INTO warns(guild,user,mod,reason,at) VALUES(?,?,?,?,?)').run(m.guild.id, m.author.id, m.client.user.id, `Automod: ${why}`, Date.now());
    if (act === 'timeout') await m.member.timeout(a.minutes * 60000, `Automod: ${why}`);
    if (act === 'kick') await m.member.kick(`Automod: ${why}`);
    if (act === 'ban') await m.guild.members.ban(m.author, { reason: `Automod: ${why}` });
  } catch { act = 'delete (punishment failed)'; }
  notice(m, `⚠️ ${m.author}, your message was removed (${why}).`);
  logSend(m.guild, 'automod', logE(0xFEE75C, '🛡️ Automod').setDescription(`**User:** ${m.author} (${m.author.id})\n**Channel:** ${m.channel}\n**Rule:** ${why}\n**Action:** ${act}\n**Content:** ${m.content.slice(0, 500) || '—'}`));
}
async function check(m, s) {
  if (!m.member || m.member.permissions.has(P.ManageMessages)) return false;
  const a = s.automod;
  if (a.whitelist.includes(m.channelId) || m.member.roles.cache.some(r => a.whitelist.includes(r.id))) return false;
  const t = m.content;
  if (s.mediaonly.includes(m.channelId)) {
    const media = m.attachments.size || /https?:\/\/\S+\.(png|jpe?g|gif|webp|mp4|mov|webm)(\?\S*)?/i.test(t) || /https?:\/\/(tenor\.com|giphy\.com|imgur\.com|i\.imgur\.com|(cdn|media)\.discordapp)/i.test(t);
    if (!media) { await m.delete().catch(() => { }); notice(m, `📷 ${m.author}, this channel is media-only.`); return true; }
  }
  let why = null;
  if (a.words.length) { const n = norm(t); if (a.words.some(w => rx(w).test(n))) why = 'Banned word'; }
  if (!why && a.invites && /(discord\.gg|discord(app)?\.com\/invite)\/\w+/i.test(t)) why = 'Discord invite';
  if (!why && a.links && /https?:\/\/|www\./i.test(t)) why = 'Link';
  if (!why && a.caps && t.length >= 10) { const l = t.replace(/[^a-z]/gi, ''); if (l.length >= 8 && l.replace(/[^A-Z]/g, '').length / l.length > 0.7) why = 'Excessive caps'; }
  if (!why && (m.mentions.users.size + m.mentions.roles.size) > a.mentions) why = 'Mention spam';
  if (!why && a.spam) { const k = m.guild.id + m.author.id, now = Date.now(), h = (hist.get(k) || []).filter(x => now - x < 5000); h.push(now); hist.set(k, h); if (h.length >= 6) { why = 'Spam'; hist.delete(k); } }
  if (!why) return false;
  await m.delete().catch(() => { }); await punish(m, a, why); return true;
}
module.exports = { check };
