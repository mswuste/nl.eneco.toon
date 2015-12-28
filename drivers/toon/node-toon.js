var EventEmitter = require('events').EventEmitter;
var util = require('util');
var request = require("request");

function Toon(key, secret) {
	EventEmitter.call(this);

	this.access_token = null;
	this.refresh_token = null;
	this.key = key;
	this.secret = secret;
};
util.inherits(Toon, EventEmitter);

Toon.prototype.authorized = function () {
	return !!this.access_token;
};
Toon.prototype.getStatus = function (callback) {
	this.baseGET("status", function (err, result) {
		if (callback) callback(err, result.thermostatInfo)
	})
};
Toon.prototype.setTemperature = function (data, callback) {
	this.basePUT("temperature", {"value": data.temperature, "scale": "celcius"}, function (err, result) {
		if (callback) callback(err, result)
	})
};
Toon.prototype.getTemperaturePrograms = function (callback) {
	this.baseGET("temperature/programs", function (err, result) {
		if (callback) callback(err, result)
	})
};
Toon.prototype.getTargetTemperature = function (callback) {
	//TODO refactor once GET temperature is implemented in Toon API
	this.baseGET("status", function (err, result) {
		if (callback) callback(err, result.thermostatInfo.currentSetpoint)
	})
};
Toon.prototype.getMeasureTemperature = function (callback) {
	//TODO refactor once GET temperature is implemented in Toon API
	this.baseGET("status", function (err, result) {
		if (callback) callback(err, result.thermostatInfo.currentTemp)
	})
};
Toon.prototype.authorize = function (username, password, callback) {
	var querystring = require("querystring"),
		btoa = require("btoa"),
		https = require("https");

	var postData = querystring.stringify({
		"username": username,
		"password": password,
		"grant_type": "password"
	});

	var options = {
		host: "api.toonapi.com",
		port: 443,
		path: "/token",
		method: "POST",
		"rejectUnauthorized": false,
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"Content-Length": Buffer.byteLength(postData),
			"Authorization": "Basic " + btoa(this.key + ":" + this.secret)
		}
	};

	// Make new token request
	var tokenRequest = https.request(options, function (response) {
		response.setEncoding("utf8");
		var res = '';
		response.on('data', function (chunk) {
			res += chunk;
		});

		response.on('end', function () {
			res = JSON.parse(res);

			if (res.access_token != null) {
				this.access_token = res.access_token;
				this.refresh_token = res.refresh_token;
				if (callback)callback(null, {access_token: res.access_token, refresh_token: res.refresh_token});
			}
			else {
				if (callback)callback(true, null);
			}
		}.bind(this));
	}.bind(this));

	// Handle error
	tokenRequest.on("error", function (e) {
		if (callback)callback(e.message, null);
	});

	tokenRequest.write(postData);
	tokenRequest.end();
};

Toon.prototype.basePUT = function (command, body, callback) {
	// Configure the request
	var options = {
		url: 'https://api.toonapi.com/toon/api/v1/' + command,
		method: 'PUT',
		"rejectUnauthorized": false,
		headers: {
			"authorization": "Bearer " + this.access_token,
			"Accept": "application/json"
		},
		json: body
	};
	performRequest(options, callback);
};

Toon.prototype.baseGET = function (command, callback) {
	// Configure the request
	var options = {
		url: 'https://api.toonapi.com/toon/api/v1/' + command,
		method: 'GET',
		"rejectUnauthorized": false,
		headers: {
			"Authorization": "Bearer " + this.access_token,
			"Accept": "application/json"
		}
	};
	performRequest(options, callback);
};

function performRequest(options, callback) {
	// Start the request
	request(options, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var result = (body) ? JSON.parse(body) : true;
			if (callback) callback(error, result);
		}
		else {
			if (callback) callback((error || response.statusCode), response);
		}
	})
}

module.exports = Toon;
