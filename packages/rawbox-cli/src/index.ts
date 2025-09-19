#!/usr/bin/env node

import process from "node:process";

import FullEnvironment, { createEnv } from "yeoman-environment";
import chalk from "chalk";
import yargs, { Argv } from "yargs";
import { hideBin } from "yargs/helpers";

import GeneratorCreate from "./generator/generator-create/index.js";
import GeneratorNewOperation from "./generator/generator-new-operation/index.js";

function makeEnv(): FullEnvironment {
  const env = createEnv();

  try {
    env.register(GeneratorCreate, { namespace: "rawbox:create" });
    env.register(GeneratorNewOperation, { namespace: "rawbox:new-operation" });
  } catch (error: any) {
    console.error(chalk.red("Error registering generator(s):"), error.message);
    process.exit(1);
  }

  return env;
}

function makeCli(env: FullEnvironment): Argv<{}> {
  const argv = yargs(hideBin(process.argv)) // Parse arguments excluding node executable and script name
    .scriptName("rawbox-cli") // The name of your command-line tool
    .usage("$0 <command> [options]") // General usage string
    .command(
      "create",
      "Creates a new project using My Framework.",
      (yargs) => {},
      async (argv) => {
        console.log(chalk.blue("Running the `create` command..."));
        try {
          await env.run(["rawbox:create"], {});
          console.log(chalk.green("\n`create` command finished."));
        } catch (error: any) {
          console.error(
            chalk.red("An error occurred during `create` execution:"),
            error.message
          );
          process.exit(1);
        }
      }
    )
    .command(
      "new-operation",
      "Creates creates a new operation.",
      (yargs) => {},
      async (argv) => {
        console.log(chalk.blue("Running the `create` command..."));
        try {
          await env.run(["rawbox:new-operation"], {});
          console.log(chalk.green("\n`create` command finished."));
        } catch (error: any) {
          console.error(
            chalk.red("An error occurred during `create` execution:"),
            error.message
          );
          process.exit(1);
        }
      }
    )
    .demandCommand(1, "You need to specify a command.")
    .help()
    .alias("h", "help")
    .recommendCommands()
    .strict();

  return argv;
}

const env = makeEnv();
const cli = makeCli(env);

await cli.parse();
