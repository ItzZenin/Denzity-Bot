const { REST, Routes } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config.json');

async function deployCommands() {
    const commands = [];
    const slashCommandsPath = path.join(__dirname, 'slash');
    const commandFolders = await fs.readdir(slashCommandsPath);

    // Collect slash commands
    for (const folder of commandFolders) {
        const commandsPath = path.join(slashCommandsPath, folder);
        const commandFiles = await fs.readdir(commandsPath);
        for (const file of commandFiles) {
            if (file.endsWith('.js')) {
                const filePath = path.join(commandsPath, file);
                const command = require(filePath);
                if ('data' in command && 'execute' in command) {
                    commands.push(command.data.toJSON());
                } else {
                    console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
                }
            }
        }
    }

    // Initialize REST client
    const rest = new REST({ version: '10' }).setToken(config.token);

    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        // Register commands (global or guild-specific)
        const guildId = config.guildId; // Optional: specify in config.json for guild-specific deployment
        const route = guildId
            ? Routes.applicationGuildCommands(config.clientId, guildId)
            : Routes.applicationCommands(config.clientId);

        const data = await rest.put(route, { body: commands });

        console.log(`Successfully reloaded ${data.length} application (/) commands ${guildId ? `for guild ${guildId}` : 'globally'}.`);
    } catch (error) {
        console.error('Error deploying commands:', error);
        const webhook = new WebhookClient({ url: config.errorWebhook });
        await webhook.send({
            content: `Error deploying slash commands: \n\`\`\`${error.stack}\`\`\``,
        });
    }
}

module.exports = { deployCommands };