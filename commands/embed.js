// commands/embed.js — Embed builder panel (replaces the old commands/embed.js). Single file, no other changes needed.
//   /embed create  [title] [description] [color] [footer] [author] [timestamp] [ping] [channel] [image] [thumbnail] [footer_image] [author_icon] [instant]
//   /embed edit    message:<link or ID>   — reload something you sent with this builder and save changes
//   /embed upload  [image] [thumbnail] [footer_image] [author_icon] — add pictures to your open draft (slash upload)
// Panel: live preview • text • author • footer • fields • PICTURES FROM YOUR DEVICE (no links) • color or TRUE NO BAR • one-click divider lines
// NO BAR = a Components V2 container: Discord draws no side line at all (an embed always has one). Needs discord.js 14.19+.
// The in-panel picture picker needs discord.js 14.24+  ->  npm i discord.js@latest
const dj = require('discord.js');
const { SlashCommandBuilder: S, ActionRowBuilder: Row, ButtonBuilder, ButtonStyle: BS, StringSelectMenuBuilder, ChannelSelectMenuBuilder, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle: TS, ChannelType, PermissionFlagsBits: P, MessageFlags, Client,
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, SeparatorBuilder, SeparatorSpacingSize,
  LabelBuilder, FileUploadBuilder } = dj;
const HAS_UPLOAD = !!(LabelBuilder && FileUploadBuilder);
const db = require('../lib/db'); const { EPH } = require('../lib/util');
const V2 = MessageFlags.IsComponentsV2;

// ---------- drafts (so the panel survives restarts) ----------
db.raw.exec('CREATE TABLE IF NOT EXISTS embed_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, user TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL)');
db.raw.exec('CREATE TABLE IF NOT EXISTS embed_sent (message TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL, data TEXT NOT NULL)');
const strip = d => { const { id, guild, user, ...rest } = d; return rest; };
const saveD = d => db.raw.prepare('UPDATE embed_drafts SET data = ?, ts = ? WHERE id = ?').run(JSON.stringify(strip(d)), Date.now(), d.id);
const addD = (guild, user, d) => { db.raw.prepare('DELETE FROM embed_drafts WHERE ts < ?').run(Date.now() - 24 * 3600 * 1000); const r = db.raw.prepare('INSERT INTO embed_drafts (guild, user, data, ts) VALUES (?, ?, ?, ?)').run(guild, user, JSON.stringify(d), Date.now()); return { ...d, id: Number(r.lastInsertRowid), guild, user }; };
const row2d = r => (r ? { ...JSON.parse(r.data), id: r.id, guild: r.guild, user: r.user } : null);
const getD = id => row2d(db.raw.prepare('SELECT id, guild, user, data FROM embed_drafts WHERE id = ?').get(Number(id)));
const lastD = (guild, user) => row2d(db.raw.prepare('SELECT id, guild, user, data FROM embed_drafts WHERE guild = ? AND user = ? ORDER BY id DESC LIMIT 1').get(guild, user));
const delD = id => db.raw.prepare('DELETE FROM embed_drafts WHERE id = ?').run(Number(id));
const saveSent = (d, msg) => db.raw.prepare('INSERT OR REPLACE INTO embed_sent (message, guild, channel, data) VALUES (?, ?, ?, ?)').run(msg.id, msg.guildId, msg.channelId, JSON.stringify(strip(d)));

// ---------- constants ----------
const HF = '\u3164'; // Hangul filler: invisible, but underlined it draws a smooth line
const LINES = {
  smooth: { label: 'Smooth line', desc: 'Clean underline (best looking)', text: `__${HF.repeat(23)}__` },
  short: { label: 'Smooth line (short)', desc: 'Same, but shorter', text: `__${HF.repeat(14)}__` },
  thick: { label: 'Thick line', desc: '━━━━━━━━━━━━━━━━', text: '━'.repeat(16) },
  thin: { label: 'Thin line', desc: '────────────────', text: '─'.repeat(20) },
  double: { label: 'Double line', desc: '════════════════', text: '═'.repeat(16) },
  dotted: { label: 'Dotted line', desc: '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈', text: '┈'.repeat(20) },
  stars: { label: 'Stars', desc: '✦ ✦ ✦ ✦ ✦', text: '✦ ✦ ✦ ✦ ✦' },
  diamond: { label: 'Diamond divider', desc: '◆━━━━━━◆━━━━━━◆', text: '◆━━━━━━◆━━━━━━◆' },
};
const COLORS = { none: ['No bar (no line at all)', null], blurple: ['Blurple', 0x5865F2], red: ['Red', 0xED4245], green: ['Green', 0x57F287], yellow: ['Yellow', 0xFEE75C], orange: ['Orange', 0xE67E22],
  purple: ['Purple', 0x9B59B6], pink: ['Pink', 0xEB459E], cyan: ['Cyan', 0x1ABC9C], gold: ['Gold', 0xF1C40F], white: ['White', 0xFFFFFF], black: ['Black', 0x010101] };
const NAMED = { ...Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, v[1]])), grey: 0x95A5A6, gray: 0x95A5A6 };
const parseColor = s => { s = (s || '').trim().toLowerCase(); if (!s || ['none', 'nobar', 'no', 'off', 'transparent'].includes(s)) return { ok: true, color: null }; if (s in NAMED) return { ok: true, color: NAMED[s] }; const m = s.match(/^#?([0-9a-f]{6})$/); return m ? { ok: true, color: parseInt(m[1], 16) } : { ok: false }; };
const hex = n => (n == null ? '' : '#' + n.toString(16).padStart(6, '0'));
const isUrl = s => /^https?:\/\/\S+$/i.test(s);
const txt = s => (s || '').replace(/\\n/g, '\n');
const IMG_KEYS = { image: 'image', thumbnail: 'thumbnail', footer_image: 'footerIcon', author_icon: 'authorIcon' };
const IMG_LABEL = { image: 'Image', thumbnail: 'Thumbnail', footerIcon: 'Footer image', authorIcon: 'Author icon' };
const IMG_HELP = { image: 'Big picture shown at the bottom', thumbnail: 'Small picture, top right', footerIcon: 'Tiny picture next to the footer text', authorIcon: 'Tiny picture next to the author name' };
const isImg = a => a && (a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name || ''));
const fileName = (key, a) => `${key}_${Date.now()}.${((a.name || 'x.png').split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'}`;

function toPic(a, key) { // an uploaded Discord attachment -> draft picture (re-attached when sent, so it never expires)
  if (!isImg(a)) return { error: `${IMG_LABEL[key]} must be an image (png, jpg, gif, webp).` };
  if (a.size > 10 * 1024 * 1024) return { error: `${IMG_LABEL[key]} is too large (max 10 MB).` };
  return { upload: true, url: a.url, name: fileName(key, a) };
}
function grab(o, opt, key) { const a = o.getAttachment(opt); return a ? toPic(a, key) : null; }
const blank = () => ({ mode: 'new', channel: null, ping: null, content: '', title: '', titleUrl: '', description: '', color: null, author: { name: '', url: '' }, footer: { text: '' }, images: {}, fields: [], timestamp: false, target: null, orig: null });
const isEmpty = d => !(d.title || d.description || d.fields.length || d.images.image || d.images.thumbnail || d.author.name || d.images.authorIcon || d.footer.text || d.images.footerIcon);
const size = d => (d.title || '').length + (d.description || '').length + (d.author.name || '').length + (d.footer.text || '').length + d.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

// ---------- building: classic embed (color bar) ----------
// pictures: new uploads are re-attached, pictures already on the message (sent) are referenced by name, links are used as they are
function picker(d, forSend, files) {
  return k => { const x = d.images[k]; if (!x) return null;
    if (x.upload && forSend) { if (!x.sent) files.push({ attachment: x.url, name: x.name }); return `attachment://${x.name}`; }
    return x.url; };
}
function build(d, forSend) {
  const files = [], pic = picker(d, forSend, files), e = new EmbedBuilder();
  if (d.color != null) e.setColor(d.color);
  if (d.title) { e.setTitle(d.title.slice(0, 256)); if (d.titleUrl) e.setURL(d.titleUrl); }
  if (d.description) e.setDescription(d.description.slice(0, 4000));
  const im = pic('image'), th = pic('thumbnail'), fi = pic('footerIcon'), ai = pic('authorIcon');
  if (im) e.setImage(im); if (th) e.setThumbnail(th);
  if (d.author.name || ai) e.setAuthor({ name: (d.author.name || '\u200b').slice(0, 256), iconURL: ai || undefined, url: d.author.url || undefined });
  if (d.footer.text || fi) e.setFooter({ text: (d.footer.text || '\u200b').slice(0, 2048), iconURL: fi || undefined });
  if (d.fields.length) e.addFields(d.fields.map(f => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024), inline: !!f.inline })));
  if (d.timestamp) e.setTimestamp();
  return { embed: e, files };
}
// ---------- building: NO BAR (Components V2 container without an accent color = no side line) ----------
const T = s => new TextDisplayBuilder().setContent(String(s).slice(0, 4000));
const sec = (s, url) => new SectionBuilder().addTextDisplayComponents(T(s)).setThumbnailAccessory(new ThumbnailBuilder().setURL(url));
function container(d, forSend) {
  const files = [], pic = picker(d, forSend, files), c = new ContainerBuilder();
  if (d.color != null) c.setAccentColor(d.color); // preview of a color bar; no color = no bar
  const ai = pic('authorIcon'), th = pic('thumbnail'), im = pic('image'), fi = pic('footerIcon');
  const author = d.author.name ? (d.author.url ? `[${d.author.name}](${d.author.url})` : d.author.name) : '';
  if (author || ai) { const t = `-# ${author || '\u200b'}`; if (ai) c.addSectionComponents(sec(t, ai)); else c.addTextDisplayComponents(T(t)); }
  const head = [d.title ? `## ${d.titleUrl ? `[${d.title}](${d.titleUrl})` : d.title}` : '', d.description || ''].filter(Boolean).join('\n');
  if (head || th) { if (th) c.addSectionComponents(sec(head || '\u200b', th)); else c.addTextDisplayComponents(T(head)); }
  for (const f of d.fields) c.addTextDisplayComponents(T(`**${f.name}**\n${f.value}`));
  if (im) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(im)));
  const foot = [d.footer.text, d.timestamp ? `<t:${Math.floor(Date.now() / 1000)}:f>` : ''].filter(Boolean).join(' • ');
  if (foot || fi) { c.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)); const t = `-# ${foot || '\u200b'}`; if (fi) c.addSectionComponents(sec(t, fi)); else c.addTextDisplayComponents(T(t)); }
  return { container: c, files };
}
// the final message
function message(d) {
  const top = [d.ping ? `<@&${d.ping}>` : '', d.content].filter(Boolean).join('\n');
  if (d.color == null) { const { container: c, files } = container(d, true); return { v2: true, files, body: { components: [...(top ? [T(top)] : []), c], flags: V2, allowedMentions: { parse: ['roles'] } } }; }
  const { embed, files } = build(d, true); return { v2: false, files, body: { content: top || undefined, embeds: [embed], allowedMentions: { parse: ['roles'] } } };
}

// ---------- panel (a Components V2 message: info + live preview + controls) ----------
const btn = (id, label, style = BS.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
function panel(d, head) {
  const empty = isEmpty(d), v2 = d.color == null, n = size(d);
  const info = [head, `**Embed builder** · ${d.mode === 'edit' ? 'editing a sent message' : `sends to <#${d.channel}>${d.ping ? ` · pings <@&${d.ping}>` : ''}`}`,
    `${v2 ? 'No bar (modern layout)' : 'Color ' + hex(d.color) + ' (classic embed)'} · ${d.fields.length} field${d.fields.length === 1 ? '' : 's'}${Object.keys(d.images).length ? ' · pictures: ' + Object.keys(d.images).map(k => IMG_LABEL[k]).join(', ') : ''}${d.content ? ' · text above set' : ''}`,
    empty ? '⚠️ Empty. Add text or a picture.' : '', n > (v2 ? 3800 : 6000) ? `⚠️ Too long (${n}/${v2 ? 3800 : 6000} characters).` : ''].filter(Boolean).join('\n');
  const cur = Object.entries(COLORS).find(([, v]) => v[1] === d.color)?.[0];
  const rows = [
    new Row().addComponents(btn(`em:text:${d.id}`, 'Text', BS.Primary), btn(`em:author:${d.id}`, 'Author', BS.Primary), btn(`em:footer:${d.id}`, 'Footer', BS.Primary), btn(`em:fields:${d.id}`, 'Fields', BS.Primary),
      btn(`em:ts:${d.id}`, `Time: ${d.timestamp ? 'ON' : 'OFF'}`, d.timestamp ? BS.Success : BS.Secondary)),
    new Row().addComponents(new StringSelectMenuBuilder().setCustomId(`em:pics:${d.id}`).setPlaceholder('Pictures').addOptions([
      { label: 'Pick from my device', value: 'upload', description: 'Choose photos from your gallery or files' }, { label: 'Use picture links', value: 'links', description: 'Paste image URLs instead' },
      { label: 'Remove image', value: 'rm_image' }, { label: 'Remove thumbnail', value: 'rm_thumbnail' }, { label: 'Remove footer image', value: 'rm_footerIcon' }, { label: 'Remove author icon', value: 'rm_authorIcon' }, { label: 'Remove all pictures', value: 'rm_all' }])),
    new Row().addComponents(new StringSelectMenuBuilder().setCustomId(`em:color:${d.id}`).setPlaceholder('Color bar').addOptions([...Object.entries(COLORS).map(([value, [label]]) => ({ label, value, default: value === cur })), { label: 'Custom hex…', value: 'custom', default: cur === undefined && d.color != null }])),
    new Row().addComponents(new StringSelectMenuBuilder().setCustomId(`em:line:${d.id}`).setPlaceholder('Add a divider line (1 click)').addOptions([...Object.entries(LINES).map(([value, l]) => ({ label: l.label, value, description: l.desc })), { label: 'Undo last line', value: 'undo', description: 'Remove the line at the end of the description' }])),
    new Row().addComponents(btn(`em:send:${d.id}`, d.mode === 'edit' ? 'Save changes' : 'Send', BS.Success), ...(d.mode === 'edit' ? [] : [btn(`em:chanv:${d.id}`, 'Channel')]), btn(`em:cancel:${d.id}`, 'Close', BS.Danger)),
  ];
  return { components: [T(info), ...(empty ? [] : [container(d, false).container]), ...rows], flags: V2, allowedMentions: { parse: [] } };
}
const chanView = d => ({ components: [T(`**Send to which channel?** Now: <#${d.channel}>`), new Row().addComponents(new ChannelSelectMenuBuilder().setCustomId(`em:chan:${d.id}`).setPlaceholder('Pick a channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setDefaultChannels(d.channel)),
  new Row().addComponents(btn(`em:back:${d.id}`, 'Back'))], flags: V2, allowedMentions: { parse: [] } });
const first = o => ({ ...o, flags: V2 | EPH });

// ---------- modals ----------
const inp = (id, label, style, { req = false, max = 100, ph, val } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(req).setMaxLength(max);
  if (ph) t.setPlaceholder(ph); if (val) t.setValue(String(val).slice(0, max)); return new Row().addComponents(t);
};
const modal = (id, title, ...rows) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...rows);
const urlOf = x => (x && !x.upload ? x.url : '');
function picsModal(d) { // real file pickers: choose photos from the device, no links
  const m = new ModalBuilder().setCustomId(`em:m:pics:${d.id}`).setTitle('Pick pictures from your device');
  return m.addLabelComponents(...['image', 'thumbnail', 'footerIcon', 'authorIcon'].map(k => {
    const fu = new FileUploadBuilder().setCustomId(k).setRequired(false); if (typeof fu.setMinValues === 'function') fu.setMinValues(0); if (typeof fu.setMaxValues === 'function') fu.setMaxValues(1);
    return new LabelBuilder().setLabel(IMG_LABEL[k]).setDescription(IMG_HELP[k]).setFileUploadComponent(fu);
  }));
}
function modalFor(act, d) {
  if (act === 'text') return modal(`em:m:text:${d.id}`, 'Title & text', inp('title', 'Title', TS.Short, { max: 256, val: d.title }), inp('description', 'Description', TS.Paragraph, { max: 4000, val: d.description }),
    inp('titleUrl', 'Title link (optional)', TS.Short, { max: 400, val: d.titleUrl }), inp('content', 'Text above the embed (optional)', TS.Paragraph, { max: 1500, val: d.content }));
  if (act === 'author') return modal(`em:m:author:${d.id}`, 'Author', inp('name', 'Author name', TS.Short, { max: 256, val: d.author.name }), inp('url', 'Author link (optional)', TS.Short, { max: 400, val: d.author.url }));
  if (act === 'footer') return modal(`em:m:footer:${d.id}`, 'Footer', inp('text', 'Footer text', TS.Short, { max: 300, val: d.footer.text }));
  if (act === 'color') return modal(`em:m:color:${d.id}`, 'Custom color', inp('color', 'Hex color', TS.Short, { req: true, max: 20, ph: '#5865F2', val: hex(d.color) }));
  if (act === 'fields') return modal(`em:m:fields:${d.id}`, 'Fields', inp('name', 'Field title', TS.Short, { max: 256 }), inp('value', 'Field text', TS.Paragraph, { max: 1024 }),
    inp('inline', 'Side by side? yes / no (classic only)', TS.Short, { max: 3, ph: 'no' }), inp('remove', d.fields.length ? `Or remove field number (1-${d.fields.length})` : 'Remove field number', TS.Short, { max: 2 }));
  if (act === 'links') return modal(`em:m:links:${d.id}`, 'Pictures (links)', ...['image', 'thumbnail', 'footerIcon', 'authorIcon'].map(k => inp(k, `${IMG_LABEL[k]} link`, TS.Short, { max: 400, val: urlOf(d.images[k]), ph: d.images[k]?.upload ? 'uploaded file (empty = keep, "clear" = remove)' : 'https://… (empty = none, "clear" = remove)' })));
}

// ---------- sending ----------
async function send(i, d) {
  const g = i.guild, msgObj = message(d), v2 = msgObj.v2;
  if (isEmpty(d)) return i.editReply(panel(d, '❌ Add some text or a picture first.'));
  if (size(d) > (v2 ? 3800 : 6000)) return i.editReply(panel(d, `❌ Too long (max ${v2 ? 3800 : 6000} characters).`));
  const names = Object.values(d.images).filter(x => x?.sent).map(x => x.name);
  if (d.mode === 'edit') {
    const ch = g.channels.cache.get(d.target.channel), msg = await ch?.messages.fetch(d.target.message).catch(() => null);
    if (!msg) return i.editReply(panel(d, '❌ The original message no longer exists.'));
    if (d.orig === 'v2' && !v2) return i.editReply(panel(d, '❌ This message uses No bar and can\'t switch to a color bar (Discord limit). Send a new one, or keep No bar.'));
    const keep = [...msg.attachments.values()].filter(a => names.includes(a.name));
    const body = { ...msgObj.body, files: msgObj.files, attachments: keep };
    if (v2 && d.orig !== 'v2') Object.assign(body, { content: null, embeds: [] }); else if (!v2) body.content = body.content ?? null;
    await msg.edit(body); for (const x of Object.values(d.images)) if (x.upload) x.sent = true; d.orig = v2 ? 'v2' : 'classic'; saveD(d); saveSent(d, msg);
    return i.editReply(panel(d, `✅ Saved. ${msg.url}`));
  }
  const ch = g.channels.cache.get(d.channel); if (!ch?.isTextBased()) return i.editReply(panel(d, '❌ Pick a channel with the Channel button.'));
  const need = [P.ViewChannel, P.SendMessages, ...(v2 ? [] : [P.EmbedLinks]), ...(msgObj.files.length ? [P.AttachFiles] : [])];
  if (!ch.permissionsFor(g.members.me)?.has(need)) return i.editReply(panel(d, `❌ I need View Channel, Send Messages${v2 ? '' : ', Embed Links'}${msgObj.files.length ? ' and Attach Files' : ''} in <#${ch.id}>.`));
  const sent = await ch.send({ ...msgObj.body, files: msgObj.files }); saveSent({ ...d, images: Object.fromEntries(Object.entries(d.images).map(([k, x]) => [k, x.upload ? { ...x, sent: true } : x])) }, sent);
  return i.editReply(panel(d, `✅ Sent to <#${ch.id}>. ${sent.url}`));
}

// ---------- interactions ----------
async function handle(i) {
  if (!i.guild) return;
  if (!i.memberPermissions?.has(P.ManageMessages)) return i.reply({ content: '❌ You need Manage Messages to use this.', flags: EPH });
  const parts = i.customId.split(':'), isModal = parts[1] === 'm', act = isModal ? parts[2] : parts[1], id = isModal ? parts[3] : parts[2];
  const d = getD(id), err = c => i.reply({ content: `❌ ${c}`, flags: EPH });
  if (!d) return isModal ? err('This draft expired. Run /embed create again.') : i.reply({ content: '❌ This draft expired. Run `/embed create` again.', flags: EPH });
  if (d.user !== i.user.id) return err('This builder belongs to someone else.');
  const f = n => { try { return i.fields.getTextInputValue(n).trim(); } catch { return ''; } };
  const show = head => { saveD(d); return i.isFromMessage?.() ? i.update(panel(d, head)) : i.reply(first(panel(d, head))); };

  if (!isModal) {
    if (['text', 'author', 'footer', 'fields'].includes(act)) return i.showModal(modalFor(act, d));
    if (act === 'pics') {
      const v = i.values[0];
      if (v === 'upload') return HAS_UPLOAD ? i.showModal(picsModal(d)) : i.reply({ content: '❌ The device picker needs a newer discord.js. Run `npm i discord.js@latest` and restart. Until then use `/embed upload` to attach pictures.', flags: EPH });
      if (v === 'links') return i.showModal(modalFor('links', d));
      if (v === 'rm_all') d.images = {}; else delete d.images[v.slice(3)];
      return show('✅ Picture removed.');
    }
    if (act === 'color') { const v = i.values[0]; if (v === 'custom') return i.showModal(modalFor('color', d)); d.color = COLORS[v][1]; return show(); }
    if (act === 'line') {
      if (i.values[0] === 'undo') {
        const ls = (d.description || '').split('\n'), last = ls[ls.length - 1]; if (!Object.values(LINES).some(l => l.text === last)) return show('⚠️ No divider line at the end to undo.');
        ls.pop(); d.description = ls.join('\n'); return show('↩️ Line removed.');
      }
      d.description = (d.description ? d.description + '\n' : '') + LINES[i.values[0]].text; return show(`✅ ${LINES[i.values[0]].label} added at the end of the description.`);
    }
    if (act === 'chanv') return i.update(chanView(d));
    if (act === 'chan') { d.channel = i.values[0]; return show(); }
    if (act === 'back') return show();
    if (act === 'ts') { d.timestamp = !d.timestamp; return show(); }
    if (act === 'cancel') { delD(d.id); return i.update({ components: [T('Closed.')], flags: V2 }); }
    if (act === 'send') {
      await i.deferUpdate();
      try { return await send(i, d); } catch (e) { console.error('Embed send failed:', e); return i.editReply(panel(d, `❌ Couldn't send: ${e.message}${/expired|404|download/i.test(e.message) ? '\nA picture may have expired. Pick it again.' : ''}`)); }
    }
    return;
  }
  // modal submits
  if (act === 'pics') {
    const bad = [];
    for (const k of ['image', 'thumbnail', 'footerIcon', 'authorIcon']) {
      let files = null; try { files = i.fields.getUploadedFiles(k); } catch { /* not in modal */ }
      const a = files && [...files.values()][0]; if (!a) continue;
      const p = toPic(a, k); if (p.error) bad.push(p.error); else d.images[k] = p;
    }
    return show(bad.length ? `⚠️ ${bad.join(' ')}` : '✅ Pictures added.');
  }
  if (act === 'text') {
    const u = f('titleUrl'); if (u && !isUrl(u)) return err('Title link must start with http:// or https://');
    Object.assign(d, { title: f('title'), description: f('description'), titleUrl: u, content: f('content') }); return show();
  }
  if (act === 'author') { const u = f('url'); if (u && !isUrl(u)) return err('Author link must start with http:// or https://'); d.author = { name: f('name'), url: u }; return show(); }
  if (act === 'footer') { d.footer = { text: f('text') }; return show(); }
  if (act === 'color') { const c = parseColor(f('color')); if (!c.ok) return err('Invalid color. Use a hex like #5865F2 or a name like red.'); d.color = c.color; return show(); }
  if (act === 'links') {
    for (const k of ['image', 'thumbnail', 'footerIcon', 'authorIcon']) {
      const v = f(k), cur = d.images[k];
      if (v.toLowerCase() === 'clear') delete d.images[k];
      else if (!v) { if (cur && !cur.upload) delete d.images[k]; }
      else if (isUrl(v)) d.images[k] = { url: v };
      else return err(`${IMG_LABEL[k]} link must start with http:// or https:// (type "clear" to remove it).`);
    }
    return show();
  }
  if (act === 'fields') {
    const rm = f('remove');
    if (rm) { const n = parseInt(rm); if (Number.isNaN(n) || n < 1 || n > d.fields.length) return err(`Field number must be 1 to ${d.fields.length || 0}.`); d.fields.splice(n - 1, 1); return show('✅ Field removed.'); }
    const name = f('name'), value = f('value'); if (!name || !value) return err('A field needs a title and text.');
    if (d.fields.length >= 25) return err('Max 25 fields.');
    d.fields.push({ name, value, inline: /^y/i.test(f('inline')) }); return show('✅ Field added.');
  }
}

// ---------- hook into the client ----------
if (!Client.prototype.__emHook) {
  Client.prototype.__emHook = true; const login = Client.prototype.login;
  Client.prototype.login = function (...a) {
    this.on('interactionCreate', i => {
      if (!(i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) || !i.customId.startsWith('em:')) return;
      handle(i).catch(e => { console.error('Embed error:', e); const o = { content: '❌ Something went wrong.', flags: EPH }; (i.deferred || i.replied ? i.followUp(o) : i.reply(o)).catch(() => { }); });
    });
    return login.apply(this, a);
  };
}

// ---------- command ----------
const picOpts = s => s.addAttachmentOption(o => o.setName('image').setDescription('Big picture from your gallery'))
  .addAttachmentOption(o => o.setName('thumbnail').setDescription('Small picture (top right) from your gallery'))
  .addAttachmentOption(o => o.setName('footer_image').setDescription('Tiny picture next to the footer text'))
  .addAttachmentOption(o => o.setName('author_icon').setDescription('Tiny picture next to the author name'));
const data = new S().setName('embed').setDescription('Build and send embeds with a live panel').setDefaultMemberPermissions(P.ManageMessages)
  .addSubcommand(s => picOpts(s.setName('create').setDescription('Open the embed builder')
    .addStringOption(o => o.setName('title').setDescription('Title'))
    .addStringOption(o => o.setName('description').setDescription('Text (use \\n for a new line)'))
    .addStringOption(o => o.setName('color').setDescription('none = no bar (default), a color name like red, or a #hex'))
    .addStringOption(o => o.setName('footer').setDescription('Footer text'))
    .addStringOption(o => o.setName('author').setDescription('Author line'))
    .addBooleanOption(o => o.setName('timestamp').setDescription('Show timestamp'))
    .addChannelOption(o => o.setName('channel').setDescription('Where to send (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption(o => o.setName('ping').setDescription('Role to ping'))
    .addBooleanOption(o => o.setName('instant').setDescription('Send right away without opening the panel'))))
  .addSubcommand(s => picOpts(s.setName('edit').setDescription('Edit something you sent with this builder').addStringOption(o => o.setName('message').setDescription('Message link or ID').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel of the message if you gave an ID (default: here)'))))
  .addSubcommand(s => picOpts(s.setName('upload').setDescription('Add or replace pictures on your open draft')));

module.exports = { data, perm: P.ManageMessages, async run(ctx) {
  if (!ctx.isSlash) return ctx.reply({ content: '❌ Use the slash command `/embed` (it needs the panel and uploads).', flags: EPH });
  const o = ctx.opts, g = ctx.guild, sub = o.getSubcommand(), bad = c => ctx.reply({ content: `❌ ${c}`, flags: EPH });
  const pics = {}; for (const [opt, key] of Object.entries(IMG_KEYS)) { const r = grab(o, opt, key); if (r?.error) return bad(r.error); if (r) pics[key] = r; }

  if (sub === 'upload') {
    const d = lastD(g.id, ctx.user.id); if (!d) return bad('You have no open draft. Run `/embed create` first.');
    if (!Object.keys(pics).length) return bad('Attach at least one picture.');
    Object.assign(d.images, pics); saveD(d); return ctx.reply(first(panel(d, '✅ Pictures added.')));
  }
  if (sub === 'edit') {
    const raw = o.getString('message'), m = raw.match(/channels\/\d+\/(\d+)\/(\d+)/), chId = m ? m[1] : (o.getChannel('channel') || ctx.channel).id, msgId = m ? m[2] : (raw.match(/\d{15,20}/) || [])[0];
    const msg = msgId && await g.channels.cache.get(chId)?.messages.fetch(msgId).catch(() => null);
    if (!msg || msg.author.id !== ctx.client.user.id) return bad('I can only edit messages I sent. Check the link / ID and channel.');
    const rec = db.raw.prepare('SELECT data FROM embed_sent WHERE message = ?').get(msg.id), isV2 = msg.flags?.has(V2);
    let d = blank();
    if (rec) {
      Object.assign(d, JSON.parse(rec.data));
      for (const [k, x] of Object.entries(d.images)) if (x.upload) { const a = [...msg.attachments.values()].find(z => z.name === x.name); if (a) { x.url = a.url; x.sent = true; } else delete d.images[k]; }
    } else if (!isV2 && msg.embeds[0]) {
      const e = msg.embeds[0];
      Object.assign(d, { content: msg.content || '', title: e.title || '', titleUrl: e.url || '', description: e.description || '', color: e.color ?? null,
        author: { name: e.author?.name === '\u200b' ? '' : e.author?.name || '', url: e.author?.url || '' }, footer: { text: e.footer?.text === '\u200b' ? '' : e.footer?.text || '' }, timestamp: !!e.timestamp,
        fields: (e.fields || []).map(x => ({ name: x.name, value: x.value, inline: x.inline })) });
      for (const [k, v] of [['image', e.image?.url], ['thumbnail', e.thumbnail?.url], ['footerIcon', e.footer?.iconURL], ['authorIcon', e.author?.iconURL]]) if (v) d.images[k] = { url: v };
    } else return bad('That message is a No bar layout made before I kept records of them, so I can\'t reload it. Send a new one with `/embed create`.');
    Object.assign(d, { mode: 'edit', target: { channel: chId, message: msg.id }, orig: isV2 ? 'v2' : 'classic' }); Object.assign(d.images, pics);
    return ctx.reply(first(panel(addD(g.id, ctx.user.id, d), '✏️ Editing a sent message.')));
  }
  // create
  const c = parseColor(o.getString('color')); if (!c.ok) return bad('Invalid color. Use none (no bar), a name like red, or a hex like #5865F2.');
  const d = blank(), ch = o.getChannel('channel') || ctx.channel;
  Object.assign(d, { channel: ch.id, ping: o.getRole('ping')?.id || null, title: (o.getString('title') || '').slice(0, 256), description: txt(o.getString('description')).slice(0, 4000), color: c.color,
    footer: { text: (o.getString('footer') || '').slice(0, 2048) }, author: { name: (o.getString('author') || '').slice(0, 256), url: '' }, timestamp: !!o.getBoolean('timestamp'), images: pics });
  if (o.getBoolean('instant')) {
    if (isEmpty(d)) return bad('Give at least a title, description or picture.');
    const mo = message(d); try { const sent = await ch.send({ ...mo.body, files: mo.files }); saveSent(d, sent); } catch (e) { return bad(`Couldn't send: ${e.message}`); }
    return ctx.reply({ content: `✅ Sent in ${ch}.`, flags: EPH });
  }
  return ctx.reply(first(panel(addD(g.id, ctx.user.id, d))));
} };
