CREATE TABLE auth_state (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (namespace, id)
);
CREATE INDEX auth_state_expiry ON auth_state(expires);
