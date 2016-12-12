'use strict';

/**
 * TODO refreshing tokens on api cal/interval
 * TODO check gas/electricity flow cards
 */

const Toon = require('node-toon');
const Log = require('homey-log').Log;

let devices = [];
let tempDevices = [];

/**
 * Find Toon
 * @param devicesData (already installed)
 * @param callback
 */
module.exports.init = (devicesData, callback) => {

	const initializations = [];

	if (devicesData) {

		// Loop over all installed devices and add them
		devicesData.forEach(deviceData => {

			// Mark device unavailable
			module.exports.setUnavailable(deviceData, __('reconnecting'));

			// Init device
			initializations.push(initDevice(deviceData));
		});
	}

	Promise.all(initializations)
		.then(() => callback(null, true))
		.catch(err => callback(err));
};

/**
 * Pairing process that calls list_devices when in need of all available Toon devices,
 * here the devices array is built and send to the front-end.
 */
module.exports.pair = socket => {

	// Create new toon instance
	const client = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET);

	tempDevices = [];

	// Listen for the start event
	socket.on('start', (data, callback) => {

		// Start with fetching access tokens
		Homey.manager('cloud').generateOAuth2Callback(`https://api.toonapi.com/authorize?response_type=code&client_id=${Homey.env.TOON_KEY}&redirect_uri=https://callback.athom.com/oauth2/callback/`,

			// Before fetching authorization code
			(err, url) => {
				if (err) console.error(err, 'Toon: error fetching authorization url');
				else console.log('Toon: success fetching authorization url');
				callback(err, url);
			},

			// After fetching authorization code
			(err, code) => {
				if (err) console.error(err, 'Toon: Error fetching authorization code');
				else console.log('Toon: success fetching authorization code');

				// Get new access and refresh token
				client.getAccessTokens(code, 'https://callback.athom.com/oauth2/callback/').then(tokens => {
					if (!err && tokens && tokens.hasOwnProperty('access_token') && tokens.hasOwnProperty('refresh_token')) {

						console.log('Toon: storing access tokens');

						// Get all devices hooked up to this account
						client.getAgreements().then(agreements => {
							if (agreements != null && agreements.length > 0) {

								// Loop over agreements
								agreements.forEach(agreement => {

									// Check if device is not added already and is valid
									if (agreement.hasOwnProperty('agreementId')
										&& agreement.hasOwnProperty('displayCommonName')
										&& !getDevice(agreement.displayCommonName)) {

										// Store access token in settings
										Homey.manager('settings').set(`toon_${agreement.displayCommonName}_access_token`, tokens.access_token);
										Homey.manager('settings').set(`toon_${agreement.displayCommonName}_refresh_token`, tokens.refresh_token);

										// Store device temporarily
										tempDevices.push({
											name: (agreements.length > 1) ? `Toon®: ${agreement.street} 
												${agreement.houseNumber} , ${agreement.postalCode} 
												${agreement.city.charAt(0)}${agreement.city.slice(1).toLowerCase()}` : 'Toon®',
											data: {
												id: agreement.displayCommonName,
												agreementId: agreement.agreementId
											}
										});
									}
								});
							} else console.error('Toon: error getting agreements', err);

							// Emit authenticated to the front-end
							socket.emit('authenticated', tokens.access_token);

						}).catch(err => {
							console.error('Toon: error getting agreements', err);
						});
					} else if (callback) {
						console.error('Toon: failed to fetch access tokens when pairing', err);
						callback(true, false);
					}
				}).catch(err => {
					console.error(err, 'Toon: failed to fetch access tokens when pairing');

					if (callback) callback(true, false);
				});
			}
		);
	});


	// Show list of devices
	socket.on('list_devices', (data, callback) => callback(null, tempDevices));

	// Pairing done
	socket.on('disconnect', () => {
		tempDevices = [];
	});
};

/**
 * These functions represent the capabilities of Toon
 */
module.exports.capabilities = {

	target_temperature: {

		get: (deviceData, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device
			const device = getDevice(deviceData);

			// Check if found
			if (device && device.state && device.state.targetTemperature)
				return callback(null, device.state.targetTemperature);

			// Return error
			return callback(true, null);
		},

		set: (deviceData, temperature, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device
			const device = getDevice(deviceData);

			// Check if found
			if (device && device.client && temperature) {

				// Set temperature via api
				device.client.setTargetTemperature(Math.round(temperature * 2) / 2)
					.then(() => callback(null, temperature))
					.catch(err => callback(err));
			} else {

				// Return error
				return callback(true, null);
			}
		},
	},

	measure_temperature: {

		get: (deviceData, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device
			const device = getDevice(deviceData);

			// Check if found
			if (device && device.state && device.state.measureTemperature)
				return callback(null, device.state.measureTemperature);

			// Return error
			return callback(true, null);
		},
	},

	meter_gas: {

		get: (deviceData, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device
			const device = getDevice(deviceData);

			// Check if found
			if (device && device.state && typeof device.state.meterGas !== 'undefined')
				return callback(null, device.state.meterGas);

			// Return error
			return callback(true, null);
		},
	},

	meter_power: {

		get: (deviceData, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device
			const device = getDevice(deviceData);

			// Check if found
			if (device && device.state && typeof device.state.meterPower !== 'undefined')
				return callback(null, device.state.meterPower);

			// Return error
			return callback(true, null);
		},
	},
};

/**
 * Adds a new device and initializes
 * it and its client.
 * @param deviceData
 * @param callback
 */
module.exports.added = (deviceData, callback) => {
	if (deviceData) {

		// Init newly added device
		initDevice(deviceData);

		// Mark first as connecting
		module.exports.setUnavailable(deviceData, __('connecting'));

		// Callback success
		return callback(null, true);
	}

	return callback('no_device_data');
};

/**
 * Delete devices internally when users removes one
 * @param deviceData
 */
module.exports.deleted = (deviceData) => {
	devices = devices.filter(device => {
		if (device.data.id === deviceData.id && device.client) {

			// Store access token in settings
			Homey.manager('settings').unset(`toon_${deviceData.id}_access_token`);
			Homey.manager('settings').unset(`toon_${deviceData.id}_refresh_token`);

			device.client.destroy();
		}
		return device.data !== deviceData;
	});
};

/**
 * Initializes a device, based on device_data
 * @param deviceData
 */
function initDevice(deviceData) {
	return new Promise((resolve, reject) => {

		// Create new toon instance
		const client = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET);

		// Listen for refresh event
		client
			.on('refreshed', tokens => {

				console.log('Toon: storing refreshed access tokens');

				// Store access token in settings
				Homey.manager('settings').set(`toon_${deviceData.id}_access_token`, tokens.access_token);
				Homey.manager('settings').set(`toon_${deviceData.id}_refresh_token`, tokens.refresh_token);

				// Listen for init event
			})
			.on('initialized', data => {

				// Get device object to store data
				const device = getDevice(deviceData);
				if (device) {
					if (!device.state.targetTemperature && data) device.state.targetTemperature = data.targetTemperature;
					if (!device.state.measureTemperature && data) device.state.measureTemperature = data.measureTemperature;
					if (!device.state.meterGas && data) device.state.meterGas = data.meterGas;
					if (!device.state.meterPower && data) device.state.meterPower = data.meterPower;
				}

				console.log(device.state);

				// Mark device as available
				module.exports.setAvailable(deviceData);

				console.log('Toon: device is initialized with data and available');

				return resolve();
			})
			.on('measureTemperature', measureTemperature => {
				console.log('Toon: new measureTemperature', measureTemperature);
				const device = getDevice(deviceData);
				device.state.measureTemperature = measureTemperature;
				module.exports.realtime(deviceData, 'measure_temperature', device.state.measureTemperature);
			})
			.on('targetTemperature', targetTemperature => {
				console.log('Toon: new targetTemperature', targetTemperature);
				const device = getDevice(deviceData);
				device.state.targetTemperature = targetTemperature;
				module.exports.realtime(deviceData, 'target_temperature', device.state.targetTemperature);
			})
			.on('meterGas', meterGas => {
				console.log('Toon: new meterGas', meterGas);
				const device = getDevice(deviceData);
				device.state.meterGas = meterGas;
				module.exports.realtime(deviceData, 'meter_gas', device.state.meterGas);
			})
			.on('meterPower', meterPower => {
				console.log('Toon: new meterPower', meterPower);
				const device = getDevice(deviceData);
				device.state.meterPower = meterPower;
				module.exports.realtime(deviceData, 'meter_power', device.state.meterPower);
			});

		// Fetch stored access tokens and store them in toon object
		if (Homey.manager('settings').get(`toon_${deviceData.id}_access_token`))
			client.accessToken = Homey.manager('settings').get(`toon_${deviceData.id}_access_token`);
		if (Homey.manager('settings').get(`toon_${deviceData.id}_refresh_token`))
			client.refreshToken = Homey.manager('settings').get(`toon_${deviceData.id}_refresh_token`);

		console.log('Toon: initializing device...');

		// Store constructed device
		devices.push({
			data: deviceData,
			state: {},
			client: client,
		});

		// Get agreements from client
		client.getAgreements().then(agreements => {
			if (agreements) {

				console.log('Toon: got agreements');

				// Loop over results
				agreements.forEach(agreement => {

					// Check if agreementId is device id
					if (agreement && agreement.hasOwnProperty('agreementId') && agreement.agreementId === deviceData.agreementId) {

						console.log(`Toon: setting agreement -> ${agreement.agreementId}`);

						// Store newly set agreement
						client.setAgreement(agreement.agreementId).then(() => {
							console.log('Toon: device initialisation done');
							resolve();
						}).catch(err => {
							console.error('Toon: setting agreement failed', err);
						});
					}
				});
			} else {
				console.error('Toon: failed to get agreements');
				return reject('Toon: failed to get agreements');
			}
		}).catch(err => {
			console.error('Toon: failed to get agreements', err);
			return reject('Toon: failed to get agreements', err);
		});
	});
}

/**
 * Gets a device based on an id
 * @param deviceData
 * @returns {*}
 */
function getDevice(deviceData) {

	// If only id provided
	if (typeof deviceData !== 'object') deviceData = { id: deviceData };

	// Loop over devices
	return devices.find(device => device.data.id === deviceData.id);
}
