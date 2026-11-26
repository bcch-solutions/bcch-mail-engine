/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src/__tests__"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: false,
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          target: "ES2021",
          esModuleInterop: true,
        },
      },
    ],
  },
  // Los archivos fuente usan imports ESM con extensión .js (./config.js).
  // ts-jest con module:commonjs emite require("./config.js"); mapeamos .js→.ts.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // sanitize-html y su cadena son ESM puro; usamos un mock para pruebas unitarias.
    "^sanitize-html$": "<rootDir>/src/__tests__/__mocks__/sanitize-html.js",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts", "!src/index.ts"],
};
