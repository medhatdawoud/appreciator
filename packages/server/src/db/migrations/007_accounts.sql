-- A person who signs in to the dashboard with GitHub. Keyed by GitHub's numeric
-- id rather than the login, because a login can be renamed and later claimed
-- by someone else.
CREATE TABLE accounts (
  id CHAR(36) PRIMARY KEY,
  github_id BIGINT NOT NULL UNIQUE,
  login VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(1024) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)
