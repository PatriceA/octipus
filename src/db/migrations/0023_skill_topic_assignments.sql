-- Skill-topic assignments: attach skills to model topics with active/inactive toggle
CREATE TABLE IF NOT EXISTS "skill_topic_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "skill_id" text NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "topic" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "skill_topic_unique" ON "skill_topic_assignments" ("skill_id", "topic");

-- Migrate skill categories from broad groups to match agent role/topic names
UPDATE "skills" SET "category" = 'architecture' WHERE "id" = 'software-architecture';
UPDATE "skills" SET "category" = 'coding' WHERE "id" = 'data-structures';
UPDATE "skills" SET "category" = 'qa' WHERE "id" = 'test-automation';
UPDATE "skills" SET "category" = 'security' WHERE "id" = 'security-practices';
UPDATE "skills" SET "category" = 'devops' WHERE "id" = 'networking';
UPDATE "skills" SET "category" = 'coding' WHERE "id" = 'api-design';
UPDATE "skills" SET "category" = 'data' WHERE "id" = 'database-design';
UPDATE "skills" SET "category" = 'coding' WHERE "id" = 'performance-engineering';
UPDATE "skills" SET "category" = 'data' WHERE "id" = 'data-engineering';
UPDATE "skills" SET "category" = 'writing' WHERE "id" = 'technical-writing';
UPDATE "skills" SET "category" = 'coding' WHERE "id" = 'plugin-development';
UPDATE "skills" SET "category" = 'design' WHERE "id" = 'design-principles';
UPDATE "skills" SET "category" = 'design' WHERE "id" = 'design-frameworks';
UPDATE "skills" SET "category" = 'devops' WHERE "id" = 'devops-practices';
UPDATE "skills" SET "category" = 'devops' WHERE "id" = 'container-orchestration';
UPDATE "skills" SET "category" = 'devops' WHERE "id" = 'cloud-platforms';
UPDATE "skills" SET "category" = 'finance' WHERE "id" = 'financial-analysis';
UPDATE "skills" SET "category" = 'automation' WHERE "id" = 'automation-patterns';
UPDATE "skills" SET "category" = 'pm' WHERE "id" = 'project-management';
UPDATE "skills" SET "category" = 'ai' WHERE "id" = 'ai-engineering';
UPDATE "skills" SET "category" = 'ai' WHERE "id" = 'machine-learning';
