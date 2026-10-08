-- Link each bean order to the customer it was placed for.
ALTER TABLE bean_order ADD COLUMN customer_id INTEGER REFERENCES customer(customer_id) ON DELETE SET NULL;
