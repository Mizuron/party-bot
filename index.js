require("dotenv").config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const cron = require("node-cron");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const GUILD_ID = process.env.GUILD_ID;
const SELECTION_CHANNEL_ID = process.env.SELECTION_CHANNEL_ID;

const PARTY_ROLE_IDS = {};
for (let i = 1; i <= 12; i++) {
  const v = process.env[`PARTY_ROLE_${i}`];
  if (!v) throw new Error(`Missing env var PARTY_ROLE_${i}`);
  PARTY_ROLE_IDS[i] = v;
}

const ALL_PARTY_ROLE_IDS = new Set(Object.values(PARTY_ROLE_IDS));

function getCurrentPartyRole(member) {
  return member.roles.cache.find(r => ALL_PARTY_ROLE_IDS.has(r.id)) ?? null;
}

function buildPartyButtons() {
  const makeBtn = (i) =>
    new ButtonBuilder()
      .setCustomId(`party_${i}`)
      .setLabel(`Party ${i}`)
      .setStyle(ButtonStyle.Primary);

  const row1 = new ActionRowBuilder().addComponents(
    makeBtn(1), makeBtn(2), makeBtn(3), makeBtn(4), makeBtn(5)
  );

  const row2 = new ActionRowBuilder().addComponents(
    makeBtn(6), makeBtn(7), makeBtn(8), makeBtn(9), makeBtn(10)
  );

  const row3 = new ActionRowBuilder().addComponents(
    makeBtn(11), makeBtn(12)
  );

  return [row1, row2, row3];
}

async function ensureSelectionMessage(guild) {
  const channel = await guild.channels.fetch(SELECTION_CHANNEL_ID);

  const content =
    "**Select your Party for today**\n\n" +
    "You can only be in **one Party** at a time.\n" +
    "If you already have a Party role, remove it first.\n\n" +
    "All Party roles reset automatically at **midnight (00:00)**.";

  const components = buildPartyButtons();

  const messages = await channel.messages.fetch({ limit: 25 });
  const existing = messages.find(m => m.author.id === client.user.id);

  if (existing) {
    await existing.edit({ content, components });
  } else {
    await channel.send({ content, components });
  }
}

async function resetAllPartyRoles(guild) {
  const members = await guild.members.fetch();

  for (const [, member] of members) {
    const rolesToRemove = member.roles.cache.filter(r => ALL_PARTY_ROLE_IDS.has(r.id));
    if (rolesToRemove.size > 0) {
      await member.roles.remove(
        rolesToRemove.map(r => r.id),
        "Daily midnight party reset"
      );
    }
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  await ensureSelectionMessage(guild);

  // Reset every day at 00:00 (midnight) Europe/Berlin
  cron.schedule("0 0 * * *", async () => {
    const g = await client.guilds.fetch(GUILD_ID);
    await resetAllPartyRoles(g);
    console.log("Midnight reset completed.");
  }, {
    timezone: "Europe/Berlin"
  });

  console.log("Midnight reset scheduler started.");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("party_")) return;

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const current = getCurrentPartyRole(member);

  if (current) {
    return interaction.reply({
      content: `❌ You are already in **${current.name}**. Please remove that role first.`,
      ephemeral: true
    });
  }

  const partyNumber = interaction.customId.split("_")[1];
  const roleId = PARTY_ROLE_IDS[partyNumber];

  if (!roleId) {
    return interaction.reply({ content: "Role not found.", ephemeral: true });
  }

  await member.roles.add(roleId);

  return interaction.reply({
    content: `✅ You joined **Party ${partyNumber}**.\nYour role will reset automatically at **midnight (00:00)**.`,
    ephemeral: true
  });
});

client.login(process.env.DISCORD_TOKEN);
