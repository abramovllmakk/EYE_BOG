CREATE TABLE "type_hit" (
	"run_id" text NOT NULL,
	"coordinate" text NOT NULL,
	"requests" integer NOT NULL,
	"occurrences" integer NOT NULL,
	CONSTRAINT "type_hit_run_id_coordinate_pk" PRIMARY KEY("run_id","coordinate")
);
