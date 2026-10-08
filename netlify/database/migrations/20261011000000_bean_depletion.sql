-- Remembers when beans were last "used up", so stock drops one step every 15 seconds no matter how many tabs are open.
CREATE TABLE bean_depletion (
  id        INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_tick TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO bean_depletion (id) VALUES (1);
