-- A tenant-facing label for telling buttons apart in the management API. NULL
-- for buttons created before it existed and for buttons created without one.
ALTER TABLE buttons ADD COLUMN name VARCHAR(255) NULL
