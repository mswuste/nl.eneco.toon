'use strict';

const Toon = require('node-toon');

let devices = [];
let tempDevices = [];
let registerInterval = undefined;

/**
 * Find Toon
 * @param devicesData (already installed)
 * @param callback
 */
module.exports.init = (devicesData, callback) => {

	// Loop over all installed devices and add them
	devicesData.forEach(deviceData => {

		// Mark device unavailable
		module.exports.setUnavailable(deviceData, __('reconnecting'));

		// Init device
		initDevice(deviceData);
	});

	// Refresh tokens for each device
	refreshTokenInterval();

	// Start listening for events
	listenForEvents();

	// Create electricity usage insights log
	Homey.manager('insights').createLog('electricity_usage', {
		label: {
			en: 'Electricity Usage',
			nl: 'Elektriciteitsverbruik'
		},
		type: 'number',
		units: {
			en: 'Watt'
		},
		decimals: 2,
		chart: 'line'
	});

	// Create gas uasge insights log
	Homey.manager('insights').createLog('gas_usage', {
		label: {
			en: 'Gas Usage',
			nl: 'Gasverbruik'
		},
		type: 'number',
		units: {
			en: 'm\u00B3'
		},
		decimals: 2,
		chart: 'line'
	});

	// Ready
	callback(null, true);
};

/**
 * Pairing process that calls list_devices when in need of all available Toon devices,
 * here the devices array is built and send to the front-end.
 */
module.exports.pair = socket => {

	// Create new toon instance
	const client = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET, Homey.env.TOON_WEBHOOK_URL);

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
				client.getAccessTokens(code, 'https://callback.athom.com/oauth2/callback/', (err, tokens) => {
					if (!err && tokens && tokens.hasOwnProperty('access_token') && tokens.hasOwnProperty('refresh_token')) {

						console.log('Toon: storing access tokens');

						// Get all devices hooked up to this account
						client.getAgreements((err, agreements) => {
							if (!err && agreements != null && agreements.length > 0) {

								// Loop over agreements
								agreements.forEach((agreement) => {

									// Check if device is not added already and is valid
									if (agreement.hasOwnProperty('agreementId')
										&& agreement.hasOwnProperty('displayCommonName')
										&& !getDevice(agreement.displayCommonName)) {

										// Store access token in settings
										Homey.manager('settings').set(`toon_${agreement.displayCommonName}_access_token`, tokens.access_token);
										Homey.manager('settings').set(`toon_${agreement.displayCommonName}_refresh_token`, tokens.refresh_token);

										// Store device temporarily
										tempDevices.push({
											name: (agreements.length > 1) ? `Toon: ${agreement.street} 
										${agreement.houseNumber} , ${agreement.postalCode} 
										${agreement.city.charAt(0)}${agreement.city.slice(1).toLowerCase()}` : 'Toon',
											data: {
												id: agreement.displayCommonName,
												agreementId: agreement.agreementId
											},
										});
									}
								});
							} else console.error(err, 'Toon: error getting agreements');

							// Emit authenticated to the front-end
							socket.emit('authenticated', tokens.access_token);
						});
					} else if (callback) {
						console.error(err, 'Toon: failed to fetch access tokens when pairing');
						callback(true, false);
					}
				});
			}
		);
	});


	// Show list of devices
	socket.on('list_devices', (data, callback) => {

		// Return results
		callback(null, tempDevices);
	});

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
			if (device && device.state.targetTemperature) {
				callback(null, device.state.targetTemperature);
			} else {

				// Return error
				callback(true, null);
			}
		},

		set: (deviceData, temperature, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device
			const device = getDevice(deviceData);

			// Check if found
			if (device && device.client && temperature) {

				// Set temperature via api
				device.client.setTargetTemperature(Math.round(temperature * 2) / 2, (err, result) => {
					callback(err, result);
				});
			} else {

				// Return error
				callback(true, null);
			}
		},
	},

	measure_temperature: {

		get: (deviceData, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device
			const device = getDevice(deviceData);

			// Check if found
			if (device && device.state.measureTemperature) {
				callback(null, device.state.measureTemperature);
			} else {

				// Return error
				callback(true, null);
			}
		},
	},
};

/**
 * Adds a new device and initializes
 * it and its client.
 * @param device_data
 * @param callback
 */
module.exports.added = (deviceData, callback) => {

	if (deviceData) {

		// Init newly added device
		initDevice(deviceData);

		// Mark first as connecting
		module.exports.setUnavailable(deviceData, __('connecting'));

		// Callback success
		callback(null, true);
	} else callback(true, false);
};

/**
 * Delete devices internally when users removes one
 * @param device_data
 */
module.exports.deleted = (deviceData) => {

	// Reset array with device removed and deregister push event subscription
	devices = devices.filter(device => {
		if (device.data.id === deviceData.id && device.client) device.client.deregisterPushEvent();
		return device.data.id !== deviceData.id;
	});
};

/**
 * Refresh token after 20 minutes to make sure we always
 * have a valid access token ready.
 */
function refreshTokenInterval() {

	setInterval(() => {

		// Refresh access tokens
		refreshAccessTokens();

	}, 20 * 60 * 1000);
}

/**
 * Refreshes the access tokens for
 * all devices.
 */
function refreshAccessTokens() {

	console.log('Toon: start refreshing tokens for all devices');

	// Loop over the devices
	devices.forEach(device => {

		// Check valid device
		if (device && device.client && device.client.refreshToken) {

			// Fetch new tokens
			device.client.refreshAccessToken((err, tokens) => {

				// Check if refresh succeeded
				if (err || !tokens || !tokens.hasOwnProperty('access_token') || !tokens.hasOwnProperty('refresh_token')) {
					console.error(err, 'Toon: failed to refresh access tokens');
				}
			});
		}
	});
}

function startRegisteringPushEvent(device) {

	// Clear existing interval
	if (registerInterval) return;

	console.log('Toon: re-register push events');

	registerInterval = setInterval(() => {
		if (device) {
			if (device.client) {
				device.client.deregisterPushEvent(() => {
					device.client.setAgreement(device.data.agreementId, () => {
						device.client.registerPushEvent();
					});
				});
			}
		} else {
			devices.forEach(storedDevice => {
				if (storedDevice && storedDevice.client) {
					storedDevice.client.deregisterPushEvent(() => {
						storedDevice.client.setAgreement(storedDevice.data.agreementId, () => {
							storedDevice.client.registerPushEvent();
						});
					});
				}
			});
		}
	}, 10000);
}

/**
 * Register webhook and listen for
 * calls to it.
 */
function listenForEvents() {

	// Register webhook and listen for incoming events
	Homey.manager('cloud').registerWebhook(Homey.env.TOON_WEBHOOK_ID, Homey.env.TOON_WEBHOOK_SECRET, {},
		data => {

			// Check if data and body is provided
			if (data && data.body) {

				console.log(`Toon: incoming pushEvent data ${data.body.timeToLiveSeconds}`);

				// If subscription has ended, restart subscription for all clients
				if (typeof data.body.timeToLiveSeconds === 'undefined') {
					startRegisteringPushEvent();
				}

				// Get device
				const device = getDevice(data.body.commonName);
				if (device) {

					// Re-register push event when TTL is less than 15
					if (data.body.timeToLiveSeconds <= 15) {
						setTimeout(() => {
							startRegisteringPushEvent(device);
						}, 30000);
					}

					// Check for valid incoming data
					if (data.body.updateDataSet && data.body.updateDataSet.thermostatInfo) {

						// Reset interval
						clearInterval(registerInterval);
						registerInterval = null;

						console.log('Toon: found new thermostat info');

						// Emit init event
						if (device.client && typeof device.state.targetTemperature === 'undefined') device.client.emit('initialized');

						// Check if setpoint is provided
						if (data.body.updateDataSet.thermostatInfo.currentSetpoint) {

							// Format data
							let updatedTargetTemperature = data.body.updateDataSet.thermostatInfo.currentSetpoint;
							updatedTargetTemperature = Math.round((updatedTargetTemperature / 100) * 10) / 10;

							// If updated temperature is not equal to prev temperature
							if (device.state.targetTemperature && updatedTargetTemperature !== device.state.targetTemperature) {

								console.log(`Toon: emit realtime target_temperature event: ${updatedTargetTemperature}`);

								// Do a realtime update
								module.exports.realtime(device.data, 'target_temperature', updatedTargetTemperature);
							}

							// And store updated value
							device.state.targetTemperature = updatedTargetTemperature;
						}

						// Check if currentTemp is provided
						if (data.body.updateDataSet.thermostatInfo.currentTemp) {

							// Format data
							let updatedMeasureTemperature = data.body.updateDataSet.thermostatInfo.currentTemp;
							updatedMeasureTemperature = Math.round((updatedMeasureTemperature / 100) * 10) / 10;

							// If updated temperature is not equal to prev temperature
							if (device.state.measureTemperature && updatedMeasureTemperature !== device.state.measureTemperature) {

								console.log(`Toon: emit realtime measure_temperature event: ${updatedMeasureTemperature}`);

								// Do a realtime update
								module.exports.realtime(device.data, 'measure_temperature', updatedMeasureTemperature);
							}

							// And store updated value
							device.state.measureTemperature = updatedMeasureTemperature;
						}

						// Check if gasUsage is provided
						if (data.body.updateDataSet.gasUsage) {
							const gasUsage = data.body.updateDataSet.gasUsage.value;

							// Create new gas usage entry
							Homey.manager('insights').createEntry('gas_usage', gasUsage, new Date(), err => {
								if (err) return Homey.error(err);
							});
						}

						// Check if gasUsage is provided
						if (data.body.updateDataSet.powerUsage) {
							const powerUsage = data.body.updateDataSet.powerUsage.value;

							// Create new electricity usage entry
							Homey.manager('insights').createEntry('electricity_usage', powerUsage, new Date(), err => {
								if (err) return Homey.error(err);
							});
						}
					}
				}
			}
		},
		(err, result) => {
			if (err) console.error(err, 'Toon: failed to setup webhook');
			else if (result) console.log('Toon: succes setting up webhook');
		}
	);
}

/**
 * Initializes a device, based on device_data
 * @param deviceData
 */
function initDevice(deviceData) {

	// Create new toon instance
	const client = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET, Homey.env.TOON_WEBHOOK_URL);

	// Listen for refresh event
	client.on('refreshed', tokens => {

		console.log('Toon: storing refreshed access tokens');

		// Store access token in settings
		Homey.manager('settings').set(`toon_${deviceData.id}_access_token`, tokens.access_token);
		Homey.manager('settings').set(`toon_${deviceData.id}_refresh_token`, tokens.refresh_token);

		// Listen for init event
	}).on('initialized', data => {

		// Get device object to store data
		const device = getDevice(deviceData);
		if (device) {
			if (!device.state.targetTemperature && data) device.state.targetTemperature = data.targetTemperature;
			if (!device.state.measureTemperature && data) device.state.measureTemperature = data.measureTemperature;
		}

		// Mark device as available
		module.exports.setAvailable(deviceData);

		console.log('Toon: device is initialized with data and available');
	});

	// Fetch stored access tokens and store them in toon object
	if (Homey.manager('settings').get(`toon_${deviceData.id}_access_token`)) {
		client.accessToken = Homey.manager('settings').get(`toon_${deviceData.id}_access_token`);
	}
	if (Homey.manager('settings').get(`toon_${deviceData.id}_refresh_token`)) {
		client.refreshToken = Homey.manager('settings').get(`toon_${deviceData.id}_refresh_token`);
	}

	console.log('Toon: initializing device...');

	// Store constructed device
	devices.push({
		data: deviceData,
		state: {},
		client: client,
	});

	// Get agreements from client
	client.getAgreements((err, agreements) => {
		if (!err && agreements) {

			console.log('Toon: got agreements');

			// Loop over results
			agreements.forEach(agreement => {

				// Check if agreementId is device id
				if (agreement && agreement.hasOwnProperty('agreementId') && agreement.agreementId === deviceData.agreementId) {

					console.log(`Toon: setting agreement -> ${agreement.agreementId}`);

					// Store newly set agreement
					client.setAgreement(agreement.agreementId, () => {

						console.log('Toon: device initialisation done');
					});
				}
			});
		} else console.error(err, 'Toon: failed to get agreements');
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
