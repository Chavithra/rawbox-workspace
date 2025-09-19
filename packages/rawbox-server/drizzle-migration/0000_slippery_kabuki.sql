CREATE TABLE `contracts-registry` (
	`contractsRegistryPath` text PRIMARY KEY NOT NULL,
	`contractsRecord` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `constant` (
	`workflow_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`key_id` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`workflow_id`, `workspace_id`, `key_id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflow`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow` (
	`alias` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`step_list` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`alias` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
