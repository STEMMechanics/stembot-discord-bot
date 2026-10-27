import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

import type { ButtonGameBoard, ButtonGameStyle } from '../services/button-games.js';

const styles: Record<ButtonGameStyle, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export function toDiscordButtonRows(board: ButtonGameBoard): ActionRowBuilder<ButtonBuilder>[] {
  return board.rows.map((row) => {
    const actionRow = new ActionRowBuilder<ButtonBuilder>();
    actionRow.addComponents(
      row.buttons.map((button) =>
        new ButtonBuilder()
          .setCustomId(button.customId)
          .setLabel(button.label)
          .setStyle(styles[button.style])
          .setDisabled(button.disabled ?? false),
      ),
    );
    return actionRow;
  });
}
