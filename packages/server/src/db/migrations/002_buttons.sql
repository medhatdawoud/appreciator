CREATE TABLE buttons (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  public_key VARCHAR(64) NOT NULL UNIQUE,
  max_clicks INT NOT NULL DEFAULT 10,
  allowed_origins JSON NOT NULL,
  svg_source MEDIUMTEXT NOT NULL,
  colors JSON NOT NULL,
  url_normalization ENUM('pathname','full') NOT NULL DEFAULT 'pathname',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (tenant_id),
  CONSTRAINT fk_buttons_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
)
