import { spawn } from "node:child_process";

const child = spawn(process.execPath, [
  "--experimental-transform-types",
  "--test",
  "packages/reveries/test/receive.integration.ts",
], { stdio: "inherit" });
child.on("error", (error) => { throw error; });
child.on("close", (code) => { process.exitCode = code ?? 1; });
