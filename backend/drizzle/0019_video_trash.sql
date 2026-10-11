CREATE TABLE `video_trash` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`title` text NOT NULL,
	`payload` text NOT NULL,
	`files` text NOT NULL,
	`deleted_at` integer NOT NULL
);
