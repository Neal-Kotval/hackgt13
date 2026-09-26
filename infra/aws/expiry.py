"""Independent backstop for tagged demo instances; the worker must also reconcile."""

import datetime
import os

import boto3


ec2 = boto3.client("ec2")
MAX_AGE = datetime.timedelta(minutes=int(os.environ["MAX_AGE_MINUTES"]))


def parse_time(value):
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def handler(event, context):
    now = datetime.datetime.now(datetime.timezone.utc)
    expired = []
    pages = ec2.get_paginator("describe_instances").paginate(
        Filters=[
            {"Name": "tag:Project", "Values": ["AgentCloudDemo"]},
            {"Name": "tag:AgentCloudAutoExpire", "Values": ["true"]},
            {
                "Name": "instance-state-name",
                "Values": ["pending", "running", "stopping", "stopped"],
            },
        ]
    )
    for page in pages:
        for reservation in page["Reservations"]:
            for instance in reservation["Instances"]:
                tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
                created = parse_time(tags.get("AgentCloudCreatedAt"))
                deadline = parse_time(tags.get("AgentCloudExpiresAt"))
                valid = (
                    created is not None
                    and deadline is not None
                    and created.tzinfo is not None
                    and deadline.tzinfo is not None
                    and created <= now + datetime.timedelta(minutes=5)
                    and created <= deadline <= created + MAX_AGE
                )
                if not valid or now >= deadline:
                    expired.append(instance["InstanceId"])
    for instance_id in expired:
        ec2.terminate_instances(InstanceIds=[instance_id])
        print("Requested termination of expired demo instance", instance_id)
    return {"expired_count": len(expired)}
