-- IF NOT EXISTS because this column shipped once before under a different
-- migration number (`0082_shocking_wind_dancer`, on the quality-loop branch)
-- and any database that ran that branch already has it. Renumbering to 0083
-- avoided a filename collision with main's own 0082; it does not undo the
-- column on databases where the old number already applied.
ALTER TABLE "swarm_nodes" ADD COLUMN IF NOT EXISTS "planned" boolean DEFAULT false NOT NULL;