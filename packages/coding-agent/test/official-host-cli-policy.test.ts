import { expect, test } from "vitest";
import { authorize, parsePolicy } from "../../../extensions/host-cli/policy.ts";

const [kubectl, gh] = parsePolicy(`version: 1
commands:
  - name: kubectl
    allow:
      - args: [get, &resources [pods, services]]
        options:
          - &namespace {names: [-n, --namespace], value: {text: true}}
          - {names: [-o, --output], value: [json, yaml]}
          - {names: [-A, --all-namespaces]}
      - args: [describe, *resources]
        options: [*namespace]
  - name: gh
    allow:
      - args: [pr, view]
        options: [{names: [--repo], value: {text: true}, required: true}]
        positionals: [{text: true}]
      - args: [pr, create]
        options:
          - {names: [--repo], value: {text: true}, required: true}
          - {names: [--head], value: {text: true}, required: true}
          - {names: [--base], value: {text: true}, required: true}
          - {names: [--title], value: {text: true}, required: true}
          - {names: [--body], value: {text: true}, required: true}
          - {names: [--draft]}
`);

const createPr = [
	"pr",
	"create",
	"--repo",
	"owner/repo",
	"--head",
	"feature",
	"--base",
	"main",
	"--title",
	"Title",
	"--body",
	"Details\nwith multiple lines",
];

test.each([
	["get", "pods"],
	["get", "pods", "-n", "staging", "--output", "json"],
	["get", "services", "-o", "yaml", "--namespace", "production"],
	["get", "pods", "--all-namespaces"],
	["describe", "pods", "--namespace", "staging"],
	["get", "pods", "-n", "--raw=/api/v1/secrets"],
])("matches explicit resources and structured option combinations: %j", (...args) => {
	expect(authorize(kubectl, args)).toEqual(args);
	expect(authorize(kubectl, args)).not.toBe(args);
});

test.each([
	["get", "secrets"],
	["get", "pods,secrets"],
	["get", "all"],
	["delete", "pods"],
	["get", "pods", "--raw=/api/v1/secrets"],
	["get", "pods", "-f", "secret.yaml"],
	["get", "pods", "--kubeconfig=untrusted.yaml"],
	["get", "pods", "--namespace=staging"],
	["get", "pods", "-n"],
	["get", "pods", "-n", ""],
	["get", "pods", "-n", "nul\0value"],
	["get", "pods", "-n", "x".repeat(65537)],
	["get", "pods", "-o", "xml"],
	["get", "pods", "-n", "staging", "--namespace", "production"],
	["get", "pods", "-o", "json", "-o", "yaml"],
	["get", "pods", "-A", "--all-namespaces"],
	["get", "pods", "name"],
	["get", "pods", "--", "name"],
])("denies writes, secret bypasses and malformed options: %j", (...args) => {
	expect(() => authorize(kubectl, args)).toThrow(/Denied/);
});

test("positionals require an explicit terminator and cannot override required options", () => {
	for (const id of ["123", "--web", "--repo", "--"]) {
		const args = ["pr", "view", "--repo", "owner/repo", "--", id];
		expect(authorize(gh, args)).toEqual(args);
	}
	for (const args of [
		["pr", "view", "--repo", "owner/repo"],
		["pr", "view", "--repo", "owner/repo", "123"],
		["pr", "view", "--repo", "owner/repo", "--"],
		["pr", "view", "--", "--repo"],
		["pr", "view", "--repo", "owner/repo", "--", "123", "--web"],
		["pr", "view", "--repo", "owner/repo", "--web", "--", "123"],
	])
		expect(() => authorize(gh, args)).toThrow(/Denied/);
});

test("PR creation requires all nonempty values while allowing safe option reordering", () => {
	expect(authorize(gh, createPr)).toEqual(createPr);
	const reordered = [
		"pr",
		"create",
		"--draft",
		"--body",
		"--web",
		"--title",
		"Title",
		"--repo",
		"owner/repo",
		"--base",
		"main",
		"--head",
		"feature",
	];
	expect(authorize(gh, reordered)).toEqual(reordered);
	for (let index = 2; index < createPr.length; index += 2) {
		const missing = [...createPr.slice(0, index), ...createPr.slice(index + 2)];
		expect(() => authorize(gh, missing)).toThrow(/Denied/);
		const empty = [...createPr];
		empty[index + 1] = "";
		expect(() => authorize(gh, empty)).toThrow(/Denied/);
	}
});

test.each([
	["pr", "create"],
	["pr", "merge", "123"],
	["issue", "create"],
	["api", "graphql"],
	["auth", "token"],
	[...createPr, "--web"],
	[...createPr, "--fill"],
	[...createPr, "--body-file", "/private/file"],
	[...createPr, "--head", "other"],
	[...createPr, "--draft", "--draft"],
])("keeps other GitHub writes and unsafe PR options denied: %j", (...args) => {
	expect(() => authorize(gh, args)).toThrow(/Denied/);
});

test("boolean required options and multiple protected positionals are enforced", () => {
	const command = parsePolicy(`version: 1
commands:
  - name: demo
    allow:
      - args: [view]
        options: [{names: [--required], required: true}]
        positionals: [[one, two], {text: true}]
`)[0];
	expect(authorize(command, ["view", "--required", "--", "one", "--web"])).toHaveLength(5);
	for (const args of [
		["view", "--", "one", "name"],
		["view", "--required", "--", "one"],
		["view", "--required", "--", "three", "name"],
		["view", "--required", "--", "one", "name", "extra"],
	])
		expect(() => authorize(command, args)).toThrow(/Denied/);
});

test.each([
	{ args: [], flags: null },
	{ args: [], options: null },
	{ args: [], positionals: null },
	{ args: [], options: [{ names: [] }] },
	{ args: [], options: [{ names: ["--"] }] },
	{ args: [], options: [{ names: ["--x=x"] }] },
	{ args: [], options: [{ names: ["*"] }] },
	{ args: [], options: [{ names: ["--x", "--x"] }] },
	{ args: [], options: [{ names: ["--x"] }, { names: ["--x"] }] },
	{ args: [], flags: ["--x"], options: [{ names: ["--x"] }] },
	{ args: [], flags: ["*"], options: [{ names: ["--x"] }] },
	{ args: [], flags: ["--*"], positionals: ["name"] },
	{ args: [], options: [{ names: ["--x"], required: "true" }] },
	{ args: [], options: [{ names: ["--x"], required: null }] },
	{ args: [], options: [{ names: ["--x"], value: null }] },
	{ args: [], options: [{ names: ["--x"], value: [] }] },
	{ args: [], options: [{ names: ["--x"], unknown: true }] },
])("rejects ambiguous structured rules: %j", (rule) => {
	expect(() => parsePolicy(JSON.stringify({ version: 1, commands: [{ name: "demo", allow: [rule] }] }))).toThrow();
});

test("aliases cannot expand without bounds or introduce cyclic policy shapes", () => {
	for (const source of [
		"version: 1\ncommands: *missing\n",
		"version: 1\ncommands: &loop [*loop]\n",
		"version: 1\ncommands:\n  - name: demo\n    allow:\n      - args: [&choices [x]]\n" +
			"      - args: [*choices]\n".repeat(110),
	])
		expect(() => parsePolicy(source)).toThrow();
});
