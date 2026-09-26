import datetime
import importlib
import io
import json
import os
import sys
import types
import unittest
import urllib.error


UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 9, 26, 20, 0, tzinfo=UTC)
JOB = "123e4567-e89b-42d3-a456-426614174000"


class Reply:
    def __init__(self, status, body=None):
        self.status = status
        self.body = b"" if body is None else json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size):
        return self.body[:size]


class FakeOpener:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request.get_method(), request.full_url, request.get_header("Authorization")))
        next_reply = self.replies.pop(0)
        if isinstance(next_reply, Exception):
            raise next_reply
        return next_reply


def not_found():
    return urllib.error.HTTPError("https://api.runpod.io/v2/pods/pod123", 404, "Not Found", {}, None)


def pod(name, created=None, identifier="pod123"):
    return {"id": identifier, "name": name, "createdAt": (created or NOW).isoformat(), "env": {"PRIVATE": "do-not-log"}}


def page(pods, cursor=None):
    return Reply(200, {"pods": pods, "pagination": {"nextCursor": cursor, "hasNextPage": bool(cursor)}})


class RunpodExpiryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.modules["boto3"] = types.SimpleNamespace(client=lambda service: None)
        cls.guard = importlib.import_module("runpod_expiry")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("boto3", None)

    def marker(self, deadline):
        return f"agentcloud-{JOB}--exp-{int(deadline.timestamp())}"

    def test_unexpired_and_unrelated_pods_are_never_deleted(self):
        opener = FakeOpener([page([
            pod(self.marker(NOW + datetime.timedelta(hours=1))),
            pod("other-owner-123", identifier="other"),
            pod("agentcloud-bad--exp-0000000000", identifier="malformed"),
        ])])
        self.assertEqual(self.guard.run("test-key", NOW, opener=opener, sleep=lambda _: None), 0)
        self.assertEqual([call[0] for call in opener.calls], ["GET"])

    def test_expired_pod_is_deleted_and_404_confirms_release(self):
        expired = self.marker(NOW - datetime.timedelta(seconds=1))
        opener = FakeOpener([page([pod(expired, NOW - datetime.timedelta(hours=1))]), Reply(204), not_found()])
        self.assertEqual(self.guard.run("test-key", NOW, opener=opener, sleep=lambda _: None), 1)
        self.assertEqual([call[0] for call in opener.calls], ["GET", "DELETE", "GET"])
        self.assertTrue(all(auth == "Bearer test-key" for _, _, auth in opener.calls))

    def test_expiry_beyond_two_hours_is_rejected_but_missing_created_time_honors_deadline(self):
        overlong = pod(self.marker(NOW + datetime.timedelta(hours=3)))
        missing = pod(self.marker(NOW + datetime.timedelta(minutes=15)), identifier="pod456")
        missing.pop("createdAt")
        opener = FakeOpener([page([overlong, missing]), Reply(204), not_found()])
        self.assertEqual(self.guard.run("test-key", NOW, opener=opener, sleep=lambda _: None), 1)

    def test_full_cursor_walk_retries_transient_errors_without_logging_body(self):
        expired = pod(self.marker(NOW - datetime.timedelta(seconds=1)), NOW - datetime.timedelta(hours=1))
        throttle = urllib.error.HTTPError("https://api.runpod.io/v2/pods", 429, "secret-body", {}, io.BytesIO(b"secret-body"))
        opener = FakeOpener([throttle, page([], "cursor-2"), page([expired]), Reply(204), not_found()])
        self.assertEqual(self.guard.run("test-key", NOW, opener=opener, sleep=lambda _: None), 1)
        self.assertIn("cursor=cursor-2", opener.calls[2][1])

    def test_visible_after_delete_fails_and_does_not_report_success(self):
        expired = pod(self.marker(NOW - datetime.timedelta(seconds=1)), NOW - datetime.timedelta(hours=1))
        opener = FakeOpener([page([expired]), Reply(204), Reply(200, expired), Reply(200, expired), Reply(200, expired)])
        with self.assertRaisesRegex(self.guard.GuardError, "remains visible"):
            self.guard.run("test-key", NOW, opener=opener, sleep=lambda _: None)

    def test_handler_updates_freshness_only_after_confirmed_scan(self):
        writes = []
        class Secrets:
            def get_secret_value(self, SecretId):
                self.assertEqual(SecretId, "arn:test-secret")
                return {"SecretString": "test-key"}
        class Ssm:
            def put_parameter(self, **args):
                writes.append(args)
        secrets = Secrets()
        secrets.assertEqual = self.assertEqual
        self.guard.boto3 = types.SimpleNamespace(client=lambda service: secrets if service == "secretsmanager" else Ssm())
        os.environ["RUNPOD_SECRET_ARN"] = "arn:test-secret"
        os.environ["FRESHNESS_PARAMETER"] = "/agentcloud/runpod-expiry-guard/last-success"
        original_run = self.guard.run
        try:
            self.guard.run = lambda key, now: 0
            result = self.guard.handler({}, None)
            self.assertEqual(result["expired_count"], 0)
            self.assertEqual(writes[0]["Type"], "String")
            self.assertTrue(writes[0]["Overwrite"])
            writes.clear()
            self.guard.run = lambda key, now: (_ for _ in ()).throw(self.guard.GuardError("scan failed"))
            with self.assertRaises(self.guard.GuardError):
                self.guard.handler({}, None)
            self.assertEqual(writes, [])
        finally:
            self.guard.run = original_run
            os.environ.pop("RUNPOD_SECRET_ARN", None)
            os.environ.pop("FRESHNESS_PARAMETER", None)


if __name__ == "__main__":
    unittest.main()
