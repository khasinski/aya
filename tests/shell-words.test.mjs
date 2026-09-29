// A preset's leading `NAME=value` words, turned into env values the way the
// shell would, so a lookup can carry them without putting preset text on a
// command line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { envWithAssignments } from "../dist-electron/shell-words.js";

const base = { HOME: "/h", PATH: "/usr/bin", KEEP: "k" };

test("quotes, escapes, $VAR, ${VAR} and a leading ~ come out as the shell gives them", () => {
  const env = envWithAssignments(base, [
    "A=1",
    'B="two words"',
    "C='$HOME'",
    'D="$HOME/x"',
    "E=${HOME}/y",
    "F=a\\ b",
    "G=~/z",
    'H="a\\"b"',
    'P="/x:$PATH"',
    "U=$NOPE",
    "M='a'\"$HOME\"b",
    "Q=",
    "R=a$/b",
    "S=cost$",
    "T=~foo",
    'V="a\\nb"',
  ]);
  assert.deepEqual(env, {
    ...base,
    A: "1",
    B: "two words",
    C: "$HOME",
    D: "/h/x",
    E: "/h/y",
    F: "a b",
    G: "/h/z",
    H: 'a"b',
    P: "/x:/usr/bin",
    U: "",
    M: "a/hb",
    Q: "",
    R: "a$/b",
    S: "cost$",
    T: "~foo",
    V: "a\\nb",
  });
  assert.deepEqual(base, { HOME: "/h", PATH: "/usr/bin", KEEP: "k" });
});

test("a later assignment sees an earlier one, as in the shell", () => {
  assert.equal(envWithAssignments(base, ["A=1", "B=$A$A"]).B, "11");
});

test("anything that would need the shell to run code is refused", () => {
  const refused = [
    ["X=$(id)", /unsupported shell expansion/],
    ["X=`id`", /unsupported command substitution/],
    ["X=${HOME:-a}", /unsupported shell expansion/],
    ['X="$(id)"', /unsupported shell expansion/],
    ["X=$((1+1))", /unsupported shell expansion/],
    ['X="a`id`"', /unsupported word/],
    ["X='unclosed", /unclosed quote/],
    ['X="open', /unsupported word/],
  ];
  for (const [token, message] of refused) {
    assert.throws(() => envWithAssignments(base, [token]), message, token);
  }
});
