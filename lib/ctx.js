// One command works for BOTH slash (/cmd) and prefix (*cmd). Prefix args are parsed using the slash option definitions.
const tokenize = s => { const o = [], re = /"([^"]*)"|(\S+)/g; let m; while ((m = re.exec(s))) o.push(m[1] ?? m[2]); return o; };
const idOf = s => (String(s).match(/\d{15,20}/) || [])[0];

function slashCtx(i) {
  return { src: i, isSlash: true, client: i.client, guild: i.guild, channel: i.channel, member: i.member, user: i.user, opts: i.options,
    reply: o => { o = typeof o === 'string' ? { content: o } : o; return (i.deferred || i.replied) ? i.followUp(o) : i.reply(o); },
    defer: eph => i.deferReply(eph ? { flags: 64 } : {}) };
}
async function conv(m, o, raw) {
  switch (o.type) {
    case 3: if (o.choices) { const c = o.choices.find(c => String(c.value).toLowerCase() === raw.toLowerCase() || c.name.toLowerCase() === raw.toLowerCase()); return c ? c.value : null; } return raw;
    case 4: { const n = parseInt(raw); return Number.isNaN(n) ? null : n; }
    case 10: { const n = parseFloat(raw); return Number.isNaN(n) ? null : n; }
    case 5: return ['true', 'yes', 'on', '1', 'enable', 'enabled'].includes(raw.toLowerCase());
    case 6: { const id = idOf(raw); if (!id) return null; const user = await m.client.users.fetch(id).catch(() => null); if (!user) return null; return { user, member: await m.guild.members.fetch(id).catch(() => null) }; }
    case 7: { const id = idOf(raw); return (id && m.guild.channels.cache.get(id)) || m.guild.channels.cache.find(c => c.name === raw.replace('#', '')) || null; }
    case 8: { const id = idOf(raw); return (id && m.guild.roles.cache.get(id)) || m.guild.roles.cache.find(r => r.name.toLowerCase() === raw.replace('@', '').toLowerCase()) || null; }
  }
  return raw;
}
async function prefixCtx(m, cmd, tokens, prefix) {
  let opts = cmd.data.toJSON().options || [], group = null, sub = null;
  if (opts.some(o => o.type <= 2)) {
    const names = opts.filter(o => o.type <= 2).map(o => o.name).join('|');
    let t = (tokens.shift() || '').toLowerCase(), f = opts.find(o => o.type <= 2 && o.name === t);
    if (!f) return { error: `❌ Usage: \`${prefix}${cmd.data.name} <${names}>\` — use \`/${cmd.data.name}\` to see all options.` };
    if (f.type === 2) { group = f.name; const gn = f.options.map(o => o.name).join('|'); t = (tokens.shift() || '').toLowerCase(); f = f.options.find(o => o.name === t); if (!f) return { error: `❌ Usage: \`${prefix}${cmd.data.name} ${group} <${gn}>\`` }; }
    sub = f.name; opts = f.options || [];
  }
  const vals = {}, atts = [...m.attachments.values()]; let ai = 0;
  for (let n = 0; n < opts.length; n++) {
    const o = opts[n];
    if (o.type === 11) { if (atts[ai]) vals[o.name] = atts[ai++]; else if (o.required) return { error: `❌ Attach a file for \`${o.name}\`.` }; continue; }
    if (!tokens.length) { if (o.required) return { error: `❌ Missing \`${o.name}\`. Use \`/${cmd.data.name}\` to see options.` }; continue; }
    const rest = o.type === 3 && !o.choices && opts.slice(n + 1).every(x => x.type === 11);
    const raw = rest ? tokens.splice(0).join(' ') : tokens.shift();
    const v = await conv(m, o, raw);
    if (v == null) { if (o.required) return { error: `❌ Invalid \`${o.name}\`.` }; if (!rest) tokens.unshift(raw); continue; }
    vals[o.name] = v;
  }
  const g = n => vals[n] ?? null;
  const optsObj = { getSubcommand: () => sub, getSubcommandGroup: () => group, getString: g, getInteger: g, getNumber: g, getBoolean: g,
    getUser: n => g(n)?.user ?? null, getMember: n => g(n)?.member ?? null, getChannel: g, getRole: g, getAttachment: g };
  return { src: m, isSlash: false, client: m.client, guild: m.guild, channel: m.channel, member: m.member, user: m.author, opts: optsObj,
    reply: o => { o = typeof o === 'string' ? { content: o } : { ...o }; delete o.ephemeral; if (o.flags != null) { o.flags &= ~64; if (!o.flags) delete o.flags; }
      return m.reply({ ...o, allowedMentions: { parse: ['users', 'roles'], repliedUser: false } }); },
    defer: async () => { } };
}
module.exports = { slashCtx, prefixCtx, tokenize };
