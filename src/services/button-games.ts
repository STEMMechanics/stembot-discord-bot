export type ButtonGameStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface ButtonGameButton {
  customId: string;
  label: string;
  style: ButtonGameStyle;
  disabled?: boolean;
}

export interface ButtonGameRow {
  buttons: readonly ButtonGameButton[];
}

export interface ButtonGameBoard {
  content: string;
  rows: readonly ButtonGameRow[];
}

export interface ButtonGameInteraction {
  channelId: string;
  messageId: string;
  userId: string;
  customId: string;
  update(board: ButtonGameBoard): Promise<void>;
  reply(content: string): Promise<void>;
}
