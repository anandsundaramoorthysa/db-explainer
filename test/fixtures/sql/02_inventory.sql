CREATE TABLE warehouses (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  city VARCHAR(80) NOT NULL,
  capacity INT NOT NULL
);

CREATE TABLE stock_levels (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  warehouse_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity_on_hand INT NOT NULL,
  reorder_level INT NOT NULL DEFAULT 10,
  last_counted_at DATETIME,
  CONSTRAINT fk_stock_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE suppliers (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  contact_email VARCHAR(150),
  country CHAR(2) NOT NULL
);

CREATE TABLE supplier_products (
  id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  supplier_id INT NOT NULL,
  product_id INT NOT NULL,
  lead_time_days INT NOT NULL,
  CONSTRAINT fk_supplier_products_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT fk_supplier_products_product FOREIGN KEY (product_id) REFERENCES products (id)
);
