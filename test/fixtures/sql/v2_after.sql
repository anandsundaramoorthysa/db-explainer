CREATE TABLE customers (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL,
  loyalty_points INT NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  sku VARCHAR(40) NOT NULL,
  name VARCHAR(150) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL
);

CREATE TABLE orders (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  placed_at DATETIME NOT NULL,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE coupons (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL UNIQUE,
  percent_off INT NOT NULL,
  expires_on DATETIME
);

CREATE TABLE order_coupons (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  coupon_id INT NOT NULL,
  CONSTRAINT fk_order_coupons_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_order_coupons_coupon FOREIGN KEY (coupon_id) REFERENCES coupons (id)
);
