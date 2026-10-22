export type JsonState = Record<string, unknown>;

export interface StateStore<TState extends JsonState = JsonState> {
  load(): Promise<TState>;
  save(state: TState): Promise<void>;
}
