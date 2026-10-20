const pg = require("pg");
const dotenv = require("dotenv");
dotenv.config({ path: "indexer/.env" });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name;
  `);
  console.log("Existing tables:", tables.rows.map(r => r.table_name));
  await pool.end();
}
check().catch(console.error);
