CREATE TABLE tenants (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  secret_key_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tenants_secret_key_hash (secret_key_hash)
)
