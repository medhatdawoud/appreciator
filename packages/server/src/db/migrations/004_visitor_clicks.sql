-- See 003_items.sql for why item_key is VARCHAR(512).
CREATE TABLE visitor_clicks (
  button_id CHAR(36) NOT NULL,
  item_key VARCHAR(512) NOT NULL,
  visitor_hash CHAR(64) NOT NULL,
  click_count INT NOT NULL DEFAULT 0,
  last_click_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (button_id, item_key, visitor_hash)
)
