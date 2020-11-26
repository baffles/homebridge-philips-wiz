"use strict";

class WizPilotBuilder {
	#params

	constructor() {
		this.#params = {};
	}
	
	setPower(on) {
		this.#params['state'] = on;
		return this;
	}

	setBrightness(brightness) {
		// lamp range is 10%-100%
		this.#params['dimming'] = Math.max(10, Math.min(100, brightness));
		return this;
	}

	setRGBWW(rgbww) {
		this.#params['r'] = rgbww['r'];
		this.#params['g'] = rgbww['g'];
		this.#params['b'] = rgbww['b'];
		this.#params['c'] = rgbww['cw'];
		this.#params['w'] = rgbww['ww'];
		return this;
	}

	clearRGBWW() {
		delete this.#params['r'];
		delete this.#params['g'];
		delete this.#params['b'];
		delete this.#params['c'];
		delete this.#params['w'];
		return this;
	}

	setWhiteTemperature(temperature) {
		// kelvin range is 2200-6500
		this.#params['temp'] = Math.max(2200, Math.min(6500, temperature));
		return this;
	}

	clearWhiteTemperature() {
		delete this.#params['temp'];
		return this;
	}

	setEffectSpeed(speed) {
		// range is 1-100
		//TODO: instead of clamping values, throw on bad value?
		this.#params['speed'] = Math.max(1, Math.min(100));
		return this;
	}

	setScene(id) {
		//TODO: flesh this out more
		this.#params['sceneId'] = id;
		return this;
	}

	toParam() {
		return this.#params;
	}
}

module.exports = WizPilotBuilder;
