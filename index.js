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
const PORT = Number(process.env.PORT) || 3000;
web.listen(PORT, "0.0.0.0", () => console.log(`Web server running on 0.0.0.0:${PORT}`));

// ================= CONFIG =================
const PARTY_LIMIT = 6;
const TIMEZONE = "Europe/Berlin";
const REFRESH_INTERVAL_MS = 60_000; // safe backup refresh
const MARKER = "[KARMA_PARTY_SELECTOR]"; // hidden marker to find the correct message

// ================= DISCORD CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Server Members Intent ON
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ================= ENV =================
const GUILD_ID = process.env.GUILD_ID;
const SELECTION_CHANNEL_ID = process.env.SELECTION_CHANNEL_ID;
if (!GUILD_ID) throw new Error("Missing env var GUILD_ID");
if (!SELECTION_CHANNEL_ID) throw new Error("Missing env var SELECTION_CHANNEL_ID");

// Party roles PARTY_ROLE_1 ... PARTY_ROLE_12
const PARTY_ROLE_IDS = {};
for (let i = 1; i <= 12; i++) {
  const v = process.env[`PARTY_ROLE_${i}`];
  if (!v) throw new Error(`Missing env var PARTY_ROLE_${i}`);
  PARTY_ROLE_IDS[i] = v;
}
const ALL_PARTY_ROLE_IDS = new Set(Object.values(PARTY_ROLE_IDS));

// ================= STATE =================
let selectionMessageId = null;
let updating = false;
let pendingUpdate = false;

// ================= UI =================
function buildPartyButtons() {
  const makeBtn = (i) =>
    new ButtonBuilder()
      .setCustomId(`party_${i}`)
      .setLabel(`Party ${i}`)
      .setStyle(ButtonStyle.Primary);

  const row1 = new ActionRowBuilder().addComponents(makeBtn(1), makeBtn(2), makeBtn(3), makeBtn(4), makeBtn(5));
  const row2 = new ActionRowBuilder().addComponents(makeBtn(6), makeBtn(7), makeBtn(8), makeBtn(9), makeBtn(10));
  const row3 = new ActionRowBuilder().addComponents(makeBtn(11), makeBtn(12));

  return [row1, row2, row3];
}

function selectionContent() {
  // marker is on purpose at the end so we can find it reliably
  return (
    `# Select your Party for Today\n\n` +
    `**Rules:**\n` +
    `• You can only be in **one Party at a time**.\n` +
    `• If you already have a Party role and chose the wrong one, you need to ask a **Leader** to remove it.\n` +
    `• Each Party is limited to **${PARTY_LIMIT}/${PARTY_LIMIT}** players.\n\n` +
    `**All Party roles reset automatically at midnight (00:00).**\n\n` +
    `${MARKER}`
  );
}

function getCurrentPartyRole(member) {
  return member.roles.cache.find((r) => ALL_PARTY_ROLE_IDS.has(r.id)) ?? null;
}

// ================= STATUS EMBED (CLEAN) =================
async function buildStatusEmbed(guild) {
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

// ================= FIND / CREATE / CLEANUP (NO MORE DOUBLE POSTS) =================
async function getSelectionChannel(guild) {
  const channel = await guild.channels.fetch(SELECTION_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("Selection channel not found or not text-based.");
  return channel;
}

async function cleanupAndPickSingleMessage(channel) {
  // fetch more history so we reliably find older messages
  const fetched = await channel.messages.fetch({ limit: 100 });

  const botMessages = [...fetched.values()].filter(
    (m) => m.author?.id === client.user.id && typeof m.content === "string" && m.content.includes(MARKER)
  );

  if (botMessages.length === 0) return null;

  // newest first
  botMessages.sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  // keep newest
  const keep = botMessages[0];

  // delete the rest (if permission missing, it will fail but that's ok)
  for (let i = 1; i < botMessages.length; i++) {
    try {
      await botMessages[i].delete();
    } catch {
      // ignore (no Manage Messages permission etc.)
    }
  }

  selectionMessageId = keep.id;
  return keep;
}

async function findOrCreateSelectionMessage(guild) {
  const channel = await getSelectionChannel(guild);

  // 1) cleanup duplicates and pick one
  const keep = await cleanupAndPickSingleMessage(channel);
  if (keep) return keep;

  // 2) if no message exists, create one
  const msg = await channel.send({
    content: selectionContent(),
    components: buildPartyButtons(),
  });

  selectionMessageId = msg.id;
  return msg;
}

// ================= UPDATE MESSAGE (QUEUE SAFE) =================
async function updateSelectionMessage(guild) {
  if (updating) {
    pendingUpdate = true;
    return;
  }
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
    if (pendingUpdate) {
      pendingUpdate = false;
      setTimeout(() => updateSelectionMessage(guild).catch(console.error), 800);
    }
  }
}

// ================= RESET =================
async function resetAllPartyRoles(guild) {
  // once per day fetch -> safe
  const members = await guild.members.fetch();

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

  // warm cache once (not forced)
  try {
    await guild.members.fetch();
  } catch {}

  // initial post/update (also cleanup duplicates)
  await updateSelectionMessage(guild);

  // backup refresh (safe)
  setInterval(() => updateSelectionMessage(guild).catch(console.error), REFRESH_INTERVAL_MS);

  // midnight reset
  cron.schedule(
    "0 0 * * *",
    async () => {
      const g = await client.guilds.fetch(GUILD_ID);
      await resetAllPartyRoles(g);
      await updateSelectionMessage(g);
    },
    { timezone: TIMEZONE }
  );

  console.log(`Scheduler started: reset at 00:00 (${TIMEZONE})`);
});

// Auto repost if selection message deleted (single source of truth)
client.on("messageDelete", async (message) => {
  try {
    if (message.channelId !== SELECTION_CHANNEL_ID) return;

    if (
      (selectionMessageId && message.id === selectionMessageId) ||
      (message.author?.id === client.user.id && message.content?.includes(MARKER))
    ) {
      selectionMessageId = null;
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
      (m) => m.channelId === SELECTION_CHANNEL_ID && m.author?.id === client.user.id && m.content?.includes(MARKER)
    );
    if (!affected) return;

    selectionMessageId = null;
    const guild = await client.guilds.fetch(GUILD_ID);
    await updateSelectionMessage(guild);
    console.log("Bulk delete detected → reposted/updated.");
  } catch (e) {
    console.error("Auto-repost bulk failed:", e);
  }
});

// ================= BUTTON HANDLER (NO INTERACTION FAILED) =================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("party_")) return;

    // prevents "Diese Interaktion ist fehlgeschlagen."
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const member = await guild.members.fetch(interaction.user.id);

    // already in a party?
    const current = getCurrentPartyRole(member);
    if (current) {
      return interaction.editReply({
        content:
          `❌ You are already in **${current.name}**.\n` +
          `If you chose the wrong Party, please ask a **Leader** to remove your current Party role.`,
      });
    }

    const partyNumber = Number(interaction.customId.split("_")[1]);
    const roleId = PARTY_ROLE_IDS[partyNumber];

    const role = await guild.roles.fetch(roleId);
    const currentCount = role?.members ? role.members.size : 0;

    // limit reached?
    if (currentCount >= PARTY_LIMIT) {
      return interaction.editReply({
        content: `⛔ **Party ${partyNumber} is full (${PARTY_LIMIT}/${PARTY_LIMIT}).** Please choose another Party.`,
      });
    }

    // add role
    await member.roles.add(roleId, "Party selected via button");

    // reply
    await interaction.editReply({
      content:
        `✅ You joined **Party ${partyNumber}** (**${Math.min(currentCount + 1, PARTY_LIMIT)}/${PARTY_LIMIT}**).\n` +
        `Your role will reset automatically at **midnight (00:00)**.\n` +
        `If you chose the wrong Party, ask a **Leader** to remove your role.`,
    });

    // live update (small delay so role cache updates)
    setTimeout(() => updateSelectionMessage(guild).catch(console.error), 1200);
  } catch (e) {
    console.error("interactionCreate failed:", e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "❌ Something went wrong. Please try again." });
      }
    } catch {}
  }
});

// ================= ERROR HANDLING =================
client.on("error", (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

client.login(process.env.DISCORD_TOKEN);
