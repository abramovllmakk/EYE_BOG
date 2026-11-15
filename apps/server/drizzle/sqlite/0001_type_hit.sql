CREATE TABLE `type_hit` (
	`run_id` text NOT NULL,
	`coordinate` text NOT NULL,
	`requests` integer NOT NULL,
	`occurrences` integer NOT NULL,
	PRIMARY KEY(`run_id`, `coordinate`)
);
