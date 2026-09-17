"""
Incremental FTP sync of a built `dist/` directory to futuremagic.de.

Shared with the sibling projects on this box (Campaigner, GM_Helper deploy the
same way): diff by size, upload new and changed files, delete remote files that
are no longer in `dist/`, and never wipe the remote tree. `ALWAYS_UPLOAD` forces
the files whose content can change without their size changing.

The password is read from the `FTP_PASSWORD` environment variable only, and is
never printed: `deploy-sync.sh` reads it from a `chmod 600` file and passes it to
this process for the length of the run.

Usage:
    FTP_PASSWORD=... python3 scripts/deploy-ftp.py \
        --server ftp.futuremagic.de --user 12529-Pyrion \
        --remote /webseiten/Orion/ --dist dist
"""

import argparse
import os
import sys
import ftplib
from pathlib import Path

ALWAYS_UPLOAD = {"index.html", ".htaccess", "futuremagic.json"}
# Seconds of silence on a data connection before giving up.
#
# The sibling projects use 300, which turns a stalled FTP data channel into a
# five-minute hang per file. A stalled channel here is a network or server
# condition that will not recover inside one run, so this fails in about a minute
# with a real error instead of holding the terminal.
FTP_TIMEOUT_S = 75


def _color_enabled() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


class C:
    def __init__(self) -> None:
        on = _color_enabled()
        self.cyan = "\033[36m" if on else ""
        self.green = "\033[32m" if on else ""
        self.yellow = "\033[33m" if on else ""
        self.red = "\033[31m" if on else ""
        self.gray = "\033[90m" if on else ""
        self.reset = "\033[0m" if on else ""


COL = C()


def normalize_ftp_dir(path: str) -> str:
    p = path.replace("\\", "/")
    if not p.startswith("/"):
        p = "/" + p
    if not p.endswith("/"):
        p = p + "/"
    return p


def join_remote(remote_dir: str, rel: str) -> str:
    return remote_dir.rstrip("/") + "/" + rel.lstrip("/")


def require_password() -> str:
    password = os.environ.get("FTP_PASSWORD")
    if not password:
        print(
            "FTP_PASSWORD is not set in the environment.",
            file=sys.stderr,
        )
        sys.exit(1)
    # Drop it from the process environment so it is less likely to leak.
    os.environ.pop("FTP_PASSWORD", None)
    return password


def connect(server: str, user: str, password: str) -> ftplib.FTP:
    ftp = ftplib.FTP()
    ftp.connect(server, 21, timeout=FTP_TIMEOUT_S)
    ftp.login(user, password)
    ftp.set_pasv(True)
    ftp.voidcmd("TYPE I")
    ftp.sock.settimeout(FTP_TIMEOUT_S)
    # ftplib keeps a copy on the instance; do not leave the real value around.
    ftp.password = ""
    return ftp


def ensure_directory(ftp: ftplib.FTP, remote_dir: str) -> None:
    path = remote_dir.rstrip("/") or "/"
    if path == "/":
        return
    try:
        ftp.mkd(path)
        print(f"{COL.cyan}Created directory: {normalize_ftp_dir(path)}{COL.reset}")
    except ftplib.all_errors:
        # Already exists (or server refused); match the PowerShell helper.
        pass


def ftp_file_size(ftp: ftplib.FTP, remote_file: str) -> int | None:
    try:
        size = ftp.size(remote_file)
    except ftplib.all_errors:
        return None
    if size is None:
        return None
    return int(size)


def upload_file(ftp: ftplib.FTP, local_path: Path, remote_file: str) -> int:
    size = local_path.stat().st_size
    with local_path.open("rb") as handle:
        ftp.storbinary(f"STOR {remote_file}", handle)
    return size


def delete_file(ftp: ftplib.FTP, remote_file: str) -> None:
    ftp.delete(remote_file)


def _parse_list_line(line: str) -> tuple[str, bool, int | None] | None:
    """Unix or DOS LIST line -> (name, is_dir, size or None)."""
    raw = line.strip()
    if not raw or raw.startswith("total"):
        return None
    # DOS: 01-01-26  12:00PM              1234 file
    #      01-01-26  12:00PM    <DIR>          dir
    if "<DIR>" in raw.upper() or raw[:1].isdigit():
        parts = raw.split()
        if len(parts) < 4:
            return None
        name = parts[-1]
        if name in (".", ".."):
            return None
        is_dir = "<DIR>" in raw.upper()
        size = None
        if not is_dir:
            try:
                size = int(parts[-2])
            except ValueError:
                size = None
        return name, is_dir, size
    parts = raw.split(None, 8)
    if len(parts) < 9:
        # permissions links owner group size month day time/year name
        parts = raw.split()
        if len(parts) < 9:
            return None
        name = parts[-1]
    else:
        name = parts[8]
    if name in (".", ".."):
        return None
    is_dir = raw.startswith("d")
    size = None
    if not is_dir:
        try:
            size = int(parts[4])
        except (IndexError, ValueError):
            size = None
    return name, is_dir, size


def _list_entries(ftp: ftplib.FTP, remote_dir: str) -> list[tuple[str, bool, int | None]]:
    """cwd into the dir, then MLSD or LIST. Never LIST with an absolute path."""
    path = remote_dir.rstrip("/") or "/"
    old = ftp.pwd()
    entries: list[tuple[str, bool, int | None]] = []
    try:
        ftp.cwd(path)
        try:
            for name, facts in ftp.mlsd():
                if name in (".", ".."):
                    continue
                kind = (facts.get("type") or "").lower()
                if kind in {"cdir", "pdir"}:
                    continue
                is_dir = kind == "dir"
                size = None
                if not is_dir and "size" in facts:
                    try:
                        size = int(facts["size"])
                    except ValueError:
                        size = None
                entries.append((name, is_dir, size))
            return entries
        except (ftplib.all_errors, AttributeError, ValueError):
            entries = []
        lines: list[str] = []
        ftp.retrlines("LIST", lines.append)
        for line in lines:
            parsed = _parse_list_line(line)
            if parsed is not None:
                entries.append(parsed)
        return entries
    except ftplib.all_errors:
        return []
    finally:
        try:
            ftp.cwd(old)
        except ftplib.all_errors:
            pass


def remote_files(
    ftp: ftplib.FTP, remote_dir: str, prefix: str = ""
) -> dict[str, int]:
    files: dict[str, int] = {}
    label = prefix or "."
    print(f"{COL.gray}  listing {label}{COL.reset}", flush=True)
    entries = _list_entries(ftp, remote_dir)
    for name, is_dir, size in entries:
        rel = name if prefix == "" else f"{prefix}/{name}"
        if is_dir:
            child_dir = join_remote(remote_dir, name) + "/"
            files.update(remote_files(ftp, child_dir, rel))
        else:
            files[rel] = -1 if size is None else size
    return files


def local_file_map(dist: Path) -> dict[str, Path]:
    mapping: dict[str, Path] = {}
    for path in dist.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(dist).as_posix()
        mapping[rel] = path
    return mapping


def ensure_parent_dirs(ftp: ftplib.FTP, remote_root: str, rel: str) -> None:
    parts = rel.split("/")
    if len(parts) <= 1:
        return
    current = remote_root
    for part in parts[:-1]:
        current = f"{current}{part}/"
        ensure_directory(ftp, current)


def sync(server: str, user: str, remote: str, dist: Path) -> int:
    password = require_password()
    remote = normalize_ftp_dir(remote)
    if not dist.is_dir():
        print(f"{COL.red}dist directory is missing: {dist}{COL.reset}", file=sys.stderr)
        return 1

    ftp = None
    try:
        ftp = connect(server, user, password)
    except ftplib.all_errors as exc:
        print(f"{COL.red}FTP connect/login failed: {exc}{COL.reset}", file=sys.stderr)
        return 1
    finally:
        password = None
    if ftp is None:
        return 1

    failed: list[str] = []
    uploaded = 0
    skipped = 0
    deleted = 0

    try:
        ensure_directory(ftp, remote)

        print(f"{COL.yellow}Listing remote files for comparison...{COL.reset}")
        remote_map = remote_files(ftp, remote)
        print(
            f"{COL.cyan}Remote currently has {len(remote_map)} file(s).{COL.reset}"
        )

        local_map = local_file_map(dist)

        print(f"{COL.green}Syncing local dist/ to remote...{COL.reset}")
        for rel in sorted(local_map):
            local_path = local_map[rel]
            remote_file = join_remote(remote, rel)
            force = rel in ALWAYS_UPLOAD
            remote_size = remote_map.get(rel)
            local_size = int(local_path.stat().st_size)

            if (
                not force
                and remote_size is not None
                and remote_size == local_size
            ):
                skipped += 1
                print(f"{COL.gray}Skip (same size): {rel}{COL.reset}")
                continue

            ensure_parent_dirs(ftp, remote, rel)

            try:
                bytes_sent = upload_file(ftp, local_path, remote_file)
                uploaded += 1
                if force:
                    reason = "always"
                elif remote_size is None:
                    reason = "new"
                else:
                    reason = "changed"
                size_kb = round(bytes_sent / 1024, 1)
                print(
                    f"{COL.green}Uploaded ({reason}): {rel} ({size_kb} KB){COL.reset}"
                )
            except ftplib.all_errors as exc:
                failed.append(rel)
                print(f"{COL.red}Failed: {rel} - {exc}{COL.reset}")

        print(f"{COL.yellow}Removing stale remote files...{COL.reset}")
        for rel in sorted(remote_map):
            if rel in local_map:
                continue
            try:
                delete_file(ftp, join_remote(remote, rel))
                deleted += 1
                print(f"{COL.yellow}Deleted stale: {rel}{COL.reset}")
            except ftplib.all_errors as exc:
                failed.append(rel)
                print(f"{COL.red}Failed delete: {rel} - {exc}{COL.reset}")

        print()
        print(f"{COL.cyan}=== DEPLOYMENT VERIFICATION ==={COL.reset}")
        for critical in ("index.html", ".htaccess"):
            size = ftp_file_size(ftp, join_remote(remote, critical))
            if size is None:
                print(f"{COL.red}[FAIL] {critical} MISSING!{COL.reset}")
                failed.append(critical)
            else:
                print(
                    f"{COL.green}[OK] {critical} verified ({size} bytes){COL.reset}"
                )

        if failed:
            print()
            print(f"{COL.red}=== FAILED OPERATIONS ==={COL.reset}")
            for name in failed:
                print(f"{COL.red}[FAIL] {name}{COL.reset}")
            print(
                f"{COL.red}Sync completed with {len(failed)} failed operation(s). "
                f"Check the errors above.{COL.reset}"
            )
            return 1

        print()
        print(
            f"{COL.green}DIFF SYNC finished! Uploaded {uploaded}, "
            f"skipped {skipped}, deleted {deleted}.{COL.reset}"
        )
        return 0
    finally:
        try:
            ftp.quit()
        except ftplib.all_errors:
            try:
                ftp.close()
            except ftplib.all_errors:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Incremental FTP sync of dist/ (password from FTP_PASSWORD only)."
    )
    parser.add_argument("--server", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--remote", required=True)
    parser.add_argument("--dist", required=True)
    args = parser.parse_args()
    return sync(args.server, args.user, args.remote, Path(args.dist).resolve())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        sys.exit(130)
