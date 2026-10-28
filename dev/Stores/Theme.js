import ko from 'ko';
import { $htmlCL, leftPanelDisabled } from 'Common/Globals';

export const
	// Also see Styles/_Values.less @maxMobileWidth
	isMobile = matchMedia('(max-width: 799px)'),
	// https://github.com/the-djmaze/snappymail/issues/1150
//	isSmall = matchMedia('(max-width: 1400px)'),

	ThemeStore = {
		isMobile: ko.observable(false)
	},

	initResponsiveState = () => {
		leftPanelDisabled(ThemeStore.isMobile());
	};

isMobile.onchange = e => {
	ThemeStore.isMobile(e.matches);
	$htmlCL.toggle('rl-mobile', e.matches);
	/*$htmlCL.contains('sm-msgView-side') || */leftPanelDisabled(e.matches);
};
isMobile.onchange(isMobile);

//isSmall.onchange = e => $htmlCL.contains('sm-msgView-side') && leftPanelDisabled(e.matches);
//isSmall.onchange(isSmall);
