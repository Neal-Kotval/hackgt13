import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateRunBoxJobs } from "../lib/run-box-jobs.mjs";
import {
  applyAwsCpuSshAccess, isPublicIpv4, listAwsCpuSshAccess, parseCloudFrontViewerAddress, requestAwsCpuSshAccess,
  trustedRequesterCidr,
} from "../lib/aws-cpu-ssh-access.mjs";

const jobId = "44444444-4444-4444-8444-444444444444";
const trusted = { AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER: "1" };

test("CloudFront-Viewer-Address yields only a public IPv4", () => {
  assert.equal(parseCloudFrontViewerAddress("8.8.8.8:46532"), "8.8.8.8");
  assert.equal(parseCloudFrontViewerAddress("184.192.120.7:1"), "184.192.120.7");
  for (const bad of [
    "10.0.0.5:443", "172.16.0.1:443", "192.168.1.2:443", "127.0.0.1:443", "169.254.169.254:80", "100.64.0.1:443",
    "0.1.2.3:443", "224.0.0.1:443", "239.1.1.1:443", "240.0.0.1:443", "255.255.255.255:443", "192.0.0.8:443", "198.18.0.1:443",
    "[2001:db8::1]:443", "2001:db8::1:443", "::ffff:8.8.8.8:443", "8.8.8.8", "8.8.8.8:0", "8.8.8.8:65536", "8.8.8.8:x",
    "08.8.8.8:443", "8.8.8.8:443, 1.1.1.1:443", " 8.8.8.8:443", "", null, undefined,
  ]) assert.equal(parseCloudFrontViewerAddress(bad), null, String(bad));
  assert.equal(isPublicIpv4("1.1.1.1"), true);
  assert.equal(isPublicIpv4("100.128.0.1"), true);
});

test("the header is trusted only with AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1; X-Forwarded-For never", () => {
  const headers = new Headers({ "CloudFront-Viewer-Address": "8.8.8.8:5000", "X-Forwarded-For": "1.1.1.1" });
  assert.equal(trustedRequesterCidr(headers, {}), null);
  assert.equal(trustedRequesterCidr(headers, { AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER: "true" }), null);
  assert.equal(trustedRequesterCidr(headers, trusted), "8.8.8.8/32");
  assert.equal(trustedRequesterCidr(new Headers({ "X-Forwarded-For": "1.1.1.1" }), trusted), null);
  assert.equal(trustedRequesterCidr(new Headers({ "CloudFront-Viewer-Address": "10.1.2.3:5000" }), trusted), null);
  assert.equal(trustedRequesterCidr(new Headers({ "CloudFront-Viewer-Address": "2a05:d014::1:5000" }), trusted), null);
});

function database() {
  const db = new Database(":memory:");
  migrateRunBoxJobs(db);
  // The job row itself is not under test here.
  db.pragma("foreign_keys = OFF");
  return db;
}

test("a requester address is recorded once per job and applied as a job-tagged rule", async () => {
  const db = database();
  try {
    const first = requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.8.8/32", employeeId: "employee-1" });
    const again = requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.8.8/32", employeeId: "employee-1" });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.throws(() => requestAwsCpuSshAccess(db, { jobId, cidr: "10.0.0.1/32", employeeId: "employee-1" }), /public IPv4/);
    const calls = [];
    const provider = { async authorizeSsh(job, cidr) { calls.push([job.id, cidr]); return { ruleId: "sgr-0aa", cidr }; } };
    assert.deepEqual((await applyAwsCpuSshAccess(db, provider, { id: jobId })).map((item) => item.status), ["applied"]);
    assert.deepEqual(calls, [[jobId, "8.8.8.8/32"]]);
    const [row] = listAwsCpuSshAccess(db, jobId);
    assert.equal(row.status, "applied");
    assert.equal(row.rule_id, "sgr-0aa");
    // Applied rows are not re-authorized on later cycles.
    await applyAwsCpuSshAccess(db, provider, { id: jobId });
    assert.equal(calls.length, 1);
  } finally { db.close(); }
});

test("a failed requester rule is recorded and does not throw", async () => {
  const db = database();
  try {
    requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.4.4/32", employeeId: "employee-1" });
    const provider = { async authorizeSsh() { throw new Error("AWS ec2:authorize-security-group-ingress RulesPerSecurityGroupLimitExceeded"); } };
    assert.deepEqual((await applyAwsCpuSshAccess(db, provider, { id: jobId })).map((item) => item.status), ["failed"]);
    assert.match(listAwsCpuSshAccess(db, jobId)[0].error, /RulesPerSecurityGroupLimitExceeded/);
  } finally { db.close(); }
});
