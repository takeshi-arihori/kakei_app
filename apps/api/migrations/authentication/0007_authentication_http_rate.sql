-- HTTP Resource予算は認証Envelope/業務Tableと独立して所有する。
CREATE SCHEMA authentication_http;
CREATE TABLE authentication_http.rate_policy (
  state_id integer PRIMARY KEY CHECK (state_id = 1),
  policy_version integer NOT NULL CHECK (policy_version = 1),
  deployment_namespace text NOT NULL CHECK (deployment_namespace ~ '^[A-Za-z0-9_-]{1,100}$'),
  key_version text NOT NULL CHECK (key_version ~ '^[A-Za-z0-9_-]{1,64}$'),
  key_check bytea NOT NULL CHECK (octet_length(key_check) = 32)
);
CREATE TABLE authentication_http.rate_window (
  operation text NOT NULL CHECK (operation IN ('attempt','login','session','logout')),
  kind text NOT NULL CHECK (kind IN ('global','peer')),
  subject_digest bytea NOT NULL CHECK (octet_length(subject_digest) = 32),
  window_start_ms bigint NOT NULL CHECK (window_start_ms BETWEEN 0 AND 9007199254680991 AND window_start_ms % 60000 = 0),
  count bigint NOT NULL CHECK (count BETWEEN 1 AND 601),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms = window_start_ms + 60000),
  PRIMARY KEY (operation,kind,subject_digest,window_start_ms)
);
CREATE INDEX rate_window_expiry ON authentication_http.rate_window (expires_at_ms);
