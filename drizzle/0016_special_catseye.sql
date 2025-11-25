ALTER TABLE `chats` ADD `workflow_status` text DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE `chats` ADD `workflow_step` text;