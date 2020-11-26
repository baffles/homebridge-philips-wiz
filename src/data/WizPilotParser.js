"use strict";

module.exports = params => (
	{
		poweredOn: params['state'],
		brightness: params['dimming'],
		r: params['r'],
		g: params['g'],
		b: params['b'],
		cw: params['c'],
		ww: params['w'],
		whiteTemperature: params['temp'],
		effectSpeed: params['speed'],
		scene: params['sceneId'],
	}
);
