CREATE TABLE `client_device` (
	`uuid` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`profile` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`last_ip` text,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_device_slug_unique` ON `client_device` (`slug`);