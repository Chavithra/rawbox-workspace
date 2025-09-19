import type { BoxLocation } from "./box-store.js";
import { Identifiable } from "./identifiable.js";

export function createSimpleBoxLocation(
  envIdentifier: string,
  dbiIdentifier: string,
  keyIdentifier: string
): BoxLocation {
  return {
    env: {
      alias: envIdentifier,
      id: envIdentifier,
    },
    dbi: {
      alias: dbiIdentifier,
      id: dbiIdentifier,
    },
    key: {
      alias: keyIdentifier,
      id: keyIdentifier,
    },
  };
}

export function createBoxLocation(
  envIdentifiable: Identifiable,
  dbiIdentifiable: Identifiable,
  keyIdentifiable: Identifiable
): BoxLocation {
  return {
    env: envIdentifiable,
    dbi: dbiIdentifiable,
    key: keyIdentifiable,
  };
}

export function areLocationsEqual(
  location1: BoxLocation,
  location2: BoxLocation
): boolean {
  return (
    location1.env.id === location2.env.id &&
    location1.dbi.id === location2.dbi.id &&
    location1.key.id === location2.key.id
  );
}
