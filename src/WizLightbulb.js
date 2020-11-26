const rx = require('rxjs');
const rxops = require('rxjs/operators');

const { hsv2rgb, rgb2hsv } = require('color-functions');

const WizMessage = require('./data/WizMessage');
const WizPilotBuilder = require('./data/WizPilotBuilder');

class WizLightbulb {
	#platform;
	#accessory;
	#api;
	#log;
	#comm;
	#service;
	
	#ip;
	get ip() {
		return this.#ip;
	}

	// this is the current (homekit) state of the bulb. it is updated by incoming
	// getPilot/syncPilot messages - so to have a change reflected, it needs to make the round
	// trip to the bulb and back
	#currentState = new rx.BehaviorSubject({});

	// the subscription responsible for applying state changes; this gets unsubscribed on shutdown
	#homekitUpdater;

	// acks coming back from the bulb
	#acks = new rx.Subject();

	// bulb states coming in from the bulb (getPilot responses or syncPilot messages)
	#bulbState = new rx.BehaviorSubject({});

	constructor(platform, accessory, api, log, comm) {
		this.#platform = platform;
		this.#accessory = accessory;
		this.#api = api;
		this.#log = log;
		this.#comm = comm;
		this.#ip = accessory.context.lastKnownIp;

		require('process').on('uncaughtExceptionMonitor', (err, origin) => {
			this.#log.debug(err, origin);
		  });

		log.debug(`Setting up bulb ${accessory.UUID}. Last known IP: ${accessory.context.lastKnownIp}.`);
		
		const service = this.#service = accessory.getService(api.hap.Service.Lightbulb) || accessory.addService(api.hap.Service.Lightbulb);

		const homekitUpdates = new rx.Subject();

		const wireCharacteristic = (characteristic, key, overrides = {}) => {
			service.getCharacteristic(characteristic)
				.on('get', cb => { this.#log.debug(`ask ${key} --> ${this.#currentState.getValue()?.[key] ?? 0}`); cb(null, this.#currentState.getValue()?.[key] ?? 0); })
				.on('set', (value, callback) => {
					let props = Object.assign({}, overrides);
					props[key] = value;
					homekitUpdates.next({ props, callback });
				});
		}

		wireCharacteristic(api.hap.Characteristic.On, 'poweredOn');
		wireCharacteristic(api.hap.Characteristic.Brightness, 'brightness');
		wireCharacteristic(api.hap.Characteristic.Hue, 'hue', { temperature: null });
		wireCharacteristic(api.hap.Characteristic.Saturation, 'saturation', { temperature: null });
		wireCharacteristic(api.hap.Characteristic.ColorTemperature, 'temperature', { hue: null, saturation: null });
		

		// this is the main logic responsible pushing new states to the bulb
		this.#homekitUpdater = homekitUpdates.pipe(
			// first, we build up a "patch" to the bulb state with the collection of pending callbacks as we go
			rxops.scan(
				(patch, change) => ({ props: Object.assign({}, patch.props, change.props), callbacks: patch.callbacks.concat([ change.callback ]) }),
				{ props: {}, callbacks: [] },
			),

			// keep repeating the latest state/callbacks periodically, so we can re-send if we don't get an ack in time
			rxops.switchMap(
				toSend => rx.concat(
					rx.of(toSend),
					rx.combineLatest([rx.of(toSend), rx.interval(1000)]).pipe(rxops.map(([val]) => val))
				)
			),

			// debounce with a short delay to account for multi-value updates (like hue+saturation)
			rxops.debounceTime(20),

			// keep repeating until we get an ack
			rxops.takeUntil(this.#acks),

			// actually do the send (this is probably an abuse of tap, since it's impure)
			rxops.tap(({ props }) => {
				// apply these new props on the current state
				const newState = Object.assign(this.#currentState.getValue(), props);

				// build the setPilot message to send
				const pilot = new WizPilotBuilder()

				pilot.setPower(newState.poweredOn);
				
				// take the 0-100% range and translate it to 10-100%
				pilot.setBrightness(Math.round(newState.brightness * 90 / 100 + 10));

				if (newState.hue === null && newState.saturation === null) {
					// mireds to kelvin
					const kelvin = Math.trunc(1e6 / newState.temperature);
					pilot.setWhiteTemperature(kelvin);
				} else {
					const rgb = hsv2rgb(newState.hue, newState.saturation, 100);
					pilot.setRGBWW(rgb);
				}

				const message = WizMessage.setPilot(pilot.toParam());

				this.#log.debug(props);
				this.#log.debug(`send ${message}`);

				this.#comm.sendTo(this.#ip, message);
			}),

			// once an ack happens, keep the last state that was being applied
			rxops.last(undefined, { props: null, callbacks: [] }),
		).pipe(
			// every time a state send finishes, repeat the collection/sending process
			rxops.repeat()
		).subscribe(({ props, callbacks }) => {
			this.#log.debug(`Send operation to ${this.#ip} complete`, props);

			// whenever a send finishes, call the callbacks
			for (const cb of callbacks) {
				cb(null);
			}
		});

		this.#bulbState.subscribe(state => {
			service.updateCharacteristic(api.hap.Characteristic.On, state.poweredOn);
			service.updateCharacteristic(api.hap.Characteristic.Brightness, state.brightness);

			if (state.temperature) {
				service.updateCharacteristic(api.hap.Characteristic.ColorTemperature, state.temperature);
				service.updateCharacteristic(api.hap.Characteristic.Hue, 0);
				service.updateCharacteristic(api.hap.Characteristic.Saturation, 0);
			} else {
				service.updateCharacteristic(api.hap.Characteristic.Hue, state.hue);
				service.updateCharacteristic(api.hap.Characteristic.Saturation, state.saturation);
			}

			this.#log('next state', state);

			this.#currentState.next(state);
		});
	}

	init() {
		this.getSystemConfig();
		this.pollBulb();
	}

	#bulbConfig
	getSystemConfig() {
		// send a getSystemConfig message; the response will be routed back to us via
		// `handleConfig`
		this.#comm.sendTo(this.#ip, WizMessage.getSystemConfig);
	};

	handleConfig(config) {
		this.#log.debug('Got configuration', config);

		//TODO: should we register get events for these characteristics and poll on demand?
		this.#accessory.getService(this.#api.hap.Service.AccessoryInformation)
			.updateCharacteristic(this.#api.hap.Characteristic.Name, config.mac)
			.updateCharacteristic(this.#api.hap.Characteristic.SerialNumber, config.mac)
			.updateCharacteristic(this.#api.hap.Characteristic.Manufacturer, "Philips")
			.updateCharacteristic(this.#api.hap.Characteristic.Model, config.moduleName)
			.updateCharacteristic(this.#api.hap.Characteristic.FirmwareRevision, config.fwVersion);
	}

	#unsubUpdater;
	close() {
		if (this.#homekitUpdater) {
			this.#homekitUpdater.unsubscribe();
			this.#homekitUpdater = null;
		}
	}

	updateNetworkInfo(ip) {
		if (ip !== this.#ip) {
			this.#log.debug(`Got new IP for bulb ${this.#accessory.UUID}: ${ip}`);
			this.#ip = ip;
			this.#accessory.context.lastKnownIp = ip;
			this.#api.updatePlatformAccessories([ this.#accessory ]);
		}
	}

	getIp() {
		return this.#ip;
	}

	// poll the bulb for its current state
	pollBulb() {
		// send a getPilot message; the response should get routed back to us via `updateStatus`
		this.#comm.sendTo(this.#ip, WizMessage.getPilot);
	}

	// read current state from the bulb
	updateStatus(status) {
		this.#log.debug(status);
		// we need to translate this status to a homekit state
		const poweredOn = status.state.poweredOn;

		// bulb range is 10-100%, so adjust to HomeKit's 0-100% range
		const brightness = Math.max(((status.state.brightness ?? 0) - 10) * 100 / 90, 0);

		let hue = null, saturation = null, temperature = null;

		if (status.state.whiteTemperature) {
			// kelvin to mireds
			temperature = Math.trunc(1e6 / status.state.whiteTemperature);
		} else {
			const { h, s } = rgb2hsv(status.state.r, status.state.g, status.state.b);
			hue = h;
			saturation = s;
		}

		this.#bulbState.next({ poweredOn, brightness, hue, saturation, temperature });
	}

	handleAck(ack) {
		this.#log.debug(`[${this.#accessory.UUID}] received ack`, ack);
		this.#acks.next(ack);
	}
}

module.exports = WizLightbulb;
