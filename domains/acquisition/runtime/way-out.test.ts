/**
 * Reading the way-out line an instance declares on its sequencer binding
 * (decisions 0067, 0069). No database: a setting read, and nothing written.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { lineWith, readWayOut } from "./way-out.js";

describe("the way-out setting (0069)", () => {
  it("reads a line with the link once, trimmed, and puts the link in its place", () => {
    const read = readWayOut({ acquisition: { wayOut: { line: "  To stop hearing from us: {link}  " } } });
    assert.deepEqual(read, { line: "To stop hearing from us: {link}" });
    assert.equal(lineWith("To stop hearing from us: {link}", "https://example.com/stop/1"), "To stop hearing from us: https://example.com/stop/1");
  });

  it("reads a cut, and nothing set as undeclared — never as a line of its own", () => {
    assert.deepEqual(readWayOut({ acquisition: { wayOut: "cut" } }), { cut: true });
    assert.deepEqual(readWayOut({}), { undeclared: true });
    assert.deepEqual(readWayOut({ acquisition: {} }), { undeclared: true });
    assert.deepEqual(readWayOut(undefined), { undeclared: true });
  });

  it("refuses a line without the link, with it twice, on two lines, empty, or beside anything else", () => {
    const why = (v: unknown) => {
      const r = readWayOut({ acquisition: { wayOut: v } });
      return "malformed" in r ? r.malformed : `read as ${JSON.stringify(r)}`;
    };
    assert.match(why({ line: "To stop, reply." }), /names \{link\} nowhere/);
    assert.match(why({ line: "{link} or {link}" }), /names \{link\} 2 times/);
    assert.match(why({ line: "To stop:\n{link}" }), /is one line/);
    assert.match(why({ line: " " }), /is empty/);
    assert.match(why({ line: "Stop: {link}", tone: "warm" }), /a line and nothing else, not "tone"/);
    assert.match(why("off"), /is `cut`, or/);
  });
});
