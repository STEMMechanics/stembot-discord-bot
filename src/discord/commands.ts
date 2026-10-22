import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

import {
  PlayerListUnavailableError,
  type MinecraftPlayer,
  type MinecraftServerStatus,
  type StemCraftIntegration,
} from '../integrations/stemcraft.js';
import {
  formatWorkshopRegistration,
  getWorkshopStatusCode,
  isStemCraftWorkshop,
  type WebsiteIntegration,
  type WorkshopRecord,
} from '../integrations/website.js';

export interface CommandContext {
  getGatewayPing(): number;
  website?: WebsiteIntegration;
  stemcraft?: StemCraftIntegration;
  timeZone?: string;
  getCurrentTime?: () => Date;
}

export interface DiscordCommand {
  data: SlashCommandBuilder;
  execute(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<void>;
}

export function getPingResponse(gatewayPing: number): string {
  return `Pong! Gateway latency: ${gatewayPing}ms`;
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

export const scheduleCommand: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('List upcoming Minecraft workshops.'),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const website = requireWebsite(context);
    const workshops = await website.getWorkshops();
    const minecraftWorkshops = getUpcomingWorkshops(workshops, currentTime(context)).filter(
      isMinecraftWorkshop,
    );
    const content = formatWorkshopList(
      minecraftWorkshops,
      context.timeZone ?? 'Australia/Brisbane',
      'Upcoming Minecraft workshops',
    );
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
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
  scheduleCommand,
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

export function isMinecraftWorkshop(workshop: WorkshopRecord): boolean {
  return isStemCraftWorkshop(workshop);
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
    let registration = formatWorkshopRegistration(workshop) ?? details;
    if (
      !registration.includes(details) &&
      (!workshop.registrationUrl ||
        workshop.registrationType === 'none' ||
        workshop.registrationType === 'message')
    ) {
      registration = `${registration} · ${details}`;
    }
    const metadata = [status, location.slice(3), registration].filter(Boolean).join(' · ');

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
