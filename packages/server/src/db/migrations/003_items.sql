-- item_key is VARCHAR(512) rather than 767: under utf8mb4 a 767-char column is
-- 3068 bytes, and (button_id, item_key) would exceed InnoDB's 3072-byte index
-- key limit. 512 chars keeps the composite primary key inside the limit and is
-- enforced as the request-level cap on `item` too.
CREATE TABLE items (
  button_id CHAR(36) NOT NULL,
  item_key VARCHAR(512) NOT NULL,
  total_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (button_id, item_key)
)
