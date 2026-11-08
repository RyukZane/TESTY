const { SlashCommandBuilder: S, EmbedBuilder, PermissionFlagsBits: P } = require('discord.js');
const db = require('../lib/db'); const { EPH, say, isAdmin, BRAND } = require('../lib/util');
module.exports = [
  { data: new S().setName('prefix').setDescription('View or change the bot prefix').addStringOption(o => o.setName('new').setDescription('New prefix (max 3 characters)')),
    async run(ctx) {
      const n = ctx.opts.getString('new'), cur = db.get(ctx.guild.id).prefix;
      if (!n) return ctx.reply(say(`My prefix here is \`${cur}\`\nChange it: \`${cur}prefix <new>\` or \`/prefix new:<new>\``));
      if (!isAdmin(ctx.member)) return ctx.reply({ content: '❌ You need Manage Server to change the prefix.', flags: EPH });
      if (n.length > 3 || /\s|[`\\]/.test(n)) return ctx.reply({ content: '❌ Prefix must be 1-3 characters, no spaces.', flags: EPH });
      db.set(ctx.guild.id, { prefix: n }); return ctx.reply(say(`✅ Prefix changed to \`${n}\` (default was \`*\`).`, 0x57F287));
    } },
  { data: new S().setName('help').setDescription('Show all commands'),
    async run(ctx) {
      const p = db.get(ctx.guild.id).prefix;
      return ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`${BRAND} Bot • Help`).setDescription(`Every command works as **/command** and **${p}command**.`).addFields(
        { name: '🎫 Tickets', value: '`ticket setup` `ticket panel` `ticket supportrole` `ticket category add/edit/remove` `ticket blacklist` `ticket add/remove/rename` `ticket leaderboard` `ticket stats` `ticket serverstats` `ticket settings`' },
        { name: '🧾 Logs', value: '`log set` `log toggle` `log view`' },
        { name: '🛡️ Automod', value: '`automod badwords` `automod toggle` `automod action` `automod mentions` `automod whitelist` `automod status` `mediaonly add/remove/list`' },
        { name: '🔨 Moderation', value: '`ban` `unban` `kick` `timeout` `untimeout` `warn` `warnings` `clearwarns` `purge` `slowmode` `lock` `unlock`' },
        { name: '✨ Utility', value: '`embed create/edit` `poll` `prefix` `ping` `serverinfo` `userinfo` `avatar`' })] });
    } },
  { data: new S().setName('ping').setDescription('Bot latency'), async run(ctx) { return ctx.reply(say(`🏓 Pong! **${ctx.client.ws.ping}ms**`)); } },
  { data: new S().setName('avatar').setDescription('Show an avatar').addUserOption(o => o.setName('user').setDescription('User')),
    async run(ctx) { const u = ctx.opts.getUser('user') || ctx.user; return ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(u.username).setImage(u.displayAvatarURL({ size: 1024 }))] }); } },
  { data: new S().setName('userinfo').setDescription('User info').addUserOption(o => o.setName('user').setDescription('User')),
    async run(ctx) { const u = ctx.opts.getUser('user') || ctx.user, m = ctx.opts.getMember('user') || (u.id === ctx.user.id ? ctx.member : null);
      return ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(u.username).setThumbnail(u.displayAvatarURL()).addFields({ name: 'ID', value: u.id, inline: true },
        { name: 'Created', value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true }, ...(m ? [{ name: 'Joined', value: `<t:${Math.floor(m.joinedTimestamp / 1000)}:R>`, inline: true }, { name: 'Roles', value: m.roles.cache.filter(r => r.id !== ctx.guild.id).map(r => r).join(' ').slice(0, 1000) || 'none' }] : []))] }); } },
  { data: new S().setName('serverinfo').setDescription('Server info'),
    async run(ctx) { const g = ctx.guild; return ctx.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(g.name).setThumbnail(g.iconURL()).addFields({ name: 'Members', value: `${g.memberCount}`, inline: true },
      { name: 'Channels', value: `${g.channels.cache.size}`, inline: true }, { name: 'Roles', value: `${g.roles.cache.size}`, inline: true }, { name: 'Owner', value: `<@${g.ownerId}>`, inline: true }, { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true })] }); } },
  { perm: P.ManageMessages, data: new S().setName('poll').setDescription('Create a poll, e.g. a time vote').setDefaultMemberPermissions(P.ManageMessages)
      .addStringOption(o => o.setName('question').setDescription('Question').setRequired(true))
      .addStringOption(o => o.setName('answers').setDescription('Answers separated by | (2-10), e.g. 5:00PM | 6:30PM | 7:00PM').setRequired(true))
      .addIntegerOption(o => o.setName('hours').setDescription('Duration in hours (default 24)').setMinValue(1).setMaxValue(768))
      .addBooleanOption(o => o.setName('multiple').setDescription('Allow multiple answers'))
      .addRoleOption(o => o.setName('ping').setDescription('Role to ping, e.g. @Whitelisted')),
    async run(ctx) {
      const a = ctx.opts.getString('answers').split('|').map(x => x.trim()).filter(Boolean).slice(0, 10);
      if (a.length < 2) return ctx.reply({ content: '❌ Give at least 2 answers separated by `|`.', flags: EPH });
      const ping = ctx.opts.getRole('ping');
      await ctx.channel.send({ content: ping ? `${ping}` : undefined, allowedMentions: { parse: ['roles'] }, poll: { question: { text: ctx.opts.getString('question').slice(0, 300) }, answers: a.map(text => ({ text: text.slice(0, 55) })), duration: ctx.opts.getInteger('hours') || 24, allowMultiselect: !!ctx.opts.getBoolean('multiple') } });
      if (ctx.isSlash) return ctx.reply({ content: '✅ Poll posted.', flags: EPH }); ctx.src.delete().catch(() => { });
    } },
];
