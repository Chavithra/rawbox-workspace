export type IdentifiableError =
  | "Alias cannot be empty"
  | "Identifier cannot be empty";

export interface Identifiable {
  readonly alias: string;
  readonly id: string;
}
