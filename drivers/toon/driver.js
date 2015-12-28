var _ = require("underscore");
var Toon = require('./node-toon');

var devices = [];
var temp_device = null;

var credentials = {
	username: "",
	password: ""
};
var toon = null;
/**
 * Find Toon
 * @param devices (already installed)
 * @param callback
 */
module.exports.init = function (devices_data, callback) {

	// Ready
	callback(true);
};

/**
 * Pairing process that calls list_devices when in need of all available Toon devices,
 * here the devices array is built and send to the front-end
 */
module.exports.pair = function (socket) {

	socket.on("store_credentials", function (data, callback) {
		credentials.password = data.password;
		credentials.username = data.username;
		callback(null, credentials);
	});

	socket.on("get_toon", function (data, callback) {
		toon = new Toon(Homey.env.credentials.key, Homey.env.credentials.secret);
		toon.authorize(credentials.username, credentials.password, function () {
			if (toon.authorized()) {
				toon.getStatus(function (err, result) {
					temp_device = {
						name: "Toon",
						data: {
							id: result.randomConfigId
						}
					};
					callback(null, temp_device);
				});
			} else {
				callback(null, null);
			}
		});
	})
};

/**
 * These represent the capabilities of Toon
 */
module.exports.capabilities = {};

/**
 * Delete devices internally when users removes one
 * @param device_data
 */
module.exports.deleted = function (device_data) {

};

