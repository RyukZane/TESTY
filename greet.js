// greet.js — Welcome panel + Invite tracker + /config  (single file, drop in repo root next to index.js)
const { SlashCommandBuilder: S, EmbedBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType, PermissionFlagsBits: P, Events,
  ActionRowBuilder: Row, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const db = require('./lib/db'); const { EPH, BRAND, say, parseColor, COLOR_HELP } = require('./lib/util');
const B = ButtonStyle;

// ---------- own storage (no changes to db.js needed) ----------
db.raw.exec(`
CREATE TABLE IF NOT EXISTS greet_settings(guild TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invite_joins(guild TEXT, user TEXT, inviter TEXT, code TEXT, at INTEGER, fake INTEGER DEFAULT 0, has_left INTEGER DEFAULT 0, PRIMARY KEY(guild,user));
CREATE INDEX IF NOT EXISTS invite_by ON invite_joins(guild, inviter);`);
const DEFAULTS = () => ({
  welcome: { enabled: false, channel: null, title: 'Welcome to {server}!', description: 'Hey {user}, welcome to **{server}**!\nYou are member **#{count}**. Check the rules and have fun!', footer: '', color: '#5865F2', image: '', avatar: true, ping: true, dm: false, dmText: 'Welcome to **{server}**, {username}! Read the rules and have fun.', roles: [] },
  invites: { enabled: false, channel: null, join: '{user} has joined **{server}**, invited by **{inviter.name}**, who now has **{invites}** invites.', leave: '**{username}** has left **{server}**, invited by **{inviter.name}**, who now has **{invites}** invites.', fakeDays: 7 },
});
function cfg(gid) {
  const d = DEFAULTS(), r = db.raw.prepare('SELECT data FROM greet_settings WHERE guild=?').get(gid);
  if (r) { const s = JSON.parse(r.data); for (const k of Object.keys(d)) d[k] = { ...d[k], ...(s[k] || {}) }; }
  return d;
}
function mut(gid, key, fn) {
  const d = cfg(gid); fn(d[key]);
  db.raw.prepare('INSERT INTO greet_settings(guild,data) VALUES(?,?) ON CONFLICT(guild) DO UPDATE SET data=excluded.data').run(gid, JSON.stringify(d));
  return d[key];
}

// ---------- helpers ----------
// {placeholder} filler shared by the welcome message + invite tracker
const fill = (t, v) => String(t ?? '').replace(/\{([\w.]+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
function vars(member, x = {}) {
  return {
    user: `<@${member.id}>`, username: member.user?.username ?? 'Unknown', id: member.id,
    server: member.guild.name, count: member.guild.memberCount,
    created: member.user ? `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` : 'unknown',
    inviter: x.inviter ?? 'Unknown', 'inviter.name': x['inviter.name'] ?? 'Unknown', invites: x.invites ?? 0, code: x.code ?? 'unknown',
  };
}

const rowOf = (...c) => new Row().addComponents(...c);
const btn = (id, label, style = ButtonStyle.Secondary, emoji) => { const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style); if (emoji) b.setEmoji(emoji); return b; };
// fields: [{ id, label, long, required, max, value, ph }]
function modal(id, title, fields) {
  const m = new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45));
  for (const f of fields) {
    const max = f.max || 100;
    const t = new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0, 45)).setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(!!f.required).setMaxLength(max);
    if (f.value) t.setValue(String(f.value).slice(0, max));
    if (f.ph) t.setPlaceholder(f.ph.slice(0, 100));
    m.addComponents(rowOf(t));
  }
  return m;
}
const canManage = i => !!i.memberPermissions?.has(P.ManageGuild);
const deny = i => i.reply({ content: '❌ You need **Manage Server** to use this panel.', flags: EPH });


const welcome = (() => {
// Welcome message: setup panel + sender

function build(member, w, x = {}) {
  const v = vars(member, x), e = new EmbedBuilder(), c = parseColor(w.color);
  if (c.color != null) e.setColor(c.color);
  const t = fill(w.title, v).slice(0, 256); if (t) e.setTitle(t);
  e.setDescription(fill(w.description, v).slice(0, 4000) || '\u200b');
  if (w.footer) e.setFooter({ text: fill(w.footer, v).slice(0, 2048) });
  if (w.avatar) e.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  if (/^https?:\/\/\S+$/.test(w.image || '')) e.setImage(w.image);
  return { content: w.ping ? `<@${member.id}>` : undefined, embeds: [e], allowedMentions: { users: [member.id] } };
}

async function onJoin(m, x = {}) {
  const w = cfg(m.guild.id).welcome; if (!w.enabled) return;
  if (w.roles?.length) {
    const roles = w.roles.map(r => m.guild.roles.cache.get(r)).filter(r => r?.editable);
    if (roles.length) await m.roles.add(roles, 'Welcome auto-role').catch(e => console.error('Auto-role failed:', e.message));
  }
  const ch = w.channel && m.guild.channels.cache.get(w.channel);
  if (ch) await ch.send(build(m, w, x)).catch(e => console.error('Welcome send failed:', e.message));
  if (w.dm && w.dmText) await m.send({ content: fill(w.dmText, vars(m, x)).slice(0, 2000) }).catch(() => { });
}

const onoff = b => (b ? '🟢 On' : '🔴 Off');
function render(guild) {
  const w = cfg(guild.id).welcome, me = guild.members.me, ch = w.channel && guild.channels.cache.get(w.channel);
  const chTxt = ch ? `${ch}${ch.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]) ? '' : ' ⚠️ bot lacks permissions there'}` : '*not set*';
  const roles = (w.roles || []).map(r => guild.roles.cache.get(r)).filter(Boolean);
  const rolesTxt = roles.length ? roles.map(r => `${r}${r.editable ? '' : ' ⚠️'}`).join(' ') + (roles.some(r => !r.editable) ? '\n⚠️ = above the bot\'s role, can\'t be given' : '') : '*none*';
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s) || '—';
  const e = new EmbedBuilder().setColor(w.enabled ? 0x57F287 : 0xED4245).setTitle('👋 Welcome Message Setup')
    .setDescription('Configure what new members see. Changes save instantly — hit **Preview** to check it.')
    .addFields(
      { name: 'Status', value: onoff(w.enabled), inline: true }, { name: 'Channel', value: chTxt, inline: true }, { name: 'Auto-roles', value: rolesTxt, inline: true },
      { name: 'Ping member', value: onoff(w.ping), inline: true }, { name: 'Avatar thumbnail', value: onoff(w.avatar), inline: true }, { name: 'DM on join', value: onoff(w.dm), inline: true },
      { name: 'Style', value: `Color: \`${w.color || 'none'}\`\nImage: ${w.image ? '[set]' : '*none*'}`, inline: true },
      { name: 'Message', value: `**Title:** ${cut(w.title, 150)}\n**Text:** ${cut(w.description, 500)}\n**Footer:** ${cut(w.footer || '', 100)}` },
      { name: 'Placeholders', value: '`{user}` `{username}` `{server}` `{count}` `{created}` `{inviter.name}` `{invites}`' });
  const chMenu = new ChannelSelectMenuBuilder().setCustomId('wl:channel').setPlaceholder('Select the welcome channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (ch) chMenu.setDefaultChannels(ch.id);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId('wl:roles').setPlaceholder('Auto-roles given on join (up to 5)').setMinValues(0).setMaxValues(5);
  if (roles.length) roleMenu.setDefaultRoles(roles.map(r => r.id));
  return { embeds: [e], components: [
    rowOf(btn('wl:toggle', w.enabled ? 'Enabled' : 'Disabled', w.enabled ? B.Success : B.Danger, w.enabled ? '✅' : '⛔'), btn('wl:msg', 'Edit message', B.Primary, '✏️'), btn('wl:style', 'Style', B.Secondary, '🎨'), btn('wl:preview', 'Preview', B.Secondary, '👁️'), btn('wl:test', 'Send test', B.Secondary, '🧪')),
    rowOf(chMenu), rowOf(roleMenu),
    rowOf(btn('wl:dm', `DM: ${w.dm ? 'On' : 'Off'}`, w.dm ? B.Success : B.Secondary), btn('wl:dmtext', 'Edit DM text', B.Secondary, '💬'), btn('wl:ping', `Ping: ${w.ping ? 'On' : 'Off'}`, w.ping ? B.Success : B.Secondary), btn('wl:avatar', `Avatar: ${w.avatar ? 'On' : 'Off'}`, w.avatar ? B.Success : B.Secondary)),
  ] };
}

async function handle(i) {
  if (!canManage(i)) return deny(i);
  const g = i.guild.id, id = i.customId.slice(3), w = cfg(g).welcome, upd = () => i.update(render(i.guild));
  const set = fn => mut(g, 'welcome', fn);
  const sample = { inviter: i.user.toString(), 'inviter.name': i.user.username, invites: 5 };
  switch (id) {
    case 'toggle':
      if (!w.enabled && !w.channel) return i.reply({ content: '❌ Pick a welcome channel first (dropdown below).', flags: EPH });
      set(x => { x.enabled = !x.enabled; }); return upd();
    case 'ping': set(x => { x.ping = !x.ping; }); return upd();
    case 'avatar': set(x => { x.avatar = !x.avatar; }); return upd();
    case 'dm': set(x => { x.dm = !x.dm; }); return upd();
    case 'channel': set(x => { x.channel = i.values[0]; }); return upd();
    case 'roles': set(x => { x.roles = i.values; }); return upd();
    case 'preview': return i.reply({ ...build(i.member, w, sample), flags: EPH });
    case 'test': {
      const ch = w.channel && i.guild.channels.cache.get(w.channel);
      if (!ch) return i.reply({ content: '❌ Pick a welcome channel first.', flags: EPH });
      try { await ch.send(build(i.member, w, sample)); } catch (e) { return i.reply({ content: `❌ Couldn't send in ${ch}: ${e.message}`, flags: EPH }); }
      return i.reply({ content: `✅ Test welcome sent in ${ch}.`, flags: EPH });
    }
    case 'msg': return i.showModal(modal('wl:m:msg', 'Welcome message', [
      { id: 'title', label: 'Title (placeholders allowed)', max: 256, value: w.title, ph: 'Welcome to {server}!' },
      { id: 'description', label: 'Message text', long: true, required: true, max: 2000, value: w.description, ph: 'Hey {user}, welcome to **{server}**!' },
      { id: 'footer', label: 'Footer (optional)', max: 200, value: w.footer }]));
    case 'style': return i.showModal(modal('wl:m:style', 'Welcome style', [
      { id: 'color', label: 'Color (name, #hex or none)', max: 20, value: w.color, ph: 'blue, #5865F2, none' },
      { id: 'image', label: 'Big image URL (blank = none)', max: 400, value: w.image, ph: 'https://…' }]));
    case 'dmtext': return i.showModal(modal('wl:m:dm', 'Welcome DM text', [
      { id: 'text', label: 'DM message', long: true, required: true, max: 1500, value: w.dmText }]));
    case 'm:msg':
      set(x => { x.title = i.fields.getTextInputValue('title').trim(); x.description = i.fields.getTextInputValue('description').trim(); x.footer = i.fields.getTextInputValue('footer').trim(); });
      return i.isFromMessage() ? upd() : i.reply({ content: '✅ Saved. Re-open `/welcome` to see it.', flags: EPH });
    case 'm:style': {
      const c = i.fields.getTextInputValue('color').trim(), img = i.fields.getTextInputValue('image').trim();
      if (c && !parseColor(c).ok) return i.reply({ content: `❌ Invalid color. Use: ${COLOR_HELP}`, flags: EPH });
      if (img && !/^https?:\/\/\S+$/.test(img)) return i.reply({ content: '❌ Image must be a direct link starting with http(s)://', flags: EPH });
      set(x => { x.color = c || 'none'; x.image = img; });
      return i.isFromMessage() ? upd() : i.reply({ content: '✅ Saved.', flags: EPH });
    }
    case 'm:dm':
      set(x => { x.dmText = i.fields.getTextInputValue('text').trim(); });
      return i.isFromMessage() ? upd() : i.reply({ content: '✅ Saved.', flags: EPH });
  }
}

return { build, onJoin, render, handle };
})();

const invites = (() => {
// Invite tracker: who invited who, join/leave messages, stats, setup panel

const VANITY_MSG = '{user} has joined **{server}** using the server\'s vanity URL.';
const UNKNOWN_MSG = '{user} has joined **{server}**, but I couldn\'t work out who invited them.';
const cache = new Map(), vanity = new Map(), queue = new Map(); // guildId -> Map(code -> {uses,max,inviter})
const serial = (gid, fn) => { const next = (queue.get(gid) || Promise.resolve()).then(fn, fn); queue.set(gid, next.catch(() => { })); return next; };

// ---------- stats ----------
function stats(gid, uid) {
  const r = db.raw.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(CASE WHEN fake=1 THEN 1 ELSE 0 END),0) fake,
    COALESCE(SUM(CASE WHEN fake=0 AND has_left=1 THEN 1 ELSE 0 END),0) lft,
    COALESCE(SUM(CASE WHEN fake=0 AND has_left=0 THEN 1 ELSE 0 END),0) active
    FROM invite_joins WHERE guild=? AND inviter=?`).get(gid, uid);
  return r;
}
const leaderboard = (gid, n = 10) => db.raw.prepare(`SELECT inviter, COUNT(*) total,
  SUM(CASE WHEN fake=0 AND has_left=0 THEN 1 ELSE 0 END) active, SUM(CASE WHEN fake=0 AND has_left=1 THEN 1 ELSE 0 END) lft, SUM(fake) fake
  FROM invite_joins WHERE guild=? AND inviter IS NOT NULL GROUP BY inviter ORDER BY active DESC, total DESC LIMIT ?`).all(gid, n);
const reset = (gid, uid) => (uid ? db.raw.prepare('DELETE FROM invite_joins WHERE guild=? AND inviter=?').run(gid, uid) : db.raw.prepare('DELETE FROM invite_joins WHERE guild=?').run(gid)).changes;

// ---------- detection ----------
async function warm(guild) {
  try {
    const inv = await guild.invites.fetch();
    cache.set(guild.id, new Map(inv.map(i => [i.code, { uses: i.uses ?? 0, max: i.maxUses ?? 0, inviter: i.inviter?.id ?? null }])));
    if (guild.vanityURLCode) vanity.set(guild.id, (await guild.fetchVanityData().catch(() => null))?.uses ?? 0);
  } catch { /* missing Manage Server */ }
}
async function detect(guild) {
  const old = cache.get(guild.id); let now;
  try { now = new Map((await guild.invites.fetch()).map(i => [i.code, { uses: i.uses ?? 0, max: i.maxUses ?? 0, inviter: i.inviter?.id ?? null }])); } catch { return null; }
  let found = null;
  if (old) {
    for (const [code, v] of now) { const o = old.get(code); if (v.uses > (o?.uses ?? 0)) { found = { code, inviter: v.inviter }; break; } }
    if (!found) for (const [code, o] of old) if (!now.has(code) && o.max > 0 && o.uses + 1 >= o.max) { found = { code, inviter: o.inviter }; break; } // single-use invite that got deleted
  }
  cache.set(guild.id, now);
  if (!found && guild.vanityURLCode) {
    const u = (await guild.fetchVanityData().catch(() => null))?.uses;
    if (u != null) { if (vanity.has(guild.id) && u > vanity.get(guild.id)) found = { code: guild.vanityURLCode, inviter: null, vanity: true }; vanity.set(guild.id, u); }
  }
  return found;
}
const nameOf = async (client, id) => client.users.cache.get(id)?.username ?? (await client.users.fetch(id).catch(() => null))?.username ?? 'Unknown';

// ---------- events ----------
async function onJoin(m) {
  const g = m.guild, s = cfg(g.id).invites;
  let x = {}, text = UNKNOWN_MSG, fake = false;
  if (!m.user.bot) {
    const d = await serial(g.id, () => detect(g)).catch(() => null);
    fake = s.fakeDays > 0 && Date.now() - m.user.createdTimestamp < s.fakeDays * 86400000;
    const put = (inviter, code) => db.raw.prepare(`INSERT INTO invite_joins(guild,user,inviter,code,at,fake,has_left) VALUES(?,?,?,?,?,?,0)
      ON CONFLICT(guild,user) DO UPDATE SET inviter=excluded.inviter, code=excluded.code, at=excluded.at, fake=excluded.fake, has_left=0`).run(g.id, m.id, inviter, code, Date.now(), fake ? 1 : 0);
    if (d?.vanity) { put(null, d.code); text = VANITY_MSG; x = { code: d.code }; }
    else if (d?.inviter) {
      put(d.inviter, d.code); const st = stats(g.id, d.inviter), nm = await nameOf(m.client, d.inviter);
      x = { inviter: `<@${d.inviter}>`, 'inviter.name': nm, invites: st.active, code: d.code }; text = s.join;
    }
    if (s.enabled && s.channel) {
      const ch = g.channels.cache.get(s.channel);
      if (ch) await ch.send({ content: (fill(text, vars(m, x)) + (fake && d?.inviter ? '\n⚠️ *New account — not counted as an invite.*' : '')).slice(0, 2000), allowedMentions: { users: [m.id, ...(d?.inviter ? [d.inviter] : [])] }, flags: MessageFlags.SuppressNotifications }).catch(e => console.error('Invite msg failed:', e.message));
    }
  }
  if (!m.user.bot) await welcome.onJoin(m, x).catch(e => console.error('Welcome failed:', e.message));
}
async function onLeave(m) {
  const g = m.guild, s = cfg(g.id).invites;
  const row = db.raw.prepare('SELECT inviter FROM invite_joins WHERE guild=? AND user=? AND has_left=0').get(g.id, m.id);
  if (!row) return;
  db.raw.prepare('UPDATE invite_joins SET has_left=1 WHERE guild=? AND user=?').run(g.id, m.id);
  if (!row.inviter || !s.enabled || !s.channel) return;
  const ch = g.channels.cache.get(s.channel); if (!ch) return;
  const st = stats(g.id, row.inviter), nm = await nameOf(m.client, row.inviter);
  const v = { user: `<@${m.id}>`, username: m.user?.username ?? 'Unknown', id: m.id, server: g.name, count: g.memberCount, created: 'unknown', inviter: `<@${row.inviter}>`, 'inviter.name': nm, invites: st.active, code: 'unknown' };
  ch.send({ content: fill(s.leave, v).slice(0, 2000), allowedMentions: { users: [m.id, row.inviter] }, flags: MessageFlags.SuppressNotifications }).catch(() => { });
}
function init(c) {
  c.once(Events.ClientReady, () => c.guilds.cache.forEach(warm));
  c.on(Events.GuildCreate, warm);
  c.on(Events.InviteCreate, i => { if (!i.guild) return; (cache.get(i.guild.id) ?? cache.set(i.guild.id, new Map()).get(i.guild.id)).set(i.code, { uses: i.uses ?? 0, max: i.maxUses ?? 0, inviter: i.inviter?.id ?? null }); });
  c.on(Events.InviteDelete, i => { if (i.guild) setTimeout(() => cache.get(i.guild.id)?.delete(i.code), 3000); }); // small delay so a just-used single-use invite is still detectable
  c.on(Events.GuildMemberAdd, m => onJoin(m).catch(e => console.error('Join handler:', e)));
  c.on(Events.GuildMemberRemove, m => onLeave(m).catch(e => console.error('Leave handler:', e)));
}

// ---------- embeds ----------
function statsEmbed(user, st) {
  return new EmbedBuilder().setColor(0x5865F2).setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setTitle(`${st.active} invites`).setDescription(`✅ **${st.active}** active • 🚪 **${st.lft}** left • ⚠️ **${st.fake}** fake/new accounts\n📊 **${st.total}** total joins`);
}
async function boardEmbed(guild) {
  const rows = leaderboard(guild.id), medal = ['🥇', '🥈', '🥉'];
  const lines = await Promise.all(rows.map(async (r, n) => `${medal[n] || `**${n + 1}.**`} <@${r.inviter}> — **${r.active}** invites *(${r.lft} left, ${r.fake} fake)*`));
  return new EmbedBuilder().setColor(0xFEE75C).setTitle(`🏆 ${guild.name} • Invite Leaderboard`).setDescription(lines.join('\n') || '*No invites tracked yet.*');
}

// ---------- panel ----------
const onoff = b => (b ? '🟢 On' : '🔴 Off');
function render(guild) {
  const s = cfg(guild.id).invites, me = guild.members.me, ch = s.channel && guild.channels.cache.get(s.channel);
  const chTxt = ch ? `${ch}${ch.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages]) ? '' : ' ⚠️ bot lacks permissions there'}` : '*not set*';
  const e = new EmbedBuilder().setColor(s.enabled ? 0x57F287 : 0xED4245).setTitle('🔗 Invite Tracker Setup')
    .setDescription('Tracks who invited every member. Join/leave messages post in the channel you pick.' + (me.permissions.has(P.ManageGuild) ? '' : '\n\n⚠️ **The bot needs the Manage Server permission to see invites.**'))
    .addFields(
      { name: 'Status', value: onoff(s.enabled), inline: true }, { name: 'Channel', value: chTxt, inline: true }, { name: 'Fake-account age', value: s.fakeDays ? `< ${s.fakeDays} days old` : 'off', inline: true },
      { name: 'Join message', value: s.join.slice(0, 500) }, { name: 'Leave message', value: s.leave.slice(0, 500) },
      { name: 'Placeholders', value: '`{user}` `{username}` `{server}` `{count}` `{inviter}` `{inviter.name}` `{invites}` `{code}`' });
  const menu = new ChannelSelectMenuBuilder().setCustomId('iv:channel').setPlaceholder('Select the invite log channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (ch) menu.setDefaultChannels(ch.id);
  return { embeds: [e], components: [
    rowOf(btn('iv:toggle', s.enabled ? 'Enabled' : 'Disabled', s.enabled ? B.Success : B.Danger, s.enabled ? '✅' : '⛔'), btn('iv:join', 'Join message', B.Primary, '📥'), btn('iv:leave', 'Leave message', B.Primary, '📤'), btn('iv:fake', 'Fake accounts', B.Secondary, '⚠️'), btn('iv:preview', 'Preview', B.Secondary, '👁️')),
    rowOf(menu)] };
}
async function handle(i) {
  if (!canManage(i)) return deny(i);
  const g = i.guild.id, id = i.customId.slice(3), s = cfg(g).invites, upd = () => i.update(render(i.guild)), set = fn => mut(g, 'invites', fn);
  switch (id) {
    case 'toggle':
      if (!s.enabled && !s.channel) return i.reply({ content: '❌ Pick a channel first (dropdown below).', flags: EPH });
      set(x => { x.enabled = !x.enabled; }); return upd();
    case 'channel': set(x => { x.channel = i.values[0]; }); return upd();
    case 'preview': {
      const v = vars(i.member, { inviter: i.user.toString(), 'inviter.name': i.user.username, invites: 5, code: 'abc123' });
      return i.reply({ content: `**Join:**\n${fill(s.join, v)}\n\n**Leave:**\n${fill(s.leave, v)}`.slice(0, 2000), flags: EPH, allowedMentions: { parse: [] } });
    }
    case 'join': return i.showModal(modal('iv:m:join', 'Join message', [{ id: 'text', label: 'Join message', long: true, required: true, max: 500, value: s.join }]));
    case 'leave': return i.showModal(modal('iv:m:leave', 'Leave message', [{ id: 'text', label: 'Leave message', long: true, required: true, max: 500, value: s.leave }]));
    case 'fake': return i.showModal(modal('iv:m:fake', 'Fake accounts', [{ id: 'days', label: 'Accounts newer than X days = fake (0 = off)', required: true, max: 3, value: String(s.fakeDays) }]));
    case 'm:join': case 'm:leave': set(x => { x[id.slice(2)] = i.fields.getTextInputValue('text').trim(); }); return i.isFromMessage() ? upd() : i.reply({ content: '✅ Saved.', flags: EPH });
    case 'm:fake': { const n = parseInt(i.fields.getTextInputValue('days')); if (Number.isNaN(n) || n < 0 || n > 365) return i.reply({ content: '❌ Enter a number from 0 to 365.', flags: EPH });
      set(x => { x.fakeDays = n; }); return i.isFromMessage() ? upd() : i.reply({ content: '✅ Saved.', flags: EPH }); }
  }
}

return { init, stats, statsEmbed, boardEmbed, reset, render, handle };
})();

const config = (() => {
// /config — one-screen overview of every setting + shortcuts to the panels
const c = id => (id ? `<#${id}>` : '*not set*'), on = b => (b ? '🟢' : '🔴');
function render(guild) {
  const s = db.get(guild.id), a = s.automod, t = s.ticket, gc = cfg(guild.id); s.welcome = gc.welcome; s.invites = gc.invites;
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`⚙️ ${BRAND} • Configuration`).setDescription(`Prefix: \`${s.prefix}\` (change with \`${s.prefix}prefix <new>\`)`)
    .addFields(
      { name: '👋 Welcome', value: `${on(s.welcome.enabled)} ${s.welcome.enabled ? 'enabled' : 'disabled'}\nChannel: ${c(s.welcome.channel)}\nAuto-roles: **${s.welcome.roles.length}** • DM: ${on(s.welcome.dm)}`, inline: true },
      { name: '🔗 Invite tracker', value: `${on(s.invites.enabled)} ${s.invites.enabled ? 'enabled' : 'disabled'}\nChannel: ${c(s.invites.channel)}\nFake age: **${s.invites.fakeDays}d**`, inline: true },
      { name: '🎫 Tickets', value: `Panel: ${c(t.panelCh)}\nLogs: ${c(t.logCh)}\nSupport roles: **${t.roles.length}** • Categories: **${t.cats.length}** • Max/user: **${t.max}**`, inline: true },
      { name: '🧾 Audit logs', value: `Channel: ${c(s.logs.channel)}\nDisabled types: ${s.logs.off.length ? s.logs.off.join(', ') : 'none'}`, inline: true },
      { name: '🛡️ Automod', value: `${on(a.links)} links ${on(a.invites)} invites ${on(a.spam)} spam ${on(a.caps)} caps\nMentions limit: **${a.mentions}** • Action: **${a.action}**\nBad words: **${a.words.length}**`, inline: true },
      { name: '🖼️ Media-only', value: s.mediaonly.length ? s.mediaonly.map(id => `<#${id}>`).join(' ') : '*none*', inline: true });
  return { embeds: [e], components: [rowOf(btn('cf:welcome', 'Welcome panel', B.Primary, '👋'), btn('cf:invites', 'Invite panel', B.Primary, '🔗'), btn('cf:refresh', 'Refresh', B.Secondary, '🔄'))] };
}
async function handle(i) {
  if (!canManage(i)) return deny(i);
  switch (i.customId.slice(3)) {
    case 'welcome': return i.reply({ ...welcome.render(i.guild), flags: EPH });
    case 'invites': return i.reply({ ...invites.render(i.guild), flags: EPH });
    case 'refresh': return i.update(render(i.guild));
  }
}

return { render, handle };
})();

// ---------- commands ----------
const commands = [
  { perm: P.ManageGuild, data: new S().setName('welcome').setDescription('Open the welcome message setup panel').setDefaultMemberPermissions(P.ManageGuild),
    run: ctx => ctx.reply(welcome.render(ctx.guild)) },
  { perm: P.ManageGuild, data: new S().setName('invitetracker').setDescription('Open the invite tracker setup panel').setDefaultMemberPermissions(P.ManageGuild),
    run: ctx => ctx.reply(invites.render(ctx.guild)) },
  { perm: P.ManageGuild, data: new S().setName('config').setDescription('Show all bot settings in one place').setDefaultMemberPermissions(P.ManageGuild),
    run: ctx => ctx.reply(config.render(ctx.guild)) },
  { data: new S().setName('invites').setDescription('Show how many people someone has invited').addUserOption(o => o.setName('user').setDescription('User (default: you)')),
    async run(ctx) { const u = ctx.opts.getUser('user') || ctx.user; return ctx.reply({ embeds: [invites.statsEmbed(u, invites.stats(ctx.guild.id, u.id))] }); } },
  { data: new S().setName('inviteleaderboard').setDescription('Top inviters in this server'),
    async run(ctx) { return ctx.reply({ embeds: [await invites.boardEmbed(ctx.guild)] }); } },
  { perm: P.ManageGuild, data: new S().setName('invitereset').setDescription('Reset tracked invites for one user, or everyone').setDefaultMemberPermissions(P.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Reset this inviter'))
      .addBooleanOption(o => o.setName('everyone').setDescription('true = wipe ALL invite data in this server')),
    async run(ctx) {
      const u = ctx.opts.getUser('user'), all = ctx.opts.getBoolean('everyone');
      if (all) return ctx.reply(say(`✅ Wiped invite data for **${invites.reset(ctx.guild.id)}** members.`, 0x57F287));
      if (!u) return ctx.reply({ content: '❌ Pick a `user`, or set `everyone` to true.', flags: EPH });
      return ctx.reply(say(`✅ Reset invites for ${u} (**${invites.reset(ctx.guild.id, u.id)}** records removed).`, 0x57F287));
    } },
];


// ---------- router (called from index.js) ----------
const handle = i => {
  const p = i.customId.slice(0, 3);
  if (p === 'wl:') return welcome.handle(i);
  if (p === 'iv:') return invites.handle(i);
  if (p === 'cf:') return config.handle(i);
};
module.exports = { commands, init: c => invites.init(c), handle };
