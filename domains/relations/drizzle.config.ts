import { defineConfig } from "drizzle-kit";

/**
 * Migrations are owned per layer, each with its own journal, so adding a
 * domain renumbers nothing. `schemaFilter` is what stops drizzle-kit from
 * diffing the whole database and proposing to drop the other layers' tables.
 *
 * `DIRECT_URL` and not the pooled URL: migrations need a real session.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  schemaFilter: ["relations"],
  dbCredentials: { url: process.env.DIRECT_URL ?? "" },
  strict: true,
  verbose: true,
});
