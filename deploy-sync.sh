#!/usr/bin/env bash
# Orion deploy: build for /Orion/, sync it to futuremagic.de over FTP, register it.
#
# Same shape as the sibling projects' deploy (Campaigner, GM_Helper): build with a
# sub-path base, diff-sync `dist/` so the remote is never wiped, then register the
# app in the website's registry. Registration is the piece the Windows PowerShell
# deploy calls out to and the Linux deploys used to skip; here it is a step in
# this script, so one command does the whole deploy on this box.
#
# Usage:
#   ./deploy-sync.sh              build, sync, register
#   ./deploy-sync.sh --no-register  build and sync only
#   ./deploy-sync.sh --dry-run    build, then show what registration would change
#
# Password: `FTP_PASSWORD` in the environment, or a KEY=VALUE line in
# ~/.config/orion/ftp.env (chmod 600) or ./.ftp.env.local (gitignored). It is
# never printed, and never exported into the build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FTP_SERVER="ftp.futuremagic.de"
FTP_USER="12529-Pyrion"
# The app's own directory, and the website's registry beside it.
REMOTE_PATH="/webseiten/Orion/"
REGISTRY_REMOTE="/webseiten/"
BASE_PATH="/Orion/"
PUBLIC_URL="https://futuremagic.de/Orion/"
SLUG="Orion"
TITLE="Orion"

HOME_ENV_FILE="${HOME}/.config/orion/ftp.env"
REPO_ENV_FILE="${SCRIPT_DIR}/.ftp.env.local"

DO_REGISTER=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-register) DO_REGISTER=0 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# xtrace would leak FTP_PASSWORD when it is passed to python.
if [[ $- == *x* ]]; then
  echo "Error: do not run this script with bash -x (it can leak secrets)." >&2
  exit 1
fi

if [[ -t 1 ]]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

# Parse KEY=VALUE lines without sourcing (no eval). Only FTP_PASSWORD is consumed.
load_ftp_password_from_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      value="${BASH_REMATCH[3]}"
      if [[ "$key" == "FTP_PASSWORD" ]]; then
        if [[ "$value" =~ ^\"(.*)\"$ ]]; then value="${BASH_REMATCH[1]}"
        elif [[ "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"
        fi
        if [[ -n "$value" ]]; then FTP_PASSWORD="$value"; return 0; fi
      fi
    fi
  done < "$file"
}

warn_mode_600() {
  local file="$1" mode
  mode="$(stat -c '%a' "$file" 2>/dev/null || true)"
  if [[ -n "$mode" && "$mode" != "600" ]]; then
    echo "${C_YELLOW}Warning: ${file} is mode ${mode}; chmod 600 is preferred.${C_RESET}" >&2
  fi
}

if [[ -n "${FTP_PASSWORD:-}" ]]; then
  echo "${C_GREEN}Using FTP_PASSWORD from the environment${C_RESET}"
elif [[ -f "$HOME_ENV_FILE" ]]; then
  warn_mode_600 "$HOME_ENV_FILE"
  load_ftp_password_from_file "$HOME_ENV_FILE"
elif [[ -f "$REPO_ENV_FILE" ]]; then
  warn_mode_600 "$REPO_ENV_FILE"
  load_ftp_password_from_file "$REPO_ENV_FILE"
fi
if [[ -z "${FTP_PASSWORD:-}" ]]; then
  echo "${C_RED}Error: FTP_PASSWORD is not set.${C_RESET}" >&2
  echo "Create ${HOME_ENV_FILE} (chmod 600) containing:" >&2
  echo "  FTP_PASSWORD=..." >&2
  echo "Do not commit that file. FTP_PASSWORD in the environment also works." >&2
  exit 1
fi

_CAMPAIGNER_FTP_PASSWORD="$FTP_PASSWORD"
unset FTP_PASSWORD
trap 'unset FTP_PASSWORD _CAMPAIGNER_FTP_PASSWORD' EXIT

echo "${C_CYAN}Building Orion for ${BASE_PATH} ...${C_RESET}"
rm -rf dist
ORION_BASE="$BASE_PATH" pnpm run build:domainfactory

echo "${C_YELLOW}Copying .htaccess ...${C_RESET}"
if [[ ! -f public/.htaccess ]]; then
  echo "${C_RED}Error: public/.htaccess is missing${C_RESET}" >&2
  exit 1
fi
cp public/.htaccess dist/.htaccess

# The committed .htaccess carries the deploy path; patch it so this file stays
# correct if the app ever moves to a different base.
python3 - "$BASE_PATH" <<'PY'
import pathlib, re, sys
base = sys.argv[1]
path = pathlib.Path("dist/.htaccess")
data = path.read_bytes()
if data.startswith(b"\xef\xbb\xbf"):
    data = data[3:]
body = data.decode("utf-8").lstrip("\ufeff")
body = re.sub(r"(?m)^(\s*RewriteBase\s+)\S+", lambda m: m.group(1) + base, body)
path.write_bytes(body.encode("utf-8"))
print(f"  RewriteBase set to {base}")
PY

if [[ -f public/futuremagic.json ]]; then
  cp public/futuremagic.json dist/futuremagic.json
fi

if [[ ! -f dist/index.html ]]; then
  echo "${C_RED}Error: build failed - no index.html found${C_RESET}" >&2
  exit 1
fi
if [[ ! -f dist/shot.png ]]; then
  echo "${C_YELLOW}Warning: dist/shot.png is missing, so the site's card will have no image.${C_RESET}"
  echo "${C_YELLOW}  Generate it with: node scripts/make-screenshot.mjs${C_RESET}"
fi

echo "${C_GREEN}Build ok${C_RESET}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "${C_YELLOW}Dry run: skipping the file sync; showing the registration diff only.${C_RESET}"
else
  echo "${C_CYAN}Syncing files (remote is not wiped; stale files in ${REMOTE_PATH} are removed) ...${C_RESET}"
  set +e
  FTP_PASSWORD="$_CAMPAIGNER_FTP_PASSWORD" python3 "$SCRIPT_DIR/scripts/deploy-ftp.py" \
    --server "$FTP_SERVER" \
    --user "$FTP_USER" \
    --remote "$REMOTE_PATH" \
    --dist "$SCRIPT_DIR/dist"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "${C_RED}File sync failed (exit $status); not registering.${C_RESET}" >&2
    exit "$status"
  fi
fi

if [[ "$DO_REGISTER" -eq 1 ]]; then
  echo "${C_CYAN}Registering ${SLUG} in ${REGISTRY_REMOTE}apps.json ...${C_RESET}"
  set +e
  if [[ "$DRY_RUN" -eq 1 ]]; then
    FTP_PASSWORD="$_CAMPAIGNER_FTP_PASSWORD" python3 "$SCRIPT_DIR/scripts/futuremagic-registry.py" \
      --server "$FTP_SERVER" --user "$FTP_USER" --remote "$REGISTRY_REMOTE" \
      --slug "$SLUG" --title "$TITLE" --path "$BASE_PATH" --dry-run
  else
    FTP_PASSWORD="$_CAMPAIGNER_FTP_PASSWORD" python3 "$SCRIPT_DIR/scripts/futuremagic-registry.py" \
      --server "$FTP_SERVER" --user "$FTP_USER" --remote "$REGISTRY_REMOTE" \
      --slug "$SLUG" --title "$TITLE" --path "$BASE_PATH"
  fi
  status=$?
  set -e
  unset FTP_PASSWORD _CAMPAIGNER_FTP_PASSWORD
  if [[ "$status" -ne 0 ]]; then
    echo "${C_RED}Registration failed (exit $status). The files are deployed; re-run to register.${C_RESET}" >&2
    exit "$status"
  fi
else
  echo "${C_YELLOW}Skipping registration (--no-register).${C_RESET}"
fi

echo "${C_CYAN}App should now be live at: ${PUBLIC_URL}${C_RESET}"
