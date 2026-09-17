#!/usr/bin/env python3
"""
Register an app in the futuremagic.de registry.

The website (`futuremagic.de`) reads one file, `/webseiten/apps.json`, and renders
a card per entry; for each entry whose `manifesto` is not false it also fetches
`<path>/futuremagic.json`, which carries the title, tagline, tags and screenshot
the card shows. Registering an app therefore means: make sure its own
`futuremagic.json` is deployed (`deploy-sync.sh` does that, and `ALWAYS_UPLOAD`
guarantees a size-preserving edit still uploads), and upsert one entry here.

This is the Linux port of the Windows helper the PowerShell deploy calls
(`Register-FuturemagicApp.ps1`, which the Linux deploy prints `[SKIP]` for). It
talks to the same file over the same FTP account.

Semantics, derived from the live registry rather than invented:

  * entries are matched by `slug`, case-insensitively;
  * an existing entry keeps its **position** and has title/path/updatedAt/
    manifesto refreshed — the live file is not sorted by either key, so moving an
    entry would churn a file other tools also write;
  * a new entry is **appended**;
  * `version` is preserved as-is, and every other entry is left alone.

Safety:
  * `--dry-run` fetches, upserts and prints the diff without writing anything;
  * the registry as downloaded is backed up locally before a write, so a restore
    is one `STOR` away;
  * the password comes from `FTP_PASSWORD` only, is never printed, and is cleared
    from the FTP object after login;
  * `--selftest` exercises the pure logic against fixtures with no network at all,
    and runs as part of `scripts/gate.sh`.
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import ftplib
import json
import os
import pathlib
import sys

# Seconds of silence before a transfer is treated as failed. See deploy-ftp.py:
# this box has seen the FTP data channel stall indefinitely, and a stall should
# surface as an error rather than as a hang.
FTP_TIMEOUT_S = 75
BACKUP_DIR = pathlib.Path(".futuremagic")


class RegistryError(Exception):
    """A refusal, with a reason worth printing."""


# ----------------------------------------------------------------------------- 
# The pure part: parse, upsert, serialise. Tested by --selftest.
# -----------------------------------------------------------------------------


def parse_registry(text: str) -> dict:
    """Parse the registry, refusing anything that is not the shape the site reads."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RegistryError(f"registry is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise RegistryError("registry must be a JSON object")
    if not isinstance(data.get("version"), int):
        raise RegistryError("registry needs an integer `version`")
    apps = data.get("apps")
    if not isinstance(apps, list):
        raise RegistryError("registry needs an `apps` array")
    for index, entry in enumerate(apps):
        if not isinstance(entry, dict):
            raise RegistryError(f"apps[{index}] is not an object")
        for key in ("slug", "title", "path"):
            value = entry.get(key)
            if not isinstance(value, str) or value == "":
                raise RegistryError(f"apps[{index}].{key} must be a non-empty string")
    return data


def normalise_path(path: str) -> str:
    """`Orion`, `/Orion` and `/Orion/` all mean the same deploy path."""
    trimmed = path.strip().strip("/")
    if trimmed == "":
        raise RegistryError("path must not be empty or '/'")
    return f"/{trimmed}/"


def utc_now() -> str:
    """UTC timestamp in the shape the live registry uses (7 fractional digits)."""
    now = dt.datetime.now(dt.timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S.')}{now.microsecond:06d}0Z"


def upsert_app(
    registry: dict,
    *,
    slug: str,
    title: str,
    path: str,
    updated_at: str,
    manifesto: bool = True,
) -> tuple[dict, str]:
    """
    Add or refresh one entry. Returns `(registry, action)` where action is
    `"added"` or `"updated"`.
    """
    if slug.strip() == "":
        raise RegistryError("slug must not be empty")
    if title.strip() == "":
        raise RegistryError("title must not be empty")
    deploy_path = normalise_path(path)

    entry = {
        "slug": slug,
        "title": title,
        "path": deploy_path,
        "updatedAt": updated_at,
        "manifesto": bool(manifesto),
    }

    apps = registry["apps"]
    for existing in apps:
        if existing["slug"].lower() == slug.lower():
            # Update in place: position is part of the file's existing order.
            existing["title"] = entry["title"]
            existing["path"] = entry["path"]
            existing["updatedAt"] = entry["updatedAt"]
            existing["manifesto"] = entry["manifesto"]
            return registry, "updated"
    apps.append(entry)
    return registry, "added"


def serialise_registry(registry: dict) -> str:
    """
    Write the registry exactly as the Windows helper writes it.

    That is not cosmetic: this file is shared with a helper that rewrites it from
    another machine, and matching its bytes means a registration from here
    produces a diff containing *one entry* rather than a whole-file reformat. The
    observed style is PowerShell's `ConvertTo-Json`: CRLF line endings, four-space
    nesting, two spaces after a colon, and array items indented under the opening
    bracket rather than under the key.
    """
    quote = json.dumps

    def dump_dict(value: dict, key_indent: int) -> str:
        if not value:
            return "{}"
        lines = []
        for key, item in value.items():
            label = f"{quote(key)}:  "
            # A nested list starts at the column just past `"key":  `, and
            # PowerShell lines its items up four columns after that.
            lines.append(
                " " * key_indent
                + label
                + dump(item, key_indent + 4, key_indent + len(label))
            )
        return "{\n" + ",\n".join(lines) + "\n" + " " * (key_indent - 4) + "}"

    def dump_list(value: list, item_indent: int, bracket_column: int) -> str:
        if not value:
            return "[]"
        # An item that is an object sits at the item indent, so its own keys go
        # one level deeper and its closing brace comes back to the item indent.
        lines = [
            " " * item_indent + dump(item, item_indent + 4, item_indent)
            for item in value
        ]
        return "[\n" + ",\n".join(lines) + "\n" + " " * bracket_column + "]"

    def dump(value: object, indent: int, bracket_column: int) -> str:
        if isinstance(value, dict):
            return dump_dict(value, indent)
        if isinstance(value, list):
            return dump_list(value, bracket_column + 4, bracket_column)
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int):
            return str(value)
        if value is None:
            return "null"
        return quote(value)

    body = dump_dict(registry, 4)
    # The helper writes CRLF throughout and ends with a bare LF, which is a
    # detail of its writer rather than a choice; reproduce it so byte comparison
    # is meaningful.
    return body.replace("\n", "\r\n") + "\n"


# -----------------------------------------------------------------------------
# The impure part: FTP.
# -----------------------------------------------------------------------------


def require_password() -> str:
    password = os.environ.get("FTP_PASSWORD")
    if not password:
        raise RegistryError(
            "FTP_PASSWORD is not set. deploy-sync.sh reads it from "
            "~/.config/orion/ftp.env (chmod 600) or ./.ftp.env.local and passes it "
            "to this process; it is never printed."
        )
    return password


def connect(server: str, user: str, password: str, timeout: int = FTP_TIMEOUT_S) -> ftplib.FTP:
    ftp = ftplib.FTP()
    ftp.connect(server, 21, timeout=timeout)
    ftp.login(user, password)
    ftp.set_pasv(True)
    ftp.voidcmd("TYPE I")
    ftp.sock.settimeout(timeout)
    # ftplib keeps a copy on the instance; do not leave the real value around.
    ftp.password = ""
    return ftp


def download_text(ftp: ftplib.FTP, remote_file: str) -> str:
    chunks: list[bytes] = []
    try:
        ftp.retrbinary(f"RETR {remote_file}", chunks.append)
    except (TimeoutError, OSError) as exc:
        # A stalled data channel is the failure mode this box has actually shown:
        # the control connection logs in fine and the data connection is
        # established, then no bytes arrive. Say which stage failed.
        raise RegistryError(
            f"reading {remote_file} stalled ({type(exc).__name__}); the FTP data "
            f"channel accepted the connection but sent nothing. Retry later or from "
            f"another network — the control channel and the path are fine."
        ) from exc
    return b"".join(chunks).decode("utf-8")


def upload_text(ftp: ftplib.FTP, remote_file: str, text: str) -> None:
    payload = text.encode("utf-8")
    ftp.storbinary(f"STOR {remote_file}", __import__("io").BytesIO(payload))


def join_remote_dir(directory: str, name: str) -> str:
    base = directory if directory.endswith("/") else f"{directory}/"
    return f"{base}{name.lstrip('/')}"


def backup(path: pathlib.Path, text: str, stamp: str) -> pathlib.Path:
    path.mkdir(parents=True, exist_ok=True)
    target = path / f"apps-{stamp}.json"
    target.write_text(text, encoding="utf-8")
    return target


# -----------------------------------------------------------------------------
# Entry points.
# -----------------------------------------------------------------------------


def register(args: argparse.Namespace) -> int:
    if args.server == "" or args.user == "":
        raise RegistryError("--server and --user are required")

    remote_registry = join_remote_dir(args.remote, args.registry)
    password = require_password()
    ftp = connect(args.server, args.user, password, timeout=args.timeout)
    password = ""
    try:
        try:
            current = download_text(ftp, remote_registry)
        except ftplib.all_errors as exc:
            raise RegistryError(f"could not read {remote_registry}: {exc}") from exc

        registry = parse_registry(current)
        updated, action = upsert_app(
            registry,
            slug=args.slug,
            title=args.title,
            path=args.path,
            updated_at=utc_now(),
            manifesto=not args.no_manifesto,
        )
        rendered = serialise_registry(updated)

        if current == rendered:
            print(f"[registry] {args.slug} already current in {remote_registry}")
            return 0

        print(f"[registry] {action}: {args.slug} -> {normalise_path(args.path)}")
        for line in difflib.unified_diff(
            current.splitlines(),
            rendered.splitlines(),
            fromfile=f"{remote_registry} (remote)",
            tofile=f"{remote_registry} (with {args.slug})",
            lineterm="",
            n=2,
        ):
            print(f"  {line}")

        if args.dry_run:
            print("[registry] dry run: nothing written")
            return 0

        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        saved = backup(BACKUP_DIR, current, stamp)
        print(f"[registry] previous registry saved to {saved}")

        try:
            upload_text(ftp, remote_registry, rendered)
        except ftplib.all_errors as exc:
            raise RegistryError(
                f"could not write {remote_registry}: {exc} "
                f"(the previous contents are in {saved})"
            ) from exc
        print(f"[registry] wrote {remote_registry} ({len(rendered)} bytes)")
        return 0
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()


def selftest() -> int:
    """The pure logic, against fixtures. No network, no password, no FTP."""
    failures: list[str] = []

    def check(name: str, condition: bool) -> None:
        if not condition:
            failures.append(name)

    fixture = json.dumps(
        {
            "version": 1,
            "apps": [
                {"slug": "Alpha", "title": "Alpha", "path": "/Alpha/", "updatedAt": "t0", "manifesto": True},
                {"slug": "Beta", "title": "Beta", "path": "/Beta/", "updatedAt": "t0", "manifesto": False},
            ],
        }
    )

    # A new app is appended and nothing else moves.
    reg = parse_registry(fixture)
    reg, action = upsert_app(reg, slug="Orion", title="Orion", path="/Orion/", updated_at="t1")
    check("add reports 'added'", action == "added")
    check("add appends", [a["slug"] for a in reg["apps"]] == ["Alpha", "Beta", "Orion"])
    check("add keeps version", reg["version"] == 1)
    check("add fills the entry", reg["apps"][2] == {
        "slug": "Orion", "title": "Orion", "path": "/Orion/", "updatedAt": "t1", "manifesto": True,
    })

    # Re-registering updates in place and normalises the path.
    reg, action = upsert_app(reg, slug="orion", title="Orion v2", path="Orion", updated_at="t2")
    check("update reports 'updated'", action == "updated")
    check("update keeps position", [a["slug"] for a in reg["apps"]] == ["Alpha", "Beta", "Orion"])
    check("update refreshes fields", reg["apps"][2]["title"] == "Orion v2")
    check("update normalises path", reg["apps"][2]["path"] == "/Orion/")
    check("update does not duplicate", len(reg["apps"]) == 3)
    check("update leaves others alone", reg["apps"][0]["slug"] == "Alpha" and reg["apps"][1]["manifesto"] is False)

    # Round trip through the serialiser, in the shared style.
    text = serialise_registry(reg)
    check("serialised parses back", parse_registry(text)["apps"] == reg["apps"])
    check("serialised uses the shared colon spacing", '"version":  1' in text)
    check("serialised uses CRLF like the Windows helper", "\r\n" in text and text.endswith("}\n"))

    # Byte-identity on the helper's own style: a registration writes one entry,
    # not a whole-file reformat.
    sample = (
        "{\r\n"
        '    "version":  1,\r\n'
        '    "apps":  [\r\n'
        "                 {\r\n"
        '                     "slug":  "Alpha",\r\n'
        '                     "title":  "Alpha",\r\n'
        '                     "path":  "/Alpha/",\r\n'
        '                     "updatedAt":  "t0",\r\n'
        '                     "manifesto":  true\r\n'
        "                 }\r\n"
        "             ]\r\n"
        "}\n"
    )
    check(
        "reproduces the Windows helper's bytes exactly",
        serialise_registry(parse_registry(sample)) == sample,
    )

    # Refusals.
    for name, bad in [
        ("refuses non-JSON", "{oops"),
        ("refuses a missing version", '{"apps": []}'),
        ("refuses a missing apps array", '{"version": 1}'),
        ("refuses an entry without a path", '{"version": 1, "apps": [{"slug": "a", "title": "b"}]}'),
        ("refuses a blank slug", '{"version": 1, "apps": [{"slug": "", "title": "b", "path": "/b/"}]}'),
    ]:
        try:
            parse_registry(bad)
            check(name, False)
        except RegistryError:
            check(name, True)

    try:
        upsert_app(parse_registry(fixture), slug="X", title="X", path="/", updated_at="t")
        check("refuses an empty path", False)
    except RegistryError:
        check("refuses an empty path", True)

    if failures:
        print("futuremagic-registry selftest FAILED:")
        for name in failures:
            print(f"  - {name}")
        return 1
    print("futuremagic-registry selftest: all checks passed")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Upsert an app entry in the futuremagic.de registry (password from FTP_PASSWORD only)."
    )
    parser.add_argument("--server", default="ftp.futuremagic.de")
    parser.add_argument("--user", default="12529-Pyrion")
    parser.add_argument("--remote", default="/webseiten/", help="directory holding the registry")
    parser.add_argument("--registry", default="apps.json", help="registry file name")
    parser.add_argument("--slug", default="Orion")
    parser.add_argument("--title", default="Orion")
    parser.add_argument("--path", default="/Orion/")
    parser.add_argument("--no-manifesto", action="store_true", help="do not point the card at futuremagic.json")
    parser.add_argument(
        "--timeout",
        type=int,
        default=FTP_TIMEOUT_S,
        help=f"seconds of silence before a transfer fails (default {FTP_TIMEOUT_S})",
    )
    parser.add_argument("--dry-run", action="store_true", help="fetch and diff, write nothing")
    parser.add_argument("--selftest", action="store_true", help="run the pure logic against fixtures and exit")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()
    try:
        return register(args)
    except RegistryError as exc:
        print(f"futuremagic-registry: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
