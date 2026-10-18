CREATE TABLE customers (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  phone VARCHAR(20),
  created_at DATETIME NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE addresses (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
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
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  parent_id INT,
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id)
);

CREATE TABLE products (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  sku VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  category_id INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  is_discontinued TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id)
);

CREATE TABLE orders (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  shipping_address_id INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_amount DECIMAL(12,2) NOT NULL,
  placed_at DATETIME NOT NULL,
  shipped_at DATETIME,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_orders_address FOREIGN KEY (shipping_address_id) REFERENCES addresses (id)
);

CREATE TABLE order_items (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE payments (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  method VARCHAR(20) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  paid_at DATETIME,
  transaction_ref VARCHAR(64),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE reviews (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  product_id INT NOT NULL,
  customer_id INT NOT NULL,
  rating TINYINT NOT NULL,
  title VARCHAR(120),
  body TEXT,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_reviews_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
);
