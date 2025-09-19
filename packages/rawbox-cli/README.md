# rawbox-cli

## Overview

**rawbox-cli** is the command-line interface for the Rawbox Framework. It provides generators and utilities for scaffolding new Rawbox projects and operations, making it easy to bootstrap automation workflows with strong type safety and modular design.

## Features

- **Project Generator:** Quickly scaffold new Rawbox projects with recommended structure and configuration.
- **Operation Generator:** Create new operation implementations and update signature registries interactively.
- **Extensible:** Built on [Yeoman](https://yeoman.io/) and [yargs](https://yargs.js.org/) for easy extension and customization.

## Commands

- `create`: Scaffolds a new Rawbox project with sample operations and configuration.
- `new-operation`: Adds a new operation implementation and updates the signature registry.

## Usage

Install dependencies and run the CLI:

```sh
npm install
npx rawbox-cli <command>
```

Or, if installed globally:

```sh
rawbox-cli <command>
```

### Example: Create a New Project

```sh
npx rawbox-cli create
```

Follow the prompts to set up your project.

### Example: Add a New Operation

```sh
npx rawbox-cli new-operation
```

Enter the operation name when prompted. The generator will create the implementation and update the registry.

## Extending

You can add your own generators in the `generator/` folder. See [`src/index.ts`](src/index.ts) for how commands are registered.

## Development

- Build:
  ```sh
  npm run build
  ```
- Test:
  ```sh
  npm test
  ```
