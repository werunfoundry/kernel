/**
 * The sandbox adapters' shared store: invented data, and a local file for
 * what they write.
 *
 * Every adapter whose name starts with `sandbox-` answers from here, so that
 * an instance generated from the template boots, verifies and runs its
 * enrolment path before anyone has an account anywhere. They are not
 * adapters to copy — `example-crm.ts` is, because it talks to an API. Replace
 * each binding in `manifest.yaml` with a real adapter, one at a time.
 *
 * Unreadable data is an error, never an empty list: "the source has nobody"
 * and "the source could not be read" are not the same answer (0016, 0017).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CallError, CallResult } from "@werunfoundry/core/contracts/types";

export interface SandboxData {
  companies: { domain: string; name: string; externalId: string }[];
  protected: { domain: string; externalId: string; reason: "customer" | "open_opportunity" | "partner" | "do_not_contact" | "other" }[];
  /** `profileId` is an invented id on the network the enrichment binding names: immutable, as 0013 means it. */
  people: { domain: string; email: string; profileId: string; name: string; title?: string }[];
  events: { id: string; type: string; occurredAt: string; email: string }[];
  /**
   * What the CRM already holds — domains and addresses. Not the target
   * list's companies: a CRM knows the accounts in conversation, which is why
   * it excludes them from cold prospecting (0031). Absent is an empty CRM.
   */
  crm?: { companies: string[]; people: string[] };
}

export interface SandboxState {
  /**
   * sequenceKey → email → the idempotency key it was enrolled under, when,
   * and the variables it carried: the messages the kernel wrote (0064).
   */
  enrolments: Record<string, Record<string, { key: string; at: string; variables?: Record<string, string> }>>;
  suppressed: string[];
  crm: { email: string; reason: string }[];
  notes: { subject: string; body: string; at: string }[];
  /**
   * The sequences whose way-out line the sandbox refuses to write (0067):
   * what lets a run see an enrolment made without one. Set by hand, or by a
   * test; the sandbox never writes it.
   */
  wayOutRefused?: string[];
}

const unavailable = (message: string): { ok: false; error: CallError } => ({
  ok: false,
  error: { code: "unavailable", message, retryable: false },
});

/** The invented data, next to this file unless the binding says otherwise. */
export function loadData(file?: string | number | boolean): CallResult<SandboxData> {
  const path = typeof file === "string" ? resolve(file) : new URL("./sandbox-data.json", import.meta.url);
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as SandboxData };
  } catch (error) {
    return unavailable(`sandbox data unreadable: ${(error as Error).message.split("\n")[0]}`);
  }
}

/** The state file, in the instance root unless the binding says otherwise. */
export function stateFile(option?: string | number | boolean): string {
  return resolve(process.cwd(), typeof option === "string" ? option : ".sandbox-state.json");
}

export function loadState(path: string): CallResult<SandboxState> {
  const empty: SandboxState = { enrolments: {}, suppressed: [], crm: [], notes: [] };
  if (!existsSync(path)) return { ok: true, value: empty };
  try {
    return { ok: true, value: { ...empty, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<SandboxState>) } };
  } catch (error) {
    return unavailable(`sandbox state unreadable: ${(error as Error).message.split("\n")[0]}`);
  }
}

export function saveState(path: string, state: SandboxState): CallResult<void> {
  try {
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    return { ok: true, value: undefined };
  } catch (error) {
    return unavailable(`sandbox state unwritable: ${(error as Error).message.split("\n")[0]}`);
  }
}
