#!/usr/bin/env python3
"""Validate localization structure without executing catalog content."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
from typing import Any


LOCALIZATION_PATH = Path("snappymail/v/0.0.0/app/localization")
CATALOG_TYPES = ("user", "admin", "static")
REQUIRED_USER_KEYS = (
    "LOGIN/TAGLINE",
    "LOGIN/LEGAL_NAVIGATION",
    "LOGIN/LEGAL_IMPRINT",
    "LOGIN/LEGAL_PRIVACY",
    "LOGIN/LEGAL_SOURCE",
)
RTL_LOCALES = frozenset({"ar", "fa"})
LANGUAGE_DIRECTION_VALUES = frozenset({"ltr", "rtl"})
PLACEHOLDER_RE = re.compile(r"%([A-Za-z][A-Za-z0-9_-]*)%")
PLACEHOLDER_NAME_RE = re.compile(r"[A-Z][A-Z0-9_-]*\Z")
PLACEHOLDER_CANDIDATE_RE = re.compile(r"%([A-Za-z0-9_-]+)(%?)")
HTML_TAGS = frozenset({"a", "b", "br", "strong"})
HTML_VOID_TAGS = frozenset({"br"})
HTML_SINK_KEYS = {
    "user": frozenset(
        {
            "COMPOSE/REPLY_MESSAGE_TITLE",
            "CRYPTO/ASK_CRYPTKEY_PASS",
            "CRYPTO/CURRENT_PASS",
            "CRYPTO/NEW_PASS",
            "COMPOSE/DISCARD_UNSAVED_DATA",
            "GLOBAL/SAVE_CHANGES",
            "POPUPS_ASK/DESC_WANT_CLOSE_THIS_WINDOW",
            "POPUPS_ASK/DESC_WANT_DELETE_MESSAGES",
            "POPUPS_CLEAR_FOLDER/DANGER_DESC_HTML_1",
            "POPUPS_CLEAR_FOLDER/DANGER_DESC_HTML_2",
            "POPUPS_CLEAR_FOLDER/DANGER_DESC_WARNING",
            "SMIME/PRIVATE_KEY_OF",
        }
    ),
    "admin": frozenset(
        {
            "POPUPS_DOMAIN/NEW_DOMAIN_DESC",
            "TAB_ABOUT/HTML_NEW_VERSION",
            "TAB_CONTACTS/HTML_ALERT_DOES_NOT_SUPPORTED",
            "TAB_CONTACTS/HTML_ALERT_DO_NOT_USE_THIS_DATABASE",
            "TAB_DOMAINS/HTML_DOMAINS_HELPER",
            "TAB_GENERAL/HTML_ALERT_WEAK_PASSWORD",
        }
    ),
}
# Message tag labels are selected by a dynamic key prefix before being included
# in generated HTML; all reference keys under this prefix share that sink.
HTML_SINK_PREFIXES = {"user": ("MESSAGE_TAGS/",)}
# These reach HTML sinks through composed UI paths, so source scanning cannot
# associate each ordinary i18n() call with its final sink.
HTML_STATIC_KEYS = frozenset(
    {
        "COMPOSE/REPLY_MESSAGE_TITLE",
        "CRYPTO/ASK_CRYPTKEY_PASS",
        "CRYPTO/CURRENT_PASS",
        "CRYPTO/NEW_PASS",
        "COMPOSE/DISCARD_UNSAVED_DATA",
        "GLOBAL/SAVE_CHANGES",
        "POPUPS_ASK/DESC_WANT_CLOSE_THIS_WINDOW",
        "POPUPS_ASK/DESC_WANT_DELETE_MESSAGES",
    }
)
RELATIVE_TIME_UNITS = frozenset(
    {"year", "month", "week", "day", "hour", "minute", "second"}
)
RELATIVE_TIME_CATEGORIES = frozenset({"zero", "one", "two", "few", "many", "other"})
MAX_DISPLAYED_ERRORS = 200
MAX_JSON_NESTING_DEPTH = 128


class DuplicateKeyError(ValueError):
    """Raised before JSON object pairs are collapsed into a dictionary."""


class CatalogError(ValueError):
    pass


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    catalog_counts: Counter[str] = field(default_factory=Counter)
    key_counts: Counter[str] = field(default_factory=Counter)


@dataclass(frozen=True)
class PluralRule:
    categories: frozenset[str]


@dataclass(frozen=True)
class JsToken:
    kind: str
    value: str


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON value {value!r}")


def _check_json_nesting(text: str) -> None:
    """Bound JSON container depth without relying on decoder recursion limits."""
    depth = 0
    in_string = False
    escaped = False

    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            if depth > MAX_JSON_NESTING_DEPTH:
                raise CatalogError(
                    f"JSON nesting exceeds the maximum depth of {MAX_JSON_NESTING_DEPTH}"
                )
        elif char in "]}":
            depth = max(0, depth - 1)


def _reject_symlinked_input(root: Path, path: Path) -> None:
    """Keep validator reads inside the checkout and off symlink targets."""
    repository = Path(os.path.abspath(root))
    candidate = Path(os.path.abspath(path))
    try:
        relative = candidate.relative_to(repository)
    except ValueError as exc:
        raise OSError("input path is outside the repository root") from exc

    current = repository
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise OSError("symbolic links are not allowed in validator inputs")


def _read_utf8(path: Path, root: Path) -> str:
    _reject_symlinked_input(root, path)
    return path.read_text(encoding="utf-8", errors="strict")


def load_json(path: Path, root: Path) -> Any:
    """Read strict UTF-8 JSON and reject duplicate keys at every object level."""
    _reject_symlinked_input(root, path)
    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="strict")
    _check_json_nesting(text)
    try:
        return json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
    except RecursionError as exc:
        raise CatalogError("JSON nesting exceeds the validator's parser limit") from exc


def flatten_catalog(value: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    flattened: dict[str, Any] = {}
    for key, child in value.items():
        path = f"{prefix}/{key}" if prefix else key
        if isinstance(child, dict):
            if child:
                flattened.update(flatten_catalog(child, path))
            else:
                flattened[path] = child
        else:
            flattened[path] = child
    return flattened


def _get_path(value: dict[str, Any], key_path: str) -> Any:
    current: Any = value
    for part in key_path.split("/"):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _empty_string_paths(value: Any, prefix: str = "") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}/{key}" if prefix else key
            paths.extend(_empty_string_paths(child, path))
    elif isinstance(value, str) and not value.strip():
        paths.append(prefix)
    return paths


def _format_counter(counter: Counter[str]) -> str:
    if not counter:
        return "{}"
    items = ", ".join(
        f"%{name}%: {count}" for name, count in sorted(counter.items())
    )
    return "{" + items + "}"


def compare_placeholders(
    reference: str, translated: str, locale: str, catalog_type: str, key: str
) -> list[str]:
    expected_tokens = PLACEHOLDER_RE.findall(reference)
    actual_tokens = PLACEHOLDER_RE.findall(translated)
    expected = Counter(expected_tokens)
    actual = Counter(actual_tokens)
    errors: list[str] = []

    malformed = sorted(
        {
            match.group(0)
            for match in PLACEHOLDER_CANDIDATE_RE.finditer(translated)
            if match.group(2) != "%" or not PLACEHOLDER_NAME_RE.fullmatch(match.group(1))
        }
    )
    if malformed:
        errors.append(
            f"{catalog_type}/{locale} {key}: malformed placeholder token(s): "
            + ", ".join(malformed)
        )

    if expected != actual:
        case_only = []
        expected_by_fold: dict[str, Counter[str]] = {}
        actual_by_fold: dict[str, Counter[str]] = {}
        for token, count in expected.items():
            expected_by_fold.setdefault(token.casefold(), Counter())[token] += count
        for token, count in actual.items():
            actual_by_fold.setdefault(token.casefold(), Counter())[token] += count
        for folded in sorted(set(expected_by_fold) & set(actual_by_fold)):
            expected_names = expected_by_fold[folded]
            actual_names = actual_by_fold[folded]
            if expected_names != actual_names:
                case_only.extend(
                    f"%{want}% vs %{got}%"
                    for want in sorted(expected_names)
                    for got in sorted(actual_names)
                    if want != got
                )
        detail = "case mismatch: " + ", ".join(case_only) + "; " if case_only else ""
        errors.append(
            f"{catalog_type}/{locale} {key}: {detail}placeholder multiset "
            f"expected {_format_counter(expected)}, got {_format_counter(actual)}"
        )
    return errors


class TranslationHtmlParser(HTMLParser):
    """Validate the intentionally small trusted-markup vocabulary."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.stack: list[str] = []
        self.errors: list[str] = []

    def _check_tag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in HTML_TAGS:
            self.errors.append(f"disallowed tag <{tag}>")
        seen: set[str] = set()
        for name, value in attrs:
            if name in seen:
                self.errors.append(f"duplicate attribute {name!r} on <{tag}>")
            seen.add(name)
            allowed = (
                (tag == "a" and name == "href" and value == "#/security")
                or (tag == "strong" and name == "style" and value == "color:red")
            )
            if not allowed:
                self.errors.append(f"disallowed attribute {name!r} on <{tag}>")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._check_tag(tag, attrs)
        if tag not in HTML_VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._check_tag(tag, attrs)
        if tag not in HTML_VOID_TAGS:
            self.errors.append(f"self-closing non-void tag <{tag}/> is not allowed")

    def handle_endtag(self, tag: str) -> None:
        if tag in HTML_VOID_TAGS:
            self.errors.append(f"void tag </{tag}> must not have a closing tag")
        elif not self.stack:
            self.errors.append(f"unexpected closing tag </{tag}>")
        elif self.stack[-1] != tag:
            self.errors.append(
                f"closing tag </{tag}> does not match <{self.stack[-1]}>")
        else:
            self.stack.pop()

    def handle_data(self, data: str) -> None:
        if "<" in data:
            self.errors.append("unescaped '<' in translation text")

    def handle_entityref(self, name: str) -> None:
        pass

    def handle_charref(self, name: str) -> None:
        pass

    def handle_comment(self, data: str) -> None:
        self.errors.append("HTML comments are not allowed")

    def handle_decl(self, decl: str) -> None:
        self.errors.append("HTML declarations are not allowed")

    def handle_pi(self, data: str) -> None:
        self.errors.append("processing instructions are not allowed")


def _has_incomplete_tag_like_markup(value: str) -> bool:
    """Find a tag-shaped '<' sequence with no unquoted closing '>'."""
    index = 0
    while index < len(value):
        opening = value.find("<", index)
        if opening < 0:
            return False

        name_start = opening + 1
        if name_start < len(value) and value[name_start] == "/":
            name_start += 1
        if name_start >= len(value) or not (
            "A" <= value[name_start] <= "Z" or "a" <= value[name_start] <= "z"
        ):
            index = opening + 1
            continue

        quote: str | None = None
        cursor = name_start + 1
        while cursor < len(value):
            char = value[cursor]
            if quote is not None:
                if char == quote:
                    quote = None
            elif char in "\"'":
                quote = char
            elif char == ">":
                break
            cursor += 1

        if cursor == len(value):
            return True
        index = cursor + 1

    return False


def validate_html_fragment(value: str) -> list[str]:
    parser = TranslationHtmlParser()
    if _has_incomplete_tag_like_markup(value):
        parser.errors.append("incomplete HTML tag-like markup")
    try:
        parser.feed(value)
        parser.close()
    except Exception as exc:  # HTMLParser errors are reported, not allowed to abort all catalogs.
        parser.errors.append(f"could not parse fragment: {exc}")
    if parser.stack:
        parser.errors.append("unclosed tag(s): " + ", ".join(parser.stack))
    return parser.errors


_JS_TOKEN_RE = re.compile(
    r"(?P<space>\s+)"
    r"|(?P<line_comment>//[^\r\n]*)"
    r"|(?P<block_comment>/\*.*?\*/)"
    r"|(?P<string>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')"
    r"|(?P<arrow>=>)"
    r"|(?P<equal>==)"
    r"|(?P<number>[0-9]+)"
    r"|(?P<identifier>[A-Za-z_$][A-Za-z0-9_$]*)"
    r"|(?P<punct>[{}:,?])"
    r"|(?P<unknown>.)",
    re.DOTALL,
)


def _decode_js_string(token: str) -> str:
    if token.startswith('"'):
        return json.loads(token)
    body = token[1:-1]
    result: list[str] = []
    index = 0
    escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v"}
    while index < len(body):
        char = body[index]
        if char != "\\":
            result.append(char)
            index += 1
            continue
        index += 1
        if index >= len(body):
            raise CatalogError("unterminated JavaScript string escape")
        escaped = body[index]
        if escaped in escapes:
            result.append(escapes[escaped])
            index += 1
        elif escaped in ("\\", "'", '"', "/"):
            result.append(escaped)
            index += 1
        elif escaped == "u" and index + 4 < len(body):
            digits = body[index + 1 : index + 5]
            try:
                result.append(chr(int(digits, 16)))
            except ValueError as exc:
                raise CatalogError("invalid JavaScript Unicode escape") from exc
            index += 5
        elif escaped == "x" and index + 2 < len(body):
            digits = body[index + 1 : index + 3]
            try:
                result.append(chr(int(digits, 16)))
            except ValueError as exc:
                raise CatalogError("invalid JavaScript hexadecimal escape") from exc
            index += 3
        else:
            raise CatalogError(f"unsupported JavaScript string escape \\{escaped}")
    return "".join(result)


class RelativeTimeParser:
    """Parse the data-only relative-time object and its simple plural selector."""

    def __init__(self, source: str) -> None:
        self.tokens: list[JsToken] = []
        for match in _JS_TOKEN_RE.finditer(source):
            kind = match.lastgroup or "unknown"
            token = match.group()
            if kind in {"space", "line_comment", "block_comment"}:
                continue
            if kind == "unknown":
                raise CatalogError(f"unsupported JavaScript token {token!r}")
            if kind == "string":
                self.tokens.append(JsToken(kind, _decode_js_string(token)))
            else:
                self.tokens.append(JsToken(kind, token))
        self.index = 0

    def _peek(self, kind: str | None = None, value: str | None = None) -> bool:
        if self.index >= len(self.tokens):
            return False
        token = self.tokens[self.index]
        return (kind is None or token.kind == kind) and (value is None or token.value == value)

    def _take(self, kind: str | None = None, value: str | None = None) -> JsToken:
        if not self._peek(kind, value):
            actual = self.tokens[self.index] if self.index < len(self.tokens) else "end of input"
            raise CatalogError(f"expected {value or kind or 'token'}, found {actual}")
        token = self.tokens[self.index]
        self.index += 1
        return token

    def parse(self) -> dict[str, Any]:
        result = self._parse_object()
        if self.index != len(self.tokens):
            raise CatalogError(f"unexpected trailing token {self.tokens[self.index]}")
        return result

    def _parse_object(self) -> dict[str, Any]:
        self._take("punct", "{")
        result: dict[str, Any] = {}
        while not self._peek("punct", "}"):
            key = self._take("identifier").value
            if key in result:
                raise CatalogError(f"duplicate relative-time property {key!r}")
            self._take("punct", ":")
            result[key] = self._parse_plural() if key == "plural" else self._parse_value()
            if self._peek("punct", ","):
                self._take("punct", ",")
                if self._peek("punct", "}"):
                    break
            elif not self._peek("punct", "}"):
                raise CatalogError("expected ',' or '}' in relative-time object")
        self._take("punct", "}")
        return result

    def _parse_value(self) -> Any:
        if self._peek("punct", "{"):
            return self._parse_object()
        if self._peek("string"):
            return self._take("string").value
        raise CatalogError("relative-time data values must be objects or strings")

    def _parse_plural(self) -> PluralRule:
        parameter = self._take("identifier").value
        self._take("arrow")
        if self._peek("string"):
            return PluralRule(frozenset({self._take("string").value}))
        if self._take("number").value != "1":
            raise CatalogError("plural selector must use the supported 1 == n form")
        self._take("equal")
        if self._take("identifier").value != parameter:
            raise CatalogError("plural selector compares against a different parameter")
        self._take("punct", "?")
        one = self._take("string").value
        self._take("punct", ":")
        other = self._take("string").value
        return PluralRule(frozenset({one, other}))


def _validate_relative_time_shape(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    plural = data.get("plural")
    nested = "long" in data
    actual_keys = set(data)
    if nested:
        expected_keys = {"long"} | ({"plural"} if "plural" in data else set())
        for missing in sorted(expected_keys - actual_keys):
            errors.append(f"missing top-level property {missing!r}")
        for extra in sorted(actual_keys - expected_keys):
            errors.append(f"unexpected top-level property {extra!r}")
        if plural is not None and not isinstance(plural, PluralRule):
            errors.append("invalid plural selector")
    else:
        if not isinstance(plural, PluralRule):
            errors.append("flat relative-time format requires a plural selector")
        for extra in sorted(actual_keys - RELATIVE_TIME_UNITS - {"plural"}):
            errors.append(f"unexpected top-level property {extra!r}")

    units = data.get("long") if nested else {key: value for key, value in data.items() if key != "plural"}
    if not isinstance(units, dict):
        return errors + ["relative-time unit table must be an object"]
    for unit in sorted(RELATIVE_TIME_UNITS - set(units)):
        errors.append(f"missing time unit {unit!r}")
    for unit in sorted(set(units) - RELATIVE_TIME_UNITS):
        errors.append(f"unexpected time unit {unit!r}")

    for unit in sorted(RELATIVE_TIME_UNITS & set(units)):
        periods = units[unit]
        if not isinstance(periods, dict):
            errors.append(f"{unit}: value must be an object")
            continue
        if set(periods) != {"past", "future"}:
            errors.append(
                f"{unit}: expected past/future properties, got {', '.join(sorted(periods)) or '(none)'}"
            )
        for period in ("past", "future"):
            value = periods.get(period)
            if isinstance(value, str):
                strings = {period: value}
            elif isinstance(value, dict):
                strings = value
                if not strings:
                    errors.append(f"{unit}.{period}: plural forms must not be empty")
                if set(strings) - RELATIVE_TIME_CATEGORIES:
                    errors.append(f"{unit}.{period}: unsupported plural form(s)")
                if "other" not in strings:
                    errors.append(f"{unit}.{period}: plural map must include 'other'")
                if isinstance(plural, PluralRule) and not plural.categories.issubset(set(strings)):
                    errors.append(
                        f"{unit}.{period}: plural selector may return "
                        f"{', '.join(sorted(plural.categories - set(strings)))} without a matching form"
                    )
            else:
                errors.append(f"{unit}.{period}: expected a string or plural-form object")
                continue
            for form, text in strings.items():
                if not isinstance(text, str) or not text:
                    errors.append(f"{unit}.{period}.{form}: text must be non-empty")
                    continue
                format_tokens = re.findall(r"\{[^{}]*\}", text)
                if any(token != "{0}" for token in format_tokens):
                    errors.append(f"{unit}.{period}.{form}: unsupported format token")
                if text.count("{0}") > 1:
                    errors.append(f"{unit}.{period}.{form}: '{{0}}' may occur at most once")
                if text.count("{") != text.count("}"):
                    errors.append(f"{unit}.{period}.{form}: unbalanced braces")
    return errors


def validate_relative_time_source(source: str) -> list[str]:
    try:
        data = RelativeTimeParser(source).parse()
    except RecursionError:
        return ["relative-time nesting exceeds the validator's parser limit"]
    except (ValueError, IndexError) as exc:
        return [str(exc)]
    return _validate_relative_time_shape(data)


def _load_catalog_files(root: Path, catalog_type: str, report: Report) -> dict[str, tuple[Path, dict[str, Any]]]:
    directory = root / LOCALIZATION_PATH
    result: dict[str, tuple[Path, dict[str, Any]]] = {}
    try:
        _reject_symlinked_input(root, directory)
    except OSError as exc:
        report.errors.append(f"{directory}: {exc}")
        return result
    for path in sorted(directory.glob(f"*/{catalog_type}.json")):
        locale = path.parent.name
        try:
            data = load_json(path, root)
        except UnicodeDecodeError as exc:
            report.errors.append(f"{path}: invalid UTF-8 at byte {exc.start}")
            continue
        except json.JSONDecodeError as exc:
            report.errors.append(f"{path}:{exc.lineno}:{exc.colno}: malformed JSON: {exc.msg}")
            continue
        except (DuplicateKeyError, ValueError, OSError) as exc:
            report.errors.append(f"{path}: {exc}")
            continue
        if not isinstance(data, dict):
            report.errors.append(f"{path}: catalog root must be a JSON object")
            continue
        result[locale] = (path, data)
    return result


def _validate_direction(locale: str, catalog_type: str, path: Path, data: dict[str, Any], report: Report) -> None:
    direction = data.get("LANG_DIR")
    if not isinstance(direction, str):
        report.errors.append(f"{path}: missing or non-string LANG_DIR")
        return
    if direction not in LANGUAGE_DIRECTION_VALUES:
        report.errors.append(f"{path}: unsupported LANG_DIR {direction!r}; expected ltr or rtl")
        return
    expected = "rtl" if locale in RTL_LOCALES else "ltr"
    if direction != expected:
        report.errors.append(
            f"{catalog_type}/{locale} LANG_DIR: expected {expected!r} from RTL locale registry, got {direction!r}"
        )


def validate_catalog_content(
    locale: str,
    catalog_type: str,
    path: Path,
    data: dict[str, Any],
    reference: dict[str, Any],
    report: Report,
) -> None:
    if catalog_type in {"user", "admin"}:
        _validate_direction(locale, catalog_type, path, data, report)

    for key in _empty_string_paths(data):
        report.errors.append(f"{path}: {key}: empty translation value")

    translated = flatten_catalog(data)
    expected = flatten_catalog(reference)
    missing = sorted(set(expected) - set(translated))
    extra = sorted(set(translated) - set(expected))
    for key in missing:
        report.errors.append(f"{path}: missing key {key}")
    for key in extra:
        report.errors.append(f"{path}: unexpected key {key}")

    report.catalog_counts[catalog_type] += 1
    if locale == "en":
        report.key_counts[catalog_type] = len(expected)

    html_keys = set(HTML_SINK_KEYS.get(catalog_type, frozenset()))
    for prefix in HTML_SINK_PREFIXES.get(catalog_type, ()):
        html_keys.update(key for key in expected if key.startswith(prefix))
    for key in sorted(set(expected) & set(translated)):
        reference_value = expected[key]
        translated_value = translated[key]
        if type(reference_value) is not type(translated_value):
            report.errors.append(
                f"{path}: {key}: expected value type {type(reference_value).__name__}, "
                f"got {type(translated_value).__name__}"
            )
            continue
        if not isinstance(reference_value, str):
            report.errors.append(
                f"{path}: {key}: catalog values must be strings, "
                f"got {type(reference_value).__name__}"
            )
            continue
        report.errors.extend(
            compare_placeholders(reference_value, translated_value, locale, catalog_type, key)
        )
        if key in html_keys:
            for problem in validate_html_fragment(translated_value):
                report.errors.append(f"{path}: {key}: {problem}")

    if catalog_type == "user":
        for key in REQUIRED_USER_KEYS:
            value = _get_path(data, key)
            if not isinstance(value, str) or not value.strip():
                report.errors.append(f"{path}: required petuja.email key {key} must be present and non-empty")


def _validate_language_names(root: Path, locales: set[str], report: Report) -> None:
    path = root / LOCALIZATION_PATH / "langs.json"
    try:
        data = load_json(path, root)
    except UnicodeDecodeError as exc:
        report.errors.append(f"{path}: invalid UTF-8 at byte {exc.start}")
        return
    except json.JSONDecodeError as exc:
        report.errors.append(f"{path}:{exc.lineno}:{exc.colno}: malformed JSON: {exc.msg}")
        return
    except (DuplicateKeyError, ValueError, OSError) as exc:
        report.errors.append(f"{path}: {exc}")
        return
    if not isinstance(data, dict) or set(data) != {"LANGS_NAMES", "LANGS_NAMES_EN"}:
        report.errors.append(f"{path}: expected LANGS_NAMES and LANGS_NAMES_EN maps")
        return
    for map_name in ("LANGS_NAMES", "LANGS_NAMES_EN"):
        names = data.get(map_name)
        if not isinstance(names, dict):
            report.errors.append(f"{path}: {map_name} must be an object")
            continue
        for locale in sorted(locales - set(names)):
            report.errors.append(f"{path}: {map_name} is missing shipped locale {locale}")
        for locale, name in names.items():
            if not isinstance(name, str) or not name.strip():
                report.errors.append(f"{path}: {map_name}/{locale} must be a non-empty string")


def _discover_html_keys(
    root: Path,
    references: dict[str, dict[str, Any]],
    report: Report,
) -> set[str]:
    found: set[str] = set(HTML_STATIC_KEYS)
    template_root = root / "snappymail/v/0.0.0/app/templates"
    template_pattern = re.compile(r'data-i18n="\[html\]([^"\s]+)"')
    template_sources: list[str] = []
    try:
        _reject_symlinked_input(root, template_root)
        template_paths = sorted(template_root.rglob("*.html"))
    except OSError as exc:
        report.errors.append(f"{template_root}: could not inspect HTML sink declarations: {exc}")
        template_paths = []
    for path in template_paths:
        try:
            text = _read_utf8(path, root)
        except (UnicodeDecodeError, OSError) as exc:
            report.errors.append(f"{path}: could not read HTML sink declarations: {exc}")
            continue
        template_sources.append(text)
        found.update(template_pattern.findall(text))

    js_root = root / "dev"
    js_call_pattern = re.compile(r"\bi18nHtml\s*\(\s*(['\"])([^'\"]+)\1\s*,")
    source_files: list[str] = []
    try:
        _reject_symlinked_input(root, js_root)
        js_paths = sorted(js_root.rglob("*.js"))
    except OSError as exc:
        report.errors.append(f"{js_root}: could not inspect HTML sink declarations: {exc}")
        js_paths = []
    for path in js_paths:
        try:
            text = _read_utf8(path, root)
        except (UnicodeDecodeError, OSError) as exc:
            report.errors.append(f"{path}: could not read HTML sink declarations: {exc}")
            continue
        source_files.append(text)
        calls = list(re.finditer(r"\bi18nHtml\s*\(", text))
        matches = list(js_call_pattern.finditer(text))
        if len(calls) != len(matches):
            report.errors.append(
                f"{path}: i18nHtml() must use a literal key so the HTML validation set stays explicit"
            )
        found.update(match.group(2) for match in matches)

    allowed = set().union(*HTML_SINK_KEYS.values())
    all_templates = "\n".join(template_sources)
    all_source = "\n".join(source_files)
    for catalog_type, prefixes in HTML_SINK_PREFIXES.items():
        for prefix in prefixes:
            # The dynamic translation prefix must be present in both the
            # generated HTML binding and its source-side i18n call.
            binding_exists = bool(
                re.search(
                    r'data-bind="[^\"]*\bhtml\s*:\s*tagsToHTML\b',
                    all_templates,
                )
            )
            call_exists = bool(
                re.search(
                    r"\bi18n\s*\(\s*(['\"])" + re.escape(prefix) + r"\1\s*\+",
                    all_source,
                )
            )
            if not (binding_exists and call_exists):
                report.errors.append(
                    f"registered HTML key prefix {catalog_type}/{prefix} has no active source sink"
                )
                continue
            reference = references.get(catalog_type, {})
            prefix_keys = {
                key for key in flatten_catalog(reference) if key.startswith(prefix)
            }
            found.update(prefix_keys)
            allowed.update(prefix_keys)

    for key in sorted(found - allowed):
        report.errors.append(f"HTML sink key {key} is not registered for trusted-markup validation")
    for key in sorted(allowed - found):
        # i18nHtml() keys are discovered from source; only a source path disappearing is notable.
        if key not in HTML_STATIC_KEYS:
            report.errors.append(f"registered HTML sink key {key} has no active source sink")
    return found & allowed


def _validate_relative_time_files(root: Path, user_locales: set[str], report: Report) -> None:
    directory = root / LOCALIZATION_PATH
    try:
        _reject_symlinked_input(root, directory)
        paths = sorted(directory.glob("*/relativetimeformat.js"))
    except OSError as exc:
        report.errors.append(f"{directory}: {exc}")
        return
    by_locale = {path.parent.name: path for path in paths}
    if "en" not in by_locale:
        report.errors.append(f"{directory}: required English relative-time reference is missing")
    report.catalog_counts["relative-time"] = len(paths)

    for locale in sorted(user_locales - set(by_locale)):
        report.warnings.append(
            f"{LOCALIZATION_PATH}/{locale}/relativetimeformat.js: absent; runtime falls back to base/English data"
        )
    for locale in sorted(set(by_locale) - user_locales):
        report.warnings.append(f"{by_locale[locale]}: no matching shipped user catalog")

    for locale, path in sorted(by_locale.items()):
        try:
            source = _read_utf8(path, root)
        except UnicodeDecodeError as exc:
            report.errors.append(f"{path}: invalid UTF-8 at byte {exc.start}")
            continue
        except OSError as exc:
            report.errors.append(f"{path}: could not read file: {exc}")
            continue
        for problem in validate_relative_time_source(source):
            report.errors.append(f"{path}: {problem}")


def validate_repository(root: Path) -> Report:
    report = Report()
    catalogs: dict[str, dict[str, tuple[Path, dict[str, Any]]]] = {}
    for catalog_type in CATALOG_TYPES:
        catalogs[catalog_type] = _load_catalog_files(root, catalog_type, report)
        if "en" not in catalogs[catalog_type]:
            report.errors.append(f"{LOCALIZATION_PATH}/en/{catalog_type}.json: required English reference is missing")
            continue
        reference = catalogs[catalog_type]["en"][1]
        for locale, (path, data) in sorted(catalogs[catalog_type].items()):
            validate_catalog_content(locale, catalog_type, path, data, reference, report)

    user_locales = set(catalogs["user"])
    admin_locales = set(catalogs["admin"])
    static_locales = set(catalogs["static"])
    for locale in sorted(user_locales - static_locales):
        report.warnings.append(
            f"{LOCALIZATION_PATH}/{locale}/static.json: absent; static strings use runtime fallback"
        )
    for locale in sorted(static_locales - user_locales):
        report.warnings.append(f"{LOCALIZATION_PATH}/{locale}/static.json: no matching user catalog")

    _validate_language_names(root, user_locales | admin_locales, report)
    references = {
        catalog_type: catalogs[catalog_type]["en"][1]
        for catalog_type in CATALOG_TYPES
        if "en" in catalogs[catalog_type]
    }
    _discover_html_keys(root, references, report)
    for catalog_type, keys in HTML_SINK_KEYS.items():
        reference_entry = catalogs[catalog_type].get("en")
        if not reference_entry:
            continue
        reference = reference_entry[1]
        for key in sorted(keys):
            if _get_path(reference, key) is None:
                report.errors.append(
                    f"{LOCALIZATION_PATH}/en/{catalog_type}.json: registered HTML sink key {key} is missing"
                )
    _validate_relative_time_files(root, user_locales, report)
    report.catalog_counts["user locales"] = len(user_locales)
    report.catalog_counts["admin locales"] = len(admin_locales)
    report.catalog_counts["static catalogs"] = len(static_locales)
    return report


def _summary(report: Report) -> str:
    return (
        f"Validated {report.catalog_counts['user locales']} user locales, "
        f"{report.catalog_counts['admin locales']} admin locales, "
        f"{report.catalog_counts['static catalogs']} static catalogs, and "
        f"{report.catalog_counts['relative-time']} relative-time catalogs "
        f"(reference keys: user {report.key_counts['user']}, "
        f"admin {report.key_counts['admin']}, static {report.key_counts['static']})."
    )


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    root = Path(args[0]).resolve() if args else Path(__file__).resolve().parents[1]
    report = validate_repository(root)
    for warning in report.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if report.errors:
        for error in report.errors[:MAX_DISPLAYED_ERRORS]:
            print(f"error: {error}", file=sys.stderr)
        omitted = len(report.errors) - MAX_DISPLAYED_ERRORS
        if omitted > 0:
            print(f"... {omitted} additional error(s) omitted.", file=sys.stderr)
        print(f"Localization validation failed with {len(report.errors)} error(s).", file=sys.stderr)
        return 1
    print(_summary(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
