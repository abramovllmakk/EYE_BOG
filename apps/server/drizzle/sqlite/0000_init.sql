CREATE TABLE `arg_hit` (
	`run_id` text NOT NULL,
	`coordinate` text NOT NULL,
	`requests` integer NOT NULL,
	`occurrences` integer NOT NULL,
	`sources` text NOT NULL,
	PRIMARY KEY(`run_id`, `coordinate`)
);
--> statement-breakpoint
CREATE TABLE `enum_value_hit` (
	`run_id` text NOT NULL,
	`coordinate` text NOT NULL,
	`requests` integer NOT NULL,
	`occurrences` integer NOT NULL,
	PRIMARY KEY(`run_id`, `coordinate`)
);
--> statement-breakpoint
CREATE TABLE `field_hit` (
	`run_id` text NOT NULL,
	`coordinate` text NOT NULL,
	`requests` integer NOT NULL,
	`occurrences` integer NOT NULL,
	`min_depth` integer NOT NULL,
	`max_depth` integer NOT NULL,
	`conditional_only` integer NOT NULL,
	`aliases` text NOT NULL,
	`fragments` text NOT NULL,
	`paths` text NOT NULL,
	PRIMARY KEY(`run_id`, `coordinate`)
);
--> statement-breakpoint
CREATE TABLE `field_test` (
	`run_id` text NOT NULL,
	`coordinate` text NOT NULL,
	`test_key` text NOT NULL,
	`requests` integer NOT NULL,
	PRIMARY KEY(`run_id`, `coordinate`, `test_key`)
);
--> statement-breakpoint
CREATE INDEX `field_test_test` ON `field_test` (`run_id`,`test_key`);--> statement-breakpoint
CREATE TABLE `input_field_hit` (
	`run_id` text NOT NULL,
	`coordinate` text NOT NULL,
	`requests` integer NOT NULL,
	`occurrences` integer NOT NULL,
	PRIMARY KEY(`run_id`, `coordinate`)
);
--> statement-breakpoint
CREATE TABLE `operation_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`target` text NOT NULL,
	`ts` integer NOT NULL,
	`operation_name` text,
	`operation_type` text,
	`query_hash` text,
	`variables` text,
	`headers` text,
	`test_name` text,
	`test_suite` text,
	`http_status` integer,
	`has_errors` integer,
	`status` text NOT NULL,
	`errors` text,
	`latency_ms` real,
	`batch_index` integer,
	`transport` text,
	`fields` text
);
--> statement-breakpoint
CREATE INDEX `operation_log_run` ON `operation_log` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `operation_log_ts` ON `operation_log` (`ts`);--> statement-breakpoint
CREATE TABLE `query_document` (
	`hash` text PRIMARY KEY NOT NULL,
	`query` text NOT NULL,
	`normalized` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`schema_snapshot_id` integer,
	`status` text NOT NULL,
	`auto` integer DEFAULT 0 NOT NULL,
	`environment` text,
	`branch` text,
	`commit_sha` text,
	`build_id` text,
	`team` text,
	`test_suite` text,
	`labels` text DEFAULT '{}' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`last_activity_at` integer NOT NULL,
	`requests_total` integer DEFAULT 0 NOT NULL,
	`requests_valid` integer DEFAULT 0 NOT NULL,
	`requests_invalid` integer DEFAULT 0 NOT NULL,
	`requests_introspection` integer DEFAULT 0 NOT NULL,
	`requests_unresolved` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_started_at` ON `run` (`started_at`);--> statement-breakpoint
CREATE INDEX `run_branch` ON `run` (`branch`);--> statement-breakpoint
CREATE INDEX `run_environment` ON `run` (`environment`);--> statement-breakpoint
CREATE TABLE `run_test` (
	`run_id` text NOT NULL,
	`test_key` text NOT NULL,
	`suite` text,
	`name` text NOT NULL,
	`requests` integer NOT NULL,
	PRIMARY KEY(`run_id`, `test_key`)
);
--> statement-breakpoint
CREATE TABLE `schema_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target` text NOT NULL,
	`hash` text NOT NULL,
	`sdl` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schema_snapshot_target_hash` ON `schema_snapshot` (`target`,`hash`);--> statement-breakpoint
CREATE TABLE `union_member_hit` (
	`run_id` text NOT NULL,
	`coordinate` text NOT NULL,
	`requests` integer NOT NULL,
	`occurrences` integer NOT NULL,
	PRIMARY KEY(`run_id`, `coordinate`)
);
