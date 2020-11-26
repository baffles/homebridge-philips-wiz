"use strict";

const NetworkConfig = require('./config/NetworkConfig');
const WizCommunication = require('./communication/WizCommunication');
const WizMessage = require('./data/WizMessage');
const WizPilotBuilder = require('./data/WizPilotBuilder');
const WizLightbulb = require('./WizLightbulb');

class WizPlatform {
	#api;
	#log;
	#networkConfig;
	#communication;

	constructor(log, config, api) {

		this.#api = api
		this.#log = log

		//TODO: better error handling
		if ('interface' in config) {
			log.info(`Using interface ${config.interface}`);
			this.#networkConfig = new NetworkConfig.InterfaceNetworkConfig(config.interface);
		} else if ('network' in config) {
			log.info(`Using network ${config.network}`);
			this.#networkConfig = new NetworkConfig.SubnetNetworkConfig(config.network);
		} else {
			log.info('Using default network settings');
			this.#networkConfig = NetworkConfig.DefaultNetworkConfig;
		}

		log.debug(`Address: ${this.#networkConfig.getAddress()}; Broadcast: ${this.#networkConfig.getBroadcastAddress()}; MAC: ${this.#networkConfig.getMac()}`);

		this.#communication = new WizCommunication(log, this.#networkConfig, config.serverPort ?? 38900, config.clientPort ?? 38899);

		api.on('didFinishLaunching', () => {
			log.info(`Starting Philips Wiz with ${config.devices?.length ?? 0} pre-configured devices...`);
			log.debug("hi!")

			this.#communication.init();
		});

		api.on('shutdown', () => {
			log.info('Shutting down Philips Wiz');
			this.#communication.close();
		})

		// sequence with bacon?
		this.#communication.on('ready', () => {
			const discoveryFreq = config.discoveryFreq ?? 300000; // every 5 minutes
			const pollFreq = config.pollFreq ?? 0; // by default, get push updates
			const broadcastPoll = config.broadcastPoll ?? false; // by default, ping each bulb individually

			// register with 'true' if we aren't polling (so the bulbs will send us updates)
			const registration = WizMessage.registration(this.#networkConfig, pollFreq <= 0)

			log.debug('Communication layer ready! Running initial discovery...');
			this.#communication.broadcast(registration);
			
			log.debug(`Sending registration to ${config.devices?.length ?? 0} pre-configured devices...`);

			if (config.devices) {
				for (const ip of config.devices) {
					this.#communication.sendTo(ip, registration);
				}
			}

			// also, send to last known IPs?
			for (const [id, bulb] of Object.entries(this.#accessoriesById)) {
				console.dir(bulb);
				if (bulb.ip) {
					this.#communication.sendTo(bulb.ip, registration);
				}
			}

			// if we're going to periodically re-discover, set that up
			if (discoveryFreq > 0) {
				log.info(`Running discovery at an interval of ${discoveryFreq} ms...`);

				const interval = setInterval(() => {
					const registration = WizMessage.registration(this.#networkConfig, pollFreq <= 0)
					this.#communication.broadcast(registration);
				}, discoveryFreq);

				api.on('shutdown', () => clearInterval(interval));
			}

			// if we're polling, set that up
			if (pollFreq > 0) {
				log.info(`Polling bulbs at an interval of ${pollFreq} ms...`);

				const interval = setInterval(() => {
					if (broadcastPoll) {
						this.#communication.broadcast(WizMessage.getPilot);
					} else {
						for (const [id, bulb] of Object.entries(this.#accessoriesById)) {
							bulb.pollBulb();
						}
					}
				}, pollFreq);

				api.on('shutdown', () => clearInterval(interval));
			}
		})

		this.#communication.on('registration', this.handleBulbRegistration.bind(this));
		this.#communication.on('ack', this.handleAck.bind(this));
		this.#communication.on('bulbStatus', this.handleBulbStatus.bind(this));
		this.#communication.on('systemConfig', this.handleSystemConfig.bind(this));
	}


	#accessoriesById = {}
	#accessoriesByMac = {}
	#accessoriesByIp = {}

	// homebridge calls this to register a cached accessory with us
	configureAccessory(accessory) {
		this.#accessoriesById[accessory.UUID] = new WizLightbulb(this, accessory, this.#api, this.#log, this.#communication);
	}

	// handler for registration events - add and update bulbs as applicable
	handleBulbRegistration(reg) {
		const id = this.#api.hap.uuid.generate(reg.mac);

		if (!(id in this.#accessoriesById)) {
			this.#log.debug(`got new bulb [${id}]: ip=${reg.ip} mac=${reg.mac}`);

			const accessory = new this.#api.platformAccessory(reg.mac, id);
			const bulb = new WizLightbulb(this, accessory, this.#api, this.#log, this.#communication);

			this.#accessoriesById[id] = bulb;
			this.#accessoriesByMac[reg.mac] = bulb;
			this.#accessoriesByIp[reg.ip] = bulb;
			bulb.updateNetworkInfo(reg.ip);
			bulb.init();

			this.#api.registerPlatformAccessories('homebridge-philips-wiz', 'PhilipsWiz', [ accessory ]);
		} else {
			this.#log.debug(`got registration for already-known bulb [${id}]: ip=${reg.ip} mac=${reg.mac}`);

			const bulb = this.#accessoriesById[id];
			const lastIp = bulb.getIp();

			if (!(reg.ip in this.#accessoriesByIp) || reg.ip != lastIp) {
				delete this.#accessoriesByIp[lastIp];
				this.#accessoriesByMac[reg.mac] = bulb;
				this.#accessoriesByIp[reg.ip] = bulb;
				bulb.updateNetworkInfo(reg.ip);
				bulb.init();
			}
		}
	}

	handleAck(ack) {
		// we address acks by IP, not expecting an IP change/clash in the short timeframe of waiting for an ack
		this.#accessoriesByIp[ack.ip]?.handleAck(ack);
	}

	handleBulbStatus(status) {
		// address bulb status updates by mac address
		this.#accessoriesByMac[status.mac]?.updateStatus(status);
	}

	handleSystemConfig(cfg) {
		// address system config responses by mac address
		this.#accessoriesByMac[cfg.mac]?.handleConfig(cfg.config);
	}
}

module.exports = (api) => {
	api.registerPlatform('PhilipsWiz', WizPlatform);
};
