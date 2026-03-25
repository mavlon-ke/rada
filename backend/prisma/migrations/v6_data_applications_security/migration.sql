-- Migration v6: Data Applications + Security
-- Add DataApplication table

CREATE TABLE IF NOT EXISTS "DataApplication" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "firstName"       TEXT NOT NULL,
    "lastName"        TEXT NOT NULL,
    "email"           TEXT NOT NULL,
    "mobile"          TEXT NOT NULL,
    "city"            TEXT NOT NULL,
    "country"         TEXT NOT NULL,
    "orgName"         TEXT NOT NULL,
    "orgType"         TEXT NOT NULL,
    "jobTitle"        TEXT NOT NULL,
    "website"         TEXT,
    "planInterest"    TEXT NOT NULL,
    "useCase"         TEXT NOT NULL,
    "useDescription"  TEXT NOT NULL,
    "dataVolume"      TEXT,
    "refNumber"       TEXT NOT NULL UNIQUE,
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "notes"           TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL
);
