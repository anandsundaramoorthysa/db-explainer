
-- ---------------------------------------------------------------------
-- SCHEMA (so the bot has context for the queries below)
-- ---------------------------------------------------------------------
CREATE TABLE customers (
    customer_id   INT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(150) UNIQUE,
    country       VARCHAR(50),
    signup_date   DATE
);

CREATE TABLE products (
    product_id    INT PRIMARY KEY,
    product_name  VARCHAR(100) NOT NULL,
    category      VARCHAR(50),
    price         DECIMAL(10, 2)
);

CREATE TABLE orders (
    order_id      INT PRIMARY KEY,
    customer_id   INT REFERENCES customers(customer_id),
    order_date    DATE,
    status        VARCHAR(20)
);

CREATE TABLE order_items (
    order_id      INT REFERENCES orders(order_id),
    product_id    INT REFERENCES products(product_id),
    quantity      INT,
    PRIMARY KEY (order_id, product_id)
);

CREATE TABLE employees (
    employee_id   INT PRIMARY KEY,
    name          VARCHAR(100),
    manager_id    INT REFERENCES employees(employee_id),
    department    VARCHAR(50),
    salary        DECIMAL(10, 2)
);


-- ---------------------------------------------------------------------
-- LEVEL 1: BASICS
-- ---------------------------------------------------------------------

-- 1.1 Simple select with filter
SELECT name, email
FROM customers
WHERE country = 'India';

-- 1.2 Sorting and limiting
SELECT product_name, price
FROM products
ORDER BY price DESC
LIMIT 5;

-- 1.3 Pattern matching and NULL handling
SELECT name
FROM customers
WHERE email LIKE '%@gmail.com'
  AND signup_date IS NOT NULL;

-- 1.4 DISTINCT and IN
SELECT DISTINCT category
FROM products
WHERE category IN ('Electronics', 'Books', 'Toys');


-- ---------------------------------------------------------------------
-- LEVEL 2: AGGREGATION
-- ---------------------------------------------------------------------

-- 2.1 GROUP BY with COUNT
SELECT country, COUNT(*) AS customer_count
FROM customers
GROUP BY country;

-- 2.2 HAVING (filtering groups, not rows)
SELECT category, AVG(price) AS avg_price
FROM products
GROUP BY category
HAVING AVG(price) > 50;

-- 2.3 Multiple aggregates
SELECT
    department,
    COUNT(*)      AS headcount,
    MIN(salary)   AS min_salary,
    MAX(salary)   AS max_salary,
    ROUND(AVG(salary), 2) AS avg_salary
FROM employees
GROUP BY department
ORDER BY avg_salary DESC;


-- ---------------------------------------------------------------------
-- LEVEL 3: JOINS
-- ---------------------------------------------------------------------

-- 3.1 INNER JOIN
SELECT c.name, o.order_id, o.order_date
FROM customers c
INNER JOIN orders o ON o.customer_id = c.customer_id;

-- 3.2 LEFT JOIN to find customers with NO orders
SELECT c.customer_id, c.name
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.customer_id
WHERE o.order_id IS NULL;

-- 3.3 Multi-table join with aggregation (total revenue per customer)
SELECT
    c.name,
    SUM(oi.quantity * p.price) AS total_spent
FROM customers c
JOIN orders o       ON o.customer_id = c.customer_id
JOIN order_items oi ON oi.order_id   = o.order_id
JOIN products p     ON p.product_id  = oi.product_id
WHERE o.status = 'completed'
GROUP BY c.name
ORDER BY total_spent DESC;

-- 3.4 Self join (employee and their manager)
SELECT e.name AS employee, m.name AS manager
FROM employees e
LEFT JOIN employees m ON e.manager_id = m.employee_id;


-- ---------------------------------------------------------------------
-- LEVEL 4: SUBQUERIES AND CTEs
-- ---------------------------------------------------------------------

-- 4.1 Scalar subquery
SELECT name, salary
FROM employees
WHERE salary > (SELECT AVG(salary) FROM employees);

-- 4.2 Correlated subquery (above average within own department)
SELECT e.name, e.department, e.salary
FROM employees e
WHERE e.salary > (
    SELECT AVG(e2.salary)
    FROM employees e2
    WHERE e2.department = e.department
);

-- 4.3 EXISTS
SELECT c.name
FROM customers c
WHERE EXISTS (
    SELECT 1
    FROM orders o
    WHERE o.customer_id = c.customer_id
      AND o.order_date >= DATE '2026-01-01'
);

-- 4.4 CTE
WITH monthly_sales AS (
    SELECT
        DATE_TRUNC('month', o.order_date) AS month,
        SUM(oi.quantity * p.price)        AS revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id  = o.order_id
    JOIN products p     ON p.product_id = oi.product_id
    GROUP BY DATE_TRUNC('month', o.order_date)
)
SELECT month, revenue
FROM monthly_sales
WHERE revenue > 10000
ORDER BY month;


-- ---------------------------------------------------------------------
-- LEVEL 5: WINDOW FUNCTIONS
-- ---------------------------------------------------------------------

-- 5.1 ROW_NUMBER / RANK within a group
SELECT
    name,
    department,
    salary,
    RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS dept_rank
FROM employees;

-- 5.2 Top N per group
SELECT *
FROM (
    SELECT
        p.category,
        p.product_name,
        p.price,
        ROW_NUMBER() OVER (PARTITION BY p.category ORDER BY p.price DESC) AS rn
    FROM products p
) ranked
WHERE rn <= 3;

-- 5.3 Running total
SELECT
    order_date,
    order_id,
    SUM(COUNT(*)) OVER (ORDER BY order_date) AS running_order_count
FROM orders
GROUP BY order_date, order_id;

-- 5.4 LAG for period-over-period comparison
WITH daily AS (
    SELECT order_date, COUNT(*) AS orders_per_day
    FROM orders
    GROUP BY order_date
)
SELECT
    order_date,
    orders_per_day,
    LAG(orders_per_day) OVER (ORDER BY order_date) AS prev_day,
    orders_per_day - LAG(orders_per_day) OVER (ORDER BY order_date) AS change
FROM daily;


-- ---------------------------------------------------------------------
-- LEVEL 6: ADVANCED
-- ---------------------------------------------------------------------

-- 6.1 Recursive CTE (full management chain)
WITH RECURSIVE org_chart AS (
    SELECT employee_id, name, manager_id, 1 AS level
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT e.employee_id, e.name, e.manager_id, oc.level + 1
    FROM employees e
    JOIN org_chart oc ON e.manager_id = oc.employee_id
)
SELECT * FROM org_chart ORDER BY level, name;

-- 6.2 CASE expression with conditional aggregation (pivot-style)
SELECT
    c.country,
    SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) AS completed_orders,
    SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
    ROUND(
        100.0 * SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) / COUNT(*),
        1
    ) AS cancel_rate_pct
FROM customers c
JOIN orders o ON o.customer_id = c.customer_id
GROUP BY c.country;

-- 6.3 Set operations
SELECT customer_id FROM orders WHERE status = 'completed'
EXCEPT
SELECT customer_id FROM orders WHERE status = 'cancelled';

-- 6.4 Find duplicate emails
SELECT email, COUNT(*) AS occurrences
FROM customers
GROUP BY email
HAVING COUNT(*) > 1;


-- ---------------------------------------------------------------------
-- LEVEL 7: DML / DDL (write operations)
-- ---------------------------------------------------------------------

-- 7.1 INSERT
INSERT INTO customers (customer_id, name, email, country, signup_date)
VALUES (101, 'Asha Raman', 'asha@example.com', 'India', '2026-10-01');

-- 7.2 UPDATE with subquery
UPDATE products
SET price = price * 1.10
WHERE category = 'Electronics'
  AND product_id IN (
      SELECT product_id FROM order_items GROUP BY product_id HAVING SUM(quantity) > 100
  );

-- 7.3 DELETE with join-style condition
DELETE FROM orders
WHERE status = 'cancelled'
  AND order_date < DATE '2025-01-01';

-- 7.4 Index and view
CREATE INDEX idx_orders_customer_date ON orders (customer_id, order_date);

CREATE VIEW v_customer_revenue AS
SELECT c.customer_id, c.name, SUM(oi.quantity * p.price) AS revenue
FROM customers c
JOIN orders o       ON o.customer_id = c.customer_id
JOIN order_items oi ON oi.order_id   = o.order_id
JOIN products p     ON p.product_id  = oi.product_id
GROUP BY c.customer_id, c.name;


-- ---------------------------------------------------------------------
-- LEVEL 8: EDGE CASES (to stress-test the bot)
-- ---------------------------------------------------------------------

-- 8.1 Query with a subtle bug: comparing to NULL with = (never true)
SELECT name FROM customers WHERE email = NULL;

-- 8.2 Query with a subtle bug: non-aggregated column not in GROUP BY
SELECT country, name, COUNT(*)
FROM customers
GROUP BY country;

-- 8.3 Cartesian product from a missing join condition
SELECT c.name, p.product_name
FROM customers c, products p;

-- 8.4 Inefficient pattern: function on indexed column in WHERE
SELECT * FROM orders WHERE YEAR(order_date) = 2026;

-- 8.5 Deeply nested query (readability test)
SELECT name
FROM customers
WHERE customer_id IN (
    SELECT customer_id FROM orders WHERE order_id IN (
        SELECT order_id FROM order_items WHERE product_id IN (
            SELECT product_id FROM products WHERE price > (
                SELECT AVG(price) FROM products
            )
        )
    )
);

-- 8.6 Intentionally malformed SQL (should the bot flag the syntax error?)
SELEC name FORM customers WERE country = 'India';

-- 8.7 Non-SQL input (should the bot handle this gracefully?)
-- Tell me a joke about databases.
