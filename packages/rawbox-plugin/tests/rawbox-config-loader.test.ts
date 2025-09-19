import { describe, it, expect } from "vitest";
import { RawboxConfigLoader } from "@/rawbox-config-loader.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("RawboxConfigLoader", () => {
  it("should load a valid config file", async () => {
    const currentFolder = path.dirname(fileURLToPath(import.meta.url));
    const startFolderPath = path.join(
      currentFolder,
      "../../rawbox-extension-maths/rawbox.config.json"
    );
    const result = await RawboxConfigLoader.loadConfigFile(startFolderPath);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const rawboxConfig = result.value;
      expect(rawboxConfig).toBeDefined();
      expect(rawboxConfig.path).toBeDefined();
      expect(rawboxConfig.content).toBeDefined();
    }
  });

  it("should return an error for an invalid config file", async () => {
    const result = await RawboxConfigLoader.loadConfigFile(
      "./test/fixtures/invalid-rawbox.config.json"
    );
    expect(result.isOk()).toBe(false);
  });
});
