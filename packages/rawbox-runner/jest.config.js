// jest.config.js
/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  // Use 'export default' for Jest config in ESM projects
  preset: "ts-jest/presets/default-esm", // Crucial: Use the ESM preset for ts-jest
  testEnvironment: "node",
  testMatch: ["**/src/**/*.spec.ts"],
  verbose: true,
  clearMocks: true,
  // If you run into issues with Jest finding modules, you might need:
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1", // Map .js imports back to source .ts files for Jest
  },
  // If you need to transform other types of files (e.g., .mjs or .cjs that are not ts)
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true, // Tell ts-jest to use ESM mode
        // Optional: Specify tsconfig for tests if it's different from main tsconfig
        // tsconfig: './tsconfig.test.json',
      },
    ],
  },
};
