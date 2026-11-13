-- Cordia is free and funded by donations, so there is no account subscription
-- left to record. The tables are dropped rather than left empty: a schema that
-- still has user_subscriptions invites someone to write to it again.
DROP TABLE IF EXISTS billing_events;
DROP TABLE IF EXISTS user_subscriptions;
