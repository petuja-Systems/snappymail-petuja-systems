import { getNotification } from 'Common/Translator';
import { addObservablesTo, addSubscribablesTo } from 'External/ko';

import Remote from 'Remote/Admin/Fetch';

import { decorateKoCommands } from 'Knoin/Knoin';
import { AbstractViewLogin } from 'Knoin/AbstractViews';

export class AdminLoginView extends AbstractViewLogin {
	constructor() {
		super('AdminLogin');

		addObservablesTo(this, {
			login: '',
			password: '',
			totp: '',

			loginError: false,
			passwordError: false,

			submitRequest: false,
			submitError: ''
		});

		addSubscribablesTo(this, {
			login: () => this.loginError(false),
			password: () => this.passwordError(false)
		});

		decorateKoCommands(this, {
			submitCommand: self => !self.submitRequest()
		});
	}

	hideError() {
		this.submitError('');
	}

	submitCommand(self, event) {
		let form = event.target.form,
			data = new FormData(form),
			valid = form.reportValidity();

		this.loginError(!this.login());
		this.passwordError(!this.password());
		this.formError(!valid);

		if (valid) {
			this.submitRequest(true);

			Remote.request('AdminLogin',
				(iError, oData) => {
					if (iError) {
						this.submitRequest(false);
						this.submitError(getNotification(iError));
					} else {
						rl.setData(oData.Result);
					}
				},
				data
			);
		}

		return valid;
	}
}
