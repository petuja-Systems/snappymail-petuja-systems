export const LoginStep = Object.freeze({
	Primary: 'primary',
	Factor: 'factor'
});

export function nextSignMeValue(current, submitting) {
	return submitting ? current : !current;
}

const ChallengePattern = /^[A-Za-z0-9_-]{43}$/;

export function parseLoginResponse(response) {
	const appData = response?.Result;
	if (!appData || 'object' !== typeof appData || Array.isArray(appData)) {
		return {type: 'invalid'};
	}

	if (true === appData.RequiresTwoFactor) {
		const expiresAt = Number(appData.ExpiresAt);
		if ('string' !== typeof appData.Challenge || !ChallengePattern.test(appData.Challenge)
			|| 'string' !== typeof appData.Account || !appData.Account
			|| !Number.isSafeInteger(expiresAt) || 0 >= expiresAt) {
			return {type: 'invalid'};
		}

		return {
			type: 'factor',
			appData,
			challenge: {
				id: appData.Challenge,
				account: appData.Account,
				expiresAt
			}
		};
	}
	if (true !== appData.Auth) {
		return {type: 'invalid'};
	}

	return {type: 'authenticated', appData};
}

export function completeLoginRequestData(data, {step, language, signMe, challenge, code}) {
	data.set('language', language || '');
	// The server-held challenge remains authoritative for factor verification.
	for (const key of ['Account', 'Challenge', 'Code', 'totp_code']) {
		data.delete(key);
	}
	if (LoginStep.Primary === step) {
		data.set('signMe', signMe ? '1' : '0');
	} else {
		data.delete('signMe');
		data.set('Challenge', challenge);
		data.set('Code', code);
	}
	return data;
}
