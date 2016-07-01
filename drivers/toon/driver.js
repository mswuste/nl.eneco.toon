'use strict';

const Toon = require('node-toon');

let devices = [];
let temp_devices = [];

/**
 * Find Toon
 * @param devices (already installed)
 * @param callback
 */
module.exports.init = function (devices_data, callback) {

	// Loop over all installed devices and add them
	devices_data.forEach(function (device_data) {
		module.exports.setUnavailable(device_data, __("reconnecting"));
		initDevice(device_data);
	});

	// Start listening for changes
	startPolling();

	// Ready
	callback(null, true);
};

/**
 * Pairing process that calls list_devices when in need of all available Toon devices,
 * here the devices array is built and send to the front-end
 */
module.exports.pair = function (socket) {

	// Create new toon instance
	let client = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET);
	temp_devices = [];

	// Listen for the start event
	socket.on("start", function (data, callback) {

		// Start with fetching access tokens
		Homey.manager('cloud').generateOAuth2Callback(`https://api.toonapi.com/authorize?response_type=code&client_id=${Homey.env.TOON_KEY}&redirect_uri=https://callback.athom.com/oauth2/callback/`,

			// Before fetching authorization code
			function (err, result) {
				callback(err, result);
			},

			// After fetching authorization code
			function (err, result) {

				// Get new access and refresh token
				client.getAccessTokens(result, "https://callback.athom.com/oauth2/callback/", function (err, result) {

					// Get all devices hooked up to this account
					client.getAgreements((err, results) => {
						if (!err && results != null && results.length > 0) {

							// Loop over agreements
							results.forEach((data) => {

								// Check if device is not added already
								if (!getDevice(data.agreementId)) {

									// Store access token in settings
									Homey.manager("settings").set(`toon_${data.agreementId}_access_token`, result.access_token);
									Homey.manager("settings").set(`toon_${data.agreementId}_refresh_token`, result.refresh_token);

									// Store device temporarily
									temp_devices.push({
										name: "Toon",
										data: {
											id: data.agreementId
										}
									});
								}
							});
						}

						// Emit authenticated to the front-end
						socket.emit("authenticated", result.access_token);
					});
				});
			}
		);
	});

	// Show list of devices
	socket.on("list_devices", (data, callback) => {

		// Return results
		callback(null, temp_devices);
	});

	// Pairing done
	socket.on('disconnect', () => {
		temp_devices = [];
	})
};

/**
 * These functions represent the capabilities of Toon
 */
module.exports.capabilities = {

	target_temperature: {

		get: function (device_data, callback) {
			if (device_data instanceof Error) return callback(device_data);

			// Get device
			let device = getDevice(device_data);

			// Check if found
			if (device && device.client) {

				// Fetch target temperature from api
				callback(null, device.client.target_temperature);
			}
			else {

				// Return error
				callback(true, null);
			}
		},

		set: function (device_data, temperature, callback) {
			if (device_data instanceof Error) return callback(device_data);

			// Get device
			let device = getDevice(device_data);

			// Check if found
			if (device && device.client) {

				// Set temperature via api
				device.client.setTargetTemperature(Math.round(temperature * 2) / 2, function (err, result) {
					callback(err, result);
				});
			}
			else {

				// Return error
				callback(true, null);
			}
		}
	},

	measure_temperature: {

		get: function (device_data, callback) {
			if (device_data instanceof Error) return callback(device_data);

			// Get device
			let device = getDevice(device_data);

			// Check if found
			if (device && device.client) {

				// Fetch measured temperature
				callback(null, device.client.measure_temperature);
			}
			else {

				// Return error
				callback(true, null);
			}
		}
	}
};

/**
 * Toon doesn't support realtime, therefore we have to poll
 * for changes considering the measured and target temperature
 */
function startPolling() {

	// Poll every 20 seconds
	setInterval(function () {

		// Loop over the devices
		devices.forEach(device => {

			if (device && device.client) {

				// Check for updated target temperature
				device.client.getTargetTemperature((err, result) => {
					var updatedTemperature = result / 100;

					// If updated temperature is not equal to prev temperature
					if (device.client.target_temperature && updatedTemperature != device.client.target_temperature) {

						// Do a realtime update
						module.exports.realtime(device.data, "target_temperature", updatedTemperature);
					}

					// And store updated value
					device.client.target_temperature = result / 100;
				});

				// Check for updated measured temperature
				device.client.getMeasureTemperature((err, result) => {
					var updatedTemperature = result / 100;

					// If updated temperature is not equal to prev temperature
					if (device.client.measure_temperature && updatedTemperature != device.data.measure_temperature) {

						// Do a realtime update
						module.exports.realtime(device.data, "measure_temperature", updatedTemperature);
					}

					// And store updated value
					device.data.measure_temperature = result / 100;
				});
			}
		});
	}, 15000);
}

/**
 * Adds a new device and initializes
 * it and its client.
 * @param device_data
 * @param callback
 */
module.exports.added = function (device_data, callback) {

	// Init newly added device
	initDevice(device_data);

	// Callback success
	callback(null, true);
};

/**
 * Delete devices internally when users removes one
 * @param device_data
 */
module.exports.deleted = function (device_data) {

	// Reset array with device removed
	devices = devices.filter(function (device) {
		return device.data.id !== device_data.id
	});
};

/**
 * Initializes a device, based on device_data
 * @param device_data
 */
function initDevice(device_data) {

	// Create new toon instance
	var client = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET);

	// Fetch stored access tokens and store them in toon object
	if (Homey.manager('settings').get(`toon_${device_data.id}_access_token`)) client.access_token = Homey.manager('settings').get(`toon_${device_data.id}_access_token`);
	if (Homey.manager('settings').get(`toon_${device_data.id}_refresh_token`)) client.refresh_token = Homey.manager('settings').get(`toon_${device_data.id}_refresh_token`);

	// Get agreements from client
	client.getAgreements((err, results) => {
		if (!err && results) {

			// Loop over results
			results.forEach(function (data) {

				// Check if agreementId is device id
				if (data.agreementId === device_data.id) {

					// Store newly set agreement
					client.setAgreement(data.agreementId);

					// Store constructed device
					devices.push({
						name: "Toon",
						data: {
							id: device_data.id
						},
						client: client
					});

					// Set available again
					module.exports.setAvailable(device_data);

					// TODO add insights logging for electicity and gas usage
					// TODO add pushEvent instead of polling
					// Homey.manager('insights').createLog( 'electricity_usage', {
					// 	label: {
					// 		en: 'Electricity Usage'
					// 	},
					// 	type: 'number',
					// 	units: {
					// 		en: 'kWh'
					// 	},
					// 	decimals: 2,
					// 	chart: 'stepLine' // prefered, or default chart type. can be: line, area, stepLine, column, spline, splineArea, scatter
					// }, function callback(err , success){
					// 	if( err ) return Homey.error(err);
					// 	Homey.manager('insights').createEntry( 'power_usage', 9, new Date(), function(err, success){
					// 		if( err ) return Homey.error(err);
					// 	})
					// });
				}
			});
		}
	});
}

/**
 * Gets a device based on an id
 * @param device_data
 * @returns {*}
 */
function getDevice(device_data) {

	// If only id provided
	if (typeof device_data != "object") device_data = { id: device_data };

	// Loop over devices
	return devices.find(function (device) {
		return device.data.id === device_data.id;
	});
}