#!/usr/bin/env bash
set -euo pipefail
umask 077

case "${1:-}" in
	prepare) export -n PRIVATE_SOURCE_READ_KEY ;;
	publish) export -n PUBLIC_SOURCE_PUBLISH_KEY ;;
	*) printf 'Usage: %s prepare|publish\n' "${BASH_SOURCE[0]}" >&2; exit 1 ;;
esac

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly MANIFEST="$SCRIPT_DIR/publication.json"
readonly STATE_DIR="${RUNNER_TEMP:?RUNNER_TEMP is required}/petuja-email-publication-state"
readonly PRIVATE_REMOTE='git@github.com:petuja-Systems/petuja.email.git'
readonly GITHUB_ED25519_HOST_KEY='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
PRIVATE_SSH_DIR=''
PUBLIC_SSH_DIR=''

fail() {
	echo "::error::$*" >&2
	exit 1
}

cleanup_private_key() {
	if [[ -n "$PRIVATE_SSH_DIR" ]]; then
		rm -f "$PRIVATE_SSH_DIR/key" "$PRIVATE_SSH_DIR/known_hosts"
		rmdir "$PRIVATE_SSH_DIR" 2>/dev/null || true
		PRIVATE_SSH_DIR=''
	fi
}

cleanup_public_key() {
	if [[ -n "$PUBLIC_SSH_DIR" ]]; then
		rm -f "$PUBLIC_SSH_DIR/key" "$PUBLIC_SSH_DIR/known_hosts"
		rmdir "$PUBLIC_SSH_DIR" 2>/dev/null || true
		PUBLIC_SSH_DIR=''
	fi
}

read_manifest() {
	local values
	values="$(python3 - "$MANIFEST" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
keys = [
    "public_repository", "public_branch", "public_tag", "public_parent",
    "public_https_url", "public_ssh_url", "public_control_branch",
    "control_sha", "release_sha",
    "product_version", "source_tree", "archive_sha256",
]
if set(data) != set(keys):
    raise SystemExit("Publication manifest fields do not match this controller")
for key in keys:
    value = data[key]
    if not isinstance(value, str) or not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise SystemExit("Invalid publication manifest value")
    print(value)
PY
)" || fail 'Cannot read the reviewed publication manifest'
	local -a values_array=()
	local value
	while IFS= read -r value; do
		values_array+=("$value")
	done <<< "$values"
	[[ ${#values_array[@]} -eq 12 ]] || fail 'Invalid publication manifest field count'
	PUBLIC_REPOSITORY="${values_array[0]}"
	PUBLIC_BRANCH="${values_array[1]}"
	PUBLIC_TAG="${values_array[2]}"
	PUBLIC_PARENT="${values_array[3]}"
	PUBLIC_HTTPS_URL="${values_array[4]}"
	PUBLIC_SSH_URL="${values_array[5]}"
	PUBLIC_CONTROL_BRANCH="${values_array[6]}"
	CONTROL_SHA="${values_array[7]}"
	RELEASE_SHA="${values_array[8]}"
	PRODUCT_VERSION="${values_array[9]}"
	SOURCE_TREE="${values_array[10]}"
	ARCHIVE_SHA256="${values_array[11]}"

	[[ "$PUBLIC_REPOSITORY" == 'petuja-Systems/snappymail-petuja-systems' ]] || fail 'Unexpected public repository'
	[[ "$PUBLIC_BRANCH" == 'petuja-email' ]] || fail 'Unexpected public product branch'
	[[ "$PUBLIC_CONTROL_BRANCH" == 'petuja-email-release-control' ]] || fail 'Unexpected public controller branch'
	[[ "$PUBLIC_TAG" == "petuja-email-v$PRODUCT_VERSION" ]] || fail 'Publication tag does not match the product version'
	[[ "$PUBLIC_PARENT" =~ ^[a-f0-9]{40}$ && "$CONTROL_SHA" =~ ^[a-f0-9]{40}$ && "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ && "$SOURCE_TREE" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid commit or tree identity in publication manifest'
	[[ "$PRODUCT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || fail 'Invalid product version in publication manifest'
	[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid archive digest in publication manifest'
	[[ "$PUBLIC_HTTPS_URL" == "https://github.com/$PUBLIC_REPOSITORY.git" ]] || fail 'Unexpected public read URL'
	[[ "$PUBLIC_SSH_URL" == "git@github.com:$PUBLIC_REPOSITORY.git" ]] || fail 'Unexpected public write URL'
}

validate_request_and_context() {
	local request_values
	request_values="$(python3 - "$SCRIPT_DIR/publication-request.json" <<'PY'
import json
import pathlib
import sys

request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
keys = {"confirmation", "release_sha", "product_version"}
if set(request) != keys:
    raise SystemExit("Publication request fields do not match this controller")
for key in ["confirmation", "release_sha", "product_version"]:
    value = request[key]
    if not isinstance(value, str) or not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise SystemExit("Invalid publication request value")
    print(value)
PY
)" || fail 'Cannot read the explicit publication request'
	local -a request_array=()
	local value
	while IFS= read -r value; do
		request_array+=("$value")
	done <<< "$request_values"
	[[ ${#request_array[@]} -eq 3 ]] || fail 'Invalid publication request field count'
	[[ "${request_array[0]}" == 'PUBLISH' ]] || fail 'Publication request confirmation must be PUBLISH'
	[[ "${request_array[1]}" == "$RELEASE_SHA" ]] || fail 'Requested source SHA does not match the reviewed 1.1.0 manifest'
	[[ "${request_array[2]}" == "$PRODUCT_VERSION" ]] || fail 'Requested product version does not match the reviewed manifest'
	[[ "${GITHUB_REPOSITORY:-}" == "$PUBLIC_REPOSITORY" ]] || fail 'Controller is running in an unexpected repository'
	[[ "${TRUSTED_CONTROL_REF:-}" == "refs/heads/$PUBLIC_CONTROL_BRANCH" ]] || fail 'Controller must run from the dedicated public release-control branch'
	[[ "${TRUSTED_CONTROL_REF_PROTECTED:-}" == 'true' ]] || fail 'The public release-control ref is not protected'
	[[ "${TRUSTED_PUBLIC_CONTROL_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || fail 'Missing exact public controller commit'
	local checkout_sha
	checkout_sha="$(git -C "$GITHUB_WORKSPACE/controller" rev-parse --verify 'HEAD^{commit}')"
	[[ "$checkout_sha" == "$TRUSTED_PUBLIC_CONTROL_SHA" ]] || fail 'Checked-out public controls differ from the protected dispatch commit'
	[[ -z "$(git -C "$GITHUB_WORKSPACE/controller" status --porcelain=v1)" ]] || fail 'Public controller checkout is not clean'
}

verify_local_publication() {
	local branch_commit tag_object tag_commit tree message trailer_count
	branch_commit="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "refs/heads/$PUBLIC_BRANCH^{commit}")"
	[[ "$branch_commit" != "$PUBLIC_PARENT" ]] || fail 'Prepared public branch did not advance'
	[[ "$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "$branch_commit^")" == "$PUBLIC_PARENT" ]] || fail 'Prepared public commit has an unexpected parent'
	tree="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "$branch_commit^{tree}")"
	[[ "$tree" == "$SOURCE_TREE" ]] || fail 'Prepared public source tree differs from the reviewed tree'
	git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" show-ref --verify --quiet "refs/tags/$PUBLIC_TAG" || fail 'Prepared immutable release tag is missing'
	tag_object="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" show-ref --hash --verify "refs/tags/$PUBLIC_TAG")"
	[[ "$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" cat-file -t "$tag_object")" == 'tag' ]] || fail 'Release tag must be annotated'
	tag_commit="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "refs/tags/$PUBLIC_TAG^{commit}")"
	[[ "$tag_commit" == "$branch_commit" ]] || fail 'Release tag does not point to the prepared branch commit'
	message="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" show -s --format=%B "$branch_commit")"
	trailer_count="$(printf '%s\n' "$message" | awk -v expected="Private source commit: $RELEASE_SHA" '/^Private source commit:/ { if ($0 == expected) count++; else invalid = 1 } END { if (invalid) print "invalid"; else print count + 0 }')"
	[[ "$trailer_count" == '1' ]] || fail 'Public commit must contain exactly one provenance line for RELEASE_SHA'
}

prepare() {
	read_manifest
	validate_request_and_context
	[[ -n "${PRIVATE_SOURCE_READ_KEY:-}" ]] || fail 'Missing environment-scoped private read-only source key'
	[[ ! -e "$STATE_DIR" && ! -L "$STATE_DIR" ]] || fail 'Publication state directory already exists'
	mkdir -m 0700 "$STATE_DIR"

	local control_dir export_dir archive public_commit public_tree
	PRIVATE_SSH_DIR="$(mktemp -d "$RUNNER_TEMP/petuja-private-source-key.XXXXXX")"
	trap cleanup_private_key EXIT
	printf '%s\n' "$PRIVATE_SOURCE_READ_KEY" > "$PRIVATE_SSH_DIR/key"
	unset PRIVATE_SOURCE_READ_KEY
	chmod 0600 "$PRIVATE_SSH_DIR/key"
	printf '%s\n' "$GITHUB_ED25519_HOST_KEY" > "$PRIVATE_SSH_DIR/known_hosts"
	chmod 0600 "$PRIVATE_SSH_DIR/known_hosts"
	export GIT_SSH_COMMAND="ssh -F /dev/null -i \"$PRIVATE_SSH_DIR/key\" -oIdentitiesOnly=yes -oBatchMode=yes -oStrictHostKeyChecking=yes -oUserKnownHostsFile=\"$PRIVATE_SSH_DIR/known_hosts\" -oGlobalKnownHostsFile=/dev/null -oHostKeyAlgorithms=ssh-ed25519"

	control_dir="$STATE_DIR/private-control"
	git init --quiet --template=/dev/null "$control_dir"
	git -c core.hooksPath=/dev/null -C "$control_dir" remote add origin "$PRIVATE_REMOTE"
	git -c core.hooksPath=/dev/null -C "$control_dir" fetch --no-tags origin refs/heads/main
	local main_tip
	main_tip="$(git -c core.hooksPath=/dev/null -C "$control_dir" rev-parse --verify 'FETCH_HEAD^{commit}')"
	git -c core.hooksPath=/dev/null -C "$control_dir" cat-file -e "$CONTROL_SHA^{commit}" || fail 'Fixed private control commit is unavailable'
	git -c core.hooksPath=/dev/null -C "$control_dir" merge-base --is-ancestor "$CONTROL_SHA" "$main_tip" || fail 'Fixed private controls are no longer reachable from private main'
	git -c core.hooksPath=/dev/null -C "$control_dir" merge-base --is-ancestor "$RELEASE_SHA" "$CONTROL_SHA" || fail 'RELEASE_SHA is not an ancestor of the fixed private control commit'
	git -c core.hooksPath=/dev/null -C "$control_dir" checkout --quiet --detach "$CONTROL_SHA"
	[[ "$(git -c core.hooksPath=/dev/null -C "$control_dir" rev-parse --verify HEAD)" == "$CONTROL_SHA" ]] || fail 'Private control checkout did not resolve to the fixed commit'
	[[ -z "$(git -c core.hooksPath=/dev/null -C "$control_dir" status --porcelain=v1)" ]] || fail 'Private trusted controls are not clean'
	unset GIT_SSH_COMMAND
	cleanup_private_key
	trap - EXIT

	export_dir="$STATE_DIR/public-source"
	archive="$STATE_DIR/public-source.tar"
	"$control_dir/scripts/export-public-source.sh" "$export_dir" "$RELEASE_SHA" "$control_dir"
	"$control_dir/scripts/validate-product-metadata.sh" "$export_dir"
	"$control_dir/scripts/validate-release-ready.sh" "$export_dir"
	"$control_dir/scripts/validate-public-source.sh" "$export_dir"
	python3 "$control_dir/scripts/prepare-public-source-commit.py" --create-archive \
		--repository "$control_dir" --source-commit "$RELEASE_SHA" --archive "$archive"
	[[ "$(sha256sum "$archive" | awk '{print $1}')" == "$ARCHIVE_SHA256" ]] || fail 'Exact source archive differs from the reviewed SHA-256'

	git -c core.hooksPath=/dev/null clone --bare --template=/dev/null --no-tags \
		"$PUBLIC_HTTPS_URL" "$STATE_DIR/public.git"
	local current_branch
	current_branch="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify 'refs/heads/'"$PUBLIC_BRANCH" 2>/dev/null || true)"
	[[ "$current_branch" == "$PUBLIC_PARENT" ]] || fail 'Public product branch is not at the reviewed expected parent'
	if git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" show-ref --verify --quiet "refs/tags/$PUBLIC_TAG"; then
		fail 'Immutable public version tag already exists'
	fi
	public_commit="$(python3 "$control_dir/scripts/prepare-public-source-commit.py" \
		--archive "$archive" --repository "$STATE_DIR/public.git" --version "$PRODUCT_VERSION" \
		--source-commit "$RELEASE_SHA" --digest "$ARCHIVE_SHA256" --baseline "$PUBLIC_PARENT")"
	verify_local_publication
	public_tree="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "$public_commit^{tree}")"
	[[ "$public_commit" == "$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "refs/heads/$PUBLIC_BRANCH")" ]] || fail 'Prepared commit is not the intended public branch tip'

	PUBLIC_REPOSITORY="$PUBLIC_REPOSITORY" PUBLIC_BRANCH="$PUBLIC_BRANCH" PUBLIC_TAG="$PUBLIC_TAG" \
	PUBLIC_PARENT="$PUBLIC_PARENT" CONTROL_SHA="$CONTROL_SHA" RELEASE_SHA="$RELEASE_SHA" \
	PRODUCT_VERSION="$PRODUCT_VERSION" SOURCE_TREE="$public_tree" ARCHIVE_SHA256="$ARCHIVE_SHA256" \
	PUBLIC_COMMIT="$public_commit" python3 - "$STATE_DIR/state.json" <<'PY'
import json
import os
import pathlib
import sys

state = {
    key.lower(): os.environ[key]
    for key in [
        "PUBLIC_REPOSITORY", "PUBLIC_BRANCH", "PUBLIC_TAG", "PUBLIC_PARENT",
        "CONTROL_SHA", "RELEASE_SHA", "PRODUCT_VERSION", "SOURCE_TREE",
        "ARCHIVE_SHA256", "PUBLIC_COMMIT",
    ]
}
path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
path.chmod(0o600)
PY

	if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
		{
			printf 'Prepared exact corresponding source for `%s` from private RELEASE_SHA `%s`.\n\n' "$PRODUCT_VERSION" "$RELEASE_SHA"
			printf -- '- Public tree: `%s`\n- Expected public parent: `%s`\n- Prepared public commit: `%s`\n- Raw archive SHA-256: `%s`\n' \
				"$public_tree" "$PUBLIC_PARENT" "$public_commit" "$ARCHIVE_SHA256"
		} >> "$GITHUB_STEP_SUMMARY"
	fi
}

publish() {
	read_manifest
	validate_request_and_context
	[[ -n "${PUBLIC_SOURCE_PUBLISH_KEY:-}" ]] || fail 'Missing environment-scoped public repository write key'
	[[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || fail 'Prepared publication state is missing'
	[[ -f "$STATE_DIR/state.json" && ! -L "$STATE_DIR/state.json" ]] || fail 'Prepared publication manifest is missing'
	[[ -f "$STATE_DIR/public-source.tar" && ! -L "$STATE_DIR/public-source.tar" ]] || fail 'Prepared public source archive is missing'
	[[ "$(sha256sum "$STATE_DIR/public-source.tar" | awk '{print $1}')" == "$ARCHIVE_SHA256" ]] || fail 'Prepared source archive changed before publication'
	verify_local_publication

	PUBLIC_REPOSITORY="$PUBLIC_REPOSITORY" PUBLIC_BRANCH="$PUBLIC_BRANCH" PUBLIC_TAG="$PUBLIC_TAG" \
	PUBLIC_PARENT="$PUBLIC_PARENT" CONTROL_SHA="$CONTROL_SHA" RELEASE_SHA="$RELEASE_SHA" \
	PRODUCT_VERSION="$PRODUCT_VERSION" SOURCE_TREE="$SOURCE_TREE" ARCHIVE_SHA256="$ARCHIVE_SHA256" \
	python3 - "$STATE_DIR/state.json" <<'PY'
import json
import os
import pathlib
import re
import sys

state = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = {
    key.lower(): os.environ[key]
    for key in [
        "PUBLIC_REPOSITORY", "PUBLIC_BRANCH", "PUBLIC_TAG", "PUBLIC_PARENT",
        "CONTROL_SHA", "RELEASE_SHA", "PRODUCT_VERSION", "SOURCE_TREE", "ARCHIVE_SHA256",
    ]
}
if any(state.get(key) != value for key, value in expected.items()):
    raise SystemExit("Prepared state does not match the reviewed publication manifest")
if not isinstance(state.get("public_commit"), str) or not re.fullmatch(r"[a-f0-9]{40}", state["public_commit"]):
    raise SystemExit("Prepared public commit identity is invalid")
PY

	local public_commit public_tree tag_object remote_refs remote_branch remote_tag verified_refs verified_branch verified_tag
	public_commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_commit"])' "$STATE_DIR/state.json")"
	[[ "$public_commit" == "$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "refs/heads/$PUBLIC_BRANCH")" ]] || fail 'Prepared branch tip differs from the saved publication identity'
	public_tree="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" rev-parse --verify "$public_commit^{tree}")"
	[[ "$public_tree" == "$SOURCE_TREE" ]] || fail 'Prepared source tree changed before publication'
	tag_object="$(git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" show-ref --hash --verify "refs/tags/$PUBLIC_TAG")"

	PUBLIC_SSH_DIR="$(mktemp -d "$RUNNER_TEMP/petuja-public-source-write-key.XXXXXX")"
	trap cleanup_public_key EXIT
	printf '%s\n' "$PUBLIC_SOURCE_PUBLISH_KEY" > "$PUBLIC_SSH_DIR/key"
	unset PUBLIC_SOURCE_PUBLISH_KEY
	chmod 0600 "$PUBLIC_SSH_DIR/key"
	printf '%s\n' "$GITHUB_ED25519_HOST_KEY" > "$PUBLIC_SSH_DIR/known_hosts"
	chmod 0600 "$PUBLIC_SSH_DIR/known_hosts"
	export GIT_SSH_COMMAND="ssh -F /dev/null -i \"$PUBLIC_SSH_DIR/key\" -oIdentitiesOnly=yes -oBatchMode=yes -oStrictHostKeyChecking=yes -oUserKnownHostsFile=\"$PUBLIC_SSH_DIR/known_hosts\" -oGlobalKnownHostsFile=/dev/null -oHostKeyAlgorithms=ssh-ed25519"

	remote_refs="$(git ls-remote --refs "$PUBLIC_SSH_URL" "refs/heads/$PUBLIC_BRANCH" "refs/tags/$PUBLIC_TAG")"
	remote_branch=""
	remote_tag=""
	while read -r oid ref; do
		[[ -n "${oid:-}" ]] || continue
		case "$ref" in
			"refs/heads/$PUBLIC_BRANCH") [[ -z "$remote_branch" ]] || fail 'Remote product branch was returned more than once'; remote_branch="$oid" ;;
			"refs/tags/$PUBLIC_TAG") [[ -z "$remote_tag" ]] || fail 'Remote immutable tag was returned more than once'; remote_tag="$oid" ;;
			*) fail 'Remote returned an unexpected publication ref' ;;
		esac
	done <<< "$remote_refs"
	[[ "$remote_branch" == "$PUBLIC_PARENT" ]] || fail 'Remote product branch moved from the reviewed expected parent'
	[[ -z "$remote_tag" ]] || fail 'Immutable public version tag already exists remotely'

	git -c core.hooksPath=/dev/null --git-dir="$STATE_DIR/public.git" push --atomic \
		"$PUBLIC_SSH_URL" \
		"refs/heads/$PUBLIC_BRANCH:refs/heads/$PUBLIC_BRANCH" \
		"refs/tags/$PUBLIC_TAG:refs/tags/$PUBLIC_TAG"

	verified_refs="$(git ls-remote --refs "$PUBLIC_SSH_URL" "refs/heads/$PUBLIC_BRANCH" "refs/tags/$PUBLIC_TAG")"
	verified_branch=""
	verified_tag=""
	while read -r oid ref; do
		[[ -n "${oid:-}" ]] || continue
		case "$ref" in
			"refs/heads/$PUBLIC_BRANCH") verified_branch="$oid" ;;
			"refs/tags/$PUBLIC_TAG") verified_tag="$oid" ;;
			*) fail 'Remote returned an unexpected publication ref after push' ;;
		esac
	done <<< "$verified_refs"
	[[ "$verified_branch" == "$public_commit" ]] || fail 'Published branch ref does not match the validated commit'
	[[ "$verified_tag" == "$tag_object" ]] || fail 'Published immutable tag ref does not match the validated tag object'

	if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
		printf '\nPublished `%s` at `%s` and immutable tag `%s` from private RELEASE_SHA `%s`.\n' \
			"$PUBLIC_BRANCH" "$public_commit" "$PUBLIC_TAG" "$RELEASE_SHA" >> "$GITHUB_STEP_SUMMARY"
	fi
}

read_manifest
case "${1:-}" in
	prepare) prepare ;;
	publish) publish ;;
esac
