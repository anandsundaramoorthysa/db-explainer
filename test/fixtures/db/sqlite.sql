CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  phone VARCHAR(20),
  created_at DATETIME NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  line1 VARCHAR(150) NOT NULL,
  line2 VARCHAR(150),
  city VARCHAR(80) NOT NULL,
  state VARCHAR(80),
  postal_code VARCHAR(12) NOT NULL,
  country CHAR(2) NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_addresses_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(80) NOT NULL,
  parent_id INTEGER,
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id)
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  category_id INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  is_discontinued TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  shipping_address_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_amount DECIMAL(12,2) NOT NULL,
  placed_at DATETIME NOT NULL,
  shipped_at DATETIME,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_orders_address FOREIGN KEY (shipping_address_id) REFERENCES addresses (id)
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  method VARCHAR(20) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  paid_at DATETIME,
  transaction_ref VARCHAR(64),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  rating TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title VARCHAR(120),
  body TEXT,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_reviews_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(80) NOT NULL,
  city VARCHAR(80) NOT NULL,
  capacity INTEGER NOT NULL
);

CREATE TABLE stock_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity_on_hand INTEGER NOT NULL,
  reorder_level INTEGER NOT NULL DEFAULT 10,
  last_counted_at DATETIME,
  CONSTRAINT fk_stock_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(120) NOT NULL,
  contact_email VARCHAR(150),
  country CHAR(2) NOT NULL
);

CREATE TABLE supplier_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  lead_time_days INTEGER NOT NULL,
  CONSTRAINT fk_supplier_products_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT fk_supplier_products_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE VIEW customer_order_totals AS
SELECT c.id AS customer_id, c.full_name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount), 0) AS total_spent
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.full_name;
CREATE INDEX idx_orders_placed_at ON orders (placed_at);

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
