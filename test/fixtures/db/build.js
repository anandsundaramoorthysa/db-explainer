// Generates the sample store database for each engine from one MySQL source, so they cannot drift apart.
// Run with: node test/fixtures/db/build.js   (output: test/fixtures/db/<engine>.sql)
const fs = require('fs');
const path = require('path');

const sqlDir = path.join(__dirname, '..', 'sql');
const base = fs.readFileSync(path.join(sqlDir, '01_core.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(sqlDir, '02_inventory.sql'), 'utf8');

// Small changes shared by every engine: a CHECK constraint and a cascading foreign key.
const shared = base
  .replace('rating TINYINT NOT NULL,', 'rating TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),')
  .replace('REFERENCES orders (id),\n  CONSTRAINT fk_order_items_product', 'REFERENCES orders (id) ON DELETE CASCADE,\n  CONSTRAINT fk_order_items_product');

const view = `CREATE VIEW customer_order_totals AS
SELECT c.id AS customer_id, c.full_name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount), 0) AS total_spent
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.full_name;`;
const index = 'CREATE INDEX idx_orders_placed_at ON orders (placed_at);';
const COMMENT = 'pending, paid, shipped or cancelled';

const data = `
INSERT INTO customers (full_name, email, phone, created_at, is_active) VALUES
('Asha Kumar', 'asha@example.com', '9876543210', '2025-01-10 09:00:00', 1),
('Bala Raj', 'bala@example.com', NULL, '2025-02-14 10:30:00', 1),
('Chitra Devi', 'chitra@example.com', '9123456780', '2025-03-01 12:00:00', 1),
('Dev Anand', 'dev@example.com', '9000011111', '2025-03-20 08:15:00', 0),
('Esha Rao', 'esha@example.com', NULL, '2025-04-05 16:45:00', 1);
INSERT INTO addresses (customer_id, line1, line2, city, state, postal_code, country, is_default) VALUES
(1, '12 Lake Road', NULL, 'Madurai', 'Tamil Nadu', '625001', 'IN', 1),
(1, '8 Hill Street', 'Flat 4', 'Chennai', 'Tamil Nadu', '600001', 'IN', 0),
(2, '5 Market Lane', NULL, 'Salem', 'Tamil Nadu', '636001', 'IN', 1),
(3, '77 Temple Road', NULL, 'Erode', 'Tamil Nadu', '638001', 'IN', 1),
(4, '3 Beach Road', NULL, 'Goa', 'Goa', '403001', 'IN', 1),
(5, '90 Park Avenue', NULL, 'Madurai', 'Tamil Nadu', '625002', 'IN', 1);
INSERT INTO categories (name, parent_id) VALUES
('Electronics', NULL), ('Phones', 1), ('Laptops', 1), ('Books', NULL);
INSERT INTO products (sku, name, description, category_id, unit_price, is_discontinued, created_at) VALUES
('PH-100', 'Phone Basic', 'Entry phone', 2, 8999.00, 0, '2025-01-01 00:00:00'),
('PH-200', 'Phone Pro', 'Flagship phone', 2, 49999.00, 0, '2025-01-01 00:00:00'),
('LP-100', 'Laptop 14', 'Light laptop', 3, 55999.00, 0, '2025-01-05 00:00:00'),
('LP-200', 'Laptop 16', 'Workstation laptop', 3, 89999.00, 0, '2025-01-05 00:00:00'),
('BK-100', 'SQL Basics', 'A beginner book', 4, 399.00, 0, '2025-02-01 00:00:00'),
('BK-200', 'Learn Node', 'A node book', 4, 499.00, 0, '2025-02-01 00:00:00'),
('BK-300', 'Old Manual', 'Out of print', 4, 99.00, 1, '2024-01-01 00:00:00'),
('PH-300', 'Phone Mini', 'Small phone', 2, 19999.00, 0, '2025-03-01 00:00:00');
INSERT INTO orders (customer_id, shipping_address_id, status, total_amount, placed_at, shipped_at) VALUES
(1, 1, 'shipped', 58998.00, '2025-05-01 10:00:00', '2025-05-03 09:00:00'),
(1, 2, 'paid', 399.00, '2025-05-10 11:00:00', NULL),
(2, 3, 'shipped', 49999.00, '2025-05-12 12:00:00', '2025-05-14 10:00:00'),
(3, 4, 'cancelled', 89999.00, '2025-06-01 13:00:00', NULL),
(3, 4, 'pending', 898.00, '2025-06-05 14:00:00', NULL),
(5, 6, 'shipped', 19999.00, '2025-06-10 15:00:00', '2025-06-12 09:30:00'),
(2, 3, 'paid', 8999.00, '2025-06-15 16:00:00', NULL);
INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
(1, 1, 1, 8999.00), (1, 2, 1, 49999.00), (2, 5, 1, 399.00), (3, 2, 1, 49999.00),
(4, 4, 1, 89999.00), (5, 5, 1, 399.00), (5, 6, 1, 499.00), (6, 8, 1, 19999.00),
(7, 1, 1, 8999.00), (1, 5, 2, 399.00), (3, 6, 1, 499.00), (6, 5, 1, 399.00);
INSERT INTO payments (order_id, method, amount, paid_at, transaction_ref) VALUES
(1, 'card', 58998.00, '2025-05-01 10:05:00', 'TX-1001'),
(2, 'upi', 399.00, '2025-05-10 11:02:00', 'TX-1002'),
(3, 'card', 49999.00, '2025-05-12 12:03:00', 'TX-1003'),
(5, 'upi', 898.00, NULL, NULL),
(6, 'card', 19999.00, '2025-06-10 15:03:00', 'TX-1006'),
(7, 'netbanking', 8999.00, '2025-06-15 16:05:00', 'TX-1007');
INSERT INTO reviews (product_id, customer_id, rating, title, body, created_at) VALUES
(1, 1, 5, 'Great value', 'Works well.', '2025-05-20 10:00:00'),
(2, 1, 4, 'Fast', NULL, '2025-05-21 10:00:00'),
(2, 2, 5, 'Love it', 'Best phone I owned.', '2025-05-25 10:00:00'),
(5, 3, 3, 'Okay', 'Basic content.', '2025-06-10 10:00:00'),
(8, 5, 4, 'Nice size', NULL, '2025-06-20 10:00:00'),
(5, 1, 5, 'Clear', 'Good for starters.', '2025-06-22 10:00:00');
INSERT INTO warehouses (name, city, capacity) VALUES ('Main Hub', 'Chennai', 10000), ('South Depot', 'Madurai', 4000);
INSERT INTO suppliers (name, contact_email, country) VALUES ('Tech Source', 'sales@techsource.example', 'IN'), ('Book World', NULL, 'IN'), ('Global Parts', 'info@globalparts.example', 'SG');
INSERT INTO stock_levels (warehouse_id, product_id, quantity_on_hand, reorder_level, last_counted_at) VALUES
(1, 1, 120, 20, '2025-06-01 08:00:00'), (1, 2, 40, 10, '2025-06-01 08:00:00'), (1, 3, 15, 10, NULL),
(2, 1, 30, 20, '2025-06-02 08:00:00'), (2, 5, 200, 50, '2025-06-02 08:00:00'), (2, 8, 5, 10, NULL);
INSERT INTO supplier_products (supplier_id, product_id, lead_time_days) VALUES (1, 1, 7), (1, 2, 10), (1, 3, 14), (2, 5, 3), (3, 8, 21);
`;

function pg() {
  const ddl = shared
    .replace(/INT NOT NULL PRIMARY KEY AUTO_INCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/\bDATETIME\b/g, 'TIMESTAMP')
    .replace(/TINYINT\(1\)/g, 'SMALLINT')
    .replace(/\bTINYINT\b/g, 'SMALLINT');
  return `${ddl}\n${view}\n${index}\nCOMMENT ON COLUMN orders.status IS '${COMMENT}';\nCOMMENT ON TABLE customers IS 'People who can place orders';\n${data}`;
}

function mysql() {
  const ddl = shared.replace("status VARCHAR(20) NOT NULL DEFAULT 'pending',", `status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '${COMMENT}',`);
  return `${ddl}\n${view}\n${index}\nALTER TABLE customers COMMENT = 'People who can place orders';\n${data}`;
}

function sqlite() {
  const ddl = shared
    .replace(/INT NOT NULL PRIMARY KEY AUTO_INCREMENT/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bINT\b/g, 'INTEGER');
  return `${ddl}\n${view}\n${index}\n${data}`;
}

function mssql() {
  const ddl = shared
    .replace(/INT NOT NULL PRIMARY KEY AUTO_INCREMENT/g, 'INT IDENTITY(1,1) NOT NULL PRIMARY KEY')
    .replace(/\bDATETIME\b/g, 'DATETIME2')
    .replace(/TINYINT\(1\)/g, 'BIT')
    .replace(/\bVARCHAR\b/g, 'NVARCHAR')
    .replace(/\bTEXT\b/g, 'NVARCHAR(MAX)');
  // Each CREATE TABLE is its own batch so that a CREATE VIEW can start a batch.
  const batches = ddl.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean).map((s) => s + ';').join('\nGO\n');
  const comment = `EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'${COMMENT}', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'orders', @level2type = N'COLUMN', @level2name = N'status';`;
  return `${batches}\nGO\n${view}\nGO\n${index}\nGO\n${comment}\nGO\n${data}\nGO\n`;
}

const out = { postgres: pg(), mysql: mysql(), sqlite: sqlite(), mssql: mssql() };
for (const [engine, text] of Object.entries(out)) fs.writeFileSync(path.join(__dirname, `${engine}.sql`), text);
console.log('written:', Object.keys(out).map((e) => `${e}.sql (${out[e].split('\n').length} lines)`).join(', '));
