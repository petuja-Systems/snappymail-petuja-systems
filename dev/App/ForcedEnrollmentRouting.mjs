const FORCED_ENROLLMENT_SCREEN = 'settings/security';
const FORCED_ENROLLMENT_HASH = '#/settings/security';

function routeToSecurity(location) {
	if (FORCED_ENROLLMENT_HASH !== location.hash) {
		location.hash = FORCED_ENROLLMENT_HASH;
	}
}

export function startForcedEnrollmentRouting(setupTwoFactor, {
	location,
	addEventListener,
	startSecurityScreen,
	schedule = callback => setTimeout(callback, 0)
}) {
	if (true !== setupTwoFactor) {
		return false;
	}

	addEventListener('sm-show-screen', event => {
		if (FORCED_ENROLLMENT_SCREEN !== event.detail) {
			event.preventDefault();
			routeToSecurity(location);
		}
	});
	startSecurityScreen();
	schedule(() => routeToSecurity(location));
	return true;
}
