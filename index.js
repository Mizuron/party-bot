require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");
const cron = require("node-cron");
const express = require("express");

// ================= MINI WEB SERVER (FOR RENDER WEB SERVICE) =================
const web = express();

web.get("/", (req, res) => {
  res.send("Karma Party Bot is running.");
});

const PORT = Number(process.env.PORT);
if (!PORT) {
  console.log("Render PORT variable missing!");
} else {
  web.listen(PORT, "0.0.0.0", () => {
    console.log(`Web server running on 0.0.0.0:${PORT}`);
  });
}

// ================= CONFIG =================
const PARTY_LIMIT = 6; // 6/6 max per party
const TIMEZONE = "Europe/Berlin";

// ================= DISCORD CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const GUILD_ID = process.env.GUILD_ID;
const SELECTION_CHANNEL_ID = process.env.SELECTION_CHANNEL_ID;

// Party roles from env vars: PARTY_ROLE_1 ... PARTY_ROLE_12
const PARTY_ROLE_IDS = {};
for (let i = 1; i <= 12; i++) {
  const value = process.env[`PARTY_ROLE_${i}`];
  if (!value) throw new Error(`Missing PARTY_ROLE_${i}`);
  PARTY_ROLE_IDS[i] = value;
}
const ALL_PARTY_ROLE_IDS = new Set(Object.values(PARTY_ROLE_IDS));

// We'll remember the selection message id (in memory)
let selectionMessageId = null;

// Small debounce so we don't spam edits
let updateTimer = null;
function scheduleStatusUpdate(guild) {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => updateSelectionMessage(guild).catch(console.error), 1200);
}

// ================= UI BUILDERS =================
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

function selectionContent() {
  return (
    `# Select your Party for Today\n\n` +
    `**Rules:**\n` +
    `• You can only be in **one Party at a time**.\n` +
    `• If you already have a Party role and chose the wrong one, you need to ask a **Leader** to remove it.\n` +
    `• Each Party is limited to **${PARTY_LIMIT}/${PARTY_LIMIT}** players.\n\n` +
    `**All Party roles reset automatically at midnight (00:00).**`
  );
}

function truncateList(arr, max = 10) {
  if (arr.length <= max) return arr;
  const shown = arr.slice(0, max);
  return [...shown, `…and ${arr.length - max} more`];
}

async function buildStatusEmbeds(guild) {
  // Ensure member cache is ready so role.members works
  await guild.members.fetch();

  const embed1 = new EmbedBuilder()
    .setTitle("Party Status")
    .setDescription(`Max **${PARTY_LIMIT}** players per Party.`)
    .setTimestamp(new Date());

  const embed2 = new EmbedBuilder()
    .setTitle("Party Status (continued)")
    .setTimestamp(new Date());

  for (let i = 1; i <= 12; i++) {
    const roleId = PARTY_ROLE_IDS[i];
    const role = await guild.roles.fetch(roleId);

    const members = role?.members ? [...role.members.values()] : [];
    const count = members.length;

    const names = members
      .map((m) => m.displayName)
      .sort((a, b) => a.localeCompare(b));

    const list = truncateList(names, 10);
    const value =
      list.length === 0
        ? "_Empty_"
        : list.map((n) => `• ${n}`).join("\n");

    const field = {
      name: `Party ${i} — ${count}/${PARTY_LIMIT}`,
      value: value.length > 1024 ? value.slice(0, 1000) + "\n…" : value,
      inline: true,
    };

    if (i <= 6) embed1.addFields(field);
    else embed2.addFields(field);
  }

  return [embed1, embed2];
}

// ================= MESSAGE MANAGEMENT =================
async function findOrCreateSelectionMessage(guild) {
  const channel = await guild.channels.fetch(SELECTION_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("Selection channel not found or not text-based.");

  const messages = await channel.messages.fetch({ limit: 25 });
  const existing = messages.find(
    (m) =>
      m.author?.id === client.user.id &&
      m.content?.includes("Select your Party for Today")
  );

  if (existing) {
    selectionMessageId = existing.id;
    return existing;
  }

  const msg = await channel.send({
    content: selectionContent(),
    components: buildPartyButtons(),
  });
  selectionMessageId = msg.id;
  return msg;
}

async function updateSelectionMessage(guild) {
  const msg = await findOrCreateSelectionMessage(guild);
  const embeds = await buildStatusEmbeds(guild);

  await msg.edit({
    content: selectionContent(),
    components: buildPartyButtons(),
    embeds,
  });
}

// ================= RESET =================
async function resetAllPartyRoles(guild) {
  const members = await guild.members.fetch();

  for (const [, member] of members) {
    const rolesToRemove = member.roles.cache.filter((r) => ALL_PARTY_ROLE_IDS.has(r.id));
    if (rolesToRemove.size > 0) {
      await member.roles.remove(rolesToRemove.map((r) => r.id), "Daily midnight reset");
    }
  }
  console.log("Midnight reset completed.");
}

// ================= HELPERS =================
function getCurrentPartyRole(member) {
  return member.roles.cache.find((r) => ALL_PARTY_ROLE_IDS.has(r.id)) ?? null;
}

// ================= EVENTS =================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  await updateSelectionMessage(guild);

  cron.schedule(
    "0 0 * * *",
    async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      await resetAllPartyRoles(g);
      await updateSelectionMessage(g);
    },
    { timezone: TIMEZONE }
  );

  console.log(`Midnight reset scheduler started (${TIMEZONE}).`);
});

// Auto repost if deleted
client.on("messageDelete", async (message) => {
  try {
    if (message.channelId !== SELECTION_CHANNEL_ID) return;

    if (
      (selectionMessageId && message.id === selectionMessageId) ||
      message.author?.id === client.user.id
    ) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await updateSelectionMessage(guild);
      console.log("Selection message deleted → reposted/updated.");
    }
  } catch (e) {
    console.error("Auto-repost failed:", e);
  }
});

// Bulk delete handling
client.on("messageDeleteBulk", async (messages) => {
  try {
    const affected = [...messages.values()].some(
      (m) =>
        m.channelId === SELECTION_CHANNEL_ID &&
        (m.id === selectionMessageId || m.author?.id === client.user.id)
    );
    if (!affected) return;

    const guild = await client.guilds.fetch(GUILD_ID);
    await updateSelectionMessage(guild);
    console.log("Bulk delete detected → reposted/updated.");
  } catch (e) {
    console.error("Auto-repost bulk failed:", e);
  }
});

// Update list when roles change (Leader removes a role)
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    const oldRole = oldMember.roles.cache.find((r) => ALL_PARTY_ROLE_IDS.has(r.id))?.id;
    const newRole = newMember.roles.cache.find((r) => ALL_PARTY_ROLE_IDS.has(r.id))?.id;
    if (oldRole !== newRole) scheduleStatusUpdate(newMember.guild);
  } catch {
    // ignore
  }
});

// Button handler with 6/6 limit
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("party_")) return;

  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);

  // Already in a party?
  const current = getCurrentPartyRole(member);
  if (current) {
    return interaction.reply({
      content:
        `❌ You are already in **${current.name}**.\n` +
        `If you chose the wrong Party, please ask a **Leader** to remove your current Party role.`,
      ephemeral: true,
    });
  }

  const partyNumber = Number(interaction.customId.split("_")[1]);
  const roleId = PARTY_ROLE_IDS[partyNumber];

  // Make sure count is accurate
  await guild.members.fetch();
  const role = await guild.roles.fetch(roleId);
  const currentCount = role?.members ? role.members.size : 0;

  if (currentCount >= PARTY_LIMIT) {
    return interaction.reply({
      content: `⛔ **Party ${partyNumber} is full (${PARTY_LIMIT}/${PARTY_LIMIT}).** Please choose another Party.`,
      ephemeral: true,
    });
  }

  await member.roles.add(roleId, "Party selected via button");

  await interaction.reply({
    content:
      `✅ You joined **Party ${partyNumber}** (**${currentCount + 1}/${PARTY_LIMIT}**).\n` +
      `Your role will reset automatically at **midnight (00:00)**.\n` +
      `If you chose the wrong Party, ask a **Leader** to remove your role.`,
    ephemeral: true,
  });

  scheduleStatusUpdate(guild);
});

client.login(process.env.DISCORD_TOKEN);
