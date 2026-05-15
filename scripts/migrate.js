const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config();

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  const [views] = await connection.query(
    "SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?",
    [process.env.DB_NAME],
  );
  const [tables] = await connection.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    [process.env.DB_NAME],
  );
  await connection.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const view of views) {
    await connection.query(`DROP VIEW IF EXISTS \`${view.name}\``);
  }
  for (const table of tables) {
    await connection.query(`DROP TABLE IF EXISTS \`${table.name}\``);
  }
  await connection.query("SET FOREIGN_KEY_CHECKS = 1");

  const sql = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
  await connection.query(sql);
  await connection.end();
  console.log("Banco recriado com sucesso.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
