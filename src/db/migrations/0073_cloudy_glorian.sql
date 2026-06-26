ALTER TABLE "embeddings" ADD COLUMN "repo_id" uuid;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_repo_id_workspace_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."workspace_repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embeddings_repo_id_idx" ON "embeddings" USING btree ("repo_id");