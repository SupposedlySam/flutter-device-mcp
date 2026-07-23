module.exports = {
  testEnvironment: "node",
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
