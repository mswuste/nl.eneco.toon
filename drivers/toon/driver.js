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

	// Start polling for changes
	startPolling();

	// Start listening for events
	listenForEvents();

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
										name: (results.length > 1) ? `Toon: ${data.street} ${data.houseNumber} , ${data.postalCode} ${data.city.charAt(0)}${data.city.slice(1).toLowerCase()}` : "Toon",
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
			if (device && device.state.target_temperature) {
				callback(null, device.state.target_temperature);
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

					// Store updated temperature internally
					device.state.target_temperature = (Math.round(temperature * 2) / 2);

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
			if (device && device.state.measure_temperature) {
				callback(null, device.state.measure_temperature);
			}
			else {

				// Return error
				callback(true, null);
			}
		}
	}
};

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

	let device = getDevice(device_data);
	if (device && device.client) device.client.destroy();

	// Reset array with device removed
	devices = devices.filter(function (device) {
		return device.data.id !== device_data.id
	});
};

/**
 * Toon doesn't support realtime, therefore we have to poll
 * for changes considering the measured and target temperature
 */
function startPolling() {

	setInterval(function () {

		// Refresh access tokens
		refreshAccessTokens();

	}, 20 * 60 * 1000);

	// Poll every 20 seconds
	setInterval(function () {

		// Start fetching and updating data
		fetchAndUpdateData();

	}, 15000);
}

/**
 * Refreshes the access tokens for
 * all devices.
 */
function refreshAccessTokens() {

	// Loop over the devices
	devices.forEach(device => {

		if (device && device.client) {

			// If once manually authorized
			if (device.client.refresh_token) {

				// Fetch new tokens
				device.client.refreshAccessToken();
			}
		}
	});
}

/**
 * Start fetching data for all devices,
 * and look for updated values.
 */
function fetchAndUpdateData() {

	// Loop over the devices
	devices.forEach(device => {

		console.log(`Toon: fetch and update data for ${devices.length} devices`);

		if (device && device.client) {

			// Fetch new status
			device.client.getStatus((err, result) => {

				console.log("Toon: get status:");
				console.log(result);

				if (!err && result) {

					console.log("Toon: found new data, updating");

					// Format values
					result.currentSetpoint = Math.round((result.currentSetpoint / 100) * 10) / 10;
					result.currentTemp = Math.round((result.currentTemp / 100) * 10) / 10;

					// If updated temperature is not equal to prev temperature
					if (device.state.target_temperature && result.currentSetpoint != device.state.target_temperature) {

						console.log("Toon: emit realtime target_temperature event: " + result.currentSetpoint);

						// Do a realtime update
						module.exports.realtime(device.data, "target_temperature", result.currentSetpoint);
					}

					// And store updated value
					device.state.target_temperature = result.currentSetpoint;

					// If updated temperature is not equal to prev temperature
					if (device.state.measure_temperature && result.currentTemp != device.state.measure_temperature) {

						console.log("Toon: emit realtime measure_temperature event: " + result.currentTemp);

						// Do a realtime update
						module.exports.realtime(device.data, "measure_temperature", result.currentTemp);
					}

					// And store updated value
					device.state.measure_temperature = result.currentTemp;
				} else {
					console.log("Toon: no new data found");
				}
			});
		}
	});
}

/**
 * Register webhook and listen for
 * calls to it.
 */
function listenForEvents() {

	// Register webhook
	// TODO use webhook registered under info@athom.com
	Homey.manager('cloud').registerWebhook(Homey.env.TOON_WEBHOOK_ID, Homey.env.TOON_WEBHOOK_SECRET, {}, (data) => {
			//TODO handle incoming event with updated data store it in this
			console.log("Incoming data")
			console.log(data.body.updateDataSet);

		},
		(err, result) => {
			if (err) console.log("Toon: failed to setup webhook");
			else if (result) console.log("Toon: succes setting up webhook");
		}
	);
}

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
					client.setAgreement(data.agreementId, function () {

						// Store constructed device
						devices.push({
							name: "Toon",
							data: {
								id: device_data.id
							},
							state: {},
							client: client
						});

						// Set available again
						module.exports.setAvailable(device_data);

						// Start fetching and updating data
						fetchAndUpdateData();

						// Subscribe to events from toon
						client._basePOST("pushEvent", {
							"callbackUrl": Homey.env.TOON_WEBHOOK_URL,
							"applicationId": Homey.env.TOON_KEY
						}, function (err, result) {
							if (err) console.log("pushEvent failed to register");
							else if (result) console.log('pushEvent registered');
						});

						// TODO add insights logging for electicity and gas usage
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
					});
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