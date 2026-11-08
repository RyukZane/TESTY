require('dotenv').config();
const fs = require('fs'), path = require('path');
const { Client, GatewayIntentBits: G, Partials, Collection, Events } = require('discord.js');
const db = require('./lib/db'); const { slashCtx, prefixCtx, tokenize } = require('./lib/ctx');
// const tickets = require('./lib/tickets'); // OLD ticket system - disabled, replaced by ./ticket.js
const guard = require('./lib/guard'); const { EPH } = require('./lib/util');

const client = new Client({
  intents: [G.Guilds, G.GuildMembers, G.GuildMessages, G.MessageContent, G.GuildModeration, G.GuildVoiceStates, G.GuildInvites, G.GuildExpressions, G.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});
client.commands = new Collection();
// skips the old commands/ticket.js so it can't clash with the new /ticket command
for (const f of fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js') && f !== 'ticket.js'))
  for (const c of [].concat(require(`./commands/${f}`))) client.commands.set(c.data.name, c);
// optional greet.js (welcome panel + invite tracker + /config) — loads only if the file exists
let greet = null;
try {
  greet = require('./greet');
  for (const c of greet.commands) client.commands.set(c.data.name, c);
  greet.init(client);
} catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes('greet')) console.error('⚠️ greet.js failed to load:', e.message); }
require('./events')(client);
// NEW ticket system - must run before client.login(). Bot still boots if ticket.js is missing.
try { require('./ticket').attach(client); }
catch (e) {
  if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'./ticket'")) console.error('⚠️ ticket.js not found next to index.js - ticket system NOT loaded. Upload ticket.js to the same folder as index.js.');
  else console.error('⚠️ ticket.js failed to load:', e);
}
// Full bot control panel (settings, embeds, commands, moderation, logs...). Shares the dashboard port at /admin.
try { require('./website')(client); }
catch (e) { if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'./website'")) console.log('ℹ️ website.js not found - bot dashboard not loaded.'); else console.error('⚠️ website.js failed to load:', e); }

async function execute(cmd, ctx) {
  if (!ctx.guild) return ctx.reply('Servers only.');
  if (cmd.perm && !ctx.member.permissions.has(cmd.perm)) return ctx.reply({ content: '❌ You do not have permission to use this.', flags: EPH });
  await cmd.run(ctx);
}
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('*help • /help');
  const json = [...client.commands.values()].map(c => c.data.toJSON());
  const gid = (process.env.GUILD_ID || '').trim();
  try {
    if (gid) {
      const guild = await client.guilds.fetch(gid).catch(() => null);
      if (!guild) {
        console.error(`❌ GUILD_ID ${gid} not found - the bot is not in that server (or the ID is wrong). Falling back to GLOBAL registration.`);
        await client.application.commands.set(json);
        console.log(`✅ Registered ${json.length} GLOBAL slash commands (can take up to 1 hour to appear)`);
      } else {
        await guild.commands.set(json);
        await client.application.commands.set([]); // remove old global copies so commands don't show twice
        console.log(`✅ Registered ${json.length} slash commands in "${guild.name}" (instant)`);
      }
    } else {
      await client.application.commands.set(json);
      console.log(`✅ Registered ${json.length} GLOBAL slash commands (can take up to 1 hour to appear). Set GUILD_ID for instant.`);
      // also push to every server the bot is in so they show up immediately
      for (const g of client.guilds.cache.values()) await g.commands.set(json).catch(() => { });
    }
  } catch (e) { console.error('❌ Command registration failed:', e); }
  console.log('Servers:', client.guilds.cache.map(g => `${g.name} (${g.id})`).join(', ') || 'none');
});
client.on('interactionCreate', async i => {
  try {
    if (i.isChatInputCommand()) { const cmd = client.commands.get(i.commandName); if (cmd) await execute(cmd, slashCtx(i)); }
    // OLD ticket buttons - disabled, the new ticket.js handles its own interactions
    // else if ((i.isButton() || i.isModalSubmit() || i.isAnySelectMenu()) && i.customId.startsWith('tk:')) await tickets.handle(i);
    else if (greet && (i.isButton() || i.isModalSubmit() || i.isAnySelectMenu()) && /^(wl|iv|cf):/.test(i.customId)) await greet.handle(i);
    // trigger.js (tg:), react roles (rr2:) and ticket setup menus attach their own listeners — nothing to add here
  } catch (e) {
    console.error(e);
    const o = { content: '❌ Something went wrong. Check my permissions and try again.', flags: EPH };
    (i.deferred || i.replied ? i.followUp(o) : i.reply(o)).catch(() => { });
  }
});
client.on('messageCreate', async m => {
  if (m.author.bot || !m.guild) return;
  try {
    m.member ??= await m.guild.members.fetch(m.author.id).catch(() => null);
    const s = db.get(m.guild.id);
    if (await guard.check(m, s)) return;
    // tickets.onMessage(m, s); // OLD ticket system - disabled
    if (m.content === `<@${client.user.id}>`) return void m.reply(`My prefix here is \`${s.prefix}\` — try \`${s.prefix}help\``);
    if (!m.content.startsWith(s.prefix)) return;
    const tokens = tokenize(m.content.slice(s.prefix.length)), cmd = client.commands.get((tokens.shift() || '').toLowerCase());
    if (!cmd) return;
    const ctx = await prefixCtx(m, cmd, tokens, s.prefix);
    if (ctx.error) return void m.reply(ctx.error);
    await execute(cmd, ctx);
  } catch (e) { console.error(e); m.reply('❌ Something went wrong.').catch(() => { }); }
});
client.login(process.env.TOKEN);
