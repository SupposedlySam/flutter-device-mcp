module.exports = {
  testEnvironment: "node",
  // Redirect the per-developer state dir (the durable pointer stage) into a
  // throwaway tmp dir for every suite, so no test can write to a real $HOME.
  setupFiles: ["<rootDir>/__tests__/support/isolateStateDir.ts"],
  roots: ["<rootDir>/__tests__"],
  // Only *.test.ts files are suites; other __tests__ files (e.g. support/
  // helpers shared across suites) are plain modules, not test files.
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json", "node"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.+)\\.js$": "$1",
  },
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.jest.json",
        useESM: true,
      },
    ],
  },
};
