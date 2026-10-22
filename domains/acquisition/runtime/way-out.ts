/**
 * acquisition/runtime — the way-out line an instance declares (decisions
 * 0065, 0067, 0069).
 *
 * Set on the sequencer's binding, under `settings.acquisition.wayOut`, and
 * read here, never by the adapter: the line a person reads is not held by
 * the layer that talks to the provider (0069). Two forms:
 *
 * - `{ line: "…{link}…" }` — the words the kernel adds after every body it
 *   writes, on one line, with `{link}` once where the provider's link goes.
 *   The instance writes the words; the kernel guarantees the link (0067 §1);
 * - `cut` — the instance cuts the way out, and each enrolment records that
 *   it did (0065 §2).
 *
 * Nothing set is neither: the enrolment goes without a way out, records why,
 * and the run says so aloud (0069). No line is ever written by the kernel in
 * its place: it would be words nobody read, put in someone's message.
 */

export const LINK = "{link}";

export type WayOutSetting =
  | { line: string }
  | { cut: true }
  | { undeclared: true }
  | { malformed: string };

/** What the binding's `settings.acquisition.wayOut` says, read once per run. */
export function readWayOut(settings: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined): WayOutSetting {
  const value = settings?.acquisition?.wayOut;
  if (value === undefined) return { undeclared: true };
  if (value === "cut") return { cut: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { malformed: "wayOut is `cut`, or `{ line: \"…{link}…\" }`" };
  }
  const extra = Object.keys(value).filter((k) => k !== "line");
  if (extra.length > 0) return { malformed: `wayOut carries a line and nothing else, not ${extra.map((k) => `"${k}"`).join(", ")}` };
  const line = (value as { line?: unknown }).line;
  if (typeof line !== "string" || line.trim() === "") return { malformed: "wayOut.line is the words of the line, and is empty" };
  if (/[\r\n]/.test(line)) return { malformed: "wayOut.line is one line: what follows the body is exactly that line (decision 0067)" };
  const links = line.split(LINK).length - 1;
  if (links !== 1) return { malformed: `wayOut.line names ${LINK} ${links === 0 ? "nowhere" : `${links} times`}: once, where the provider's link goes` };
  return { line: line.trim() };
}

/** The line, the link in its place. */
export const lineWith = (line: string, link: string) => line.replace(LINK, link);
