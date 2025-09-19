import { err, ok, type Result } from "neverthrow";
import { randomUUID } from "crypto";

import type { Identifiable, IdentifiableError } from "./identifiable.js";

export function createIdentifiable(alias: string, id: string): Identifiable {
  return {
    alias: alias,
    id: id,
  };
}

export function createSimpleIdentifiable(id: string): Identifiable {
  return {
    alias: id,
    id: id,
  };
}

export function generateIdentifiable(
  alias: string
): Result<Identifiable, IdentifiableError> {
  alias = alias.trim();
  if (!alias) {
    return err("Alias cannot be empty");
  }

  const id = randomUUID();

  return ok({ alias, id });
}
