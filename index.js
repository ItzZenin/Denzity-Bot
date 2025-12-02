const { Client, GatewayIntentBits, Collection, WebhookClient, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const { MongoClient } = require('mongodb');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const config = require('./config.json');
const mongoose = require('mongoose');
const { deployCommands } = require('./deploy-commands');

// Import models
const { Blacklist, WelcomeConfig, GoodbyeConfig } = require('./models/index');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildBans,
    ],
});

client.commands = new Collection();
client.prefixCommands = new Collection();

// Connect to MongoDB
async function connectToMongo() {
    try {
        await mongoose.connect(config.mongoURI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        const webhook = new WebhookClient({ url: config.errorWebhook });
        await webhook.send({
            content: `MongoDB connection error: \n\`\`\`${error.stack}\`\`\``,
        });
    }
}

// Load auto files
const autoFolderPath = path.join(__dirname, 'auto');
if (fsSync.existsSync(autoFolderPath)) {
    const autoFiles = fsSync.readdirSync(autoFolderPath).filter(file => file.endsWith('.js'));
    for (const file of autoFiles) {
        try {
            const autoModule = require(path.join(autoFolderPath, file));
            if (typeof autoModule.init === 'function') {
                autoModule.init(client);
            }
        } catch (err) {
            console.error(`❌ Failed to load auto file ${file}:`, err);
        }
    }
}

// Load slash commands
async function loadSlashCommands() {
    const slashCommandsPath = path.join(__dirname, 'slash');
    const commandFolders = await fs.readdir(slashCommandsPath);
    for (const folder of commandFolders) {
        const commandsPath = path.join(slashCommandsPath, folder);
        const commandFiles = await fs.readdir(commandsPath);
        for (const file of commandFiles) {
            if (file.endsWith('.js')) {
                const filePath = path.join(commandsPath, file);
                const command = require(filePath);
                if ('data' in command && 'execute' in command) {
                    client.commands.set(command.data.name, command);
                    if (command.setup) command.setup(client);
                } else {
                    console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
                }
            }
        }
    }
}

// Load prefix commands
async function loadPrefixCommands() {
    const prefixCommandsPath = path.join(__dirname, 'prefix');
    const commandFolders = await fs.readdir(prefixCommandsPath);
    for (const folder of commandFolders) {
        const commandsPath = path.join(prefixCommandsPath, folder);
        const commandFiles = await fs.readdir(commandsPath);
        for (const file of commandFiles) {
            if (file.endsWith('.js')) {
                const filePath = path.join(commandsPath, file);
                const command = require(filePath);
                if ('name' in command && 'execute' in command) {
                    client.prefixCommands.set(command.name, command);
                    if (command.setup) command.setup(client);
                } else {
                    console.log(`[WARNING] The prefix command at ${filePath} is missing a required "name" or "execute" property.`);
                }
            }
        }
    }
}

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // Check if user is blacklisted
    const isBlacklisted = await Blacklist.exists({ guildId: interaction.guild.id, userId: interaction.user.id });
    if (isBlacklisted) {
        const errorEmbed = new EmbedBuilder()
            .setDescription('❌ You are blacklisted from using commands.')
            .setColor(0xff0000)
            .setFooter({ text: config.embed.footer });

        const errorMessage = await interaction.reply({ embeds: [errorEmbed], ephemeral: true, fetchReply: true });
        setTimeout(() => errorMessage.delete().catch(() => {}), 10000);
        return;
    }

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        const errorEmbed = new EmbedBuilder()
            .setDescription('There was an error while executing this command!')
            .setColor(0xff0000)
            .setFooter({ text: config.embed.footer });

        const errorMessage = await interaction.reply({ embeds: [errorEmbed], ephemeral: true, fetchReply: true });
        setTimeout(() => errorMessage.delete().catch(() => {}), 10000);

        // Send error to webhook
        const webhook = new WebhookClient({ url: config.errorWebhook });
        await webhook.send({
            content: `Error in command ${interaction.commandName}: \n\`\`\`${error.stack}\`\`\``,
        });
    }
});

// Handle prefix commands
client.on('messageCreate', async message => {
    if (!message.content.startsWith(config.prefix) || message.author.bot) return;

    // Check if user is blacklisted
    const isBlacklisted = await Blacklist.exists({ guildId: message.guild.id, userId: message.author.id });
    if (isBlacklisted) {
        const errorEmbed = new EmbedBuilder()
            .setDescription('❌ You are blacklisted from using commands.')
            .setColor(0xff0000)
            .setFooter({ text: config.embed.footer });

        const errorMessage = await message.reply({ embeds: [errorEmbed] });
        setTimeout(() => errorMessage.delete().catch(() => {}), 10000);
        return;
    }

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = client.prefixCommands.get(commandName);
    if (!command) return;

    try {
        await command.execute(message, args);
    } catch (error) {
        console.error(error);
        const errorEmbed = new EmbedBuilder()
            .setDescription('There was an error while executing this command!')
            .setColor(0xff0000)
            .setFooter({ text: config.embed.footer });

        const errorMessage = await message.reply({ embeds: [errorEmbed] });
        setTimeout(() => errorMessage.delete().catch(() => {}), 10000);

        // Send error to webhook
        const webhook = new WebhookClient({ url: config.errorWebhook });
        await webhook.send({
            content: `Error in prefix command ${commandName}: \n\`\`\`${error.stack}\`\`\``,
        });
    }
});

// Handle guild member add
client.on('guildMemberAdd', async member => {
    try {
        const config = await WelcomeConfig.findOne({ guildId: member.guild.id });
        if (!config) return;

        const { channelId, embedColor, title, description, image } = config;
        const channel = member.guild.channels.cache.get(channelId);
        if (!channel) return;

        const userMention = `<@${member.user.id}>`;
        const server = member.guild.name;

        const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(title.replace('{user}', userMention).replace('{server}', server))
            .setDescription(description.replace('{user}', userMention).replace('{server}', server))
            .setImage(image || null)
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Error in guildMemberAdd:', error);
        const webhook = new WebhookClient({ url: config.errorWebhook });
        await webhook.send({
            content: `Error in guildMemberAdd: \n\`\`\`${error.stack}\`\`\``,
        });
    }
});

// Handle guild member remove
client.on('guildMemberRemove', async member => {
    try {
        const config = await GoodbyeConfig.findOne({ guildId: member.guild.id });
        if (!config) return;

        const { channelId, embedColor, title, description, image } = config;
        const channel = member.guild.channels.cache.get(channelId);
        if (!channel) return;

        const userMention = `<@${member.user.id}>`;
        const server = member.guild.name;

        const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle(title.replace('{user}', userMention).replace('{server}', server))
            .setDescription(description.replace('{user}', userMention).replace('{server}', server))
            .setImage(image || null)
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Error in guildMemberRemove:', error);
        const webhook = new WebhookClient({ url: config.errorWebhook });
        await webhook.send({
            content: `Error in guildMemberRemove: \n\`\`\`${error.stack}\`\`\``,
        });
    }
});

// Bot ready event
client.once('ready', async () => {
    console.log(`Hello World, I'm ${client.user.tag}`);
    const updateStreamingStatus = () => {
        const serverCount = client.guilds.cache.size;
        client.user.setActivity({
            name: `On ${serverCount} Servers | ${config.prefix}help`,
            type: 1, // Streaming
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' // Replace with your real YouTube livestream URL
        });
    };

    updateStreamingStatus();
    // Update every 10 seconds (in case the bot joins/leaves servers)
    setInterval(updateStreamingStatus, 10000);

    // Rejoin 24/7 voice channels
    try {
        const mongoClient = new MongoClient(config.mongoURI);
        await mongoClient.connect();
        const db = mongoClient.db('bot');
        const collection = db.collection('voice247');

        const configs = await collection.find({}).toArray();
        for (const config of configs) {
            const guild = client.guilds.cache.get(config.guildId);
            if (!guild) {
                console.log(`Guild ${config.guildId} not found for 24/7 rejoin.`);
                continue;
            }

            const channel = guild.channels.cache.get(config.channelId);
            if (!channel || !channel.isVoiceBased()) {
                console.log(`Voice channel ${config.channelId} not found or not a voice channel in guild ${guild.name}`);
                continue;
            }

            if (!channel.permissionsFor(guild.members.me).has([GatewayIntentBits.Connect, GatewayIntentBits.Speak])) {
                console.log(`Missing permissions to join voice channel ${channel.name} in guild ${guild.name}`);
                continue;
            }

            joinVoiceChannel({
                channelId: config.channelId,
                guildId: config.guildId,
                adapterCreator: guild.voiceAdapterCreator,
            });
            console.log(`Rejoined 24/7 voice channel ${channel.name} in guild ${guild.name}`);
        }

        await mongoClient.close();
    } catch (error) {
        console.error('Error rejoining 24/7 voice channels:', error);
        const webhook = new WebhookClient({ url: config.errorWebhook });
        await webhook.send({
            content: `Error rejoining 24/7 voice channels: \n\`\`\`${error.stack}\`\`\``,
        });
    }

    await connectToMongo();
    await loadSlashCommands();
    await loadPrefixCommands();
    await deployCommands(); // Deploy slash commands
});

// Login to Discord
client.login(config.token);