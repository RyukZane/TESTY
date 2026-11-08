# DynastySMP Bot

Tickets • Embeds • Audit logs • Automod • Media-only • Moderation • Polls. Every command works as **/command** AND **\*command** (default prefix `*`, change with `*prefix <new>` or `/prefix`).

## Setup
1. Create a bot at https://discord.com/developers/applications → Bot → copy the token.
   Turn ON **Server Members Intent** and **Message Content Intent**.
2. Install Node.js 20+, then in this folder: `npm install`
3. Copy `.env.example` to `.env`, paste your token (add `GUILD_ID` for instant slash commands in your server).
4. `npm start`
5. Invite (Administrator, easiest): `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=8`
6. In Discord run: `/ticket setup panel_channel:#tickets logs_channel:#ticket-logs support_role:@Staff` then `/log set channel:#mod-logs`.
   Put the bot's role ABOVE the staff/member roles so it can manage channels and moderate.

## Prefix examples
`*ticket category add "Event Help" 🎉` • `*embed create "Title" "Text" red` (attach a picture to the same message) • `*poll "Select a time for ENDWAR" "5:00PM | 6:30PM | 7:00PM" 24` • `*ban @user spamming`
Use quotes around multi-word values (except the last one).

## Notes
- Data is stored in `data.db` (SQLite). Back it up to keep tickets/settings.
- Run `*help` for the full command list.
