/* eslint-disable no-process-env */

import { builtinModules } from 'module';

import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';

import pkg from './package.json';

const nodeDependencies = Object.keys(pkg.dependencies);

const banner =
  `/*! OpenPGP.js v${pkg.version} - ` +
  `${new Date().toISOString().split('T')[0]} - ` +
  `this is LGPL licensed code, see LICENSE/our website ${pkg.homepage} for more information. */`;

const intro = "const globalThis = window;";

export default Object.assign([
  {
    input: 'src/index.js',
    output: [
      { file: 'dist/openpgp.js', format: 'iife', name: pkg.name, banner }
    ],
    inlineDynamicImports: true,
    plugins: [
      resolve({
        browser: true
      }),
      commonjs({
        ignore: builtinModules.concat(nodeDependencies)
      }),
      replace({
        'OpenPGP.js VERSION': `OpenPGP.js ${pkg.version}`,
        'require(': 'void(',
        delimiters: ['', ''],
        preventAssignment: true
      })
    ]
  }
].filter(config => {
  config.output = config.output.filter(output => {
    return (output.file || output.dir + '/' + output.entryFileNames).includes(
      process.env.npm_config_build_only || // E.g. `npm install --build-only=lightweight`.
      'dist' // Don't build test bundle by default.
    );
  });
  return config.output.length;
}), {
  allow_empty: true // Fake option to trick rollup into accepting empty config array when filtered above.
});
