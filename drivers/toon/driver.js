var Toon = require('node-toon');
var devices = [];
var temp_pair_tokens = null;
var credentials = {};
var request = require("request");

/**
 * Find Toon
 * @param devices (already installed)
 * @param callback
 */
module.exports.init = function (devices_data, callback) {

	// Loop over all installed devices and add them
	for (var x = 0; x < devices_data.length; x++) {
		if (devices_data.hasOwnProperty("id")) {
			addDevice(devices_data[x]);
		}
	}

	// Add device, if not already added
	function addDevice(device_data) {
		var device = getDevice(device_data.id);
		var toon = new Toon(Homey.env.credentials.key, Homey.env.credentials.secret);
		toon.authorize(device_data.credentials.username, device_data.credentials.password, function () {
			if (!device) {
				toon.getStatus(function (err, result) {
					devices.push({
						name: "Toon",
						data: {
							id: result.randomConfigId,
							api: toon,
							credentials: credentials
						}
					});
				});
			}
		});
	};

	// Ready
	callback(true);
};

/**
 * Pairing process that calls list_devices when in need of all available Toon devices,
 * here the devices array is built and send to the front-end
 */
module.exports.pair = function (socket) {
	var toon = new Toon(Homey.env.credentials.key, Homey.env.credentials.secret);
	socket.on("start", function (data, callback) {
		temp_pair_tokens = {};
		Homey.manager('cloud').generateOAuth2Callback('https://api.toonapi.com/authorize?client_id=' + Homey.env.credentials.key + '&redirect_uri=https://callback.athom.com/oauth2/callback/&response_type=code&state=toon',

			// Before fetching authorization code
			function (err, result) {
				callback(err, result);
			},

			// After fetching authorization code
			function (err, result) {
				toon.getAccessToken(result, "https://callback.athom.com/oauth2/callback/",
					function (error, response, body) {
						var result = JSON.parse(body);
						temp_pair_tokens.access_token = result.access_token;
						temp_pair_tokens.refresh_token = result.refresh_token;
						socket.emit("authenticated", temp_pair_tokens.access_token);
					});
			}
		);
	});

	socket.on("get_toon", function (data, callback) {
		toon.authorize(credentials.username, credentials.password, function () {
			if (toon.authorized()) {
				toon.getStatus(function (err, result) {
					if (!getDevice(result.randomConfigId)) {
						var temp_device = {
							name: "Toon",
							data: {
								id: result.randomConfigId,
								api: toon,
								credentials: credentials
							}
						};
						callback(null, temp_device);
					}
					else {
						callback("already installed", getDevice(result.randomConfigId));
					}
				});
			}
			else {
				callback("not found", null);
			}
		});
	});

	socket.on("add_toon", function (device, callback) {
		devices.push(device);
	});
};

/**
 * These functions represent the capabilities of Toon
 */
module.exports.capabilities = {

	target_temperature: {

		get: function (device_data, callback) {
			if (device_data instanceof Error) return callback(device_data);

			var toon = getDevice(device_data.id);
			if (toon && toon.data.api.authorized()) {
				toon.data.api.getTargetTemperature(function (err, result) {
					callback(err, result / 100);
				});
			}
			else {
				callback("not authenticated", null);
			}
		},

		set: function (device_data, temperature, callback) {
			if (device_data instanceof Error) return callback(device_data);
			var toon = getDevice(device_data.id);
			if (toon && toon.data.api.authorized()) {
				toon.data.api.setTemperature(Math.round(temperature * 2) / 2, function (err, result) {
					callback(err, result);
				});
			}
			else {
				callback("not authenticated", null);
			}
		}
	},

	measure_temperature: {
		get: function (device_data, callback) {
			if (device_data instanceof Error) return callback(device_data);

			var toon = getDevice(device_data.id);
			if (toon && toon.data.api.authorized()) {
				toon.data.api.getMeasureTemperature(function (err, result) {
					callback(err, result / 100);
				});
			}
			else {
				callback("not authenticated", null);
			}
		}
	}
};

/**
 * Delete devices internally when users removes one
 * @param device_data
 */
module.exports.deleted = function (device_data) {

};

function getDevice(device_id) {
	for (var x = 0; x < devices.length; x++) {
		if (devices[x].data.id === device_id) {
			return devices[x];
		}
	}
};

