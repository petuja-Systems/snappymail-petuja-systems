export const AppearancePreference = Object.freeze({
	LIGHT: 'light',
	DARK: 'dark',
	SYSTEM: 'system'
});

export const EffectiveColorScheme = Object.freeze({
	LIGHT: 'light',
	DARK: 'dark'
});

export function isAppearancePreference(value) {
	return Object.values(AppearancePreference).includes(value);
}

export function isEffectiveColorScheme(value) {
	return Object.values(EffectiveColorScheme).includes(value);
}

export function resolveEffectiveColorScheme(preference, prefersDark) {
	if (!isAppearancePreference(preference)) {
		return null;
	}

	return AppearancePreference.SYSTEM === preference
		? (prefersDark ? EffectiveColorScheme.DARK : EffectiveColorScheme.LIGHT)
		: preference;
}

export function createAppearanceController(root, mediaQuery) {
	let preference = null,
		listener = null;

	const removeListener = () => {
		if (listener) {
			if (mediaQuery.removeEventListener) {
				mediaQuery.removeEventListener('change', listener);
			} else if (mediaQuery.removeListener) {
				mediaQuery.removeListener(listener);
			}
			listener = null;
		}
	},
		apply = prefersDark => {
			const scheme = resolveEffectiveColorScheme(preference, prefersDark);
			if (isEffectiveColorScheme(scheme)) {
				root.setAttribute('data-appearance-scheme', scheme);
			} else {
				root.removeAttribute('data-appearance-scheme');
			}
		};

	return {
		setPreference(value) {
			removeListener();
			if (!isAppearancePreference(value)) {
				preference = null;
				root.removeAttribute('data-appearance-scheme');
				return false;
			}

			preference = value;
			apply(mediaQuery.matches);
			if (AppearancePreference.SYSTEM === preference) {
				listener = event => {
					if (AppearancePreference.SYSTEM === preference) {
						apply(event.matches);
					}
				};
				if (mediaQuery.addEventListener) {
					mediaQuery.addEventListener('change', listener);
				} else if (mediaQuery.addListener) {
					mediaQuery.addListener(listener);
				}
			}
			return true;
		},

		clear() {
			removeListener();
			preference = null;
			root.removeAttribute('data-appearance-scheme');
		},

		getPreference() {
			return preference;
		}
	};
}

export function createAppearanceWriteQueue(save, onResult = () => {}) {
	let saving = false,
		pending = null,
		revision = 0;

	const run = () => {
		if (saving || !pending) {
			return;
		}

		const request = pending;
		pending = null;
		saving = true;
		save(request.preference, error => {
			saving = false;
			onResult(request.preference, error, request.revision === revision && !pending);
			run();
		});
	};

	return value => {
		if (!isAppearancePreference(value)) {
			return false;
		}

		pending = { preference: value, revision: ++revision };
		run();
		return true;
	};
}
