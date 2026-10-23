import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  type User,
} from 'discord.js';

import {
  PlayerListUnavailableError,
  type MinecraftPlayer,
  type MinecraftServerStatus,
  type StemCraftIntegration,
} from '../integrations/stemcraft.js';
import {
  getWorkshopStatusCode,
  type WebsiteIntegration,
  type WorkshopRecord,
} from '../integrations/website.js';
import {
  getXpForNextLevel,
  type UserLevelProfile,
  type UserLevelService,
} from '../services/user-levels.js';
import type { StemScrambleService } from '../services/scramble.js';
import type { UptimeKumaIntegration, UptimeKumaStatus } from '../integrations/uptime-kuma.js';
import type { CountingChainService } from '../services/counting-chain.js';

export interface CommandContext {
  getGatewayPing(): number;
  website?: WebsiteIntegration;
  stemcraft?: StemCraftIntegration;
  timeZone?: string;
  getCurrentTime?: () => Date;
  countingChain?: CountingChainService;
  requestCountingChainReview?: (channelId: string) => Promise<boolean>;
  userLevels?: UserLevelService;
  scramble?: StemScrambleService;
  uptime?: UptimeKumaIntegration;
}

export interface DiscordCommand {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<void>;
}

export const robotJokes = [
  'Why did the robot get a job? It wanted to make more cents.',
  'Why did the robot bring a ladder? It wanted to reach the cloud.',
  'Why was the robot tired? It was running on low battery.',
  'Why did the robot go on a date? It was looking for a connection.',
  'Why did the robot take a break? It needed a reboot.',
  'What is a robot’s favourite snack? Microchips.',
  'Why did the robot choose engineering? It had a lot of drive.',
  'Why did the robot call the elevator? It needed an uplink.',
  'Why does a robot avoid the beach? Too much sand in the gears.',
  'Why was the robot good at dancing? It had the best moves in the firmware.',
  'What music does a robot love? Heavy metal.',
  'Why did the robot become a singer? It was already good at Auto-Tune.',
  'Why did the robot go to school? It wanted to improve its algorithms.',
  'Why did the robot fail the test? It had too many bugs.',
  'How did the robot finish its homework? It compiled it.',
  'Why did the robot cross the road? There was an update on the other side.',
  'Why did the robot get promoted? It had outstanding performance.',
  'What does a robot fear most? A virus.',
  'Where does a robot hide? Behind a firewall.',
  'How does a robot keep a secret? It encrypts it.',
  'Why did the robot apologise? It had an error in judgment.',
  'Why did the robot not answer? Its data was still pending.',
  'How do robots make friends? They start with a handshake.',
  'Why did the robot get lost? It needed a better GPS.',
  'Why does a robot like gardening? It enjoys growing data.',
  'What is a robot’s favourite programming language? Java, because it likes a good brew.',
  'How does a robot meditate? It clears its cache.',
  'Why did the robot go to the gym? It wanted to work out its core.',
  'Why was the robot’s joke bad? It needed better processing.',
  'Why did the robot overeat? It had too many bytes.',
  'Why did the robot go camping? It wanted to unplug.',
  'Why did the robot visit the doctor? It needed a byte of advice.',
  'Why did the robot avoid the stairs? It could not find a compatible driver.',
  'Why was the robot popular at the party? It connected to the LAN.',
  'Why did the robot bring an umbrella? The cloud forecast looked stormy.',
  'Why does a robot dislike a broken pencil? The point was null.',
  'Why does a robot like chess? It is good at processing moves.',
  'Why did the robot win the race? It optimised its run loop.',
  'Why did the robot become a chef? It mastered byte-sized meals.',
  'Why did the robot pay the bill? It had a debit in its database.',
  'Why did the robot visit the museum? It admired the old hardware.',
  'Why did the robot wear glasses? It needed a better interface.',
  'Why did the robot use shampoo? It wanted to clear its cache.',
  'Why did the robot visit the beach? It wanted to surf the web.',
  'Why did the robot lose its job? Automation automated it.',
  'Why was the robot locked out? It forgot its passcode.',
  'Why did the robot send flowers? It wanted to improve its byte of affection.',
  'Why does a robot like spring? It is clean boot season.',
  'Why was the robot bad at hide-and-seek? It always left a trace.',
  'Why did the robot read a book? It wanted more bytes of wisdom.',
  'Why did the robot become a musician? It had perfect timing.',
  'Why did the robot join a band? It had good circuitry.',
  'How does a robot tell time? It uses clock cycles.',
  'Why did the robot go to space? It needed more bandwidth.',
  'Why did the robot buy shoes? It wanted a better boot sequence.',
  'Why did the robot sleep through its alarm? The alarm was in another process.',
  'Why does a robot like pizza? It loves circular logic.',
  'Why does a robot use a phone? It likes to stay in touch.',
  'Why did the robot get cold? It turned up its heat sink.',
  'Why did the robot become a gardener? It had green LEDs.',
  'How did the robot do its homework? It used a neural network.',
  'Why does a robot avoid arguments? It refuses to waste cycles.',
  'What is a robot’s favourite game? Cache me if you can.',
  'Why did the robot get excited? Its fans went wild.',
  'Why did the robot miss the bus? Its scheduler had a queue.',
  'Why did the robot play soccer? It was excellent at goal-oriented programming.',
  'Why did the robot go to the library? It needed quiet processing.',
  'Why did the robot visit the dentist? One of its gears had a cavity.',
  'Why did the robot buy a jacket? It wanted better byte protection.',
  'How did the robot cook dinner? It followed an algorithm.',
  'Why did the robot get a ticket? It exceeded the speed limit in a loop.',
  'Why does a robot like winter? It enjoys cool running.',
  'Why did the robot break up? The connection timed out.',
  'How does a robot stay calm? It has good exception handling.',
  'Why did the robot make toast? It had a breadboard.',
  'Why did the robot go to a concert? It wanted to feel the current.',
  'Why did the robot get detention? It ran in the hallway.',
  'Why did the robot use a pencil? It wanted to sketch its API.',
  'Why did the robot fail at karaoke? Nobody understood its machine code.',
  'Why did the robot carry a toolbox? It packed its dependencies.',
  'Why does a robot love maths? The numbers always make sense.',
  'Why did the robot join the orchestra? It had a solid byte section.',
  'Why did the robot get a haircut? It needed to trim its fringe buffer.',
  'Why does a robot use stairs? It takes one step at a time in its loop.',
  'Why did the robot become a detective? It followed the logs.',
  'Why did the robot get invited? It sent a packet.',
  'Why was the robot scared? It saw a null pointer.',
  'Why did the robot get a pet? It wanted a byte-sized bug.',
  'Why did the robot take a vacation? It needed to clear its cache.',
  'Why did the robot win the argument? It had the final byte.',
  'Why did the robot become a farmer? It cultivated its data.',
  'Why did the robot go to the bank? It needed to check its balance.',
  'Why did the robot wait at the airport? It was waiting for a gate connection.',
  'Why did the robot use a doorbell? It preferred push notifications.',
  'Why does a robot love astronomy? The data is out of this world.',
  'Why did the robot become an artist? It drew with vector graphics.',
  'Why does a robot not share its password? Security comes first.',
  'Why did the robot order food? It requested a byte.',
  'Why did the robot run a marathon? It optimised its battery usage.',
  'What is a robot’s favourite exercise? Circuit training.',
  'Why did the robot stay cool? It had a fan club.',
  'Why did the robot buy a computer? It wanted a new motherboard.',
  'Why did the robot open a bakery? It specialised in byte-sized pies.',
  'Why did the robot cross the river? It used a data bridge.',
  'Why did the robot wear a tie? It was using a formal protocol.',
  'Why did the robot tell jokes? It was running a comedy algorithm.',
  'Why did the robot become a teacher? It was excellent at explaining loops.',
  'Why do robots love programmers? Programmers understand their syntax.',
  'Why did the robot bring a map to class? It wanted to study its route table.',
  'Why did the robot get a medal? It had first-class hardware.',
  'Why did the robot join the choir? It knew how to harmonise with the network.',
  'Why did the robot go to the optician? Its vision API needed an update.',
  'Why did the robot enjoy puzzles? Every problem had a solution path.',
  'Why did the robot bring a ruler? It wanted to measure its response time.',
  'Why did the robot become a photographer? It had a great point of view.',
  'Why did the robot bring a notebook? It never forgot to log an idea.',
  'Why did the robot like the library computer? It had plenty of memory.',
  'Why did the robot join the debate team? It had a strong argument parser.',
  'Why did the robot take a train? It liked operating on a fixed schedule.',
  'Why did the robot become a plumber? It was good at fixing pipelines.',
  'Why did the robot like the ocean? It was full of useful currents.',
  'Why did the robot open an umbrella indoors? It was protecting its cloud data.',
  'Why did the robot enter the maze? It wanted to test its pathfinding.',
  'Why did the robot bring a spare battery? It planned for a power outage.',
  'Why did the robot enjoy fireworks? It appreciated a well-timed burst.',
  'Why did the robot sit near the window? It was waiting for a wireless signal.',
  'Why did the robot become a mechanic? It liked working on machine problems.',
  'Why did the robot bring a calculator? It wanted to count its blessings in binary.',
  'Why did the robot like sandwiches? They came with a good stack.',
  'Why did the robot become a librarian? It knew how to index everything.',
  'Why did the robot go to the playground? It wanted to test its swing algorithm.',
  'Why did the robot become a pilot? It was good at taking control.',
  'Why did the robot wear sunscreen? Its sensors were sensitive to bright ideas.',
  'Why did the robot visit the farm? It wanted to see the latest crop of data.',
  'Why did the robot bring a towel? It expected a data spill.',
  'Why did the robot enjoy puzzles? It was always ready to debug a mystery.',
  'Why did the robot carry a compass? It needed reliable direction from its API.',
  'Why did the robot join a relay race? It was great at passing messages.',
  'Why did the robot go to the theatre? It liked a good runtime performance.',
] as const;

export function getRandomRobotJoke(random: () => number = Math.random): string {
  const randomIndex = Math.floor(random() * robotJokes.length);
  const index = Math.max(0, Math.min(robotJokes.length - 1, randomIndex));
  return robotJokes[index] ?? robotJokes[0];
}

export function getPingResponse(gatewayPing: number): string {
  const latency =
    Number.isFinite(gatewayPing) && gatewayPing >= 0 ? `${gatewayPing}ms` : 'not available yet';
  return `Pong! Gateway latency: ${latency}`;
}

export const pingCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether STEMBot is connected to Discord.'),

  async execute(interaction, context): Promise<void> {
    await interaction.reply({ content: getPingResponse(context.getGatewayPing()) });
  },
};

export const workshopsCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('workshops')
    .setDescription('List upcoming STEMMechanics workshops.'),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const website = requireWebsite(context);
    const workshops = await website.getWorkshops();
    const content = formatWorkshopList(
      getUpcomingWorkshops(workshops, currentTime(context)),
      context.timeZone ?? 'Australia/Brisbane',
      'Upcoming STEMMechanics workshops',
    );
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  },
};

export const jokeCommand: DiscordCommand = {
  data: new SlashCommandBuilder().setName('joke').setDescription('Tell a robot-themed joke.'),

  async execute(interaction): Promise<void> {
    await interaction.reply({ content: getRandomRobotJoke() });
  },
};

export const levelCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription("Show your or another member's STEMBot level and XP.")
    .addUserOption((option) =>
      option.setName('user').setDescription('The member whose level to show.').setRequired(false),
    ),

  async execute(interaction, context): Promise<void> {
    const userLevels = context.userLevels;
    if (!userLevels) {
      await interaction.reply({
        content: 'The level system is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const profile = await userLevels.getProfile(targetUser.id);
    await interaction.editReply({
      embeds: [buildUserLevelEmbed(profile, targetUser)],
      allowedMentions: { parse: [] },
    });
  },
};

export const statusCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the current STEMMechanics service status.'),

  async execute(interaction, context): Promise<void> {
    const uptime = context.uptime;
    if (!uptime) {
      await interaction.reply({
        content: 'Uptime Kuma status is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const status = await uptime.getStatus();
    await interaction.editReply({
      embeds: [buildUptimeStatusEmbed(status)],
      allowedMentions: { parse: [] },
    });
  },
};

export const scrambleCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('scramble')
    .setDescription('Manage the STEM word scramble.')
    .addSubcommand((subcommand) =>
      subcommand.setName('reset').setDescription('Reset the current round and start a new one.'),
    ),

  async execute(interaction, context): Promise<void> {
    const scramble = context.scramble;
    if (!scramble) {
      await interaction.reply({
        content: 'The scramble game is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: 'You need Manage Messages permission to reset the scramble.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const previousWord = await scramble.resetRound();
    await interaction.editReply({
      content: previousWord
        ? `Scramble reset. The previous answer was **${previousWord}**.`
        : 'No active scramble was found; a new round has been started.',
    });
  },
};

export const leaderboardCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the STEMBot XP leaderboard.'),

  async execute(interaction, context): Promise<void> {
    const userLevels = context.userLevels;
    if (!userLevels) {
      await interaction.reply({
        content: 'The level system is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const leaderboard = await userLevels.getLeaderboard(10);
    await interaction.editReply({
      content: formatUserLeaderboard(leaderboard),
      allowedMentions: { parse: [] },
    });
  },
};

export const reviewCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Ask a moderator to review the last counting-chain post that ended the game.'),

  async execute(interaction, context): Promise<void> {
    const requestReview = context.requestCountingChainReview;
    if (!requestReview) {
      await interaction.reply({
        content: 'Counting-chain review is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const requested = await requestReview(interaction.channelId);
    await interaction.editReply({
      content: requested
        ? 'Review requested for the last counting-chain post. A moderator can react to the review request or original post with ✅ to approve it or ❌ to reset the chain.'
        : 'No game-ending counting-chain post is waiting for review.',
    });
  },
};

export const countingChainCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('counting-chain')
    .setDescription('Set the next number for the counting-chain game.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addIntegerOption((option) =>
      option
        .setName('number')
        .setDescription('The next number the game should accept.')
        .setMinValue(1)
        .setMaxValue(1_000_000)
        .setRequired(true),
    ),

  async execute(interaction, context): Promise<void> {
    const countingChain = context.countingChain;
    if (!countingChain) {
      await interaction.reply({
        content: 'The counting-chain game is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const hasModeratorPermission =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
    if (!hasModeratorPermission) {
      await interaction.reply({
        content: 'You need Manage Messages permission to update the counting chain.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const nextNumber = interaction.options.getInteger('number', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const updated = await countingChain.setNextNumber(
      interaction.channelId,
      nextNumber,
      interaction.user.id,
    );
    await interaction.editReply({
      content: updated
        ? `Counting chain updated. The next accepted number is **${nextNumber}**.`
        : 'Use this command in the configured counting-chain channel.',
    });
  },
};

export const minecraftCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('minecraft')
    .setDescription('Show the STEMCraft server status and player count.'),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const stemcraft = requireStemCraft(context);
    const status = await stemcraft.getServerStatus();
    await interaction.editReply({
      content: formatMinecraftStatus(status),
      allowedMentions: { parse: [] },
    });
  },
};

/** This command intentionally has no role or permission gate. It returns usernames only. */
export const playersCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('players')
    .setDescription('List online STEMCraft usernames.'),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const stemcraft = requireStemCraft(context);

    try {
      const players = await stemcraft.getOnlinePlayers();
      await interaction.editReply({
        content: formatPlayers(players),
        allowedMentions: { parse: [] },
      });
    } catch (error: unknown) {
      if (error instanceof PlayerListUnavailableError) {
        await interaction.editReply({
          content: 'Online Minecraft usernames are not available from STEMCraft right now.',
          allowedMentions: { parse: [] },
        });
        return;
      }

      throw error;
    }
  },
};

export const commands: readonly DiscordCommand[] = [
  pingCommand,
  workshopsCommand,
  jokeCommand,
  levelCommand,
  statusCommand,
  scrambleCommand,
  leaderboardCommand,
  reviewCommand,
  countingChainCommand,
  minecraftCommand,
  playersCommand,
];

export function getCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return commands.map((command) => command.data.toJSON());
}

export function getUpcomingWorkshops(
  workshops: readonly WorkshopRecord[],
  now: Date,
): WorkshopRecord[] {
  return workshops
    .filter(
      (workshop) =>
        workshop.startsAt.getTime() > now.getTime() &&
        !['cancelled', 'private', 'hidden'].includes(getWorkshopStatusCode(workshop)),
    )
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
}

export function formatWorkshopList(
  workshops: readonly WorkshopRecord[],
  timeZone: string,
  heading: string,
): string {
  if (workshops.length === 0) {
    return `${heading}\nNo upcoming workshops found.`;
  }

  const lines = workshops.slice(0, 10).map((workshop) => {
    const status = formatStatus(workshop);
    const location = workshop.location ? ` · ${workshop.location}` : '';
    const details = `[Details](${workshop.url})`;
    const metadata = [status, location.slice(3), details].filter(Boolean).join(' · ');

    return `• **${workshop.title}** — ${formatDateRange(workshop, timeZone)}${metadata ? ` · ${metadata}` : ''}`;
  });

  const suffix =
    workshops.length > lines.length ? '\nMore workshops are available on the website.' : '';
  return truncateDiscordMessage(`${heading}\n${lines.join('\n')}${suffix}`);
}

export function formatMinecraftStatus(status: MinecraftServerStatus): string {
  const state = status.maintenance ? 'under maintenance' : status.online ? 'online' : 'offline';
  const capacity =
    status.maxPlayers === undefined
      ? `${status.playerCount} players online`
      : `${status.playerCount}/${status.maxPlayers} players online`;
  const version = status.version ? ` · version ${status.version}` : '';
  const message = status.message ? `\n${status.message}` : '';

  return `STEMCraft is **${state}** — ${capacity}${version}.${message}`;
}

export function formatPlayers(players: readonly MinecraftPlayer[]): string {
  if (players.length === 0) {
    return 'No Minecraft players are currently online.';
  }

  return `Online Minecraft players:\n${players.map((player) => `• ${player.username}`).join('\n')}`;
}

export function formatUserLevel(profile: UserLevelProfile): string {
  const nextLevelXp = getXpForNextLevel(profile.level);
  const remainingXp = Math.max(0, nextLevelXp - profile.xp);
  return [
    `**Level ${profile.level}** — ${profile.xp} XP`,
    `${remainingXp} XP to level ${profile.level + 1}.`,
    `Messages: ${profile.messageCount} · Reactions: ${profile.reactionCount} · Games: ${profile.gameCount}`,
  ].join('\n');
}

export function buildUserLevelEmbed(profile: UserLevelProfile, user: User): APIEmbed {
  const progress = getUserLevelProgress(profile);
  const displayName = user.globalName ?? user.username;
  const avatarUrl = user.displayAvatarURL({ extension: 'png', size: 128 });

  return {
    color: 0x5865f2,
    author: {
      name: `${displayName}'s STEMBot level`,
      icon_url: avatarUrl,
    },
    thumbnail: { url: avatarUrl },
    description: [
      `## Level ${profile.level}`,
      `${formatProgressBar(progress.percent)} **${profile.xp} XP**`,
      `**${progress.currentXp} / ${progress.requiredXp} XP** to level ${profile.level + 1}`,
    ].join('\n'),
    fields: [
      {
        name: 'Activity',
        value: [
          `Messages: **${profile.messageCount}**`,
          `Reactions: **${profile.reactionCount}**`,
          `Games: **${profile.gameCount}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Next level',
        value: `${progress.percent}% complete`,
        inline: true,
      },
    ],
    footer: { text: 'STEMBot levels' },
  };
}

export function buildUptimeStatusEmbed(status: UptimeKumaStatus): APIEmbed {
  const isOperational = status.overall === 'up';
  const dot = isOperational ? '🟢' : '🔴';
  const serviceLines = status.monitors.map((monitor) => {
    const monitorDot = monitor.state === 'up' ? '🟢' : '🔴';
    const message = monitor.message ? ` · ${escapeEmbedText(monitor.message)}` : '';
    return `${monitorDot} **${escapeEmbedText(monitor.name)}** — ${formatMonitorState(monitor.state)}${message}`;
  });

  if (serviceLines.length === 0 && !status.sourceError) {
    serviceLines.push('🔴 No public monitors are configured.');
  }

  const description = status.sourceError
    ? `**Monitoring unavailable.** ${status.sourceError}`
    : isOperational
      ? 'All monitored services are online.'
      : 'One or more monitored services require attention.';

  return {
    title: `${dot} ${status.title}`,
    url: status.statusPageUrl,
    color: isOperational ? 0x2ecc71 : 0xe74c3c,
    description,
    fields: [
      {
        name: 'Services',
        value: truncateEmbedField(serviceLines.join('\n') || 'No status data available.'),
      },
      ...(status.incident
        ? [
            {
              name: 'Incident',
              value: truncateEmbedField(
                [
                  `**${escapeEmbedText(status.incident.title)}**`,
                  status.incident.content ? escapeEmbedText(status.incident.content) : undefined,
                ]
                  .filter(Boolean)
                  .join('\n'),
              ),
            },
          ]
        : []),
    ],
    timestamp: status.checkedAt.toISOString(),
    footer: { text: 'Last checked' },
  };
}

export function getUserLevelProgress(profile: UserLevelProfile): {
  currentXp: number;
  requiredXp: number;
  percent: number;
} {
  const previousLevelXp = profile.level <= 1 ? 0 : getXpForNextLevel(profile.level - 1);
  const nextLevelXp = getXpForNextLevel(profile.level);
  const requiredXp = Math.max(1, nextLevelXp - previousLevelXp);
  const currentXp = Math.max(0, profile.xp - previousLevelXp);
  const percent = Math.min(100, Math.floor((currentXp / requiredXp) * 100));
  return { currentXp, requiredXp, percent };
}

export function formatUserLeaderboard(profiles: readonly UserLevelProfile[]): string {
  if (profiles.length === 0) {
    return 'No XP has been recorded yet.';
  }

  return [
    '🏆 **STEMBot leaderboard**',
    ...profiles.map(
      (profile, index) =>
        `${index + 1}. <@${profile.userId}> — Level ${profile.level} (${profile.xp} XP)`,
    ),
  ].join('\n');
}

function formatDateRange(workshop: WorkshopRecord, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const start = formatter.format(workshop.startsAt);
  if (!workshop.endsAt) {
    return start;
  }

  return `${start}–${new Intl.DateTimeFormat('en-AU', {
    timeStyle: 'short',
    timeZone,
  }).format(workshop.endsAt)}`;
}

function formatStatus(workshop: WorkshopRecord): string {
  const labels: Partial<Record<WorkshopRecord['status'], string>> = {
    scheduled: 'Opens Soon',
    open: 'Open',
    full: 'Full',
    closed: 'Closed',
    cancelled: 'Cancelled',
    private: 'Private',
    hidden: 'Hidden',
  };
  return labels[getWorkshopStatusCode(workshop)] ?? '';
}

function truncateDiscordMessage(content: string): string {
  const maximumLength = 1900;
  return content.length <= maximumLength
    ? content
    : `${content.slice(0, maximumLength - 28).trimEnd()}\n…message truncated`;
}

function currentTime(context: CommandContext): Date {
  return context.getCurrentTime?.() ?? new Date();
}

function requireWebsite(context: CommandContext): WebsiteIntegration {
  if (!context.website) {
    throw new Error('The Website integration is not available');
  }

  return context.website;
}

function requireStemCraft(context: CommandContext): StemCraftIntegration {
  if (!context.stemcraft) {
    throw new Error('The STEMCraft integration is not available');
  }

  return context.stemcraft;
}

function formatProgressBar(percent: number): string {
  const segments = 10;
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * segments);
  return `${'█'.repeat(filled)}${'░'.repeat(segments - filled)}`;
}

function formatMonitorState(state: UptimeKumaStatus['monitors'][number]['state']): string {
  return (
    {
      up: 'Online',
      down: 'Offline',
      pending: 'Pending',
      maintenance: 'Maintenance',
    }[state] ?? 'Unknown'
  );
}

function escapeEmbedText(value: string): string {
  return value.replace(/[\\`*_~|]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function truncateEmbedField(value: string): string {
  const maximumLength = 1024;
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 20).trimEnd()}\n…more services`;
}
