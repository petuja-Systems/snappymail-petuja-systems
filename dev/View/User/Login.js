import { Notifications } from 'Common/Enums';
import { ClientSideKeyNameLastSignMe } from 'Common/EnumsUser';
import { Settings, SettingsGet } from 'Common/Globals';
import { getNotification, translatorReload, convertLangName } from 'Common/Translator';
import { addObservablesTo, addComputablesTo, addSubscribablesTo } from 'External/ko';

import { LanguageStore } from 'Stores/Language';

import * as Local from 'Storage/Client';

import Remote from 'Remote/User/Fetch';

import { staticLink } from 'Common/Links';
import { showScreenPopup } from 'Knoin/Knoin';
import { AbstractViewLogin } from 'Knoin/AbstractViews';

import { LanguagesPopupView } from 'View/Popup/Languages';
import {
	completeLoginRequestData,
	LoginStep,
	nextSignMeValue,
	parseLoginResponse
} from './LoginFlow.mjs';

const
	PetujaEmailPublicSourceBaseUrl = 'https://github.com/petuja-Systems/snappymail-petuja-systems/tree/petuja-email-v',
	SignMeOff = 0,
	SignMeOn = 1,
	SignMeUnused = 2;

export class LoginUserView extends AbstractViewLogin {
	constructor() {
		super();

		// Keep the branding asset version-aware without changing login submission behavior.
		this.loginLogoUrl = staticLink('images/petuja-systems-logo.svg');
		this.petujaEmailVersion = Settings.app('petujaEmailVersion') || '';
		this.petujaEmailSnappyMailVersion = Settings.app('petujaEmailSnappyMailVersion') || '';
		this.petujaEmailSourceUrl = this.petujaEmailVersion
			? PetujaEmailPublicSourceBaseUrl + encodeURIComponent(this.petujaEmailVersion)
			: '';

		addObservablesTo(this, {
			loadingDesc: SettingsGet('loadingDescription'),

			email: SettingsGet('DevEmail'),
			password: SettingsGet('DevPassword'),
			signMe: false,

			emailError: false,
			passwordError: false,
			loginStep: LoginStep.Primary,
			factorCode: '',

			submitRequest: false,
			submitError: '',
			submitErrorAdditional: '',

			langRequest: false,

			signMeType: SignMeUnused
		});

		this.allowLanguagesOnLogin = !!SettingsGet('allowLanguagesOnLogin');

		this.language = LanguageStore.language;
		this.languages = LanguageStore.languages;

		this.bSendLanguage = false;
		this.loginErrorRevision = 0;
		this.challengeState = null;
		this.activeRequest = '';
		this.requestRevision = 0;
		this.focusRevision = 0;
		this.loginComplete = false;

		addComputablesTo(this, {

			languageFullName: () => convertLangName(this.language()),

			signMeVisibility: () => SignMeUnused !== this.signMeType()
		});

		addSubscribablesTo(this, {
			email: () => this.emailError(false),

			password: () => this.passwordError(false),

			submitError: value => value || this.submitErrorAdditional(''),

			signMeType: iValue => this.signMe(SignMeOn === iValue),

			language: value => {
				const loginErrorRevision = this.loginErrorRevision;
				this.langRequest(true);
				translatorReload(value).then(
					() => {
						this.langRequest(false);
						// Preserve a newer server error received while the language was loading.
						if (loginErrorRevision === this.loginErrorRevision) {
							this.submitError('');
							this.submitErrorAdditional('');
						}
						this.bSendLanguage = true;
					},
					() => this.langRequest(false)
				);
			}
		});

		if (SettingsGet('AdditionalLoginError') && !this.submitError()) {
			this.submitError(SettingsGet('AdditionalLoginError'));
		}

	}

	hideError() {
		this.submitError('');
	}

	toggleSignMe() {
		this.signMe(nextSignMeValue(this.signMe(), this.submitRequest()));
	}

	submitCommand(self, event) {
		const target = event?.target,
			form = 'FORM' === target?.nodeName ? target : target?.form;
		if (!form || 'FORM' !== form.nodeName || this.submitRequest() || this.loginComplete) {
			return false;
		}

		const step = this.loginStep(),
			isPrimary = LoginStep.Primary === step,
			email = this.email().trim();
		if (isPrimary) {
			this.email(email);
			this.emailError(!email);
			this.passwordError(!this.password());
		}

		const formValid = form.reportValidity(),
			code = isPrimary ? '' : String(this.factorCode() || '').trim(),
			valid = formValid && (isPrimary
			? Boolean(email && this.password())
			: Boolean(code && this.challengeState));

		if (!isPrimary) {
			this.factorCode(code);
		}
		this.formError(!valid);
		if (!valid) {
			if (!isPrimary) {
				this.focusLoginInput('login-factor-code', LoginStep.Factor);
			}
			return false;
		}

		const data = new FormData();
		data.set('Email', isPrimary ? email : this.email());
		data.set('Password', this.password());

		completeLoginRequestData(data, {
			step,
			language: this.bSendLanguage ? this.language() : '',
			signMe: this.signMe(),
			challenge: isPrimary ? '' : this.challengeState.id,
			code
		});

		const requestType = isPrimary ? 'begin' : 'verify',
			requestRevision = ++this.requestRevision;
		this.activeRequest = requestType;
		this.submitRequest(true);
		Remote.request(isPrimary ? 'TwoFactorLoginBegin' : 'TwoFactorLoginVerify',
			(iError, oData) => this.handleLoginResponse(requestRevision, requestType, iError, oData),
			data
		);

		if (isPrimary) {
			Local.set(ClientSideKeyNameLastSignMe, this.signMe() ? '-1-' : '-0-');
		}

		return false;
	}

	handleLoginResponse(requestRevision, requestType, error, response) {
		if (requestRevision !== this.requestRevision || requestType !== this.activeRequest) {
			if ('begin' === requestType && !error) {
				const staleResult = parseLoginResponse(response);
				if ('factor' === staleResult.type
					&& staleResult.challenge.id !== this.challengeState?.id) {
					this.abortChallenge(staleResult.challenge);
				}
			}
			return;
		}

		const result = error ? {type: 'invalid'} : parseLoginResponse(response),
			acceptedResult = ('begin' === requestType && ['factor', 'authenticated'].includes(result.type))
				|| ('verify' === requestType && 'authenticated' === result.type),
			loginError = error || (acceptedResult ? 0 : Notifications.AuthError);
		if (requestRevision !== this.requestRevision || requestType !== this.activeRequest) {
			return;
		}

		this.activeRequest = '';
		this.submitRequest(false);
		if (loginError) {
			this.showLoginError(loginError, response, requestType);
		} else if ('begin' === requestType && 'factor' === result.type) {
			this.challengeState = result.challenge;
			this.factorCode('');
			this.submitError('');
			this.submitErrorAdditional('');
			this.formError(false);
			this.loginStep(LoginStep.Factor);
			this.focusLoginInput('login-factor-code', LoginStep.Factor);
		} else if ('authenticated' === result.type) {
			this.completeLogin(result.appData);
		} else {
			this.showLoginError(Notifications.AuthError, response, requestType);
		}
	}

	showLoginError(error, response, requestType) {
		this.loginErrorRevision++;
		if (Notifications.InvalidInputArgument == error) {
			error = Notifications.AuthError;
		}
		this.submitError(getNotification(error, response?.message, Notifications.UnknownError));
		this.submitErrorAdditional(response?.messageAdditional || response?.message);
		this.formError(true);
		if ('verify' === requestType) {
			this.factorCode('');
			this.focusLoginInput('login-factor-code', LoginStep.Factor);
		}
	}

	completeLogin(appData) {
		if (this.loginComplete) {
			return;
		}
		this.loginComplete = true;
		this.challengeState = null;
		this.password('');
		this.factorCode('');
		this.email('');
		this.loginStep(LoginStep.Primary);
		rl.setData(appData);
	}

	backToPrimary() {
		if (LoginStep.Factor !== this.loginStep() || this.submitRequest() || !this.challengeState) {
			return false;
		}

		const challenge = this.challengeState,
			data = new FormData();
		data.set('Account', challenge.account);
		data.set('Challenge', challenge.id);
		this.factorCode('');
		this.password('');
		this.activeRequest = 'abort';
		const requestRevision = ++this.requestRevision;
		this.submitRequest(true);
		Remote.request('TwoFactorLoginAbort', () => {
			if (requestRevision !== this.requestRevision || 'abort' !== this.activeRequest) {
				return;
			}
			this.activeRequest = '';
			this.submitRequest(false);
			this.challengeState = null;
			this.loginStep(LoginStep.Primary);
			this.emailError(false);
			this.passwordError(false);
			this.submitError('');
			this.submitErrorAdditional('');
			this.formError(false);
			this.focusLoginInput('login-password', LoginStep.Primary);
		}, data);
		return false;
	}

	abortChallenge(challenge, callback = () => {}) {
		const data = new FormData();
		data.set('Account', challenge.account);
		data.set('Challenge', challenge.id);
		Remote.request('TwoFactorLoginAbort', callback, data);
	}

	focusLoginInput(id, step) {
		const focusRevision = ++this.focusRevision;
		setTimeout(() => {
			if (focusRevision === this.focusRevision && step === this.loginStep()
				&& !this.submitRequest()) {
				this.viewModelDom?.querySelector('#' + id)?.focus();
			}
		}, 0);
	}

	onBuild(dom) {
		super.onBuild(dom);
		this.viewModelDom = dom;

		let signMe = SettingsGet('signMe');
		switch (signMe) {
			case SignMeOff:
			case SignMeOn:
				switch (Local.get(ClientSideKeyNameLastSignMe)) {
					case '-1-':
						signMe = SignMeOn;
						break;
					case '-0-':
						signMe = SignMeOff;
						break;
					// no default
				}
				this.signMeType(signMe);
				break;
			default:
				this.signMeType(SignMeUnused);
				break;
		}
	}

	onShow() {
		super.onShow();
		this.loginComplete = false;
	}

	onHide() {
		if (this.challengeState && !this.submitRequest()) {
			this.abortChallenge(this.challengeState);
		}
		this.requestRevision++;
		this.focusRevision++;
		this.activeRequest = '';
		this.submitRequest(false);
		this.challengeState = null;
		this.password('');
		this.factorCode('');
		this.email('');
		this.loginStep(LoginStep.Primary);
		super.onHide();
	}

	selectLanguage() {
		if (!this.submitRequest() && !this.langRequest() && LoginStep.Primary === this.loginStep()) {
			showScreenPopup(LanguagesPopupView, [this.language, this.languages(), LanguageStore.userLanguage()]);
		}
	}
}
