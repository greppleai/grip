import { expect, test } from "vitest";
import { authorize, parsePolicy } from "../../../extensions/host-cli/policy.ts";

const [unrestricted, restricted, literal] = parsePolicy(`version: 1
commands:
  - name: trustedcli
    allow: "*"
  - name: restricted
    allow: [[help]]
  - name: literal
    allow: [["*"]]
`);

test("command wildcard permits arbitrary literal argv without changing it", () => {
	for (const args of [
		[],
		["help", "--json"],
		["task", "create", "--name", "Title", "--description", "line one\nline two"],
		["future-command", "--flag=value", "-xyz", "--", "", "$(touch nope); echo literal"],
		Array(64).fill("x"),
		["x".repeat(65536)],
	]) {
		expect(authorize(unrestricted, args)).toEqual(args);
		expect(authorize(unrestricted, args)).not.toBe(args);
	}
	expect(() => authorize(restricted, ["future-command"])).toThrow(/Denied/);
	expect(authorize(literal, ["*"])).toEqual(["*"]);
	expect(() => authorize(literal, ["anything"])).toThrow(/Denied/);
});

test("command wildcard preserves argv safety limits", () => {
	for (const args of [null, "help", [123], ["bad\0arg"], ["x".repeat(65537)], Array(65).fill("x")]) {
		expect(() => authorize(unrestricted, args)).toThrow();
	}
});

test("unrestricted grants require the exact command-level wildcard", () => {
	for (const allow of [true, "**", "--*", { args: "*" }, ["*"], []]) {
		expect(() => parsePolicy(JSON.stringify({ version: 1, commands: [{ name: "demo", allow }] }))).toThrow();
	}
});
