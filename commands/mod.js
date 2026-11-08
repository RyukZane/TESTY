const { SlashCommandBuilder: S, PermissionFlagsBits: P, EmbedBuilder } = require('discord.js');
const db = require('../lib/db'); const { EPH, say, logSend, logE } = require('../lib/util');
const U = (s, req = true) => s.addUserOption(o => o.setName('user').setDescription('User').setRequired(req));
const R = s => s.addStringOption(o => o.setName('reason').setDescription('Reason'));
// helper: can the invoker + bot act on this member?
function block(ctx, m, flag) {
  if (!m) return null; if (m.id === ctx.user.id) return "You can't target yourself.";
  if (m.id === ctx.guild.ownerId) return "You can't target the owner.";
  if (ctx.guild.ownerId !== ctx.user.id && m.roles.highest.position >= ctx.member.roles.highest.position) return 'That member has an equal or higher role than you.';
  if (!m[flag]) return "I can't do that — their role is above mine or I lack permission."; return null;
}
const tag = ctx => `${ctx.user.username}: `;
const dm = (u, t) => u.send(t).catch(() => { });
const cmds = [
  { perm: P.BanMembers, data: R(U(new S().setName('ban').setDescription('Ban a user').setDefaultMemberPermissions(P.BanMembers))
      .addIntegerOption(o => o.setName('delete_days').setDescription('Delete their messages from the last X days').setMinValue(0).setMaxValue(7))),
    async run(ctx) { const u = ctx.opts.getUser('user'), why = ctx.opts.getString('reason') || 'No reason', e = block(ctx, ctx.opts.getMember('user'), 'bannable');
      if (e) return ctx.reply({ content: '❌ ' + e, flags: EPH }); await dm(u, `🔨 You were banned from **${ctx.guild.name}**: ${why}`);
      await ctx.guild.members.ban(u, { reason: tag(ctx) + why, deleteMessageSeconds: (ctx.opts.getInteger('delete_days') || 0) * 86400 }); return ctx.reply(say(`🔨 Banned **${u.username}** — ${why}`, 0xED4245)); } },
  { perm: P.BanMembers, data: R(new S().setName('unban').setDescription('Unban a user by ID').setDefaultMemberPermissions(P.BanMembers).addStringOption(o => o.setName('user_id').setDescription('User ID').setRequired(true))),
    async run(ctx) { try { await ctx.guild.members.unban(ctx.opts.getString('user_id').replace(/\D/g, ''), tag(ctx) + (ctx.opts.getString('reason') || 'No reason')); return ctx.reply(say('✅ Unbanned.', 0x57F287)); } catch { return ctx.reply({ content: '❌ That user is not banned.', flags: EPH }); } } },
  { perm: P.KickMembers, data: R(U(new S().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(P.KickMembers))),
    async run(ctx) { const m = ctx.opts.getMember('user'), why = ctx.opts.getString('reason') || 'No reason'; if (!m) return ctx.reply({ content: '❌ Member not found.', flags: EPH });
      const e = block(ctx, m, 'kickable'); if (e) return ctx.reply({ content: '❌ ' + e, flags: EPH }); await dm(m.user, `👢 You were kicked from **${ctx.guild.name}**: ${why}`);
      await m.kick(tag(ctx) + why); return ctx.reply(say(`👢 Kicked **${m.user.username}** — ${why}`, 0xE67E22)); } },
  { perm: P.ModerateMembers, data: R(U(new S().setName('timeout').setDescription('Timeout a member').setDefaultMemberPermissions(P.ModerateMembers)).addIntegerOption(o => o.setName('minutes').setDescription('Minutes (max 40320)').setRequired(true).setMinValue(1).setMaxValue(40320))),
    async run(ctx) { const m = ctx.opts.getMember('user'), why = ctx.opts.getString('reason') || 'No reason', min = ctx.opts.getInteger('minutes'); if (!m) return ctx.reply({ content: '❌ Member not found.', flags: EPH });
      const e = block(ctx, m, 'moderatable'); if (e) return ctx.reply({ content: '❌ ' + e, flags: EPH }); await m.timeout(min * 60000, tag(ctx) + why); await dm(m.user, `🔇 You were timed out in **${ctx.guild.name}** for ${min}m: ${why}`);
      return ctx.reply(say(`🔇 Timed out **${m.user.username}** for ${min}m — ${why}`, 0xE67E22)); } },
  { perm: P.ModerateMembers, data: U(new S().setName('untimeout').setDescription('Remove a timeout').setDefaultMemberPermissions(P.ModerateMembers)),
    async run(ctx) { const m = ctx.opts.getMember('user'); if (!m) return ctx.reply({ content: '❌ Member not found.', flags: EPH }); await m.timeout(null, tag(ctx) + 'Timeout removed'); return ctx.reply(say(`✅ Timeout removed for **${m.user.username}**.`, 0x57F287)); } },
  { perm: P.ModerateMembers, data: R(U(new S().setName('warn').setDescription('Warn a member').setDefaultMemberPermissions(P.ModerateMembers))),
    async run(ctx) { const u = ctx.opts.getUser('user'), why = ctx.opts.getString('reason') || 'No reason';
      db.raw.prepare('INSERT INTO warns(guild,user,mod,reason,at) VALUES(?,?,?,?,?)').run(ctx.guild.id, u.id, ctx.user.id, why, Date.now());
      const n = db.raw.prepare('SELECT COUNT(*) n FROM warns WHERE guild=? AND user=?').get(ctx.guild.id, u.id).n; await dm(u, `⚠️ You were warned in **${ctx.guild.name}**: ${why}`);
      logSend(ctx.guild, 'mod', logE(0xFEE75C, '⚠️ Warning').setDescription(`**User:** ${u} (${u.id})\n**By:** ${ctx.user}\n**Reason:** ${why}\n**Total warns:** ${n}`));
      return ctx.reply(say(`⚠️ Warned **${u.username}** (${n} total) — ${why}`, 0xFEE75C)); } },
  { perm: P.ModerateMembers, data: U(new S().setName('warnings').setDescription('View warnings').setDefaultMemberPermissions(P.ModerateMembers)),
    async run(ctx) { const u = ctx.opts.getUser('user'), r = db.raw.prepare('SELECT * FROM warns WHERE guild=? AND user=? ORDER BY at DESC LIMIT 15').all(ctx.guild.id, u.id);
      return ctx.reply(say(r.length ? r.map(w => `**#${w.id}** <t:${Math.floor(w.at / 1000)}:d> by <@${w.mod}> — ${w.reason}`).join('\n') : `${u.username} has no warnings.`)); } },
  { perm: P.ModerateMembers, data: U(new S().setName('clearwarns').setDescription('Clear all warnings of a user').setDefaultMemberPermissions(P.ModerateMembers)),
    async run(ctx) { const u = ctx.opts.getUser('user'); db.raw.prepare('DELETE FROM warns WHERE guild=? AND user=?').run(ctx.guild.id, u.id); return ctx.reply(say(`✅ Cleared warnings for **${u.username}**.`, 0x57F287)); } },
  { perm: P.ManageMessages, data: new S().setName('purge').setDescription('Bulk delete messages').setDefaultMemberPermissions(P.ManageMessages).addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    async run(ctx) { const n = ctx.opts.getInteger('amount'); const d = await ctx.channel.bulkDelete(ctx.isSlash ? n : n + 1, true); const r = await ctx.channel.send(`🧹 Deleted ${Math.max(0, d.size - (ctx.isSlash ? 0 : 1))} messages.`);
      setTimeout(() => r.delete().catch(() => { }), 4000); if (ctx.isSlash) ctx.reply({ content: '✅ Done.', flags: EPH }); } },
  { perm: P.ManageChannels, data: new S().setName('slowmode').setDescription('Set slowmode').setDefaultMemberPermissions(P.ManageChannels).addIntegerOption(o => o.setName('seconds').setDescription('0 to disable (max 21600)').setRequired(true).setMinValue(0).setMaxValue(21600)),
    async run(ctx) { await ctx.channel.setRateLimitPerUser(ctx.opts.getInteger('seconds')); return ctx.reply(say(`✅ Slowmode set to ${ctx.opts.getInteger('seconds')}s.`, 0x57F287)); } },
  { perm: P.ManageChannels, data: new S().setName('lock').setDescription('Lock a channel').setDefaultMemberPermissions(P.ManageChannels).addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')),
    async run(ctx) { const ch = ctx.opts.getChannel('channel') || ctx.channel; await ch.permissionOverwrites.edit(ctx.guild.id, { SendMessages: false }); return ctx.reply(say(`🔒 ${ch} locked.`, 0xED4245)); } },
  { perm: P.ManageChannels, data: new S().setName('unlock').setDescription('Unlock a channel').setDefaultMemberPermissions(P.ManageChannels).addChannelOption(o => o.setName('channel').setDescription('Channel (default: here)')),
    async run(ctx) { const ch = ctx.opts.getChannel('channel') || ctx.channel; await ch.permissionOverwrites.edit(ctx.guild.id, { SendMessages: null }); return ctx.reply(say(`🔓 ${ch} unlocked.`, 0x57F287)); } },
];
module.exports = cmds;
