ALTER TABLE daily_logs ADD COLUMN external_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX daily_logs_external_id_idx ON daily_logs (external_id);
