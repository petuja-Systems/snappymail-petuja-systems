const
	htmlre = /[&<>"']/g,
	htmlmap = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#x27;'
	};

/**
 * @param {string} text
 * @returns {string}
 */
export const
	encodeHtml = text => (text?.toString?.() || '' + text).replace(htmlre, m => htmlmap[m]),

	/**
	 * Interpolates raw text values into trusted HTML translation markup.
	 * @param {string} template
	 * @param {Object=} valueList
	 * @returns {string}
	 */
	interpolateHtml = (template, valueList) => {
		valueList && Object.entries(valueList).forEach(([key, value]) => {
			template = template.replace('%' + key + '%', () => encodeHtml(value));
		});
		return template;
	};
