"use strict";

const ip = require('ip');
const os = require('os');

class NetworkConfig {
	getInterface() {
		return null;
	}

	getAddressDetails() {
		return this.getInterface()?.filter(addr => addr.family === 'IPv4')[0];
	}

	getBroadcastAddress() {
		let details = this.getAddressDetails();
		if (!details) return null;

		let cidr = ip.cidrSubnet(details.cidr);
		return cidr.broadcastAddress;
	}

	getAddress() {
		return this.getAddressDetails()?.address;
	}

	getMac() {
		return this.getAddressDetails()?.mac;
	}
}

class DefaultNetworkConfig extends NetworkConfig {
	getAddressDetails() {
		// just grab the first non-local address
		return Object.entries(os.networkInterfaces()).flatMap(iface => iface[1]).filter(addr => addr.family === 'IPv4' && !addr.internal)[0];
	}

	getBroadcastAddress() {
		// blast everywhere
		return '255.255.255.255';
	}
}

class InterfaceNetworkConfig extends NetworkConfig {
	interfaceName;

	constructor(interfaceName) {
		super();
		this.interfaceName = interfaceName;
	}

	getInterface() {
		return os.networkInterfaces()[this.interfaceName];
	}
}

class SubnetNetworkConfig extends NetworkConfig {
	networkAddress;

	constructor(subnetSpecifier) {
		super();

		try {
			this.networkAddress = ip.cidrSubnet(subnetSpecifier).networkAddress;
		} catch {
			this.networkAddress = subnetSpecifier;
		}
	}

	getInterface() {
		// find interface by the subnet specifier (either network address or cidr)

		for (const [name, iface] of Object.entries(os.networkInterfaces())) {
			let ipv4 = iface.filter(addr => addr.family === 'IPv4')[0];
			let cidr = ip.cidrSubnet(ipv4.cidr);

			if (cidr.networkAddress === this.networkAddress) {
				return iface;
			}
		}

		return null;
	}
}

module.exports.DefaultNetworkConfig = new DefaultNetworkConfig;
module.exports.InterfaceNetworkConfig = InterfaceNetworkConfig;
module.exports.SubnetNetworkConfig = SubnetNetworkConfig;
