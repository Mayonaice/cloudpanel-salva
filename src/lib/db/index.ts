import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { getDatabaseConfig } from "../env";
import * as schema from "./schema";

let pool: Pool | undefined;

export function getDb() {
  if (!pool) {
    const config = getDatabaseConfig();
    pool = new Pool({
      connectionString: config.url,
      max: 5,
      ssl: config.ssl ? {
        rejectUnauthorized: true,
        ...(process.env.DATABASE_SSL_CA_FILE ? { ca: readFileSync(process.env.DATABASE_SSL_CA_FILE, "utf8") } : {})
      } : undefined
    });
  }
  return drizzle(pool, { schema });
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}
