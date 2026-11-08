const { SlashCommandBuilder: S, PermissionFlagsBits: P, ChannelType } = require('discord.js');
const db = require('../lib/db'); const { say, EPH } = require('../lib/util');
const word = (s, d) => s.addStringOption(o => o.setName('word').setDescription('Word or phrase').setRequired(true));
const automod = {
  perm: P.ManageGuild,
  data: new S().setName('automod').setDescription('Configure automod').setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommandGroup(g => g.setName('badwords').setDescription('Banned words')
      .addSubcommand(s => word(s.setName('add').setDescription('Ban a word/phrase')))
      .addSubcommand(s => word(s.setName('remove').setDescription('Unban a word/phrase')))
      .addSubcommand(s => s.setName('list').setDescription('List banned words')))
    .addSubcommand(s => s.setName('toggle').setDescription('Turn a rule on/off')
      .addStringOption(o => o.setName('rule').setDescription('Rule').setRequired(true).addChoices({ name: 'Links', value: 'links' }, { name: 'Discord invites', value: 'invites' }, { name: 'Spam', value: 'spam' }, { name: 'Caps', value: 'caps' }))
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand(s => s.setName('action').setDescription('What happens on a violation (message is always deleted)')
      .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Delete only', value: 'delete' }, { name: 'Warn', value: 'warn' }, { name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
      .addIntegerOption(o => o.setName('minutes').setDescription('Timeout minutes').setMinValue(1).setMaxValue(40320)))
    .addSubcommand(s => s.setName('mentions').setDescription('Max mentions per message').addIntegerOption(o => o.setName('limit').setDescription('Limit').setRequired(true).setMinValue(1).setMaxValue(50)))
    .addSubcommand(s => s.setName('whitelist').setDescription('Exempt a role or channel from automod')
      .addStringOption(o => o.setName('mode').setDescription('add or remove').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
      .addRoleOption(o => o.setName('role').setDescription('Role')).addChannelOption(o => o.setName('channel').setDescription('Channel')))
    .addSubcommand(s => s.setName('status').setDescription('Show automod settings')),
  async run(ctx) {
    const o = ctx.opts, g = ctx.guild.id, sub = o.getSubcommand(), grp = o.getSubcommandGroup(false), ok = t => ctx.reply(say(t, 0x57F287));
    if (grp === 'badwords') {
      const w = o.getString('word')?.toLowerCase().trim(), a = db.get(g).automod.words;
      if (sub === 'list') return ctx.reply({ ...say(a.length ? a.map(x => `\`${x}\``).join(', ') : 'No banned words yet.'), flags: EPH });
      db.mut(g, 'automod', m => { m.words = sub === 'add' ? [...new Set([...m.words, w])] : m.words.filter(x => x !== w); });
      return ok(`✅ \`${w}\` ${sub === 'add' ? 'added to' : 'removed from'} banned words.`);
    }
    if (sub === 'toggle') { db.mut(g, 'automod', m => { m[o.getString('rule')] = o.getBoolean('enabled'); }); return ok(`✅ **${o.getString('rule')}** is now ${o.getBoolean('enabled') ? 'ON' : 'OFF'}.`); }
    if (sub === 'action') { db.mut(g, 'automod', m => { m.action = o.getString('action'); if (o.getInteger('minutes')) m.minutes = o.getInteger('minutes'); }); return ok(`✅ Action set to **${o.getString('action')}**.`); }
    if (sub === 'mentions') { db.mut(g, 'automod', m => { m.mentions = o.getInteger('limit'); }); return ok(`✅ Max mentions: **${o.getInteger('limit')}**.`); }
    if (sub === 'whitelist') {
      const ids = [o.getRole('role')?.id, o.getChannel('channel')?.id].filter(Boolean); if (!ids.length) return ctx.reply({ content: '❌ Give a role and/or channel.', flags: EPH });
      db.mut(g, 'automod', m => { m.whitelist = o.getString('mode') === 'add' ? [...new Set([...m.whitelist, ...ids])] : m.whitelist.filter(x => !ids.includes(x)); });
      return ok(`✅ Whitelist updated (${o.getString('mode')}).`);
    }
    const a = db.get(g).automod, f = b => b ? '🟢' : '🔴';
    return ctx.reply(say(`${f(a.words.length)} Banned words: **${a.words.length}**\n${f(a.links)} Links\n${f(a.invites)} Discord invites\n${f(a.spam)} Spam\n${f(a.caps)} Caps\n🟢 Max mentions: **${a.mentions}**\n**Action:** ${a.action}${a.action === 'timeout' ? ` (${a.minutes}m)` : ''}\n**Whitelist:** ${a.whitelist.map(x => `<@&${x}>`.replace(/<@&(\d+)>/, (m, id) => ctx.guild.channels.cache.has(id) ? `<#${id}>` : m)).join(' ') || 'none'}`));
  },
};
const channelOpt = s => s.addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true));
const mediaonly = {
  perm: P.ManageChannels,
  data: new S().setName('mediaonly').setDescription('Media-only channels').setDefaultMemberPermissions(P.ManageChannels)
    .addSubcommand(s => channelOpt(s.setName('add').setDescription('Make a channel media-only')))
    .addSubcommand(s => channelOpt(s.setName('remove').setDescription('Remove media-only')))
    .addSubcommand(s => s.setName('list').setDescription('List media-only channels')),
  async run(ctx) {
    const sub = ctx.opts.getSubcommand(), g = ctx.guild.id;
    if (sub === 'list') { const l = db.get(g).mediaonly; return ctx.reply(say(l.length ? l.map(i => `<#${i}>`).join('\n') : 'No media-only channels.')); }
    const ch = ctx.opts.getChannel('channel');
    db.mut(g, 'mediaonly', l => { const i = l.indexOf(ch.id); if (sub === 'add' && i < 0) l.push(ch.id); if (sub === 'remove' && i >= 0) l.splice(i, 1); });
    return ctx.reply(say(`✅ ${ch} ${sub === 'add' ? 'is now **media-only** (images, videos, GIFs). Staff with Manage Messages are exempt.' : 'is no longer media-only.'}`, 0x57F287));
  },
};
module.exports = [automod, mediaonly];
