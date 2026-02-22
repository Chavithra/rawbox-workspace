/** @type {import('@rtk-query/codegen-openapi').ConfigFile} */
const config = {
  schemaFile: "http://127.0.0.1:3000/api/v1/swagger/json",
  apiFile: "./src/redux/rawbox-api-empty.ts",
  apiImport: "rawboxApiEmpty",
  outputFile: "./src/redux/rawbox-api.ts",
  exportName: "rawboxApi",
  hooks: true,
  tag: true,
};

export default config;
