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
web.get("/", (req, res) => res.send("Karma Party Bot is running."));

const PORT = Number(process.env.PORT);
if (!PORT) console.log("Render PORT variable missing!");
else web.listen(PORT, "0.0.0.0", () => console.log(`Web server running on 0.0.0.0:${PORT}`));

// ================= CONFIG =================
const PARTY_LIMIT = 6;
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

// Remember the selection message id (best effort)
let selectionMessageId = null;

// Prevent overlapping edits (rate-limit safe)
let updating = false;

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
  const row3 = new ActionRowBuilder().addComponents(makeBtn(11), makeBtn(12));

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

function getCurrentPartyRole(member) {
  return member.roles.cache.find((r) => ALL_PARTY_ROLE_IDS.has(r.id)) ?? null;
}

// ================= STATUS EMBED (CLEAN + NO DUPLICATES) =================
async function buildStatusEmbed(guild) {
  // force a fresh member cache -> accurate role.members
  await guild.members.fetch({ force: true });

  const embed = new EmbedBuilder()
    .setTitle("Party Status")
    .setDescription(`Max **${PARTY_LIMIT}** players per Party.`)
    .setTimestamp(new Date());

  const lines1 = [];
  const lines2 = [];

  for (let i = 1; i <= 12; i++) {
    const roleId = PARTY_ROLE_IDS[i];
    const role = await guild.roles.fetch(roleId);

    const members = role?.members ? [...role.members.values()] : [];
    const count = members.length;

    // Unique names, sorted, show max PARTY_LIMIT names
    const uniqueNames = [...new Set(members.map((m) => m.displayName))]
      .sort((a, b) => a.localeCompare(b));

    const shown = uniqueNames.slice(0, PARTY_LIMIT);
    const nameText = shown.length ? shown.join(", ") : "Empty";

    const fullTag = count >= PARTY_LIMIT ? " ✅ FULL" : "";
    const line = `**Party ${i} — ${count}/${PARTY_LIMIT}${fullTag}**\n${nameText}`;

    if (i <= 6) lines1.push(line);
    else lines2.push(line);
  }

  embed.addFields(
    { name: "Parties 1–6", value: lines1.join("\n\n") || "—", inline: false },
    { name: "Parties 7–12", value: lines2.join("\n\n") || "—", inline: false }
  );

  return embed;
}

// ================= MESSAGE MANAGEMENT =================
async function findOrCreateSelectionMessage(guild) {
  const channel = await guild.channels.fetch(SELECTION_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("Selection channel not found.");

  const messages = await channel.messages.fetch({ limit: 25 });
  const existing = messages.find(
    (m) => m.author?.id === client.user.id && m.content?.includes("Select your Party for Today")
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
  if (updating) return;
  updating = true;

  try {
    const msg = await findOrCreateSelectionMessage(guild);
    const embed = await buildStatusEmbed(guild);

    await msg.edit({
      content: selectionContent(),
      components: buildPartyButtons(),
      embeds: [embed],
    });
  } catch (e) {
    console.error("Update failed:", e);
  } finally {
    updating = false;
  }
}

// ================= RESET =================
async function resetAllPartyRoles(guild) {
  const members = await guild.members.fetch({ force: true });

  for (const [, member] of members) {
    const rolesToRemove = member.roles.cache.filter((r) => ALL_PARTY_ROLE_IDS.has(r.id));
    if (rolesToRemove.size > 0) {
      await member.roles.remove(rolesToRemove.map((r) => r.id), "Daily midnight reset");
    }
  }

  console.log("Midnight reset completed.");
}

// ================= EVENTS =================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);

  // Initial post/update
  await updateSelectionMessage(guild);

  // Backup refresh every 30 seconds (always correct even if events fail)
  setInterval(() => updateSelectionMessage(guild).catch(console.error), 30_000);

  // Midnight reset
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

    if ((selectionMessageId && message.id === selectionMessageId) || message.author?.id === client.user.id) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await updateSelectionMessage(guild);
      console.log("Selection message deleted → reposted/updated.");
    }
  } catch (e) {
    console.error("Auto-repost failed:", e);
  }
});

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

// ================= BUTTON HANDLER (LIVE UPDATE) =================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("party_")) return;

  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);

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

  // Accurate count before adding
  await guild.members.fetch({ force: true });
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

  // LIVE UPDATE immediately after join
  await updateSelectionMessage(guild);
});

// ================= ERROR HANDLING (NO CRASH) =================
client.on("error", (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

client.login(process.env.DISCORD_TOKEN);
