"use strict";

module.exports = {
	registration: (networkConfig, register) => JSON.stringify({
		method: 'registration',
		params: {
			register: register,
			phoneMac: networkConfig.getMac()?.toUpperCase().replace(/:/g, ''),
			phoneIp: networkConfig.getAddress(),
		},
	}),

	setPilot: pilot => JSON.stringify({ method: 'setPilot', params: pilot }),
	getPilot: JSON.stringify({ method: 'getPilot', params: {}}),

	getSystemConfig: JSON.stringify({ method: 'getSystemConfig', params: {} }),
}
