import ko from 'ko';

import { AppearancePreference, createAppearanceController, createAppearanceWriteQueue, isAppearancePreference } from 'Common/Appearance';
import { SaveSettingStatus } from 'Common/Enums';
import { Settings } from 'Common/Globals';
import Remote from 'Remote/User/Fetch';

const controller = createAppearanceController(
	document.documentElement,
	matchMedia('(prefers-color-scheme: dark)')
);

export const AppearanceStore = {
	preference: ko.observable(null),
	saveStatus: ko.observable(SaveSettingStatus.Idle)
};

let synchronizing = false;

const saveAppearance = createAppearanceWriteQueue(
	(value, callback) => Remote.saveSetting('Appearance', value, callback),
	(value, error, isLatest) => {
		if (!isLatest) {
			return;
		}
		if (!error) {
			Settings.set('Appearance', value);
		}
		AppearanceStore.saveStatus(error ? SaveSettingStatus.Failed : SaveSettingStatus.Success);
		setTimeout(() => {
			if (AppearanceStore.preference() === value && SaveSettingStatus.Saving !== AppearanceStore.saveStatus()) {
				AppearanceStore.saveStatus(SaveSettingStatus.Idle);
			}
		}, 1000);
	}
);

AppearanceStore.preference.subscribe(value => {
	if (synchronizing) {
		return;
	}
	if (!isAppearancePreference(value)) {
		synchronizing = true;
		AppearanceStore.preference(controller.getPreference() || AppearancePreference.LIGHT);
		synchronizing = false;
		return;
	}

	controller.setPreference(value);
	document.documentElement.removeAttribute('data-appearance-preference');
	AppearanceStore.saveStatus(SaveSettingStatus.Saving);
	saveAppearance(value);
});

export function initAppearance(value) {
	const valid = isAppearancePreference(value),
		preference = valid ? value : AppearancePreference.LIGHT;

	synchronizing = true;
	controller.setPreference(preference);
	document.documentElement.removeAttribute('data-appearance-preference');
	AppearanceStore.preference(preference);
	AppearanceStore.saveStatus(SaveSettingStatus.Idle);
	synchronizing = false;
	return valid;
}

export function setAppearancePreference(value) {
	if (!isAppearancePreference(value)) {
		return false;
	}

	AppearanceStore.preference(value);
	return true;
}

export function clearAppearance() {
	synchronizing = true;
	controller.clear();
	document.documentElement.removeAttribute('data-appearance-preference');
	AppearanceStore.preference(null);
	AppearanceStore.saveStatus(SaveSettingStatus.Idle);
	synchronizing = false;
}
