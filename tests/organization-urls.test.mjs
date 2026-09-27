import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../lib/organization-url.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
new Function("module", "exports", output)(module, module.exports);
const { resolveOrganizationUrl } = module.exports;

test("organization URLs use membership-scoped IDs and redirect old slugs", () => {
  const organization = { id: "org-123", slug: "new-name", role: "member" };
  assert.deepEqual(resolveOrganizationUrl([organization], "org-123", "new-name"),
    { kind: "found", organization });
  assert.deepEqual(resolveOrganizationUrl([organization], "org-123", "old-name"),
    { kind: "redirect", url: "/organizations/org-123/new-name" });
  assert.deepEqual(resolveOrganizationUrl([organization], "org-456", "new-name"), { kind: "missing" });
  assert.deepEqual(resolveOrganizationUrl([], "org-123", "new-name"), { kind: "missing" });
});
