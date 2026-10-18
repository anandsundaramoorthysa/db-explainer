-- Rebuilt from the description of sql_explainer_test.db (SQLite). Facts the accuracy tests rely on:
--  * status values are lowercase: completed, cancelled, pending
--  * two different customers are both named "Asha Raman" (1 and 2)
--  * customers 11 (Mei Chen) and 12 (Noah Davis) never ordered
--  * three customers (3, 5, 7) have a cancelled order, and one more cancelled order has customer_id NULL
--  * 3 employees earn above their department average; the management tree has 10 people
CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, country TEXT, signup_date TEXT);
CREATE TABLE products (product_id INTEGER PRIMARY KEY, product_name TEXT NOT NULL, category TEXT, price REAL NOT NULL);
CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id), order_date TEXT, status TEXT NOT NULL);
CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(order_id), product_id INTEGER NOT NULL REFERENCES products(product_id), quantity INTEGER NOT NULL, PRIMARY KEY (order_id, product_id));
CREATE TABLE employees (employee_id INTEGER PRIMARY KEY, name TEXT NOT NULL, manager_id INTEGER REFERENCES employees(employee_id), department TEXT, salary REAL);
CREATE VIEW v_customer_revenue AS
  SELECT c.customer_id, c.name, ROUND(SUM(p.price * oi.quantity), 2) AS revenue
  FROM customers c JOIN orders o ON o.customer_id = c.customer_id JOIN order_items oi ON oi.order_id = o.order_id JOIN products p ON p.product_id = oi.product_id
  WHERE o.status = 'completed' GROUP BY c.customer_id, c.name;

INSERT INTO customers VALUES
 (1, 'Asha Raman', 'asha.r@example.com', 'India', '2023-01-10'),
 (2, 'Asha Raman', 'asha.raman@example.org', 'Singapore', '2023-02-14'),
 (3, 'Ben Carter', 'ben@example.com', 'USA', '2023-03-01'),
 (4, 'Chloe Martin', 'chloe@example.com', 'France', '2023-03-20'),
 (5, 'Dev Patel', 'dev@example.com', 'India', '2023-04-05'),
 (6, 'Elena Petrova', 'elena@example.com', 'Germany', '2023-05-11'),
 (7, 'Farid Khan', 'farid@example.com', 'UAE', '2023-06-02'),
 (8, 'Grace Lee', 'grace@example.com', 'USA', '2023-06-30'),
 (9, 'Hiro Tanaka', 'hiro@example.com', 'Japan', '2023-07-19'),
 (10, 'Isla Brown', 'isla@example.com', 'UK', '2023-08-08'),
 (11, 'Mei Chen', 'mei@example.com', 'China', '2023-09-01'),
 (12, 'Noah Davis', 'noah@example.com', 'USA', '2023-09-15');

INSERT INTO products VALUES
 (1, 'Notebook', 'stationery', 4.99),
 (2, 'Desk Lamp', 'home', 19.99),
 (3, 'Headphones', 'electronics', 59.9),
 (4, 'Keyboard', 'electronics', 34.95),
 (5, 'Water Bottle', 'home', 12.49);

INSERT INTO orders VALUES
 (1, 1, '2024-01-05', 'completed'),
 (2, 1, '2024-02-11', 'completed'),
 (3, 2, '2024-02-12', 'completed'),
 (4, 3, '2024-02-20', 'cancelled'),
 (5, 4, '2024-03-02', 'completed'),
 (6, 5, '2024-03-09', 'cancelled'),
 (7, 6, '2024-03-15', 'pending'),
 (8, 7, '2024-03-21', 'cancelled'),
 (9, 8, '2024-04-01', 'completed'),
 (10, 9, '2024-04-07', 'pending'),
 (11, 10, '2024-04-18', 'completed'),
 (12, NULL, '2024-04-25', 'cancelled'),
 (13, 4, '2024-05-03', 'completed'),
 (14, 8, '2024-05-09', 'pending');

INSERT INTO order_items VALUES
 (1, 1, 3), (1, 2, 1), (2, 3, 1), (3, 5, 2), (4, 4, 1), (5, 3, 2), (5, 1, 4),
 (6, 2, 2), (7, 4, 1), (8, 5, 3), (9, 1, 1), (9, 4, 2), (10, 3, 1), (11, 2, 1),
 (11, 5, 1), (12, 1, 2), (13, 4, 1), (14, 2, 3);

INSERT INTO employees VALUES
 (1, 'Ava Stone', NULL, 'Exec', 200),
 (2, 'Bo Rivera', 1, 'Engineering', 120),
 (3, 'Cy Nguyen', 2, 'Engineering', 100),
 (4, 'Di Okafor', 2, 'Engineering', 80),
 (5, 'Eli Novak', 1, 'Sales', 90),
 (6, 'Fay Moreau', 5, 'Sales', 70),
 (7, 'Gus Haddad', 5, 'Sales', 50),
 (8, 'Hana Ito', 1, 'Operations', 60),
 (9, 'Ivo Silva', 8, 'Operations', 45),
 (10, 'Jun Park', 8, 'Operations', 45);
