# The Instantly sequencer — what was observed live

The calls decision 0051 rests on. They were run once, on 2026-10-20, against
a live workspace. The test used throwaway campaigns, six throwaway addresses
and one sending account; every object was deleted afterwards. Every claim
here was observed, not read in the documentation, unless it says so. The
documentation is the OpenAPI document (`api.instantly.ai/openapi/api_v2.json`,
v2.0.0) and the help centre.

## Suspending one lead

The criterion was the next step: did it leave? It was checked in
`GET /api/v2/emails` and in the receiving mailbox. The control lead
received every step, about 26 minutes apart for a configured delay of 20.

| Way | Call | Answer | Next step left? | Cost |
| --- | ---- | ------ | --------------- | ---- |
| Status field | `PATCH /api/v2/leads/{id}` with `status` 2, `"Paused"`, `lead_status`, `paused`, `is_paused`, `status` 3 or -2, `unsubscribed`: ten bodies | 200, the full lead back, `status` still 1 | **yes** | — it does nothing, although the schema declares the body `additionalProperties: false` |
| Interest status | `POST /api/v2/leads/update-interest-status` `{lead_email, interest_value: -1, campaign_id}` | 202, a background job; `status` 3 and `lt_interest_status` -1 within seconds | no | writes *Not Interested*: ruled out by 0051 |
| Subsequence | `POST /api/v2/subsequences` (one step, `pre_delay` 300 days), then `POST /api/v2/leads/subsequence/move {id, subsequence_id}` | 200; `subsequence_id` set, `status` still 1 | no, with the subsequence in draft **and** after `POST /api/v2/subsequences/{id}/resume` (38 minutes watched) | `status` reads active; the campaign shows `status` 4, *Running Subsequences*; `subsequence_id` goes when the subsequence is deleted |
| Move | `POST /api/v2/leads/move {ids, campaign, to_campaign_id}` to a campaign never activated | 200, a background job, `success` | no | `campaign` becomes the destination; `status_summary` emptied, `timestamp_last_contact` null |
| Delete | `DELETE /api/v2/leads/{id}` | 200; then `GET` 404 | no | the record is gone; its sent emails stay |

## What the adapter does with it

`withdraw` parks the lead, the least destructive way above that says nothing
about the person. Each sequence is bound to a parking subsequence the
instance creates in its campaign: one step, with a `pre_delay` longer than
the campaign lives. The adapter never creates or edits one.

    options:
      campaign.<sequenceKey>: <campaign id>
      subsequence.<sequenceKey>: <its parking subsequence id>

1. It finds the lead by email in the campaign.
2. It reads the subsequence (`GET /api/v2/subsequences/{id}`): its
   `parent_campaign` must be the campaign, or that campaign keeps sending.
3. It moves the lead (`POST /api/v2/leads/subsequence/move`), unless the
   lead is parked already.
4. It reads the lead back (`GET /api/v2/leads/{id}`), and answers with it
   only if it shows `subsequence_id` set to the bound subsequence, in the
   same campaign. A move answered 200 that does not read back is an error.

A dry run does steps 1 and 2, and writes nothing. `status` reads a parked
lead as `stopped`, though Instantly reads it as active.

What it declares (0051): enrolment served; suspension served by parking,
costing the person `provider_status_stays_active` and the sequence
`shared_state_changes`, with its gap **unknown**: in the test above,
suspensions made 18 minutes or more before a due step held, and nothing
closer was tried. Pulling the touches and the unsubscribes: not served,
not built yet. A binding with a sequence that has no parking subsequence
declares that it cannot suspend, and `kernel-enrol` refuses it.

Before 0051, `withdraw` deleted the lead and reported success on the status
code.

`suppress` writes to the workspace blocklist, and reads back what it wrote
(0051). For each address or domain of the target:

1. It reads the blocklist (`GET /api/v2/block-lists-entries?search=…`): an
   address already listed, or under a listed domain, is reported applied
   with nothing written.
2. Otherwise it writes the entry (`POST /api/v2/block-lists-entries`).
3. It reads the blocklist again, and reports the key applied only if that
   exact value is listed. A write answered 200 that does not read back is
   an error, and names the keys read back before it.

A dry run does step 1 and writes nothing. None of it was observed against a
live workspace (below).

Before this, `suppress` read before it wrote and never after, and reported
the key applied on the write's status code.

`enrol` reads back what it uploaded (0051):

1. It looks the person up in the campaign (`POST /api/v2/leads/list`): a
   lead already there is the same enrolment if it carries the caller's key,
   and a conflict otherwise.
2. Otherwise it uploads the lead (`POST /api/v2/leads/add`).
3. It looks the person up again, and answers only with the lead that read
   shows, decided by the key as in step 1. An upload answered
   `leads_uploaded: 1` whose lead does not read back is an error.

Before this, `enrol` answered `active` on `leads_uploaded: 1` alone.

Every answer carries the time of the read it rests on. `status` used to give
a lead's `timestamp_updated`, which every change to the record moves (0051).

`status` and `withdraw` find a lead by address, and say which enrolment it
is (0060): each answer carries the key the lead holds in
`engine_idempotency_key`, as the read found it — the read-back's lead, for
`withdraw` — or no key when the lead holds none, as a lead enrolled outside
this engine does. The adapter compares nothing: the requests carry no
enrolment key, and a lead without the key is still parked, by address.
Matching the key to the registry's row is the kernel's.

## Pulling what was sent

`GET /api/v2/emails?campaign_id=…&email_type=sent&min_timestamp_created=<ISO, ms>`
returns each send with `lead_id`, `campaign_id`, `subsequence_id`,
`eaccount`, `timestamp_email` and `step`. `step` is
`"<sequence>_<step>_<variant>"`, counted from 0. A send appeared within a
minute. All eleven sends of the test were still listed after the leads and
the campaigns were deleted, with their now dangling ids. The limit is 20
requests a minute, unlike the rest of the API. It needs `emails:read`.

## Unsubscribes

The campaign had `insert_unsubscribe_header: true`. The email carried
`List-Unsubscribe: <https://<tracking domain>/unsub/1/{lead_id}>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`. A `GET` on it shows a
confirmation page and changes nothing; confirming unsubscribes.

What the receiving client did with that header was looked at once, in
October 2026, on a message a real recipient received from a campaign of
this provider. The operator recorded it, and it is reported here as they
recorded it.
- *What was looked at:* the received message's headers, and the message as
  Gmail displayed it.
- *What was seen:* the headers carried `List-Unsubscribe`. Gmail displayed
  no unsubscribe link for the message.

This is one message, in one client, on one day. Why Gmail showed no link
was not looked into.

After confirming, read at +30 s and again at +4 min 30:

- `GET /api/v2/leads/{id}`: `status` -2, and `timestamp_updated` at the
  click. Nothing else moved; there is no unsubscribe timestamp.
- `POST /api/v2/leads/list {"filter":"FILTER_VAL_UNSUBSCRIBED"}`: returns the
  lead, scoped to the campaign or across the workspace. There is no date
  filter.
- `POST /api/v2/leads/list` with `queries` `lead-status` (status -2,
  `occurrence-days` 1) or `lead-status-change` (`occurrence-days` 1): **not**
  returned. The second does return a lead closed through its interest status.
- `GET /api/v2/block-lists-entries`: empty. An unsubscribe is not written to
  the blocklist. Entries carry `timestamp_created`, but the endpoint
  filters on `search` and `domains_only` only.
- `GET /api/v2/campaigns/analytics/overview`: `unsubscribed_count` 0.

`lead_unsubscribed` is listed by `GET /api/v2/webhooks/event-types`. It was
not tested: no key held `webhooks:create`, and no receiver was reachable from
the test environment. `GET /api/v2/webhook-events` lists webhook
*deliveries* (`success`, `status_code`, `retry_count`), not events; it was
empty with no webhook subscribed. Its `from` and `to` take `YYYY-MM-DD`, and a
full timestamp is refused with 400.

## State that moves between reads

The campaigns were deleted at 08:33 UTC. Their leads were still listed at
08:34 and returned 404 by 09:36, without a delete of ours.
`GET /api/v2/audit-logs` shows the three campaign deletions and nothing after
them.

## Two things about writing campaigns

- A body that mixes HTML with bare text loses the bare text at creation,
  silently: `kt test.<br/><a href="…">x</a>` is stored as
  `<br/><a href="…">x</a>`. A plain-text body is kept whole.
- `{{unsubscribe_url}}` renders as an empty string. No unsubscribe variable is
  documented: the help centre inserts the link from the editor.

## Payload

Read on 2026-10-21, against a live workspace, with a read-only key and
nothing written: existing leads of two campaigns, five from each. None of
the ten carries an `engine_` variable, which this adapter sets on every
lead it uploads.

- `POST /api/v2/leads/list` by campaign returned `payload` on all ten leads:
  an object, never empty, holding the lead's custom variables.
- On one of them, the two calls the adapter makes — `leads/list` with
  `contacts`, as `findLead` sends it, and `GET /api/v2/leads/{id}` — both
  returned `payload`, identical: nine keys, six of them beyond the core lead
  fields.

Then, the same day, one write. It went to a campaign created for this test
and never activated: draft, no sending account, no step. It held one lead,
an address of the operator's. `POST /api/v2/leads/add` sent the body `enrol`
sends, with `engine_idempotency_key` and `engine_run_id` in
`custom_variables`.

- `leads/list` with `contacts`, as `findLead` sends it, returned the lead on
  the first read, 145 ms after the upload answered. `payload` held both
  variables with the values sent, beside `email` and `firstName`.
- `GET /api/v2/leads/{id}` returned the same `payload`, identical.
- The lead read `status` 1. The campaign stayed at `status` 0, and
  `GET /api/v2/emails` listed nothing for it.

Afterwards, the lead and the campaign were deleted. Both read 404, and
`leads/list` by the address, across the workspace, returned nothing.

So `status` and `withdraw` read the key where it is kept, by both calls they
make, and `enrol`'s read-back finds the key it uploaded (0060).

## A whole message in a variable

Decision 0064 rests on the kernel writing every step's message whole and
passing it as a variable. Its storage was measured on 2026-10-21, under the
same conditions as the write above: one campaign created for the test and
never activated (draft, no sending account, no step), and one lead, an
address of the operator's.

**What was sent.** `POST /api/v2/leads/add`, with four values in
`custom_variables`:
- a key;
- a subject;
- a body of 19 lines and 619 bytes, written as a message. It held
  paragraphs, a list and a signature, both a bare link and an `<a href>`,
  and markup inside bare text (`<b>`, a bare `&`). It also held what a
  normalisation would touch: a double space, a trailing space, a
  non-breaking space, typographic quotes and an emoji;
- the same message in markup only: `<p>`, `<ul>`, `<br/>`, `&nbsp;`,
  `&amp;`. 486 bytes.

**What came back.**
- *Both reads.* The adapter's two reads returned all four values: `leads/list`
  with `contacts`, as `findLead` sends it, on the first try; and
  `GET /api/v2/leads/{id}`.
- *Byte for byte.* Each value was identical, compared as UTF-8 bytes to
  what was sent, on both reads.
- *The comparison catches a change.* The same comparison, given the body
  with its double space made single, one blank line removed, or its
  non-breaking space made plain, reported each one as different.
- *Nothing was sent.* The campaign stayed at `status` 0, and
  `GET /api/v2/emails` listed nothing for it.
- *Cleanup.* The lead and the campaign were deleted. Both then read 404,
  and `leads/list` by the address, across the workspace, returned nothing.

So the provider stores a whole message in a variable as it was given, and
gives it back unchanged. That is storage only, not what a recipient
receives.

**No preview of the rendering exists in the API.** The OpenAPI document
(v2.0.0) has no endpoint that renders a step for a lead without sending it.
The nearest one, `POST /api/v2/emails/test` ("Send a test email"), sends a
real email to the addresses it is given, from a connected account. It
documents the body as HTML: "Use `<br/>` tags for delivered email line
breaks". That is the documentation's word, not something observed.

## Not observed

- `suppress`, the workspace blocklist, against a live workspace: the write
  key had `campaigns:all`, `leads:all`, `webhook_events:all` and
  `subsequences:all`, and nothing for the blocklist. So none of what the
  read-back rests on was seen:
  - whether an entry reads back as soon as its write answers. If it lags,
    the adapter reports an error for a write that landed;
  - whether `search` matches parts of values, and whether `limit=50` can
    hide the exact entry under longer matches. If so, the read-back reports
    an error, never a false success;
  - whether a domain's entry refuses the addresses under it, as the help
    centre says. The adapter counts an address under a listed domain as
    already blocked.
- Whether a lead uploaded with `POST /api/v2/leads/add` is always returned
  by `POST /api/v2/leads/list` as soon as the upload answers, as `enrol`'s
  read-back needs. One upload to an empty campaign was (*Payload*); a busy
  workspace was not tried. If it lags, the adapter reports an error for an
  upload that landed: the run stops with the registry row left pending, and
  the next run confirms it from `status`. `status` now reports the key the
  lead carries, but the reconciliation does not compare it yet (0060).
- Whether a step renders a whole message passed in a variable as it was
  given: its line breaks, its markup, its links. Storage is measured above,
  and comes back unchanged. Rendering takes a send, which was not made: the
  API offers no preview without one. The documentation reads a body as HTML,
  so a bare line break may not survive delivery. 0064 can fall on this.
- Whether an unsubscribe reaches the same address in another campaign.
- Whether resetting the interest status, or removing a lead from a
  subsequence (`POST /api/v2/leads/subsequence/remove`), resumes the lead.
- How `FILTER_VAL_UNSUBSCRIBED` orders and pages at scale: there was one
  unsubscribed lead in the workspace.
