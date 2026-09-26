import datetime
import importlib
import os
import sys
import types
import unittest


class FakeEc2:
    def __init__(self):
        self.instances = []
        self.terminated = []

    def get_paginator(self, operation):
        assert operation == "describe_instances"
        return self

    def paginate(self, **kwargs):
        return [{"Reservations": [{"Instances": self.instances}]}]

    def terminate_instances(self, InstanceIds):
        self.terminated.extend(InstanceIds)


class ExpiryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ec2 = FakeEc2()
        sys.modules["boto3"] = types.SimpleNamespace(client=lambda service: cls.ec2)
        os.environ["MAX_AGE_MINUTES"] = "120"
        cls.expiry = importlib.import_module("expiry")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("boto3", None)

    def setUp(self):
        self.ec2.instances = []
        self.ec2.terminated = []

    def instance(self, identifier, created=None, deadline=None):
        tags = []
        if created is not None:
            tags.append({"Key": "AgentCloudCreatedAt", "Value": created.isoformat()})
        if deadline is not None:
            tags.append({"Key": "AgentCloudExpiresAt", "Value": deadline.isoformat()})
        return {"InstanceId": identifier, "Tags": tags}

    def test_valid_unexpired_run_remains(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.ec2.instances = [self.instance("i-valid", now, now + datetime.timedelta(hours=1))]
        self.assertEqual(self.expiry.handler({}, None), {"expired_count": 0})
        self.assertEqual(self.ec2.terminated, [])

    def test_missing_or_expired_deadline_terminates(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.ec2.instances = [
            self.instance("i-missing"),
            self.instance("i-expired", now - datetime.timedelta(hours=2), now - datetime.timedelta(minutes=1)),
        ]
        self.assertEqual(self.expiry.handler({}, None), {"expired_count": 2})
        self.assertEqual(self.ec2.terminated, ["i-missing", "i-expired"])

    def test_deadline_beyond_two_hours_terminates(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.ec2.instances = [self.instance("i-too-long", now, now + datetime.timedelta(hours=3))]
        self.assertEqual(self.expiry.handler({}, None), {"expired_count": 1})
        self.assertEqual(self.ec2.terminated, ["i-too-long"])


if __name__ == "__main__":
    unittest.main()
