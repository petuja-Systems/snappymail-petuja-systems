import { pInt } from 'Common/Utils';
import { doc, Settings, SettingsAdmin } from 'Common/Globals';

const
	BASE = doc.location.pathname.replace(/\/+$/,'') + '/',
	HASH_PREFIX = '#/',

	adminPath = () => rl.adminArea() && !SettingsAdmin('host'),

	prefix = () => BASE + '?' + (adminPath() ? SettingsAdmin('path') : '');

export const
	SUB_QUERY_PREFIX = '&q[]=',

	/**
	 * @param {string=} startupUrl
	 * @returns {string}
	 */
	root = () => HASH_PREFIX,

	/**
	 * @returns {string}
	 */
	logoutLink = () => adminPath() ? prefix() : BASE,

	/**
	 * @param {string} type
	 * @param {string} hash
	 * @param {string=} customSpecSuffix
	 * @returns {string}
	 */
	serverRequestRaw = (type, hash) =>
		BASE + '?/Raw/' + SUB_QUERY_PREFIX + '/'
		+ '0/' // Settings.get('accountHash') ?
		+ (type
			? type + '/' + (hash ? SUB_QUERY_PREFIX + '/' + hash : '')
			: ''),

	/**
	 * @param {string} download
	 * @returns {string}
	 */
	attachmentDownload = (download) =>
		serverRequestRaw('Download', download),

	proxy = url =>
		BASE + '?/ProxyExternal/public-v1/'
//			+ btoa(JSON.stringify([token,url]).replace(/ /g, '%20')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
			+ btoa(url.replace(/ /g, '%20')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
//			+ b64EncodeJSONSafe(url.replace(/ /g, '%20')),

	/**
	 * @param {string} type
	 * @returns {string}
	 */
	serverRequest = type => prefix() + '/' + type + '/' + SUB_QUERY_PREFIX + '/0/',

	/**
	 * @param {string} lang
	 * @param {boolean} isAdmin
	 * @returns {string}
	 */
	langLink = (lang, isAdmin) =>
		BASE + '?/Lang/0/' + (isAdmin ? 'Admin' : 'App')
			+ '/' + encodeURI(lang)
			+ '/' + Settings.app('version') + '/',

	/**
	 * @param {string} path
	 * @returns {string}
	 */
	staticLink = path => Settings.app('webStaticPath') + path,

	/**
	 * @param {string} inboxFolderName = 'INBOX'
	 * @returns {string}
	 */
	mailbox = (inboxFolderName = 'INBOX') => HASH_PREFIX + 'mailbox/' + inboxFolderName,

	/**
	 * @param {string=} screenName = ''
	 * @returns {string}
	 */
	settings = (screenName = '') => HASH_PREFIX + 'settings' + (screenName ? '/' + screenName : ''),

	/**
	 * @param {string=} screenName
	 * @returns {string}
	 */
	admin = screenName => HASH_PREFIX + (
		'AdminDomains' == screenName ? 'domains'
		: 'AdminSecurity' == screenName ? 'security'
		: ''
	),

	/**
	 * @param {string} folder
	 * @param {number=} page = 1
	 * @param {string=} search = ''
	 * @param {number=} threadUid = 0
	 * @returns {string}
	 */
	mailBox = (folder, page, search, threadUid, messageUid) => {
		let result = [HASH_PREFIX + 'mailbox'];

		if (folder) {
			result.push(folder + (threadUid ? '~' + threadUid : ''));
		}

		if (messageUid) {
			result.push('m' + messageUid);
		} else {
			page = pInt(page, 1);
			if (1 < page) {
				result.push('p' + page);
			}
			search && result.push(encodeURI(search));
		}

		return result.join('/');
	},

	mailBoxMessage = (folder, messageUid) => mailBox(folder, 1, '', 0, pInt(messageUid));
