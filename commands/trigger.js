// commands/trigger.js — Auto-responder: /trigger setup (text or custom embed), list, edit, remove
// Single file. Drop it in your commands/ folder and restart. No other file needs changes.
// Placeholders you can use in any text: {user} {username} {server} {channel} {membercount}
const { SlashCommandBuilder: S, EmbedBuilder, ActionRowBuilder: Row, ButtonBuilder, ButtonStyle: BS, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle: TS, PermissionFlagsBits: P, Client } = require('discord.js');
const db = require('../lib/db'); const { EPH } = require('../lib/util');

// ---------- storage (own table, nothing else touched) ----------
db.raw.exec('CREATE TABLE IF NOT EXISTS triggers (id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, data TEXT NOT NULL)');
const cache = new Map();
const load = g => { if (!cache.has(g)) cache.set(g, db.raw.prepare('SELECT id, data FROM triggers WHERE guild = ?').all(g).map(r => ({ ...JSON.parse(r.data), id: r.id }))); return cache.get(g); };
const add = (g, t) => { const { id, ...d } = t; const r = db.raw.prepare('INSERT INTO triggers (guild, data) VALUES (?, ?)').run(g, JSON.stringify(d)); cache.delete(g); return Number(r.lastInsertRowid); };
const save = (g, t) => { const { id, ...d } = t; db.raw.prepare('UPDATE triggers SET data = ? WHERE id = ? AND guild = ?').run(JSON.stringify(d), id, g); cache.delete(g); };
const del = (g, id) => { db.raw.prepare('DELETE FROM triggers WHERE id = ? AND guild = ?').run(id, g); cache.delete(g); };
const get = (g, id) => load(g).find(t => t.id === Number(id));
const MAX = 50;

// ---------- helpers ----------
const MATCH = { contains: 'Contains', exact: 'Exact message', starts: 'Starts with', word: 'Whole word' };
const NAMED = { red: 0xED4245, green: 0x57F287, blue: 0x5865F2, yellow: 0xFEE75C, orange: 0xE67E22, purple: 0x9B59B6, pink: 0xEB459E, white: 0xFFFFFF, black: 0x000000, gold: 0xF1C40F, cyan: 0x1ABC9C, grey: 0x95A5A6, gray: 0x95A5A6 };
const color = s => { s = (s || '').trim().toLowerCase(); if (!s) return 0x5865F2; if (NAMED[s] != null) return NAMED[s]; const m = s.match(/^#?([0-9a-f]{6})$/); return m ? parseInt(m[1], 16) : null; };
const isUrl = s => /^https?:\/\/\S+$/i.test(s);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = s => String(s).replace(/`/g, "'");
const fill = (s, m) => String(s || '').replace(/{user}/gi, `<@${m.author.id}>`).replace(/{username}/gi, m.author.username).replace(/{server}/gi, m.guild.name)
  .replace(/{channel}/gi, `<#${m.channel.id}>`).replace(/{membercount}/gi, String(m.guild.memberCount));

function payload(t, m) {
  const f = x => fill(x, m), o = {};
  if (t.type === 'text') o.content = f(t.text).slice(0, 2000);
  else {
    const e = t.embed || {}, em = new EmbedBuilder().setColor(e.color ?? 0x5865F2);
    if (e.title) em.setTitle(f(e.title).slice(0, 256));
    if (e.description) em.setDescription(f(e.description).slice(0, 4000));
    if (e.image) em.setImage(e.image);
    if (e.thumbnail) em.setThumbnail(e.thumbnail);
    if (e.footer) em.setFooter({ text: f(e.footer).slice(0, 2048) });
    if (e.author) em.setAuthor({ name: f(e.author).slice(0, 256) });
    o.embeds = [em]; if (t.content) o.content = f(t.content).slice(0, 2000);
  }
  if (t.button) o.components = [new Row().addComponents(new ButtonBuilder().setStyle(BS.Link).setLabel(t.button.label).setURL(t.button.url))];
  return o;
}
function matches(t, content) {
  const c = content.toLowerCase().trim(), w = t.word.toLowerCase();
  if (t.match === 'exact') return c === w;
  if (t.match === 'starts') return c.startsWith(w);
  if (t.match === 'word') return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, 'u').test(c);
  return c.includes(w);
}

// ---------- auto-responder ----------
const cd = new Map();
async function onMessage(m) {
  if (m.author.bot || !m.guild || !m.content) return;
  const list = load(m.guild.id); if (!list.length) return;
  const t = list.filter(x => matches(x, m.content)).sort((a, b) => b.word.length - a.word.length)[0]; if (!t) return;
  const k = `${m.channel.id}:${t.id}`, now = Date.now(); if ((cd.get(k) || 0) > now) return; cd.set(k, now + (t.cd || 3) * 1000);
  const perms = m.channel.permissionsFor(m.guild.members.me); if (!perms?.has([P.ViewChannel, P.SendMessages])) return;
  if (t.type === 'embed' && !perms.has(P.EmbedLinks)) return;
  const o = payload(t, m); o.allowedMentions = { parse: ['users'], repliedUser: false };
  try {
    if (t.reply && !t.del) await m.reply(o); else await m.channel.send(o);
    if (t.del && perms.has(P.ManageMessages)) m.delete().catch(() => { });
  } catch (e) { console.error('Trigger send failed:', e.message); }
}

// ---------- views ----------
const toggle = (id, label, on, dis) => new ButtonBuilder().setCustomId(id).setLabel(`${label}: ${on ? 'ON' : 'OFF'}`).setStyle(on ? BS.Success : BS.Secondary).setDisabled(!!dis);
const matchSelect = (id, cur) => new StringSelectMenuBuilder().setCustomId(id).setPlaceholder('Match mode')
  .addOptions(Object.entries(MATCH).map(([value, label]) => ({ label, value, default: value === cur, description: { contains: 'Message contains the trigger anywhere', exact: 'Whole message equals the trigger', starts: 'Message begins with the trigger', word: 'Trigger appears as its own word' }[value] })));

function setupView(st) {
  const [type, match, reply, dl] = st.split('.');
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle('Trigger setup')
    .setDescription('Choose how the trigger answers, then press **Continue**.\nPlaceholders: `{user}` `{username}` `{server}` `{channel}` `{membercount}`')
    .addFields({ name: 'Type', value: type === 'embed' ? 'Embed' : 'Text', inline: true }, { name: 'Match', value: MATCH[match], inline: true },
      { name: 'Reply', value: reply === '1' && dl !== '1' ? 'On' : 'Off', inline: true }, { name: 'Delete message', value: dl === '1' ? 'On' : 'Off', inline: true });
  const ts = new StringSelectMenuBuilder().setCustomId(`tg:s:type:${st}`).setPlaceholder('Response type')
    .addOptions([{ label: 'Text', value: 'text', description: 'Plain message', default: type === 'text' }, { label: 'Embed', value: 'embed', description: 'Custom embed (title, description, color, image...)', default: type === 'embed' }]);
  return { embeds: [e], components: [new Row().addComponents(ts), new Row().addComponents(matchSelect(`tg:s:match:${st}`, match)),
    new Row().addComponents(toggle(`tg:s:reply:${st}`, 'Reply', reply === '1' && dl !== '1', dl === '1'), toggle(`tg:s:del:${st}`, 'Delete message', dl === '1'),
      new ButtonBuilder().setCustomId(`tg:s:go:${st}`).setLabel('Continue').setStyle(BS.Primary))] };
}
function manageView(t, i, head) {
  const p = payload(t, { author: i.user, guild: i.guild, channel: i.channel });
  const sum = `${head ? head + '\n' : ''}**Trigger #${t.id}** — \`${clean(t.word)}\` · ${MATCH[t.match]} · ${t.type}${t.button ? ` · button: ${clean(t.button.label)}` : ''}\nPreview:`;
  return { content: (sum + (p.content ? '\n\n' + p.content : '')).slice(0, 2000), embeds: p.embeds || [], allowedMentions: { parse: [] },
    components: [
      new Row().addComponents(new ButtonBuilder().setCustomId(`tg:v:edit:${t.id}`).setLabel('Edit').setStyle(BS.Primary), new ButtonBuilder().setCustomId(`tg:v:more:${t.id}`).setLabel('More options').setStyle(BS.Secondary),
        new ButtonBuilder().setCustomId(`tg:v:del:${t.id}`).setLabel('Delete').setStyle(BS.Danger)),
      new Row().addComponents(toggle(`tg:v:reply:${t.id}`, 'Reply', t.reply && !t.del, t.del), toggle(`tg:v:dflag:${t.id}`, 'Delete message', t.del)),
      new Row().addComponents(matchSelect(`tg:v:match:${t.id}`, t.match))] };
}
function listView(g) {
  const list = load(g.id); if (!list.length) return { content: 'No triggers yet. Create one with `/trigger setup`.' };
  const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`Triggers (${list.length}/${MAX})`)
    .setDescription(list.map(t => `**#${t.id}** \`${clean(t.word)}\` · ${t.type} · ${MATCH[t.match]}`).join('\n').slice(0, 4000));
  const sel = new StringSelectMenuBuilder().setCustomId('tg:l:pick').setPlaceholder('Pick a trigger to edit')
    .addOptions(list.slice(0, 25).map(t => ({ label: `#${t.id} ${t.word}`.slice(0, 100), value: String(t.id), description: `${t.type} · ${MATCH[t.match]}` })));
  return { embeds: [e], components: [new Row().addComponents(sel)], content: list.length > 25 ? 'Menu shows the first 25 — use `/trigger edit id:<number>` for the rest.' : undefined };
}

// ---------- modals ----------
const inp = (id, label, style, { req = false, max = 100, ph, val } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(req).setMaxLength(max);
  if (ph) t.setPlaceholder(ph); if (val) t.setValue(String(val).slice(0, max)); return new Row().addComponents(t);
};
const hex = n => (n == null ? '' : '#' + n.toString(16).padStart(6, '0'));
function contentRows(type, t = {}) {
  const e = t.embed || {};
  if (type === 'text') return [inp('word', 'Trigger word / phrase', TS.Short, { req: true, val: t.word }), inp('text', 'Response text', TS.Paragraph, { req: true, max: 2000, val: t.text })];
  return [inp('word', 'Trigger word / phrase', TS.Short, { req: true, val: t.word }), inp('title', 'Embed title', TS.Short, { max: 256, val: e.title }),
    inp('description', 'Embed description', TS.Paragraph, { max: 4000, val: e.description }), inp('color', 'Color (hex or name)', TS.Short, { max: 20, ph: '#5865F2 or red', val: e.color != null ? hex(e.color) : '' }),
    inp('image', 'Image URL (optional)', TS.Short, { max: 400, val: e.image })];
}
const newModal = st => { const type = st.split('.')[0]; return new ModalBuilder().setCustomId(`tg:m:new:${st}`).setTitle(type === 'embed' ? 'New embed trigger' : 'New text trigger').addComponents(...contentRows(type)); };
const editModal = t => new ModalBuilder().setCustomId(`tg:m:edit:${t.id}`).setTitle(`Edit trigger #${t.id}`).addComponents(...contentRows(t.type, t));
function moreModal(t) {
  const e = t.embed || {}, btn = t.button ? `${t.button.label} | ${t.button.url}` : '';
  const b = inp('button', 'Link button: Label | https://url', TS.Short, { max: 200, ph: 'Join Discord | https://discord.gg/...', val: btn });
  if (t.type === 'text') return new ModalBuilder().setCustomId(`tg:m:more:${t.id}`).setTitle(`More options #${t.id}`).addComponents(b);
  return new ModalBuilder().setCustomId(`tg:m:more:${t.id}`).setTitle(`More options #${t.id}`).addComponents(inp('footer', 'Footer text', TS.Short, { max: 200, val: e.footer }),
    inp('thumbnail', 'Thumbnail URL', TS.Short, { max: 400, val: e.thumbnail }), inp('author', 'Author name', TS.Short, { max: 200, val: e.author }),
    inp('content', 'Text above the embed', TS.Paragraph, { max: 1000, val: t.content }), b);
}
function embedFrom(f) {
  const title = f('title'), description = f('description'), c = color(f('color')), image = f('image');
  if (!title && !description) return { error: 'An embed needs a title or a description.' };
  if (c == null) return { error: 'Invalid color. Use a hex like #5865F2 or a name like red, green, blue.' };
  if (image && !isUrl(image)) return { error: 'Image must be a direct link starting with http:// or https://' };
  return { embed: { title, description, color: c, image } };
}

// ---------- interactions ----------
async function handle(i) {
  if (!i.guild) return;
  const err = c => i.reply({ content: `❌ ${c}`, flags: EPH });
  if (!i.memberPermissions?.has(P.ManageGuild)) return err('You need Manage Server to use this.');
  const [, kind, act, arg] = i.customId.split(':'), g = i.guild.id;
  const f = n => { try { return i.fields.getTextInputValue(n).trim(); } catch { return ''; } };
  const show = (v, head) => (i.isFromMessage?.() ? i.update(v) : i.reply({ ...v, flags: EPH }));

  if (kind === 's') {
    let [type, match, reply, dl] = arg.split('.');
    if (act === 'type') type = i.values[0]; else if (act === 'match') match = i.values[0];
    else if (act === 'reply') reply = reply === '1' ? '0' : '1'; else if (act === 'del') dl = dl === '1' ? '0' : '1';
    const st = [type, match, reply, dl].join('.');
    if (act === 'go') return i.showModal(newModal(st));
    return i.update(setupView(st));
  }
  if (kind === 'l') { const t = get(g, i.values[0]); return t ? i.reply({ ...manageView(t, i), flags: EPH }) : err('That trigger no longer exists.'); }
  if (kind === 'v') {
    const t = get(g, arg); if (!t) return i.update({ content: '❌ That trigger no longer exists.', embeds: [], components: [] });
    if (act === 'edit') return i.showModal(editModal(t));
    if (act === 'more') return i.showModal(moreModal(t));
    if (act === 'del') { del(g, t.id); return i.update({ content: `🗑️ Trigger #${t.id} (\`${clean(t.word)}\`) deleted.`, embeds: [], components: [] }); }
    if (act === 'reply') t.reply = !t.reply; else if (act === 'dflag') t.del = !t.del; else if (act === 'match') t.match = i.values[0];
    save(g, t); return i.update(manageView(t, i));
  }
  if (kind === 'm') {
    if (act === 'new') {
      const [type, match, reply, dl] = arg.split('.'), list = load(g);
      if (list.length >= MAX) return err(`Limit is ${MAX} triggers per server.`);
      const word = f('word'); if (!word) return err('Trigger word is required.');
      if (list.some(x => x.word.toLowerCase() === word.toLowerCase())) return err(`A trigger for \`${clean(word)}\` already exists.`);
      const t = { word, type, match, reply: reply === '1', del: dl === '1', cd: 3 };
      if (type === 'text') { t.text = f('text'); if (!t.text) return err('Response text is required.'); }
      else { const r = embedFrom(f); if (r.error) return err(r.error); t.embed = r.embed; }
      t.id = add(g, t); return i.reply({ ...manageView(t, i, '✅ Trigger created.'), flags: EPH });
    }
    const t = get(g, arg); if (!t) return err('That trigger no longer exists.');
    if (act === 'edit') {
      const word = f('word'); if (!word) return err('Trigger word is required.');
      if (load(g).some(x => x.id !== t.id && x.word.toLowerCase() === word.toLowerCase())) return err(`A trigger for \`${clean(word)}\` already exists.`);
      if (t.type === 'text') { const tx = f('text'); if (!tx) return err('Response text is required.'); t.text = tx; }
      else { const r = embedFrom(f); if (r.error) return err(r.error); t.embed = { ...t.embed, ...r.embed }; }
      t.word = word; save(g, t); return show(manageView(t, i, '✅ Saved.'));
    }
    if (act === 'more') {
      const bt = f('button'); let button;
      if (bt) { const [l, ...r] = bt.split('|'), url = r.join('|').trim(); if (!l.trim() || !isUrl(url)) return err('Button format: `Label | https://link`'); button = { label: l.trim().slice(0, 80), url }; }
      if (t.type === 'embed') {
        const th = f('thumbnail'); if (th && !isUrl(th)) return err('Thumbnail must be a link starting with http:// or https://');
        t.embed = { ...t.embed, footer: f('footer'), thumbnail: th, author: f('author') }; t.content = f('content');
      }
      if (button) t.button = button; else delete t.button;
      save(g, t); return show(manageView(t, i, '✅ Saved.'));
    }
  }
}

// ---------- hook into the client (no index.js change needed) ----------
if (!Client.prototype.__tgHook) {
  Client.prototype.__tgHook = true; const login = Client.prototype.login;
  Client.prototype.login = function (...a) {
    this.on('interactionCreate', i => {
      if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) || !i.customId.startsWith('tg:')) return;
      handle(i).catch(e => { console.error('Trigger error:', e); const o = { content: '❌ Something went wrong.', flags: EPH }; (i.deferred || i.replied ? i.followUp(o) : i.reply(o)).catch(() => { }); });
    });
    this.on('messageCreate', m => onMessage(m).catch(e => console.error('Trigger error:', e)));
    return login.apply(this, a);
  };
}

// ---------- command ----------
const data = new S().setName('trigger').setDescription('Auto-responder: reply to words with text or a custom embed').setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s => s.setName('setup').setDescription('Create a trigger (choose text or embed)'))
  .addSubcommand(s => s.setName('create').setDescription('Create a trigger (same as setup)'))
  .addSubcommand(s => s.setName('list').setDescription('List and manage all triggers'))
  .addSubcommand(s => s.setName('edit').setDescription('Edit a trigger').addIntegerOption(o => o.setName('id').setDescription('Trigger ID (see /trigger list)').setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Delete a trigger').addIntegerOption(o => o.setName('id').setDescription('Trigger ID (see /trigger list)').setRequired(true)));

module.exports = [{ perm: P.ManageGuild, data, async run(ctx) {
  const sub = ctx.opts.getSubcommand(), g = ctx.guild;
  if (sub === 'setup' || sub === 'create') return ctx.reply({ ...setupView('embed.contains.1.0'), flags: EPH });
  if (sub === 'list') return ctx.reply({ ...listView(g), flags: EPH });
  const t = get(g.id, ctx.opts.getInteger('id'));
  if (!t) return ctx.reply({ content: '❌ No trigger with that ID. Use `/trigger list`.', flags: EPH });
  if (sub === 'remove') { del(g.id, t.id); return ctx.reply({ content: `🗑️ Trigger #${t.id} (\`${clean(t.word)}\`) deleted.`, flags: EPH }); }
  return ctx.reply({ ...manageView(t, { user: ctx.user, guild: g, channel: ctx.channel }), flags: EPH });
} }];
