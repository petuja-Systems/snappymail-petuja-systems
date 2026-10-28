/* RainLoop Webmail (c) RainLoop Team | Licensed under MIT */
const { execFile } = require('child_process');

function pythonCandidates({ platform = process.platform, env = process.env } = {}) {
	const override = 'string' === typeof env.PYTHON ? env.PYTHON.trim() : '';
	if (override) {
		return [{ command: override, args: [], fromOverride: true }];
	}

	if ('win32' === platform) {
		return [
			{ command: 'py', args: ['-3'] },
			{ command: 'python3', args: [] },
			{ command: 'python', args: [] }
		];
	}

	return [
		{ command: 'python3', args: [] },
		{ command: 'python', args: [] }
	];
}

function executionDetail(error) {
	if ('ENOENT' === error?.code) {
		return 'executable not found or could not be launched';
	}
	if (error?.signal) {
		return 'stopped by ' + error.signal;
	}
	if (Number.isInteger(error?.code)) {
		return 'exited with code ' + error.code;
	}
	return String(error?.message || 'unknown error').slice(0, 180);
}

function isUnavailableCommand(error, platform, output = '', errorOutput = '') {
	return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error?.code)
		|| (
			'win32' === platform
			&& 9009 === error?.code
			&& /python(?:3)?\s+(?:was not found|wurde nicht gefunden)|microsoft store/i.test(
				[error?.message, output, errorOutput].filter(Boolean).join('\n')
			)
		);
}

function createPythonError(candidate, error, { platform, candidates, output, errorOutput, operation }) {
	const detail = executionDetail(error);
	if (candidate.fromOverride) {
		return new Error(
			'Python 3 ' + operation + ' could not run using PYTHON (' + candidate.command + '): '
			+ detail + '. Set PYTHON to the Python 3 executable path.'
		);
	}
	if (isUnavailableCommand(error, platform, output, errorOutput)) {
		return new Error(
			'Python 3 is required for ' + operation + '; none of '
			+ candidates.map(({ command, args }) => [command, ...args].join(' ')).join(', ')
			+ ' could provide a usable interpreter. Install Python 3 or set PYTHON to its executable path.'
		);
	}
	return new Error(
		'Python 3 ' + operation + ' failed using '
		+ [candidate.command, ...candidate.args].join(' ') + ' (' + detail
		+ '). Install Python 3 or set PYTHON to its executable path.'
	);
}

function runPythonScript(scriptPath, {
	cwd,
	env = process.env,
	platform = process.platform,
	operation = 'localization validation',
	execFileImpl = execFile,
	stdout = process.stdout,
	stderr = process.stderr
} = {}) {
	const candidates = pythonCandidates({ platform, env });
	return new Promise((resolve, reject) => {
		let index = 0;
		const runCandidate = () => {
			const candidate = candidates[index];
			const options = { env };
			if (cwd) {
				options.cwd = cwd;
			}
			const onResult = (error, output, errorOutput) => {
				if (!error) {
					if (output) {
						stdout.write(output);
					}
					if (errorOutput) {
						stderr.write(errorOutput);
					}
					resolve();
					return;
				}
				if (
					!candidate.fromOverride
					&& isUnavailableCommand(error, platform, output, errorOutput)
					&& index + 1 < candidates.length
				) {
					index += 1;
					runCandidate();
					return;
				}
				if (output) {
					stdout.write(output);
				}
				if (errorOutput) {
					stderr.write(errorOutput);
				}
				reject(createPythonError(candidate, error, { platform, candidates, output, errorOutput, operation }));
			};

			try {
				execFileImpl(candidate.command, [...candidate.args, scriptPath], options, onResult);
			} catch (error) {
				onResult(error);
			}
		};
		runCandidate();
	});
}

module.exports = { pythonCandidates, runPythonScript };
