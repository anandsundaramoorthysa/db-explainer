# Share a database

There are two ways to show DB Explainer a database. Neither needs an export.

**A live connection.** Choose *Add Database Connection*, pick MySQL or MariaDB, PostgreSQL, SQL Server or SQLite, and enter the details. Use a read-only account if you can. DB Explainer also opens every connection in read-only mode and never runs anything except SELECT.

**Shared SQL.** Right-click a `.sql` file and choose *Share SQL With the Chat*, or run the command from the Command Palette with SQL selected. The tables, keys and views in the script are read for you. Nothing is run.

Your password is kept in VS Code secret storage on this computer.
