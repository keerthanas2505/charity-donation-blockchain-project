const pg = require("pg");
const dotenv = require("dotenv");
dotenv.config({ path: "indexer/.env" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 2000,
});

pool.query("SELECT current_database(), now()")
  .then(res => {
    console.log("PostgreSQL connected successfully:", res.rows[0]);
    process.exit(0);
  })
  .catch(err => {
    console.log("PostgreSQL check status:", err.message);
    process.exit(0);
  });
