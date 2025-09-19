# Rawbox Framework

This document is the starting point of the Rawbox Framework documentation.

## 1. What is Rawbox?

Rawbox is a general purpose automation framework.

## 2. Questions & Answers

1. What kind of automations? most of them.
2. How to configure an automation? by connecting provided operations.
3. What if the operations I need don't exist? you can add them.

## 3. Packages

This repository contains the following packages:

| Package                  | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| `rawbox-cli`             | Command-line interface for scaffolding projects and generating operations.  |
| `rawbox-client`          | Graphical user interface for managing and monitoring automations.           |
| `rawbox-default-plugins` | Set of operations availlable by default.                                    |
| `rawbox-mcp-dev`         | (Coming soon) MCP Server to assist Developers.                              |
| `rawbox-mcp-user`        | (Coming soon) MCP Server to assist Users.                                   |
| `rawbox-plugin`          | Plugin system for defining, validating, and dynamically loading operations. |
| `rawbox-runner`          | Orchestration system for executing automation workflows.                    |
| `rawbox-server`          | REST API for interacting with the Rawbox ecosystem.                         |
| `rawbox-store`           | Data Exchange system for workflows.                                         |

## 4. Getting Started

To get started with the Rawbox Framework, clone the monorepo and set up the development environment:

```sh
git clone https://github.com/your-username/rawbox-workspace.git
cd rawbox-workspace
npm install
npm run build
```
