-- Local-only baseline for an empty PostgreSQL database.
-- This represents the pre-003B profiles table and contains no user data.

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY,
  username varchar(50) NOT NULL UNIQUE,
  display_name varchar(50) NOT NULL,
  bio text,
  favorite_genres text,
  avatar_url text,
  is_age_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
