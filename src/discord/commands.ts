import {
  AttachmentBuilder,
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
import sharp from 'sharp';

import {
  PlayerListUnavailableError,
  type MinecraftPlayer,
  type MinecraftServerStatus,
  type StemCraftIntegration,
} from '../integrations/stemcraft.js';
import {
  InvalidMinecraftUsernameError,
  MinecraftProfileLookupError,
  InvalidMinecraftUuidError,
  type MinecraftProfile,
  type MinecraftProfileLookup,
  normalizeMinecraftUuid,
} from '../integrations/minecraft-profile.js';
import {
  MinecraftPlayerProfileLookupError,
  type MinecraftPlayerProfileLookup,
  type MinecraftPlayerStats,
} from '../integrations/minecraft-player-profile.js';
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
import { parseReminderDuration, type AdminReminderService } from '../services/admin-reminders.js';
import type { StemCodeFixService } from '../services/code-fix.js';
import type { NumberGameService } from '../services/number-game.js';
import type { StemWordRevealService } from '../services/word-reveal.js';
import type { TicTacToeService } from '../services/tic-tac-toe.js';
import type { ConnectFourService } from '../services/connect-four.js';
import type {
  IgnoredMinecraftPlayer,
  PlayerNotificationService,
} from '../services/player-notifications.js';
import type { AppLogger } from '../logging/logger.js';

export interface CommandContext {
  getGatewayPing(): number;
  logger?: AppLogger;
  website?: WebsiteIntegration;
  stemcraft?: StemCraftIntegration;
  timeZone?: string;
  getCurrentTime?: () => Date;
  countingChain?: CountingChainService;
  requestCountingChainReview?: (channelId: string) => Promise<boolean>;
  userLevels?: UserLevelService;
  scramble?: StemScrambleService;
  uptime?: UptimeKumaIntegration;
  reminders?: AdminReminderService;
  wordReveal?: StemWordRevealService;
  codeFix?: StemCodeFixService;
  numberGame?: NumberGameService;
  ticTacToe?: TicTacToeService;
  connectFour?: ConnectFourService;
  minecraftProfiles?: MinecraftProfileLookup;
  minecraftPlayerProfiles?: MinecraftPlayerProfileLookup;
  playerNotifications?: PlayerNotificationService;
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

export const numberCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('number')
    .setDescription('Guess the number STEMBot is thinking of.'),

  async execute(interaction, context): Promise<void> {
    const numberGame = context.numberGame;
    if (!numberGame) {
      await interaction.reply({
        content: 'The number game is not available.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const challenge = await numberGame.startChallenge(interaction.user.id, interaction.channelId);
    const prompt = await interaction.reply({
      content: challenge.content,
      fetchReply: true,
      allowedMentions: { parse: [] },
    });
    await numberGame.activateChallenge(challenge.challengeId, prompt.id);
  },
};

export const levelCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription("Show your or another member's STEMBot level, rank, and XP.")
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
    const rank = await userLevels.getRank(targetUser.id);
    const card = await buildUserLevelCard(profile, targetUser, rank);
    await interaction.editReply({
      files: [new AttachmentBuilder(card, { name: 'stembot-level-card.png' })],
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

export const mysteryLabCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('mystery-lab')
    .setDescription('Manage the Mystery Lab game.')
    .addSubcommand((subcommand) =>
      subcommand.setName('reset').setDescription('Reset the current round and start a new one.'),
    ),

  async execute(interaction, context): Promise<void> {
    const wordReveal = context.wordReveal;
    if (!wordReveal) {
      await interaction.reply({
        content: 'The Mystery Lab game is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: 'You need Manage Messages permission to reset Mystery Lab.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const previousWord = await wordReveal.resetRound();
    await interaction.editReply({
      content: previousWord
        ? `Mystery Lab reset. The previous answer was **${previousWord}**.`
        : 'No active Mystery Lab round was found; a new one has been started.',
    });
  },
};

export const codeFixCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('code-fix')
    .setDescription('Manage the STEM Code Fix game.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reset')
        .setDescription('Reset the current challenge and start a new one.'),
    ),

  async execute(interaction, context): Promise<void> {
    const codeFix = context.codeFix;
    if (!codeFix) {
      await interaction.reply({
        content: 'The Code Fix game is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: 'You need Manage Messages permission to reset Code Fix.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const previousTitle = await codeFix.resetChallenge();
    await interaction.editReply({
      content: previousTitle
        ? `Code Fix reset. The previous challenge was **${previousTitle}**.`
        : 'No active Code Fix challenge was found; a new one has been started.',
    });
  },
};

export const ticTacToeCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('tictactoe')
    .setDescription('Manage the Tic Tac Toe game.')
    .addSubcommand((subcommand) =>
      subcommand.setName('reset').setDescription('Reset the current round and start a new one.'),
    ),

  async execute(interaction, context): Promise<void> {
    const ticTacToe = context.ticTacToe;
    if (!ticTacToe) {
      await interaction.reply({
        content: 'The Tic Tac Toe game is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: 'You need Manage Messages permission to reset Tic Tac Toe.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const resetActiveRound = await ticTacToe.resetRound();
    await interaction.editReply({
      content: resetActiveRound
        ? 'Tic Tac Toe reset. A fresh round has been started.'
        : 'No active Tic Tac Toe round was found; a new one has been started.',
    });
  },
};

export const connectFourCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('connect4')
    .setDescription('Manage the Connect 4 game.')
    .addSubcommand((subcommand) =>
      subcommand.setName('reset').setDescription('Reset the current round and start a new one.'),
    ),

  async execute(interaction, context): Promise<void> {
    const connectFour = context.connectFour;
    if (!connectFour) {
      await interaction.reply({
        content: 'The Connect 4 game is not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({
        content: 'You need Manage Messages permission to reset Connect 4.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const resetActiveRound = await connectFour.resetRound();
    await interaction.editReply({
      content: resetActiveRound
        ? 'Connect 4 reset. A fresh round has been started.'
        : 'No active Connect 4 round was found; a new one has been started.',
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

export const remindCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Schedule a reminder in the moderator reminders channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('How long to wait, for example 30m or 5d.')
        .setMaxLength(16)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('What should STEMBot remind you about?')
        .setMaxLength(1800)
        .setRequired(true),
    ),

  async execute(interaction, context): Promise<void> {
    const reminders = context.reminders;
    if (!reminders) {
      await interaction.reply({
        content: 'Moderator reminders are not enabled.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const hasModeratorPermission =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
    if (!hasModeratorPermission) {
      await interaction.reply({
        content: 'You need Manage Messages permission to schedule reminders.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const durationText = interaction.options.getString('duration', true);
    const delayMs = parseReminderDuration(durationText);
    if (!delayMs) {
      await interaction.reply({
        content: 'Use a positive duration such as `30m` for minutes or `5d` for days.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const content = interaction.options.getString('message', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reminder = await reminders.schedule(interaction.user.id, delayMs, content);
    const dueAt = new Date(reminder.dueAt).toLocaleString('en-AU', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: context.timeZone ?? 'Australia/Brisbane',
    });
    await interaction.editReply({ content: `Reminder scheduled for **${dueAt}**.` });
  },
};

export const minecraftCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('minecraft')
    .setDescription('Show STEMCraft status, player count, and online usernames.'),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const stemcraft = requireStemCraft(context);
    const status = await stemcraft.getServerStatus();

    let players: readonly MinecraftPlayer[] | undefined;
    try {
      players = await stemcraft.getOnlinePlayers();
    } catch (error: unknown) {
      if (!(error instanceof PlayerListUnavailableError)) {
        throw error;
      }
    }

    await interaction.editReply({
      content: formatMinecraftStatus(status, players),
      allowedMentions: { parse: [] },
    });
  },
};

export const playerInfoCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('playerinfo')
    .setDescription("Show a Minecraft player's profile and STEMCraft statistics.")
    .addStringOption((option) =>
      option
        .setName('username')
        .setDescription('The Minecraft username or UUID to look up.')
        .setMaxLength(36)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('The statistics period to display.')
        .setRequired(false)
        .addChoices(
          { name: 'All time', value: 'all' },
          { name: 'Today', value: '1d' },
          { name: 'Last 7 days', value: '7d' },
          { name: 'Last 28 days', value: '28d' },
          { name: 'Last 30 days', value: '30d' },
          { name: 'Last 365 days', value: '365d' },
        ),
    ),

  async execute(interaction, context): Promise<void> {
    const profiles = requireMinecraftProfiles(context);
    const identifier = interaction.options.getString('username', true).trim();
    const period = interaction.options.getString('period') ?? 'all';
    await interaction.deferReply();

    let profile: MinecraftProfile | undefined;
    let playerStats: MinecraftPlayerStats | undefined;
    let statsLookupAttempted = false;
    const uuid = normalizeMinecraftUuid(identifier);

    try {
      if (uuid && context.minecraftPlayerProfiles) {
        statsLookupAttempted = true;
        try {
          const snapshot = await context.minecraftPlayerProfiles.findByUuid(uuid, {
            include: ['stats'],
            period,
          });
          if (snapshot) {
            profile = snapshot.profile;
            playerStats = snapshot.stats ?? unavailableMinecraftPlayerStats(period);
          } else {
            playerStats = unavailableMinecraftPlayerStats(period);
          }
        } catch (error: unknown) {
          if (!(error instanceof MinecraftPlayerProfileLookupError)) {
            throw error;
          }
          context.logger?.warn(
            { err: error, uuid },
            'STEMCraft player profile lookup failed; continuing without statistics',
          );
          playerStats = unavailableMinecraftPlayerStats(period);
        }
      }

      if (!profile && uuid && profiles.findByUuid) {
        profile = await profiles.findByUuid(uuid);
      }

      if (!profile && !uuid) {
        profile = await profiles.findByUsername(identifier);
      }
    } catch (error: unknown) {
      if (
        error instanceof InvalidMinecraftUsernameError ||
        error instanceof InvalidMinecraftUuidError
      ) {
        await interaction.editReply({
          content: uuid
            ? 'That Minecraft UUID is not valid.'
            : 'Minecraft usernames must contain 1 to 16 letters, numbers, or underscores.',
        });
        return;
      }

      if (
        !(error instanceof MinecraftProfileLookupError) &&
        !(error instanceof MinecraftPlayerProfileLookupError)
      ) {
        throw error;
      }

      context.logger?.warn(
        {
          err: error,
          identifier,
          lookupType: uuid ? 'uuid' : 'username',
        },
        'Minecraft profile lookup failed; returning a temporary-unavailable response',
      );
      await interaction.editReply({
        content: 'Minecraft profile lookup is temporarily unavailable. Please try again later.',
      });
      return;
    }

    if (!profile) {
      await interaction.editReply({
        content: `No Minecraft player profile was found for **${identifier}**.`,
      });
      return;
    }

    if (!statsLookupAttempted && context.minecraftPlayerProfiles) {
      try {
        const snapshot = await context.minecraftPlayerProfiles.findByUuid(profile.uuid, {
          include: ['stats'],
          period,
        });
        if (snapshot) {
          profile = snapshot.profile;
          playerStats = snapshot.stats ?? unavailableMinecraftPlayerStats(period);
        } else {
          playerStats = unavailableMinecraftPlayerStats(period);
        }
      } catch (error: unknown) {
        if (!(error instanceof MinecraftPlayerProfileLookupError)) {
          throw error;
        }
        context.logger?.warn(
          { err: error, uuid: profile.uuid },
          'STEMCraft player profile lookup failed; continuing without statistics',
        );
        playerStats = unavailableMinecraftPlayerStats(period);
      }
    }

    const playerStatus = await getMinecraftPlayerInfoStatus(profile, context);
    await interaction.editReply({
      embeds: [buildMinecraftPlayerInfoEmbed(profile, playerStatus, playerStats)],
      allowedMentions: { parse: [] },
    });
  },
};

export const playerNotificationsCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('playernotifications')
    .setDescription('Manage Minecraft join and leave announcements.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addSubcommandGroup((group) =>
      group
        .setName('ignore')
        .setDescription('Manage players excluded from join and leave announcements.')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('add')
            .setDescription('Exclude a player from join and leave announcements.')
            .addStringOption((option) =>
              option
                .setName('username')
                .setDescription('The Minecraft username to exclude.')
                .setMaxLength(16)
                .setRequired(true),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('remove')
            .setDescription("Restore a player's join and leave announcements.")
            .addStringOption((option) =>
              option
                .setName('username')
                .setDescription('The Minecraft username to restore.')
                .setMaxLength(16)
                .setRequired(true),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('list')
            .setDescription('List players excluded from join and leave announcements.'),
        ),
    ),

  async execute(interaction, context): Promise<void> {
    const hasModeratorPermission =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
    if (!hasModeratorPermission) {
      await interaction.reply({
        content: 'You need Manage Messages permission to manage player notifications.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const playerNotifications = context.playerNotifications;
    if (!playerNotifications) {
      await interaction.reply({
        content: 'Player notifications are not configured.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const players = await playerNotifications.listIgnoredPlayers();
      await interaction.editReply({
        content: formatIgnoredMinecraftPlayers(players),
      });
      return;
    }

    const profiles = requireMinecraftProfiles(context);
    const username = interaction.options.getString('username', true).trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (subcommand === 'add') {
      const profile = await lookupMinecraftProfile(
        profiles,
        username,
        interaction,
        true,
        context.logger,
      );
      if (!profile) {
        return;
      }

      const result = await playerNotifications.addIgnoredPlayer(profile);
      await interaction.editReply({
        content: result.alreadyIgnored
          ? `Join/leave announcements are already suppressed for **${result.player.username}**.`
          : `Join/leave announcements will now be suppressed for **${result.player.username}**.`,
      });
      return;
    }

    const profile = await lookupMinecraftProfile(
      profiles,
      username,
      interaction,
      false,
      context.logger,
    );
    const ignoredPlayer = profile
      ? await playerNotifications.removeIgnoredPlayer(profile.uuid)
      : await playerNotifications.findIgnoredPlayerByUsername(username);
    if (!ignoredPlayer) {
      await interaction.editReply({
        content: `No ignored player was found for **${username}**.`,
      });
      return;
    }

    await interaction.editReply({
      content: `Join/leave announcements have been restored for **${ignoredPlayer.username}**.`,
    });
  },
};

export const commands: readonly DiscordCommand[] = [
  pingCommand,
  workshopsCommand,
  jokeCommand,
  numberCommand,
  levelCommand,
  statusCommand,
  scrambleCommand,
  mysteryLabCommand,
  codeFixCommand,
  ticTacToeCommand,
  connectFourCommand,
  leaderboardCommand,
  reviewCommand,
  countingChainCommand,
  remindCommand,
  minecraftCommand,
  playerInfoCommand,
  playerNotificationsCommand,
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

export function formatMinecraftStatus(
  status: MinecraftServerStatus,
  players?: readonly MinecraftPlayer[],
): string {
  const state = status.maintenance ? 'under maintenance' : status.online ? 'online' : 'offline';
  const capacity =
    status.maxPlayers === undefined
      ? `${status.playerCount} players online`
      : `${status.playerCount}/${status.maxPlayers} players online`;
  const version = status.version ? ` · version ${status.version}` : '';
  const message = status.message ? `\n${status.message}` : '';
  const playerList = players
    ? formatPlayers(players)
    : 'Online Minecraft usernames are not available from STEMCraft right now.';

  return `STEMCraft is **${state}** — ${capacity}${version}.${message}\n\n${playerList}`;
}

export function formatPlayers(players: readonly MinecraftPlayer[]): string {
  if (players.length === 0) {
    return 'No Minecraft players are currently online.';
  }

  return `Online Minecraft players:\n${players.map((player) => `• ${player.username}`).join('\n')}`;
}

export interface MinecraftPlayerInfoStatus {
  playerStatus: 'Online' | 'Offline' | 'Unknown';
  serverStatus: string;
}

export function buildMinecraftPlayerInfoEmbed(
  profile: MinecraftProfile,
  status: MinecraftPlayerInfoStatus,
  stats?: MinecraftPlayerStats,
): APIEmbed {
  const avatarUrl = getMinecraftAvatarUrl(profile.username, 128);
  const color =
    status.playerStatus === 'Online'
      ? 0x2ecc71
      : status.playerStatus === 'Offline'
        ? 0xe74c3c
        : 0x5865f2;

  const fields: NonNullable<APIEmbed['fields']> = [
    { name: 'UUID', value: `\`${profile.uuid}\`` },
    { name: 'Player status', value: status.playerStatus, inline: true },
    { name: 'Server', value: status.serverStatus, inline: true },
  ];

  if (stats) {
    fields.push(...buildMinecraftStatsFields(stats));
  }

  return {
    color,
    author: {
      name: `${profile.username}'s Minecraft profile`,
      icon_url: avatarUrl,
    },
    thumbnail: { url: avatarUrl },
    fields,
    footer: { text: 'Minecraft profile' },
  };
}

function buildMinecraftStatsFields(stats: MinecraftPlayerStats): NonNullable<APIEmbed['fields']> {
  if (!stats.available) {
    return [
      {
        name: 'Statistics',
        value: 'STEMCraft statistics are not available for this player right now.',
      },
    ];
  }

  if (stats.items.length === 0) {
    return [
      {
        name: `Statistics (${formatMinecraftStatsPeriod(stats.period)})`,
        value: 'No statistics are available for this period.',
      },
    ];
  }

  const lines = stats.items.map(
    (item) => `**${escapeEmbedText(item.title)}**: ${formatMinecraftStatValue(item.value)}`,
  );
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > 900 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) {
    chunks.push(current);
  }

  return chunks.map((value, index) => ({
    name:
      index === 0
        ? `Statistics (${formatMinecraftStatsPeriod(stats.period)})`
        : 'Statistics (continued)',
    value,
  }));
}

function formatMinecraftStatsPeriod(period: string): string {
  return (
    {
      all: 'all time',
      '1d': 'today',
      '7d': 'last 7 days',
      '28d': 'last 28 days',
      '30d': 'last 30 days',
      '365d': 'last 365 days',
    }[period] ?? period
  );
}

function formatMinecraftStatValue(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-AU')
    : value.toLocaleString('en-AU', { maximumFractionDigits: 2 });
}

function unavailableMinecraftPlayerStats(period: string): MinecraftPlayerStats {
  return { available: false, period, items: [] };
}

export function formatIgnoredMinecraftPlayers(players: readonly IgnoredMinecraftPlayer[]): string {
  if (players.length === 0) {
    return 'No Minecraft players are excluded from join/leave announcements.';
  }

  return [
    '**Players excluded from join/leave announcements:**',
    ...players.map((player) => `• **${player.username}** — \`${player.uuid}\``),
  ].join('\n');
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

export function buildUserLevelEmbed(profile: UserLevelProfile, user: User, rank = 1): APIEmbed {
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
        name: 'Rank',
        value: `#${Math.max(1, Math.floor(rank))}`,
        inline: true,
      },
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

export async function buildUserLevelCard(
  profile: UserLevelProfile,
  user: User,
  rank: number,
): Promise<Buffer> {
  const avatarDataUri = await fetchDiscordAvatarDataUri(
    user.displayAvatarURL({ extension: 'png', size: 128 }),
  );
  return sharp(Buffer.from(buildUserLevelCardSvg(profile, user, rank, avatarDataUri)))
    .png()
    .toBuffer();
}

export function buildUserLevelCardSvg(
  profile: UserLevelProfile,
  user: User,
  rank: number,
  avatarDataUri?: string,
): string {
  const progress = getUserLevelProgress(profile);
  const displayName = user.globalName ?? user.username;
  const initials = getUserInitials(displayName);
  const safeName = escapeSvgText(displayName.slice(0, 32));
  const safeInitials = escapeSvgText(initials);
  const safeRank = Math.max(1, Math.floor(rank));
  const barWidth = 650;
  const filledBarWidth = Math.round((barWidth * progress.percent) / 100);
  const avatar = avatarDataUri
    ? `<clipPath id="avatar-clip"><circle cx="104" cy="126" r="70" /></clipPath><image href="${avatarDataUri}" x="34" y="56" width="140" height="140" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)" />`
    : `<circle cx="104" cy="126" r="70" fill="#5865f2" /><text x="104" y="144" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="48" font-weight="700" fill="#ffffff">${safeInitials}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="280" viewBox="0 0 900 280">
  <defs>
    <linearGradient id="card" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#131a25" />
      <stop offset="1" stop-color="#202b3d" />
    </linearGradient>
    <linearGradient id="progress" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#55d6f5" />
      <stop offset="1" stop-color="#7e8cff" />
    </linearGradient>
  </defs>
  <rect width="900" height="280" rx="18" fill="url(#card)" />
  ${avatar}
  <text x="198" y="82" font-family="DejaVu Sans, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${safeName}</text>
  <text x="198" y="114" font-family="DejaVu Sans, sans-serif" font-size="17" letter-spacing="2" fill="#9aa8bd">STEMBOT LEVEL</text>
  <text x="648" y="66" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1" fill="#9aa8bd">RANK</text>
  <text x="648" y="101" font-family="DejaVu Sans, sans-serif" font-size="35" font-weight="700" fill="#ffffff">#${safeRank}</text>
  <text x="770" y="66" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1" fill="#9aa8bd">LEVEL</text>
  <text x="770" y="101" font-family="DejaVu Sans, sans-serif" font-size="35" font-weight="700" fill="#55d6f5">${profile.level}</text>
  <rect x="198" y="164" width="${barWidth}" height="24" rx="12" fill="#3a4553" />
  <rect x="198" y="164" width="${filledBarWidth}" height="24" rx="12" fill="url(#progress)" />
  <text x="198" y="226" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#ffffff">${progress.currentXp} / ${progress.requiredXp} XP</text>
  <text x="848" y="226" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#9aa8bd">to level ${profile.level + 1}</text>
</svg>`;
}

async function fetchDiscordAvatarDataUri(url: string): Promise<string | undefined> {
  if (
    !url.startsWith('https://cdn.discordapp.com/') &&
    !url.startsWith('https://media.discordapp.net/')
  ) {
    return undefined;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? 'image/png';
    if (!contentType.startsWith('image/')) {
      return undefined;
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > 2_000_000) {
      return undefined;
    }

    return `data:${contentType};base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}

export function buildUptimeStatusEmbed(status: UptimeKumaStatus): APIEmbed {
  const hasOfflineMonitor = status.monitors.some((monitor) => monitor.state === 'down');
  const hasSoftIssue = status.monitors.some(
    (monitor) => monitor.state === 'pending' || monitor.state === 'maintenance',
  );
  const isUnavailable =
    Boolean(status.sourceError) ||
    hasOfflineMonitor ||
    (!hasSoftIssue && status.overall === 'down');
  const isOperational = !isUnavailable && !hasSoftIssue && status.overall === 'up';
  const isDegraded = !isUnavailable && !isOperational;
  const dot = isOperational ? '🟢' : isDegraded ? '🟠' : '🔴';
  const serviceLines = status.monitors.map((monitor) => {
    const monitorDot = monitor.state === 'up' ? '🟢' : monitor.state === 'down' ? '🔴' : '🟠';
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
      : 'One or more monitored services are interrupted or under maintenance.';

  return {
    title: `${dot} ${status.title}`,
    url: status.statusPageUrl,
    color: isOperational ? 0x2ecc71 : isDegraded ? 0xf39c12 : 0xe74c3c,
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

function requireMinecraftProfiles(context: CommandContext): MinecraftProfileLookup {
  if (!context.minecraftProfiles) {
    throw new Error('The Minecraft profile lookup is not available');
  }

  return context.minecraftProfiles;
}

async function getMinecraftPlayerInfoStatus(
  profile: MinecraftProfile,
  context: CommandContext,
): Promise<MinecraftPlayerInfoStatus> {
  if (!context.stemcraft) {
    return { playerStatus: 'Unknown', serverStatus: 'Unavailable' };
  }

  try {
    const players = await context.stemcraft.getOnlinePlayers();
    const isOnline = players.some(
      (player) => player.username.toLocaleLowerCase() === profile.username.toLocaleLowerCase(),
    );
    return {
      playerStatus: isOnline ? 'Online' : 'Offline',
      serverStatus: `${players.length} players online`,
    };
  } catch (error: unknown) {
    if (!(error instanceof PlayerListUnavailableError)) {
      return { playerStatus: 'Unknown', serverStatus: 'Unavailable' };
    }
  }

  try {
    const server = await context.stemcraft.getServerStatus();
    const state = server.maintenance ? 'Maintenance' : server.online ? 'Online' : 'Offline';
    const capacity =
      server.maxPlayers === undefined
        ? `${server.playerCount} players online`
        : `${server.playerCount}/${server.maxPlayers} players online`;
    return {
      playerStatus: server.online ? 'Unknown' : 'Offline',
      serverStatus: `${state} · ${capacity}`,
    };
  } catch {
    return { playerStatus: 'Unknown', serverStatus: 'Unavailable' };
  }
}

function getMinecraftAvatarUrl(username: string, size: number): string {
  return `https://mc-heads.net/avatar/${encodeURIComponent(username)}/${size}.png`;
}

async function lookupMinecraftProfile(
  profiles: MinecraftProfileLookup,
  username: string,
  interaction: ChatInputCommandInteraction,
  reportNotFound = false,
  logger?: AppLogger,
): Promise<MinecraftProfile | undefined> {
  try {
    const profile = await profiles.findByUsername(username);
    if (!profile && reportNotFound) {
      await interaction.editReply({
        content: `No Minecraft player profile was found for **${username}**.`,
      });
    }
    return profile;
  } catch (error: unknown) {
    if (error instanceof InvalidMinecraftUsernameError) {
      await interaction.editReply({
        content: 'Minecraft usernames must contain 1 to 16 letters, numbers, or underscores.',
      });
      return undefined;
    }

    if (error instanceof MinecraftProfileLookupError) {
      logger?.warn(
        { err: error, username },
        'Minecraft profile lookup failed; returning a temporary-unavailable response',
      );
      await interaction.editReply({
        content: 'Minecraft profile lookup is temporarily unavailable. Please try again later.',
      });
      return undefined;
    }

    throw error;
  }
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
      pending: 'Issue',
      maintenance: 'Maintenance',
    }[state] ?? 'Unknown'
  );
}

function escapeEmbedText(value: string): string {
  return value.replace(/[\\`*_~|]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getUserInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }

  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }

  return `${words[0]![0] ?? ''}${words.at(-1)?.[0] ?? ''}`.toUpperCase();
}

function truncateEmbedField(value: string): string {
  const maximumLength = 1024;
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 20).trimEnd()}\n…more services`;
}
