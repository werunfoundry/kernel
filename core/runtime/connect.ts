/**
 * core/runtime — a database connection, made with the instance's own driver.
 *
 * The kernel declares no driver (see `run.ts`, decision 0010). The commands
 * it ships — verify, migrate, enrol — connect with the `pg` and `drizzle-orm`
 * the instance installed, resolved from the instance root as decision 0007
 * resolves every name the instance chose.
 */

import { resolvePackage } from "./resolve.js";
import type { Database } from "./run.js";

export interface Connection {
  db: Database;
  end(): Promise<void>;
}

export async function connect(url: string, root: string, who = "this command"): Promise<Connection> {
  let pg: {
    Client: new (config: { connectionString: string }) => {
      connect(): Promise<void>;
      end(): Promise<void>;
      on(event: "error", listener: (error: Error) => void): void;
    };
  };
  let drizzle: (client: unknown) => unknown;
  try {
    pg = ((await import(resolvePackage("pg", root))) as { default: typeof pg }).default;
    ({ drizzle } = (await import(resolvePackage("drizzle-orm/node-postgres", root))) as { drizzle: typeof drizzle });
  } catch (error) {
    throw new Error(
      `${who} connects with this instance's own pg and drizzle-orm, and could not load them — ` +
        `add both to its dependencies (${(error as Error).message.split("\n")[0]})`,
    );
  }
  const client = new pg.Client({ connectionString: url });
  // A connection the server drops emits "error" outside any await. Without a
  // listener that is an uncaught exception, and the process dies with a stack
  // trace instead of a report. The failure itself surfaces where it matters:
  // in the query that needed the connection.
  client.on("error", () => {});
  await client.connect();
  return { db: drizzle(client) as Database, end: () => client.end() };
}
