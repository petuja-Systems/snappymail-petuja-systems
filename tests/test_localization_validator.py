import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_localization as validator  # noqa: E402


def user_fixture(direction="ltr", name="Inbox"):
    return {
        "LANG_DIR": direction,
        "LOGIN": {
            "TAGLINE": "Your inbox, wherever you are.",
            "LEGAL_NAVIGATION": "Legal information",
            "LEGAL_IMPRINT": "Imprint",
            "LEGAL_PRIVACY": "Privacy",
            "LEGAL_SOURCE": "Source Code",
        },
        "GROUP": {"LABEL": name},
    }


class LocalizationValidatorTests(unittest.TestCase):
    def test_valid_nested_catalog_and_unicode_are_accepted(self):
        reference = user_fixture(name="Inbox %NAME%")
        translated = user_fixture(name="Boîte de réception %NAME%")
        report = validator.Report()

        validator.validate_catalog_content(
            "fr", "user", Path("fr/user.json"), translated, reference, report
        )

        self.assertEqual(report.errors, [])

    def test_malformed_json_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            for text in ('{"LOGIN": ', '{"x":[}}', '[[}', ']'):
                with self.subTest(text=text):
                    path.write_text(text, encoding="utf-8")
                    with self.assertRaises(json.JSONDecodeError):
                        validator.load_json(path, Path(directory))

    def test_excessive_json_nesting_is_reported_as_a_catalog_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            for opener, closer, prefix in (
                ("{", "}", '{"nested":'),
                ("[", "]", "["),
            ):
                with self.subTest(container=opener):
                    path.write_text(
                        prefix * (validator.MAX_JSON_NESTING_DEPTH + 1)
                        + '"value"'
                        + closer * (validator.MAX_JSON_NESTING_DEPTH + 1),
                        encoding="utf-8",
                    )

                    with self.assertRaisesRegex(validator.CatalogError, "nesting exceeds"):
                        validator.load_json(path, Path(directory))

    def test_json_nesting_at_limit_is_accepted_for_objects_and_arrays(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            depth = validator.MAX_JSON_NESTING_DEPTH
            for opener, closer, prefix, expected_type in (
                ("{", "}", '{"nested":', dict),
                ("[", "]", "[", list),
            ):
                with self.subTest(container=opener):
                    path.write_text(
                        prefix * depth + '"value"' + closer * depth,
                        encoding="utf-8",
                    )

                    self.assertIsInstance(validator.load_json(path, Path(directory)), expected_type)

    def test_mixed_json_nesting_obeys_the_same_depth_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            for depth in (
                validator.MAX_JSON_NESTING_DEPTH,
                validator.MAX_JSON_NESTING_DEPTH + 1,
            ):
                with self.subTest(depth=depth):
                    text = '"value"'
                    for index in range(depth):
                        if index % 2:
                            text = "[" + text + "]"
                        else:
                            text = '{"nested":' + text + "}"
                    path.write_text(text, encoding="utf-8")

                    if depth == validator.MAX_JSON_NESTING_DEPTH:
                        self.assertIsInstance(validator.load_json(path, Path(directory)), list)
                    else:
                        with self.assertRaisesRegex(validator.CatalogError, "nesting exceeds"):
                            validator.load_json(path, Path(directory))

    def test_json_nesting_scanner_ignores_string_delimiters_and_escapes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            bracket_text = "{}[]" * (validator.MAX_JSON_NESTING_DEPTH + 1)
            values = [
                bracket_text + "\\" * count + '"{}[]'
                for count in range(5)
            ]
            values.extend("\\" * count for count in range(1, 5))
            values.append(bracket_text + " 用户")
            for value in values:
                with self.subTest(value=value[-12:]):
                    path.write_text(
                        json.dumps({"literal": value}, ensure_ascii=False),
                        encoding="utf-8",
                    )

                    self.assertEqual(
                        validator.load_json(path, Path(directory)), {"literal": value}
                    )

    def test_invalid_utf8_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            path.write_bytes(b'{"value":"\xff"}')
            with self.assertRaises(UnicodeDecodeError):
                validator.load_json(path, Path(directory))

    def test_escaped_json_strings_nested_objects_and_unicode_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            path.write_text(
                r'{"nested":{"quoted":"value with \"quotes\"",'
                r'"path":"C:\\mail","unicode":"用户"}}',
                encoding="utf-8",
            )

            self.assertEqual(
                validator.load_json(path, Path(directory)),
                {
                    "nested": {
                        "quoted": 'value with "quotes"',
                        "path": r"C:\mail",
                        "unicode": "用户",
                    }
                },
            )

    def test_catalog_symlink_is_rejected_before_reading_its_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            catalog_dir = root / validator.LOCALIZATION_PATH / "fr"
            catalog_dir.mkdir(parents=True)
            outside = Path(directory) / "outside.json"
            outside.write_text('{"MARKER":"outside-file-read"}', encoding="utf-8")
            catalog = catalog_dir / "user.json"
            try:
                catalog.symlink_to(outside)
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"symlink creation is unavailable: {exc}")

            report = validator.Report()
            catalogs = validator._load_catalog_files(root, "user", report)

            self.assertNotIn("fr", catalogs)
            self.assertTrue(any("symbolic links are not allowed" in error for error in report.errors))
            self.assertFalse(any("outside-file-read" in error for error in report.errors))

    def test_symlinked_localization_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            app_dir = root / "snappymail/v/0.0.0/app"
            app_dir.mkdir(parents=True)
            outside = Path(directory) / "outside"
            (outside / "fr").mkdir(parents=True)
            (outside / "fr/user.json").write_text("{}", encoding="utf-8")
            localization = app_dir / "localization"
            try:
                localization.symlink_to(outside, target_is_directory=True)
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"symlink creation is unavailable: {exc}")

            report = validator.Report()
            catalogs = validator._load_catalog_files(root, "user", report)

            self.assertEqual(catalogs, {})
            self.assertTrue(any("symbolic links are not allowed" in error for error in report.errors))

    def test_source_reader_rejects_symlinked_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            source_dir = root / "dev"
            source_dir.mkdir(parents=True)
            outside = Path(directory) / "outside.js"
            outside.write_text("trusted test fixture", encoding="utf-8")
            source = source_dir / "fixture.js"
            try:
                source.symlink_to(outside)
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"symlink creation is unavailable: {exc}")

            with self.assertRaisesRegex(OSError, "symbolic links are not allowed"):
                validator._read_utf8(source, root)

    def test_duplicate_keys_are_rejected_before_dictionary_collapse(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            path.write_text('{"LOGIN":{"LABEL":"one","LABEL":"two"}}', encoding="utf-8")
            with self.assertRaisesRegex(validator.DuplicateKeyError, "LABEL"):
                validator.load_json(path, Path(directory))

    def test_duplicate_keys_are_compared_after_json_escape_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "user.json"
            path.write_text(r'{"name":1,"n\u0061me":2}', encoding="utf-8")
            with self.assertRaisesRegex(validator.DuplicateKeyError, "name"):
                validator.load_json(path, Path(directory))

    def test_missing_and_extra_keys_are_reported(self):
        reference = user_fixture()
        translated = user_fixture()
        del translated["GROUP"]["LABEL"]
        translated["GROUP"]["EXTRA"] = "unexpected"
        translated["EMPTY_SECTION"] = {}
        report = validator.Report()

        validator.validate_catalog_content(
            "fr", "user", Path("fr/user.json"), translated, reference, report
        )

        self.assertTrue(any("missing key GROUP/LABEL" in error for error in report.errors))
        self.assertTrue(any("unexpected key GROUP/EXTRA" in error for error in report.errors))
        self.assertTrue(any("unexpected key EMPTY_SECTION" in error for error in report.errors))

    def test_catalog_leaf_values_must_be_strings(self):
        reference = user_fixture()
        reference["GROUP"]["LABEL"] = 7
        report = validator.Report()

        validator.validate_catalog_content(
            "en", "user", Path("en/user.json"), reference, reference, report
        )

        self.assertTrue(
            any("GROUP/LABEL: catalog values must be strings" in error for error in report.errors)
        )

    def test_empty_required_value_is_reported(self):
        reference = user_fixture()
        translated = user_fixture()
        translated["LOGIN"]["LEGAL_PRIVACY"] = "   "
        report = validator.Report()

        validator.validate_catalog_content(
            "fr", "user", Path("fr/user.json"), translated, reference, report
        )

        self.assertTrue(any("empty translation value" in error for error in report.errors))
        self.assertTrue(any("LOGIN/LEGAL_PRIVACY" in error for error in report.errors))

    def test_placeholder_missing_extra_case_and_repetition_are_rejected(self):
        cases = (
            ("%NAME%", "Name", "placeholder multiset"),
            ("%NAME%", "%NAME% %EMAIL%", "expected"),
            ("%NAME%", "%name%", "case mismatch"),
            ("%NAME% %NAME%", "%NAME%", "NAME%: 2"),
        )
        for reference, translated, expected_text in cases:
            with self.subTest(reference=reference, translated=translated):
                errors = validator.compare_placeholders(
                    reference, translated, "fr", "user", "GROUP/LABEL"
                )
                self.assertTrue(errors)
                self.assertIn(expected_text, " ".join(errors))

    def test_placeholder_trailing_literal_percent_is_supported(self):
        self.assertEqual(
            validator.compare_placeholders("%PROC%%", "%PROC%%", "en", "user", "KEY"),
            [],
        )

    def test_reordered_placeholders_with_unicode_are_accepted(self):
        self.assertEqual(
            validator.compare_placeholders(
                "Hello %NAME%, %EMAIL%",
                "Müller & Söhne (%EMAIL%) — %NAME%",
                "de",
                "user",
                "GROUP/LABEL",
            ),
            [],
        )

    def test_unclosed_placeholder_is_detected_by_expected_multiset(self):
        errors = validator.compare_placeholders(
            "%TIME%", "%TIME", "fr", "user", "MESSAGE_LIST/DATE"
        )
        self.assertTrue(errors)
        self.assertTrue(any("placeholder multiset" in error for error in errors))

    def test_unclosed_extra_placeholder_like_text_is_reported(self):
        errors = validator.compare_placeholders(
            "No placeholder", "Malformed %USER\"", "fr", "user", "CRYPTO/GOOD_SIGNATURE"
        )
        self.assertTrue(any("malformed placeholder" in error for error in errors))

    def test_invalid_language_direction_is_rejected(self):
        reference = user_fixture()
        translated = user_fixture(direction="auto")
        report = validator.Report()

        validator.validate_catalog_content(
            "fr", "user", Path("fr/user.json"), translated, reference, report
        )

        self.assertTrue(any("unsupported LANG_DIR" in error for error in report.errors))

    def test_missing_language_direction_is_rejected(self):
        reference = user_fixture()
        translated = user_fixture()
        del translated["LANG_DIR"]
        report = validator.Report()

        validator.validate_catalog_content(
            "fr", "user", Path("fr/user.json"), translated, reference, report
        )

        self.assertTrue(any("missing or non-string LANG_DIR" in error for error in report.errors))

    def test_rtl_direction_is_explicit_and_locale_scoped(self):
        reference = user_fixture()
        translated = user_fixture(direction="rtl")
        report = validator.Report()

        validator.validate_catalog_content(
            "fa", "user", Path("fa/user.json"), translated, reference, report
        )

        self.assertEqual(report.errors, [])

    def test_trusted_translation_html_allows_current_formatting(self):
        fragment = (
            '<strong>Important</strong><b>Bold</b><br>'
            '<a href="#/security">Security</a>'
        )
        self.assertEqual(validator.validate_html_fragment(fragment), [])
        self.assertEqual(validator.validate_html_fragment("AT&T"), [])
        self.assertEqual(validator.validate_html_fragment("Literal &lt;strong&gt; text"), [])
        self.assertEqual(validator.validate_html_fragment("&lt;strong"), [])
        self.assertEqual(validator.validate_html_fragment("&#60;strong&#62;"), [])
        self.assertEqual(validator.validate_html_fragment("AT&amp;T"), [])
        self.assertEqual(validator.validate_html_fragment("<STRONG>case</STRONG>"), [])
        self.assertEqual(
            validator.validate_html_fragment('<strong style="color:red">Stop</strong>'),
            [],
        )

    def test_dynamic_message_tag_keys_are_checked_as_html(self):
        reference = user_fixture()
        reference["MESSAGE_TAGS"] = {"$custom": "Custom"}
        translated = user_fixture()
        translated["MESSAGE_TAGS"] = {"$custom": "<img src=x>"}
        report = validator.Report()

        validator.validate_catalog_content(
            "fr", "user", Path("fr/user.json"), translated, reference, report
        )

        self.assertTrue(any("disallowed tag <img>" in error for error in report.errors))

    def test_malformed_or_dangerous_translation_html_is_rejected(self):
        incomplete_fragments = (
            "<strong",
            "<strong ",
            "<strong\n",
            "<strong attr=",
            '<strong attr="value>',
            "</strong",
            "</strong\n",
        )
        rejected_fragments = incomplete_fragments + (
            "<strong><b>text</strong></b>",
            "<strong>unclosed",
            "<img src=x>",
            '<a href="https://example.invalid">external</a>',
            '<strong onclick="run()">text</strong>',
            '<strong title="a > b">text</strong>',
            "<!-- comment -->",
            "<!-- unfinished",
            "<!DOCTYPE html>",
            "<!DOCTYPE html",
            '<?xml version="1.0"?>',
            '<?xml version="1.0"',
        )
        for fragment in rejected_fragments:
            with self.subTest(fragment=fragment):
                errors = validator.validate_html_fragment(fragment)
                self.assertTrue(errors)
                if fragment in incomplete_fragments:
                    self.assertTrue(any("incomplete" in error for error in errors))

    def test_quoted_greater_than_does_not_end_a_tag_early(self):
        for fragment in (
            '<strong title="a > b">text</strong>',
            '<strong title="a\n> b">text</strong>',
        ):
            with self.subTest(fragment=fragment):
                errors = validator.validate_html_fragment(fragment)
                self.assertTrue(any("disallowed attribute 'title'" in error for error in errors))
                self.assertFalse(any("incomplete" in error for error in errors))

    def test_unescaped_less_than_is_rejected_but_escaped_text_is_accepted(self):
        for fragment in ("<", "1 < 2"):
            with self.subTest(fragment=fragment):
                self.assertTrue(validator.validate_html_fragment(fragment))

        self.assertEqual(validator.validate_html_fragment("&lt;"), [])

    def test_flat_and_nested_relative_time_data_are_supported(self):
        units = ("year", "month", "week", "day", "hour", "minute", "second")
        flat_units = ",".join(
            f"{unit}: {{ past: {{ one: 'one {unit} ago', other: '{{0}} {unit}s ago' }}, future: 'in {{0}} {unit}s' }}"
            for unit in units
        )
        nested_units = ",".join(
            f"{unit}: {{ past: '{{0}} {unit}s ago', future: '{{0}} {unit}s from now' }}"
            for unit in units
        )
        flat = "{" + flat_units + ", plural: n => 1 == n ? 'one' : 'other'}"
        nested = "{ long: {" + nested_units + "} }"

        self.assertEqual(validator.validate_relative_time_source(flat), [])
        self.assertEqual(validator.validate_relative_time_source(nested), [])

    def test_relative_time_parser_rejects_executable_or_malformed_content(self):
        self.assertTrue(
            validator.validate_relative_time_source("{ day: process.exit(1), plural: n => 'other' }")
        )

    def test_relative_time_parser_reports_excessive_nesting(self):
        depth = 1500
        source = "{" + "nested:{" * depth + "value:'text'" + "}" * depth + "}"

        errors = validator.validate_relative_time_source(source)
        self.assertTrue(any("nesting exceeds" in error for error in errors))

    def test_regional_catalog_is_compared_to_complete_reference(self):
        reference = user_fixture(name="Inbox %NAME%")
        translated = user_fixture(name="Caixa de entrada %NAME%")
        report = validator.Report()

        validator.validate_catalog_content(
            "pt-BR", "user", Path("pt-BR/user.json"), translated, reference, report
        )

        self.assertEqual(report.errors, [])

    def test_dynamic_expression_after_literal_i18n_html_prefix_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dev").mkdir()
            (root / "snappymail/v/0.0.0/app/templates").mkdir(parents=True)
            (root / "dev/test.js").write_text(
                "i18nHtml('CRYPTO/CURRENT_PASS' + suffix, {})",
                encoding="utf-8",
            )
            report = validator.Report()

            validator._discover_html_keys(root, {"user": {}, "admin": {}}, report)

            self.assertTrue(
                any("i18nHtml() must use a literal key" in error for error in report.errors)
            )

    def test_current_repository_catalogs_pass_without_modification(self):
        report = validator.validate_repository(ROOT)
        self.assertEqual(report.errors, [])
        localization = ROOT / validator.LOCALIZATION_PATH
        expected_counts = {
            "user locales": len(list(localization.glob("*/user.json"))),
            "admin locales": len(list(localization.glob("*/admin.json"))),
            "static catalogs": len(list(localization.glob("*/static.json"))),
            "relative-time": len(list(localization.glob("*/relativetimeformat.js"))),
        }
        for label, expected in expected_counts.items():
            with self.subTest(catalog=label):
                self.assertEqual(report.catalog_counts[label], expected)


if __name__ == "__main__":
    unittest.main()
