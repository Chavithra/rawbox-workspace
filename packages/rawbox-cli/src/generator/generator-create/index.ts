import { fileURLToPath } from "node:url";
import path from "node:path";

import Generator from "yeoman-generator";

interface ProjectInfo {
  projectName: string;
  packageManager: "npm" | "yarn" | "pnpm";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class extends Generator<never> {
  private answers: ProjectInfo | undefined;

  initializing() {
    this.log("Welcome to the My Framework `create` generator!");
  }

  async prompting() {
    this.answers = await this.prompt<ProjectInfo>([
      {
        type: "input",
        name: "projectName",
        message: "What is the name of your project?",
        default: path.basename(this.destinationRoot()), // Default to current folder name
      },
      {
        type: "list",
        name: "packageManager",
        message: "Which package manager would you like to use?",
        choices: ["npm", "yarn", "pnpm"],
      },
    ]);
  }

  writing() {
    if (this.answers) {
      const { projectName } = this.answers;

      this.fs.copyTpl(
        this.templatePath(
          __dirname,
          "package-template",
          "rawbox.config.json.ejs"
        ),
        this.destinationPath(projectName, "rawbox.config.json"),
        {}
      );

      this.fs.copyTpl(
        this.templatePath(
          __dirname,
          "package-template",
          "src",
          "sum.definition.ts.ejs"
        ),
        this.destinationPath(projectName, "src", "sum.definition.ts"),
        { projectName }
      );

      this.fs.copyTpl(
        this.templatePath(
          __dirname,
          "package-template",
          "src",
          "mul.definition.ts.ejs"
        ),
        this.destinationPath(projectName, "src", "mul.definition.ts"),
        { projectName }
      );

      this.fs.copyTpl(
        this.templatePath(
          __dirname,
          "package-template",
          "src",
          "contracts-registry.ts.ejs"
        ),
        this.destinationPath(projectName, "src", "contracts-registry.ts"),
        { projectName }
      );

      this.fs.copyTpl(
        this.templatePath(__dirname, "package-template", "tsconfig.json.ejs"),
        this.destinationPath(projectName, "tsconfig.json"),
        {}
      );

      this.fs.copyTpl(
        this.templatePath(__dirname, "package-template", "package.json.ejs"),
        this.destinationPath(projectName, "package.json"),
        { projectName }
      );

      this.log(`\nCreated ${projectName} folder.`);
    } else {
      this.log("\nCould not create project files; no answers were provided.");
    }
  }

  install() {
    if (this.answers) {
      const { projectName, packageManager } = this.answers;
      const projectDir = this.destinationPath(projectName);

      this.log(`\nInstalling dependencies with ${packageManager}...`);
      this.spawnSync(packageManager, ["install"], {
        cwd: projectDir,
        stdio: "inherit",
      });
    }
  }

  end() {
    this.log("\n✅ Project generation complete!");
    this.log("You can now `cd` into your new project and start building.");
  }
}
