-- Each bean gets a usual supplier and a price, so ordering is one click.
ALTER TABLE bean ADD COLUMN supplier_id INTEGER REFERENCES supplier(supplier_id) ON DELETE SET NULL;
ALTER TABLE bean ADD COLUMN price_per_kg NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (price_per_kg >= 0);
-- Orders placed from the Order Beans page arrive automatically at this time.
ALTER TABLE bean_order ADD COLUMN arrives_at TIMESTAMPTZ;

INSERT INTO supplier (name, contact_name, email, phone) VALUES
  ('Northern Roast Imports', 'Sam Rivera', 'sam@example.com', '403-555-0101'),
  ('Andes Green Coffee Co.', 'Priya Nair', 'priya@example.com', '403-555-0102')
ON CONFLICT (name) DO NOTHING;

INSERT INTO bean (name, origin_country, roast_level, stock_kg, reorder_level_kg) VALUES
  ('Colombian Supremo', 'Colombia', 'Medium', 18.5, 10),
  ('Ethiopian Yirgacheffe', 'Ethiopia', 'Light', 6, 8),
  ('Sumatra Mandheling', 'Indonesia', 'Dark', 12, 5),
  ('Guatemalan Antigua', 'Guatemala', 'Medium', 9, 8),
  ('Brazilian Santos', 'Brazil', 'Dark', 14, 6)
ON CONFLICT (name) DO NOTHING;

UPDATE bean b SET
  supplier_id  = (SELECT s.supplier_id FROM supplier s WHERE s.name = v.sup),
  price_per_kg = v.price
FROM (VALUES
  ('Colombian Supremo',     'Northern Roast Imports', 11.25),
  ('Ethiopian Yirgacheffe', 'Andes Green Coffee Co.', 14.50),
  ('Sumatra Mandheling',    'Northern Roast Imports', 12.80),
  ('Guatemalan Antigua',    'Andes Green Coffee Co.', 12.40),
  ('Brazilian Santos',      'Northern Roast Imports',  9.90)
) AS v(bean, sup, price)
WHERE b.name = v.bean;
