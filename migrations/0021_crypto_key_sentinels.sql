-- Verifies that a configured key version has the same material as the key
-- version that originally wrote durable Questshop data.  The digest is an
-- HMAC verification value, never the key itself.
CREATE TABLE IF NOT EXISTS crypto_key_sentinels (
  keyring_name TEXT NOT NULL CHECK (keyring_name IN ('DATA_ENCRYPTION','VOUCHER_HMAC','BACKUP_ENCRYPTION')),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  verification_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (keyring_name, key_version)
);
