"""Independent Runpod Pod expiry guard. No API key or response body is logged."""

import datetime
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3


API = "https://api.runpod.io/v2"
NAME = re.compile(r"^agentcloud-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})--exp-([0-9]{10})$")
MAX_AGE = datetime.timedelta(minutes=120)
CLOCK_SKEW = datetime.timedelta(minutes=5)
MAX_PAGES = 100
MAX_REPLY_BYTES = 2_000_000


class GuardError(Exception):
    """Safe error text; never contains a key or upstream response body."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _api(method, path, key, *, opener=None, sleep=time.sleep):
    opener = opener or urllib.request.build_opener(_NoRedirect)
    url = API + path
    for attempt in range(3):
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "Accept": "application/json"}, method=method)
        try:
            with opener.open(request, timeout=15) as response:
                status = response.status
                if status == 204:
                    return status, None
                raw = response.read(MAX_REPLY_BYTES + 1)
                if len(raw) > MAX_REPLY_BYTES:
                    raise GuardError("Runpod response too large")
                try:
                    return status, json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    raise GuardError("Runpod returned invalid JSON") from None
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return 404, None
            if error.code not in (408, 429) and error.code < 500:
                raise GuardError("Runpod request rejected") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        if attempt < 2:
            sleep(2**attempt)
    raise GuardError("Runpod request could not be confirmed")


def _pages(key, *, opener=None, sleep=time.sleep):
    cursor = None
    seen = set()
    for _ in range(MAX_PAGES):
        query = "?limit=1000"
        if cursor:
            query += "&cursor=" + urllib.parse.quote(cursor, safe="")
        status, data = _api("GET", "/pods" + query, key, opener=opener, sleep=sleep)
        if status != 200 or not isinstance(data, dict) or not isinstance(data.get("pods"), list):
            raise GuardError("Runpod pod list is invalid")
        yield from data["pods"]
        pagination = data.get("pagination")
        if not isinstance(pagination, dict):
            raise GuardError("Runpod pagination is invalid")
        if not pagination.get("hasNextPage"):
            return
        cursor = pagination.get("nextCursor")
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            raise GuardError("Runpod pagination cursor is invalid")
        seen.add(cursor)
    raise GuardError("Runpod pagination exceeded guard limit")


def _utc(value):
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(datetime.timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return None


def _expired(pod, now):
    if not isinstance(pod, dict) or not isinstance(pod.get("name"), str):
        return False
    match = NAME.fullmatch(pod["name"])
    if not match:
        return False
    try:
        deadline = datetime.datetime.fromtimestamp(int(match.group(2)), datetime.timezone.utc)
    except (OverflowError, ValueError):
        return True
    created = _utc(pod.get("createdAt"))
    # Runpod's Pod list may omit createdAt. The name carries the server-derived
    # deadline, so an absent timestamp must never delete a live Pod early.
    if created is not None and (created > now + CLOCK_SKEW or not created <= deadline <= created + MAX_AGE):
        return True
    return now >= deadline


def _delete_and_confirm(pod_id, key, *, opener=None, sleep=time.sleep):
    if not isinstance(pod_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", pod_id):
        raise GuardError("Runpod pod ID is invalid")
    path = "/pods/" + urllib.parse.quote(pod_id, safe="")
    status, _ = _api("DELETE", path, key, opener=opener, sleep=sleep)
    if status not in (204, 404):
        raise GuardError("Runpod termination was not confirmed")
    for attempt in range(3):
        current, _ = _api("GET", path, key, opener=opener, sleep=sleep)
        if current == 404:
            return
        if attempt < 2:
            sleep(2)
    raise GuardError("Runpod Pod remains visible after termination")


def run(key, now, *, opener=None, sleep=time.sleep):
    expired = []
    for pod in _pages(key, opener=opener, sleep=sleep):
        if _expired(pod, now):
            expired.append(pod.get("id"))
    for pod_id in expired:
        _delete_and_confirm(pod_id, key, opener=opener, sleep=sleep)
    return len(expired)


def handler(event, context):
    secret_arn = os.environ["RUNPOD_SECRET_ARN"]
    freshness_parameter = os.environ["FRESHNESS_PARAMETER"]
    secret = boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn).get("SecretString")
    if not isinstance(secret, str) or not secret.strip() or "\n" in secret or "\r" in secret:
        raise GuardError("Runpod API key is unavailable")
    now = datetime.datetime.now(datetime.timezone.utc)
    count = run(secret.strip(), now)
    boto3.client("ssm").put_parameter(
        Name=freshness_parameter, Value=now.isoformat().replace("+00:00", "Z"), Type="String", Overwrite=True
    )
    print("Runpod expiry scan succeeded; expired Pods confirmed absent:", count)
    return {"expired_count": count, "last_success_at": now.isoformat().replace("+00:00", "Z")}
