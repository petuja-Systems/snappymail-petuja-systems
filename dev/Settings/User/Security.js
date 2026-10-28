import ko from 'ko';

import { koComputable } from 'External/ko';

import { SettingsCapa, SettingsGet } from 'Common/Globals';
import { i18n, translateTrigger, relativeTime } from 'Common/Translator';

import { AbstractViewSettings } from 'Knoin/AbstractViews';
import Remote from 'Remote/User/Fetch';
import { AskPopupView } from 'View/Popup/Ask';

import { SettingsUserStore } from 'Stores/User/Settings';

import { GnuPGUserStore } from 'Stores/User/GnuPG';
import { OpenPGPUserStore } from 'Stores/User/OpenPGP';

import { showScreenPopup } from 'Knoin/Knoin';

import { OpenPgpImportPopupView } from 'View/Popup/OpenPgpImport';
import { OpenPgpGeneratePopupView } from 'View/Popup/OpenPgpGenerate';

import { SMimeUserStore } from 'Stores/User/SMime';
import { SMimeImportPopupView } from 'View/Popup/SMimeImport';

export class UserSettingsSecurity extends AbstractViewSettings {
	constructor() {
		super();

		this.twoFactorState = ko.observable('missing');
		this.twoFactorBusy = ko.observable(false);
		this.twoFactorCode = ko.observable('');
		this.twoFactorError = ko.observable('');
		this.twoFactorSecret = ko.observable('');
		this.twoFactorQrCode = ko.observable('');
		this.twoFactorRecoveryCodes = ko.observable('');
		this.forcedEnrollment = !!SettingsGet('SetupTwoFactor');
		this.twoFactorRequired = !!SettingsGet('RequireTwoFactor');
		this.twoFactorEnabled = koComputable(() => 'enabled' === this.twoFactorState());
		this.twoFactorIncomplete = koComputable(() => 'disabled' === this.twoFactorState());
		this.twoFactorCanDisable = koComputable(() => this.twoFactorEnabled() && !this.twoFactorRequired);

		this.autoLogout = SettingsUserStore.autoLogout;
		this.autoLogoutOptions = koComputable(() => {
			translateTrigger();
			return [
				{ id: 0, name: i18n('SETTINGS_SECURITY/NEVER') },
				{ id: 5, name: relativeTime(300) },
				{ id: 15, name: relativeTime(900) },
				{ id: 30, name: relativeTime(1800) },
				{ id: 60, name: relativeTime(3600) },
				{ id: 120, name: relativeTime(7200) },
				{ id: 300, name: relativeTime(18000) },
				{ id: 600, name: relativeTime(36000) }
			];
		});
		this.addSetting('AutoLogout');

		this.keyPassForget = SettingsUserStore.keyPassForget;
		this.addSetting('keyPassForget');

		this.gnupgPublicKeys = GnuPGUserStore.publicKeys;
		this.gnupgPrivateKeys = GnuPGUserStore.privateKeys;

		this.openpgpkeysPublic = OpenPGPUserStore.publicKeys;
		this.openpgpkeysPrivate = OpenPGPUserStore.privateKeys;

		this.smimeCertificates = SMimeUserStore;

		this.canOpenPGP = SettingsCapa('OpenPGP');
		this.canGnuPG = GnuPGUserStore.isSupported();
		this.canMailvelope = !!window.mailvelope;
	}

	addOpenPgpKey() {
		showScreenPopup(OpenPgpImportPopupView);
	}

	generateOpenPgpKey() {
		showScreenPopup(OpenPgpGeneratePopupView);
	}

	importToOpenPGP() {
		OpenPGPUserStore.loadBackupKeys();
	}

	importToSMime() {
		showScreenPopup(SMimeImportPopupView);
	}

	loadTwoFactorState() {
		Remote.request('TwoFactorState', (iError, data) => {
			if (iError) {
				this.twoFactorState('invalid');
				this.twoFactorError(i18n('SETTINGS_SECURITY/TFA_ERROR'));
				return;
			}

			this.twoFactorState(data?.Result?.Status || 'invalid');
		});
	}

	startTwoFactorSetup() {
		this.requestTwoFactorSetup(false);
	}

	requestTwoFactorSetup(restart) {
		if (this.twoFactorBusy()) {
			return;
		}
		this.twoFactorBusy(true);
		this.twoFactorError('');
		Remote.request('TwoFactorSetup', (iError, data) => {
			this.twoFactorBusy(false);
			if (iError) {
				this.twoFactorError(i18n('SETTINGS_SECURITY/TFA_ERROR'));
				return;
			}

			const result = data?.Result || {};
			this.twoFactorSecret(result.Secret || '');
			this.twoFactorQrCode(result.QRCode || '');
			this.twoFactorRecoveryCodes(result.BackupCodes || '');
			this.twoFactorCode('');
			this.twoFactorState('disabled');
			this.loadTwoFactorState();
		}, restart ? { Restart: 1 } : {});
	}

	confirmTwoFactorRestart() {
		AskPopupView.showModal([
			i18n('SETTINGS_SECURITY/TFA_RESTART_CONFIRM'),
			() => this.requestTwoFactorSetup(true)
		]);
	}

	verifyAndEnableTwoFactor() {
		if (this.twoFactorBusy()) {
			return;
		}
		this.twoFactorBusy(true);
		this.twoFactorError('');
		const action = this.forcedEnrollment ? 'TwoFactorCompleteEnrollment' : 'TwoFactorEnable';
		Remote.request(action, (iError) => {
			this.twoFactorBusy(false);
			if (iError) {
				this.twoFactorError(i18n('SETTINGS_SECURITY/TFA_CODE_REJECTED'));
				return;
			}

			if (this.forcedEnrollment) {
				// The server invalidates this pending session; reload to begin fresh login.
				window.location.reload();
				return;
			}

			this.twoFactorState('enabled');
			this.twoFactorSecret('');
			this.twoFactorQrCode('');
			this.twoFactorCode('');
		}, { Code: this.twoFactorCode() });
	}

	confirmTwoFactorDisable() {
		AskPopupView.showModal([
			i18n('SETTINGS_SECURITY/TFA_DISABLE_CONFIRM'),
			() => this.changeTwoFactorState('TwoFactorDisable')
		]);
	}

	confirmTwoFactorClear() {
		AskPopupView.showModal([
			i18n('SETTINGS_SECURITY/TFA_CLEAR_CONFIRM'),
			() => this.changeTwoFactorState('TwoFactorClear')
		]);
	}

	changeTwoFactorState(action) {
		if (this.twoFactorBusy()) {
			return;
		}
		this.twoFactorBusy(true);
		this.twoFactorError('');
		Remote.request(action, iError => {
			this.twoFactorBusy(false);
			if (iError) {
				this.twoFactorError(i18n('SETTINGS_SECURITY/TFA_ERROR'));
				return;
			}

			this.twoFactorSecret('');
			this.twoFactorQrCode('');
			this.twoFactorRecoveryCodes('');
			this.twoFactorCode('');
			this.loadTwoFactorState();
		});
	}

	onBuild() {
		this.loadTwoFactorState();
		if (this.forcedEnrollment) {
			return;
		}
		/**
		 * Create an iframe to display the Mailvelope keyring settings.
		 * The iframe will be injected into the container identified by selector.
		 */
		window.mailvelope && mailvelope.createSettingsContainer('#mailvelope-settings'/*[, keyring], options*/);
		/**
		 * https://github.com/the-djmaze/snappymail/issues/973
		Remote.request('GetStoredPGPKeys', (iError, data) => {
			console.dir([iError, data]);
		});
		*/
	}
}
