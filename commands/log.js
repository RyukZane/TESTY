const { SlashCommandBuilder: S, ChannelType, PermissionFlagsBits: P } = require('discord.js');
const db = require('../lib/db'); const { say } = require('../lib/util');
const TYPES = ['message', 'member', 'mod', 'channel', 'role', 'server', 'voice', 'automod'];
const typeOpt = (o, req) => o.setName('type').setDescription('Log type').setRequired(req).addChoices(...TYPES.map(t => ({ name: t, value: t })));
const data = new S().setName('log').setDescription('Audit log settings').setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s => s.setName('set').setDescription('Set the log channel').addChannelOption(o => o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => typeOpt(o, false).setDescription('Only this log type (default: everything)')))
  .addSubcommand(s => s.setName('toggle').setDescription('Turn a log type on/off').addStringOption(o => typeOpt(o, true)).addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))
  .addSubcommand(s => s.setName('view').setDescription('Show log settings'));
module.exports = { data, perm: P.ManageGuild, async run(ctx) {
  const o = ctx.opts, sub = o.getSubcommand(), g = ctx.guild.id;
  if (sub === 'set') { const ch = o.getChannel('channel'), t = o.getString('type');
    db.mut(g, 'logs', l => { if (t) l.channels[t] = ch.id; else l.channel = ch.id; });
    return ctx.reply(say(`✅ ${t ? `**${t}** logs` : 'All logs'} will go to ${ch}.`, 0x57F287)); }
  if (sub === 'toggle') { const t = o.getString('type'), on = o.getBoolean('enabled');
    db.mut(g, 'logs', l => { l.off = on ? l.off.filter(x => x !== t) : [...new Set([...l.off, t])]; });
    return ctx.reply(say(`✅ **${t}** logs ${on ? 'enabled' : 'disabled'}.`, 0x57F287)); }
  const l = db.get(g).logs;
  return ctx.reply(say(`**Main channel:** ${l.channel ? `<#${l.channel}>` : 'not set'}\n${TYPES.map(t => `${l.off.includes(t) ? '🔴' : '🟢'} ${t}${l.channels[t] ? ` → <#${l.channels[t]}>` : ''}`).join('\n')}`));
} };
