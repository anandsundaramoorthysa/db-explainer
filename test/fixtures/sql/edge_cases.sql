-- Stress file: real-world SQL that a simple parser may handle badly.
-- Keep this OUTSIDE the schema folder. Copy one statement at a time into schema/ to test it.

-- 1. Composite primary key declared at table level
CREATE TABLE enrollments (
  student_id INT NOT NULL,
  course_id INT NOT NULL,
  enrolled_on DATE NOT NULL,
  PRIMARY KEY (student_id, course_id)
);

-- 2. Table-level UNIQUE constraint and backtick identifiers
CREATE TABLE `course_codes` (
  `id` INT NOT NULL PRIMARY KEY,
  `code` VARCHAR(20) NOT NULL,
  `term` VARCHAR(10) NOT NULL,
  UNIQUE KEY uq_course_term (`code`, `term`)
);

-- 3. ENUM, JSON and DEFAULT expressions, plus table options
CREATE TABLE audit_log (
  id BIGINT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  action ENUM('create', 'update', 'delete') NOT NULL,
  payload JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. IF NOT EXISTS
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(60) NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255)
);

-- 5. Statements that are not CREATE TABLE
CREATE INDEX idx_orders_placed_at ON orders (placed_at);
CREATE VIEW active_customers AS SELECT id, full_name FROM customers WHERE is_active = 1;
ALTER TABLE products ADD COLUMN weight_grams INT;
INSERT INTO settings (setting_key, setting_value) VALUES ('currency', 'INR');
