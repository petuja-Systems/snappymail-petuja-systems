/* RainLoop Webmail (c) RainLoop Team | Licensed under MIT */
const gulp = require('gulp');
const { cleanStatic } = require('./tasks/common');
const { js, jsLint } = require('./tasks/js');
const { css, cssLint } = require('./tasks/css');
const { runPythonScript } = require('./tasks/python-runner');
const { prepareProductStatic } = require('./tasks/product-static');
const productStatic = () => prepareProductStatic();

const clean = gulp.series(cleanStatic);

const localizationLint = () => runPythonScript('scripts/validate_localization.py', { cwd: __dirname });
const normalizeReleaseTar = () => runPythonScript('scripts/normalize-release-tar.py', {
	cwd: __dirname, operation: 'release TAR normalization'
});

const lint = gulp.parallel(jsLint, cssLint, localizationLint);

const buildState1 = gulp.parallel(js, css);
const buildState2 = gulp.series(clean, buildState1);

const build = gulp.series(gulp.parallel(lint, buildState2), productStatic);

exports.css = css;
exports.lint = lint;
exports.build = build;
exports.devDemoAssets = gulp.parallel(js, css);
exports.prepareProductStatic = productStatic;
exports.normalizeReleaseTar = normalizeReleaseTar;
exports.default = build;
