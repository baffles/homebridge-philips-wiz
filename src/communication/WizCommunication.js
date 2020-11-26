"use strict";

const dgram = require('dgram');
const EventEmitter = require('events');

const WizPilotParser = require('../data/WizPilotParser');

/**
 * This handles incoming Wiz data packets - namely those from a discovery broadcast/registration
 * event and event updates from devices that we have registered for periodic updates from. In the
 * case that we are configured to poll devices instead, this communication channel will not be
 * utilized.
 */
class WizCommunication extends EventEmitter {
	#log
	#config
	#serverPort
	#clientPort

	#socket
	#socketBound = false

	constructor(log, config, serverPort = 38900, clientPort = 38899) {
		super();

		this.#log = log;
		this.#config = config;
		this.#serverPort = serverPort;
		this.#clientPort = clientPort;
	}

	init() {
		let socket = this.#socket = dgram.createSocket('udp4');

		socket.on('error', err => {
			this.#log.error('UDP socket error', err);
			this.emit('error', err);
		});

		socket.on('listening', () => {
			const address = socket.address();
			this.#log.debug(`Listening on ${address.address}:${address.port}`);
		});

		socket.on('message', (msgBuf, client) => {
			// incoming message is just UTF-8 JSON
			let msgStr = msgBuf.toString('utf8');
			this.#log.debug(`Received from ${client.address}: ${msgStr}`);

			try {
				let msg = JSON.parse(msgStr);

				if ('error' in msg) {
					// error message
					this.#log.debug(`Received error response from ${client.address}: ${msg.error?.message}`);
					this.emit('ack', { ip: client.address, success: false, error: msg.error });
				} else {
					switch (msg.method) {
						case 'registration': {
							// registration message, we know of a potentially new bulb
							this.#log.debug(`Received registration from ${client.address} [${msg.result.mac}]`);
							this.emit('registration', { ip: client.address, mac: msg.result.mac });
							break;
						}
						
						case 'syncPilot': {
							// update pushed to us from a bulb
							const state = WizPilotParser(msg.params);
							this.#log.debug(`Received syncPilot from ${client.address} [${msg.params.mac}]: RSSI=${msg.params.rssi}, state=${state}`);
							this.emit('bulbStatus', { ip: client.address, mac: msg.params.mac, rssi: msg.params.rssi, state: state });
							break;
						}
						
						case 'getPilot': {
							// getPilot response
							const state = WizPilotParser(msg.result);
							this.#log.debug(`Received getPilot response from ${client.address} [${msg.result.mac}]: RSSI=${msg.result.rssi}, state=${state}`);
							this.emit('bulbStatus', { ip: client.address, mac: msg.result.mac, rssi: msg.result.rssi, state: state });
							break;
						}
						
						case 'setPilot': {
							// a setPilot command we went came back
							this.#log.debug(`Received setPilot success response from ${client.address}`);
							this.emit('ack', { ip: client.address, success: true });
							//  Received from 192.168.201.44: {"method":"setPilot","env":"pro","error":{"code":-32602,"message":"Invalid params"}}
							//  Received from 192.168.201.44: {"method":"setPilot","env":"pro","result":{"success":true}}
							this.#log.debug(msg);
							break;
						}

						case 'getSystemConfig': {
							this.#log.debug(`Received getSystemConfig response from ${client.address} [${msg.result.mac}]: ${msg.result}`);
							this.emit('systemConfig', { ip: client.address, mac: msg.result.mac, config: msg.result });
							break;
						}
						
						default: {
							// unknown
							this.#log.error(`Received unknown '${msg.method}' message from ${client.address}`, msg);
							break;
						}
					}
				}
			} catch (e) {
				this.#log.error(`Error processing received message from ${client.address}: ${msgStr}`);
				this.emit('error', e);
			}
		});

		socket.bind({ address: this.#config.getAddress(), port: this.#serverPort }, () => {
			this.#socketBound = true;

			// we will need to be able to broadcast
			this.#socket.setBroadcast(true);

			// _now_ we are ready
			this.emit('ready');
		});
	}

	close() {
		if (this.#socketBound) {
			try {
				this.#socket.close();
			} catch (e) {
				this.log.error(`Error closing socket`, e);
			}
			this.#socket = null;
			this.#socketBound = false;
		}
	}

	broadcast(msg) {
		if (this.#socketBound) {
			this.#log.debug(`Broadcasting to ${this.#config.getBroadcastAddress()}:${this.#clientPort}: ${msg}`);
			this.#socket.send(msg, this.#clientPort, this.#config.getBroadcastAddress(), err => {
				if (err) {
					this.#log.error(`error sending broadcast`, err);
					this.emit('error', err);
				}
			});
		} else {
			throw 'socket not bound';
		}
	}

	sendTo(ip, msg) {
		if (this.#socketBound) {
			this.#log.debug(`Sending directly to ${ip}:${this.#clientPort}: ${msg}`);
			this.#socket.send(msg, this.#clientPort, ip, err => {
				if (err) {
					this.#log.error(`error sending directed message`, err);
					this.emit('error', err);
				}
			});
		} else {
			throw 'socket not bound';
		}
	}
}

module.exports = WizCommunication;
