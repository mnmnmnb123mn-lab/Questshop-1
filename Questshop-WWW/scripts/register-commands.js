import '../src/config/load-runtime-environment.js';
import { REST, Routes } from 'discord.js';
import { loadRuntimeEnvironment } from '../src/config/env.js';
import { commandData } from '../src/discord/commands/definitions.js';

const env = loadRuntimeEnvironment();
const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body: commandData });
console.log(`Registered ${commandData.length} guild commands`);
