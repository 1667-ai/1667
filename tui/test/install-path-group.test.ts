import { expect, test } from "bun:test";
import {
  parseDsclMembership,
  parseGetentGroup,
  parseMembers
} from "../src/install-path-group.js";

/*
 * A test cannot create a system group, so the decision that depends on one is
 * covered where it can be: the two platform answers this product parses. The
 * refusal and the --force waiver are covered end to end against a
 * world-writable Install Root, which needs no group at all.
 */

test("a getent line yields the group name and its supplementary members", () => {
  expect(parseGetentGroup("staff:x:50:alice,bob")).toEqual({
    name: "staff",
    others: ["alice", "bob"]
  });
  // Ubuntu's private user group: the owner is not repeated in the member list.
  expect(parseGetentGroup("chris:x:1000:")).toEqual({ name: "chris", others: [] });
  expect(parseGetentGroup("")).toBe(null);
  expect(parseGetentGroup("nonsense")).toBe(null);
});

test("dscl membership is read from its labelled line", () => {
  // macOS answers this way, and /etc/group does not: that file carries
  // `admin:*:80:root` while Directory Services holds the real membership.
  expect(parseDsclMembership("GroupMembership: root chris\n")).toEqual(["root", "chris"]);
  // A group with nobody in it has no such key at all.
  expect(parseDsclMembership("No such key: GroupMembership\n")).toEqual([]);
  expect(parseDsclMembership("")).toEqual([]);
});

test("member lists split on either separator and drop empty entries", () => {
  expect(parseMembers("alice, bob   carol")).toEqual(["alice", "bob", "carol"]);
  expect(parseMembers("   ")).toEqual([]);
});
