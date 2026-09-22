CREATE TABLE "skill_selections" (
  "user_id" text NOT NULL,
  "scope" text NOT NULL DEFAULT '',
  "skill_id" text NOT NULL,
  "mode" text NOT NULL,
  PRIMARY KEY ("user_id", "scope", "skill_id"),
  CHECK (("scope" = '' AND "mode" = 'always') OR
         ("scope" <> '' AND "mode" IN ('automatic', 'session')))
);
