-- The account a tenant (a "site" in the dashboard) belongs to. NULL for tenants
-- that no account owns: MANAGEMENT_SECRET, the create-tenant CLI and the demo.
ALTER TABLE tenants
  ADD COLUMN account_id CHAR(36) NULL,
  ADD INDEX idx_tenants_account (account_id),
  ADD CONSTRAINT fk_tenants_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
