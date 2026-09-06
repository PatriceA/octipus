-- Permission requests no longer expire: a human takes as long as a human
-- takes, and the 5-minute TTL denied the call out from under them. New rows
-- are written with NULL; existing pending rows keep whatever deadline they
-- were given, and are cleared of it so a restart doesn't expire them either.
ALTER TABLE "permission_requests" ALTER COLUMN "expires_at" DROP NOT NULL;
UPDATE "permission_requests" SET "expires_at" = NULL WHERE "status" = 'pending';
