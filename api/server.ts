/**
 * api — the kernel over HTTP (decision 0040), on Node's own `http`.
 *
 * `openapi.json` is the contract; `routes` below is what serves it, and a
 * test holds the two equal. Three rules, before any route runs:
 *
 * - **The instance's token, or nothing.** A bearer token compared in constant
 *   time. It says the caller holds it — not who acts.
 * - **No person over a token.** An actor is attribution, declared by the
 *   caller (doctrine 5); any caller can declare any actor, so a request
 *   naming `human` is refused, and what only a person may do is not here.
 * - **No event in.** Inbound is pulled (0017); nothing here receives a push.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { and, asc, eq } from "drizzle-orm";

import { run } from "@werunfoundry/core/db/schema";
import type { DomainManifest } from "@werunfoundry/core/manifest/types";
import { planErasure } from "@werunfoundry/core/runtime/erase";
import type { Database } from "@werunfoundry/core/runtime/run";
import { draft, draftState } from "@werunfoundry/acquisition/db/schema";
import { propose } from "@werunfoundry/acquisition/runtime/draft";

export interface ApiDeps {
  db: Database;
  /** The enabled domains, for what they declare — erasure, today. */
  domains: readonly DomainManifest[];
  token: string;
}

type Reply = { status: number; body: unknown };
type Handler = (deps: ApiDeps, req: { params: Record<string, string>; query: URLSearchParams; body: unknown }) => Promise<Reply>;

export const MIN_TOKEN = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 1_000_000;

class BadRequest extends Error {}

const object = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body is a JSON object");
  return body as Record<string, unknown>;
};
const uuid = (v: unknown, what: string) => {
  if (typeof v !== "string" || !UUID.test(v)) throw new BadRequest(`${what} is a uuid`);
  return v;
};
const text = (v: unknown, what: string) => {
  if (typeof v !== "string") throw new BadRequest(`${what} is a string`);
  return v;
};
const integer = (v: unknown, what: string, min: number) => {
  if (!Number.isInteger(v) || (v as number) < min) throw new BadRequest(`${what} is an integer, at least ${min}`);
  return v as number;
};

/** The actor as declared; a person is refused, because a token cannot say one acts. */
function actorOf(v: unknown): { type: "agent" | "system"; id?: string } | Reply {
  const a = object(v);
  if (a.type === "human") return { status: 403, body: { refused: "a person cannot act through this API: its token says who holds it, not who acts (decision 0040)" } };
  if (a.type !== "agent" && a.type !== "system") throw new BadRequest("actor.type is agent or system");
  if (a.id !== undefined && typeof a.id !== "string") throw new BadRequest("actor.id is a string");
  return { type: a.type, ...(typeof a.id === "string" ? { id: a.id } : {}) };
}

const draftView = (d: typeof draft.$inferSelect) => ({
  id: d.id,
  experimentId: d.experimentId,
  personId: d.personId,
  step: d.step,
  state: d.state,
  renderedSubject: d.renderedSubject,
  renderedBody: d.renderedBody,
  decidedBy: d.decidedBy,
});

export const routes: { method: string; path: string; handler: Handler }[] = [
  { method: "get", path: "/v1/health", handler: async () => ({ status: 200, body: { ok: true } }) },
  {
    method: "get",
    path: "/v1/runs/{id}",
    handler: async ({ db }, { params }) => {
      const [r] = await db.select().from(run).where(eq(run.id, uuid(params.id, "the run id")));
      if (!r) return { status: 404, body: { refused: "no such run" } };
      const { id, processKey, status, actorType, actorId, dryRun, startedAt, finishedAt, error } = r;
      return { status: 200, body: { id, processKey, status, actorType, actorId, dryRun, startedAt, finishedAt, error } };
    },
  },
  {
    method: "get",
    path: "/v1/drafts",
    handler: async ({ db }, { query }) => {
      const state = query.get("state");
      if (!state || !(draftState.enumValues as readonly string[]).includes(state)) throw new BadRequest(`state is one of ${draftState.enumValues.join(", ")}`);
      const rows = await db
        .select()
        .from(draft)
        .where(and(eq(draft.state, state as (typeof draftState.enumValues)[number])))
        .orderBy(asc(draft.createdAt))
        .limit(100);
      return { status: 200, body: { drafts: rows.map(draftView) } };
    },
  },
  {
    method: "post",
    path: "/v1/drafts",
    handler: async ({ db }, { body }) => {
      const b = object(body);
      const allowed = new Set(["experimentId", "personId", "step", "templateId", "renderedSubject", "renderedBody", "sender", "autonomyAfter", "reactiveWithinMinutes", "actor", "runId"]);
      for (const k of Object.keys(b)) if (!allowed.has(k)) throw new BadRequest(`${k} is not a field of this operation`);
      const actor = actorOf(b.actor);
      if ("status" in actor) return actor;
      const proposed = await propose(
        db,
        {
          experimentId: uuid(b.experimentId, "experimentId"),
          personId: uuid(b.personId, "personId"),
          step: integer(b.step, "step", 0),
          ...(b.templateId !== undefined ? { templateId: uuid(b.templateId, "templateId") } : {}),
          renderedBody: text(b.renderedBody, "renderedBody"),
          ...(b.renderedSubject !== undefined ? { renderedSubject: text(b.renderedSubject, "renderedSubject") } : {}),
          ...(b.sender !== undefined ? { sender: text(b.sender, "sender") } : {}),
        },
        { actor, ...(b.runId !== undefined ? { runId: uuid(b.runId, "runId") } : {}) },
        {
          autonomyAfter: integer(b.autonomyAfter, "autonomyAfter", 1),
          ...(b.reactiveWithinMinutes !== undefined ? { reactiveWithinMinutes: integer(b.reactiveWithinMinutes, "reactiveWithinMinutes", 1) } : {}),
        },
      );
      if (!proposed.ok) return { status: 422, body: { refused: proposed.refused } };
      return { status: 201, body: { outcome: proposed.outcome, draft: draftView(proposed.draft) } };
    },
  },
  {
    method: "get",
    path: "/v1/people/{id}/erasure",
    handler: async ({ db, domains }, { params }) => ({ status: 200, body: { steps: await planErasure(db, domains, uuid(params.id, "the person id")) } }),
  },
];

const compiled = routes.map((r) => ({
  ...r,
  pattern: new RegExp(`^${r.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`),
}));

const digest = (s: string) => createHash("sha256").update(s).digest();

/** The request handler. Refuses to exist without a token long enough to be one. */
export function createApi(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  if (typeof deps.token !== "string" || deps.token.length < MIN_TOKEN) throw new Error(`the API needs the instance's token, at least ${MIN_TOKEN} characters`);
  const expected = digest(deps.token);

  const send = (res: ServerResponse, reply: Reply) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  };

  return (req, res) => {
    void (async () => {
      const header = req.headers.authorization ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      // Hashed first, so the comparison takes the same time whatever the length.
      if (!timingSafeEqual(digest(given), expected)) return send(res, { status: 401, body: { refused: "the instance's token is required" } });

      const url = new URL(req.url ?? "/", "http://localhost");
      const method = (req.method ?? "GET").toLowerCase();
      const route = compiled.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!route) return send(res, { status: 404, body: { refused: "no such operation" } });

      let body: unknown;
      if (method === "post") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) return send(res, { status: 400, body: { refused: "the body is too large" } });
          chunks.push(chunk as Buffer);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(res, { status: 400, body: { refused: "the body is not JSON" } });
        }
      }
      try {
        const params = (route.pattern.exec(url.pathname)?.groups ?? {}) as Record<string, string>;
        send(res, await route.handler(deps, { params, query: url.searchParams, body }));
      } catch (error) {
        if (error instanceof BadRequest) return send(res, { status: 400, body: { refused: error.message } });
        send(res, { status: 500, body: { refused: "the operation failed; the run, if one was opened, says why" } });
      }
    })();
  };
}
