/**
 * adapters/attio/crm — the relations `Crm` contract, against Attio.
 *
 *   - contract: crm
 *     adapter: "@werunfoundry/adapters/attio/crm"
 *     env: [ATTIO_API_KEY]
 *
 * It lives beside the Attio inbound adapter, so that both share one client and
 * one token: one folder per provider, whichever domains own the contracts it
 * satisfies (decision 0023).
 *
 * How the contract maps:
 *
 * - **Records are people and companies**, found by the verbose filter
 *   syntax on `email_addresses` and `domains`.
 * - **A reference is `<object>:<record_id>`.** The contract's `CrmRef` does
 *   not say which object a record belongs to, and Attio needs it to attach a
 *   note; the adapter reads its own references, which the engine never
 *   parses.
 * - **Registering is idempotent by Attio's own key.** Attio takes no
 *   idempotency key. A person is looked up by address first — an existing one
 *   is returned with `existed: true` and nothing written — and created with
 *   `PUT …/records?matching_attribute=email_addresses`, an upsert, so that a
 *   replay racing the first call updates the same record instead of creating a
 *   second. The company, when the registration names a domain, is upserted
 *   the same way on `domains` and linked.
 * - **The reason is not written.** Attio has no standard attribute for "why
 *   this record exists", and inventing one would write a field into every
 *   instance's workspace. The reason stays in the engine's run.
 * - **Notes are idempotent by content and time.** Attio takes no key for a
 *   note either. A note is created backdated to `occurredAt`, and a note on
 *   the same record with the same time and the same text is taken to be the
 *   same note. Two genuinely different notes with identical text at the same
 *   instant would be merged; nothing writes those.
 */

import type { AdapterFactory, CallContext, CallResult } from "@werunfoundry/core/contracts/types";
import type { Crm, CrmCompany, CrmPerson, CrmRegistrationResult } from "@werunfoundry/relations/contracts/crm";

import { DEFAULT_BASE_URL, client, fail } from "../client.js";

interface AttioRecord {
  id: { record_id: string };
  web_url?: string;
  values?: Record<string, unknown[]>;
}

/** The first value's field, for the value shapes Attio returns. */
function first(values: Record<string, unknown[]> | undefined, attribute: string, field: string): string | undefined {
  const v = values?.[attribute]?.[0] as Record<string, unknown> | undefined;
  const x = v?.[field];
  return typeof x === "string" ? x : undefined;
}

const ref = (object: "people" | "companies", r: AttioRecord) =>
  r.web_url ? { externalId: `${object}:${r.id.record_id}`, url: r.web_url } : { externalId: `${object}:${r.id.record_id}` };

const asCompany = (r: AttioRecord): CrmCompany => {
  const name = first(r.values, "name", "value");
  const domain = first(r.values, "domains", "domain");
  return { ref: ref("companies", r), ...(name ? { name } : {}), ...(domain ? { domain } : {}), fields: {} };
};

const asPerson = (r: AttioRecord): CrmPerson => {
  const email = first(r.values, "email_addresses", "email_address");
  const fullName = first(r.values, "name", "full_name");
  return { ref: ref("people", r), ...(email ? { email } : {}), ...(fullName ? { fullName } : {}), fields: {} };
};

const factory: AdapterFactory<Crm> = ({ options, env }) => {
  const { call, probe } = client(
    env.ATTIO_API_KEY,
    String(options.baseUrl ?? DEFAULT_BASE_URL),
    typeof options.timeoutMs === "number" ? options.timeoutMs : undefined,
  );

  async function findOne(object: "people" | "companies", filter: unknown, ctx: CallContext): Promise<CallResult<AttioRecord | null>> {
    const found = await call<{ data: AttioRecord[] }>("POST", `/v2/objects/${object}/records/query`, ctx, { filter, limit: 1 });
    if (!found.ok) return found;
    return { ok: true, value: found.value.data[0] ?? null };
  }
  const byDomain = (domain: string, ctx: CallContext) =>
    findOne("companies", { domains: { domain: { $eq: domain.trim().toLowerCase() } } }, ctx);
  const byEmail = (email: string, ctx: CallContext) =>
    findOne("people", { email_addresses: { email_address: { $eq: email.trim().toLowerCase() } } }, ctx);

  return {
    provider: "attio",
    probe,

    async findCompanyByDomain(domain, ctx) {
      const r = await byDomain(domain, ctx);
      return r.ok ? { ok: true, value: r.value ? asCompany(r.value) : null } : r;
    },

    async findPersonByEmail(email, ctx) {
      const r = await byEmail(email, ctx);
      return r.ok ? { ok: true, value: r.value ? asPerson(r.value) : null } : r;
    },

    async register(registration, ctx): Promise<CallResult<CrmRegistrationResult>> {
      const email = registration.person.email?.trim().toLowerCase();
      if (!email) return fail("invalid", "Attio matches a person by email; this registration has none");

      const existing = await byEmail(email, ctx);
      if (!existing.ok) return existing;
      if (existing.value) return { ok: true, value: { person: asPerson(existing.value), existed: true } };

      const domain = registration.company?.domain?.trim().toLowerCase();
      if (ctx.dryRun) {
        // Every read the real call depends on, and no write.
        const company = domain ? await byDomain(domain, ctx) : undefined;
        if (company && !company.ok) return company;
        return {
          ok: true,
          simulated: true,
          value: {
            person: { ref: { externalId: "(would be created)" }, email, fields: {} },
            ...(company?.ok && company.value ? { company: asCompany(company.value) } : {}),
            existed: false,
          },
        };
      }

      let company: AttioRecord | undefined;
      if (domain) {
        const upserted = await call<{ data: AttioRecord }>("PUT", "/v2/objects/companies/records?matching_attribute=domains", ctx, {
          data: { values: { domains: [domain], ...(registration.company?.name ? { name: registration.company.name } : {}) } },
        });
        if (!upserted.ok) return upserted;
        company = upserted.value.data;
      }

      const fullName = registration.person.fullName?.trim();
      const [firstName, ...rest] = (fullName ?? "").split(/\s+/).filter(Boolean);
      const person = await call<{ data: AttioRecord }>("PUT", "/v2/objects/people/records?matching_attribute=email_addresses", ctx, {
        data: {
          values: {
            email_addresses: [email],
            ...(fullName ? { name: [{ first_name: firstName ?? "", last_name: rest.join(" "), full_name: fullName }] } : {}),
            ...(company ? { company: [{ target_object: "companies", target_record_id: company.id.record_id }] } : {}),
          },
        },
      });
      if (!person.ok) return person;
      return {
        ok: true,
        value: { person: asPerson(person.value.data), ...(company ? { company: asCompany(company) } : {}), existed: false },
      };
    },

    async annotate(note, ctx): Promise<CallResult<void>> {
      const [object, recordId] = note.subject.externalId.split(":");
      if ((object !== "people" && object !== "companies") || !recordId) {
        return fail("invalid", "not a reference this adapter made: expected people:<id> or companies:<id>");
      }
      const at = new Date(note.occurredAt);
      if (Number.isNaN(at.getTime())) return fail("invalid", "occurredAt is not a time");

      // Every page, not the first: a note missed on page two is a duplicate
      // written on replay.
      const PAGE = 50;
      for (let offset = 0; ; offset += PAGE) {
        const listed = await call<{ data: { created_at: string; content_plaintext: string }[] }>(
          "GET",
          `/v2/notes?parent_object=${object}&parent_record_id=${encodeURIComponent(recordId)}&limit=${PAGE}&offset=${offset}`,
          ctx,
        );
        if (!listed.ok) return listed;
        if (listed.value.data.some((n) => Date.parse(n.created_at) === at.getTime() && n.content_plaintext === note.body)) {
          return { ok: true, value: undefined };
        }
        if (listed.value.data.length < PAGE) break;
      }
      if (ctx.dryRun) return { ok: true, simulated: true, value: undefined };

      const created = await call<unknown>("POST", "/v2/notes", ctx, {
        data: {
          parent_object: object,
          parent_record_id: recordId,
          title: note.body.split("\n")[0]!.slice(0, 80) || "Note",
          format: "plaintext",
          content: note.body,
          created_at: at.toISOString(),
        },
      });
      return created.ok ? { ok: true, value: undefined } : created;
    },
  };
};

export default factory;
