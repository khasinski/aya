// The team editor's model: rows keep stable keys and links point at keys, so a
// rename, a cleared name or a removed row never leaves a stale link behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addRole,
  applyDraft,
  cadenceProblem,
  DEFAULT_CADENCE_MINUTES,
  fromEditor,
  removeRole,
  ROLE_ID_MAX_LEN,
  roleId,
  roleIdProblem,
  setSend,
  toEditor,
  updateRole,
} from "../dist-test/team-edit.js";
import { ID_RE, parseTeamFile, serializeTeam } from "../dist-electron/team-definition.js";

const TEAM = {
  name: "trio",
  roles: [
    { id: "reviewer", sendsTo: [{ to: "implementer", what: "findings" }, { to: "tester", what: "requests" }], mustNot: "edit code", responsibilities: "R" },
    { id: "implementer", sendsTo: [{ to: "reviewer", what: "commits" }], mustNot: "skip", responsibilities: "" },
    { id: "tester", sendsTo: [], mustNot: "fix", responsibilities: "" },
  ],
  lead: "tester",
  cadenceMinutes: 30,
  protocol: "P",
};
const keyOf = (t, id) => t.roles.find((r) => r.id === id).key;

test("a team goes into the editor and comes back unchanged", () => {
  assert.deepEqual(fromEditor(toEditor(TEAM)), TEAM);
});

test("renaming a role keeps every link and the lead (and its rounds) pointing at it", () => {
  let t = toEditor(TEAM);
  t = updateRole(t, keyOf(t, "tester"), { id: "qa" });
  const out = fromEditor(t);
  assert.deepEqual(out.roles[0].sendsTo[1], { to: "qa", what: "requests" });
  assert.deepEqual([out.lead, out.cadenceMinutes], ["qa", 30]);
});

test("clearing a name and typing it again keeps the links", () => {
  let t = toEditor(TEAM);
  const k = keyOf(t, "implementer");
  t = updateRole(t, k, { id: "" });
  t = updateRole(t, k, { id: "implementer" });
  assert.deepEqual(fromEditor(t), TEAM);
});

test("a lead on a row whose name was cleared is left out until it has a name", () => {
  let t = toEditor(TEAM);
  const k = keyOf(t, "tester");
  t = updateRole(t, k, { id: "" });
  assert.equal(fromEditor(t).lead, null);
  t = updateRole(t, k, { id: "qa" });
  assert.equal(fromEditor(t).lead, "qa");
});

test("removing a role drops every link to it, and the lead when it led", () => {
  let t = toEditor(TEAM);
  t = removeRole(t, keyOf(t, "tester"));
  assert.equal(t.lead, null);
  const out = fromEditor(t);
  assert.deepEqual(out.roles.map((r) => r.id), ["reviewer", "implementer"]);
  assert.deepEqual(out.roles[0].sendsTo, [{ to: "implementer", what: "findings" }]);
  assert.equal(out.lead, null);
});

test("an unnamed row stays for the user to fill, but nothing links to it yet", () => {
  let t = addRole(toEditor(TEAM));
  const blank = t.roles.at(-1).key;
  t = setSend(t, keyOf(t, "reviewer"), blank, true);
  const out = fromEditor(t);
  assert.equal(out.roles.length, 4);
  assert.equal(out.roles[3].id, "");
  assert.equal(out.roles[0].sendsTo.length, 2);
  t = updateRole(t, blank, { id: "designer" });
  assert.deepEqual(fromEditor(t).roles[0].sendsTo.at(-1), { to: "designer", what: "" });
});

test("ticking and unticking a route, and typing its what", () => {
  let t = toEditor(TEAM);
  const [rev, tes] = [keyOf(t, "reviewer"), keyOf(t, "tester")];
  t = setSend(t, tes, rev, true);
  t = setSend(t, tes, rev, true, "results (pass)\n");
  assert.deepEqual(fromEditor(t).roles[2].sendsTo, [{ to: "reviewer", what: "results pass" }]);
  t = setSend(t, tes, rev, true, "  spaced as typed ");
  assert.equal(t.roles[2].sendsTo[0].what, "  spaced as typed ");
  assert.deepEqual(fromEditor(t).roles[2].sendsTo, [{ to: "reviewer", what: "spaced as typed" }]);
  t = setSend(t, tes, rev, false);
  assert.deepEqual(fromEditor(t).roles[2].sendsTo, []);
});

test("a draft lands on its own row even after rows above it were removed", () => {
  let t = toEditor(TEAM);
  const tes = keyOf(t, "tester");
  t = removeRole(t, keyOf(t, "reviewer"));
  t = applyDraft(t, tes, { responsibilities: "Tests.", mustNot: "fix bugs", sendsTo: [{ to: "implementer", what: "bugs" }, { to: "ghost", what: "x" }] });
  assert.deepEqual(t.roles[1].sendsTo, [{ key: keyOf(t, "implementer"), what: "bugs" }]);
  const out = fromEditor(t);
  assert.deepEqual(out.roles[1], { id: "tester", sendsTo: [{ to: "implementer", what: "bugs" }], mustNot: "fix bugs", responsibilities: "Tests." });
  assert.equal(out.roles[0].responsibilities, "");
});

test("whatever is typed as a role name becomes an id the team file accepts, or nothing yet", () => {
  // The editor (renderer) and the file parser (main) must agree on the rule.
  const typed = ["Senior UX Game Designer", "  QA!!", "-lead-", "a".repeat(60), "Ünïcode rôle", "x", "---", "", "2nd reviewer"];
  for (const t of typed) {
    const id = roleId(t);
    assert.ok(id === "" || ID_RE.test(id), `${JSON.stringify(t)} -> ${JSON.stringify(id)}`);
  }
  assert.equal(roleId("Senior UX Game Designer"), "senior-ux-game-designer");
  // The longest id the editor makes is the longest the file parser accepts.
  assert.equal(ROLE_ID_MAX_LEN, 40);
  assert.equal(roleId("a".repeat(60)).length, ROLE_ID_MAX_LEN);
  assert.ok(ID_RE.test("a".repeat(ROLE_ID_MAX_LEN)));
  assert.ok(!ID_RE.test("a".repeat(ROLE_ID_MAX_LEN + 1)));
});

test("a new cadence runs every 30 minutes until changed", () => {
  assert.equal(DEFAULT_CADENCE_MINUTES, 30);
});

test("a hand-written link or lead to a role the file lacks never enters the editor", () => {
  const t = toEditor({
    ...TEAM,
    roles: [{ ...TEAM.roles[0], sendsTo: [{ to: "ghost", what: "x" }, ...TEAM.roles[0].sendsTo] }, ...TEAM.roles.slice(1)],
    lead: "ghost",
  });
  assert.deepEqual(t.roles[0].sendsTo.map((s) => s.key), [keyOf(t, "implementer"), keyOf(t, "tester")]);
  assert.equal(t.lead, null);
});

test("rows added one after another each get their own key", () => {
  const t = addRole(addRole(toEditor(TEAM)));
  const keys = t.roles.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("ticking an already ticked route without new text keeps its what", () => {
  let t = toEditor(TEAM);
  const [rev, imp] = [keyOf(t, "reviewer"), keyOf(t, "implementer")];
  t = setSend(t, rev, imp, true);
  assert.equal(t.roles[0].sendsTo.find((s) => s.key === imp).what, "findings");
});

test("a draft route to an empty name does not land on an unnamed row", () => {
  let t = addRole(toEditor(TEAM));
  const tes = keyOf(t, "tester");
  t = applyDraft(t, tes, { responsibilities: "", mustNot: "x", sendsTo: [{ to: "", what: "?" }] });
  assert.deepEqual(t.roles.find((r) => r.key === tes).sendsTo, []);
});

test("the editor flags only the role id aya, before Save", () => {
  assert.equal(roleIdProblem("aya"), '"aya" is reserved for Aya\'s own messages; name the role something else');
  for (const id of ["", "ay", "ayaa", "aya-helper", "reviewer"]) assert.equal(roleIdProblem(id), null, id);
});

test("the editor flags a cadence exactly when the saved file would refuse it", () => {
  const saves = (minutes) => {
    try {
      parseTeamFile("trio", serializeTeam({ ...TEAM, cadenceMinutes: minutes }));
      return true;
    } catch {
      return false;
    }
  };
  for (const minutes of [NaN, -1, 0, 0.5, 1, 2.5, 30, 1439, 1440, 1441, 5000]) {
    assert.equal(cadenceProblem(minutes) === null, saves(minutes), `${minutes} min`);
  }
  assert.match(cadenceProblem(5000), /1-1440/);
});
