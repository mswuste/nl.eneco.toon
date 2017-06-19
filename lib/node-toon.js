'use strict';

const _ = require('underscore');
const request = require('request-promise-native');
const EventEmitter = require('events').EventEmitter;

const PromiseQueue = require('promise-queue');

const apiBaseUrl = 'https://api.toonapi.com/toon/api/v1/';

const DEBUG = true;

class Toon extends EventEmitter {

	/**
	 * Toon constructor, provide the API key and secret.
	 * @constructor
	 */
	constructor(options) {
		super();

		options = options || {};

		if (!options.key) {
			this._error('no client key provided');
			return new Error('missing_client_key_argument');
		}
		if (!options.secret) {
			this._error('no client secret provided');
			return new Error('missing_client_secret_argument');
		}

		// Store key and secret for authorization later on
		this.key = options.key;
		this.secret = options.secret;

		// Defaults
		this.targetTemperature = undefined;
		this.measureTemperature = undefined;
		this.meterGas = undefined;
		this.meterPower = undefined;
		this.temperatureState = undefined;
		this.offline = undefined;
		this.refreshPromises = [];
		this.refreshPromise = undefined;

		// States map
		this.states = {
			comfort: 0,
			home: 1,
			sleep: 2,
			away: 3,
			none: -1,
		};

		// Create fields for the access tokens
		this.accessToken = new Buffer(`${this.key}:${this.secret}`).toString('base64');
		this.refreshToken = undefined;

		this.promiseQueue = new PromiseQueue(); // Default concurrency of 1

		if (!this.pollInterval && options.polling) {
			this.pollInterval = setInterval(() => {
				this.getStatus();
			}, 30000);
		}

		this._debug('new Toon constructed');
	}

	/**
	 * Set the state of the device, overrides the program.
	 * @param state ['away', 'home', 'sleep', ['comfort']
	 */
	updateState(state, keepProgram) {

		const body = {
			temperatureState: this.states[state],
		};

		if (keepProgram) body.state = 2;

		this._debug(`set state to ${state} (${this.states[state]}), body:${JSON.stringify(body)}`);

		return this._put('temperature/states', body);
	}

	/**
	 * Enable the temperature program.
	 * @returns {*}
	 */
	enableProgram() {

		this._debug('enable program');

		return this._put('temperature/states', {
			state: 1,
		});
	}

	/**
	 * Disable the temperature program.
	 * @returns {*}
	 */
	disableProgram() {

		this._debug('disable program');

		return this._put('temperature/states', {
			state: 0,
		});
	}

	/**
	 * Destroy client, clean up.
	 */
	destroy() {
		return new Promise((resolve, reject) => {
			clearInterval(this.pollInterval);
			this._debug('client destroyed');
			return resolve();
		});
	}

	/**
	 * Queries the Toon API for the display status.
	 */
	getStatus() {
		return new Promise((resolve, reject) => {
			this._debug('get status');

			this._get('status').then(result => {
				let initialized = false;

				// If no data available, this is probably the first time
				if (typeof this.measureTemperature === 'undefined'
					&& typeof this.targetTemperature === 'undefined'
					&& typeof this.meterPower === 'undefined'
					&& typeof this.meterGas === 'undefined') {
					initialized = true;
				}

				// Check for temperature data
				if (result && result.thermostatInfo) {

					// Store new values
					if (result.thermostatInfo.currentTemp) {
						this._debug('store currentTemp', Math.round((result.thermostatInfo.currentTemp / 100) * 10) / 10);
						this.emit('measureTemperature', Math.round((result.thermostatInfo.currentTemp / 100) * 10) / 10);

						this.measureTemperature = Math.round((result.thermostatInfo.currentTemp / 100) * 10) / 10;
					}

					if (result.thermostatInfo.currentSetpoint) {
						this._debug('store currentSetpoint', Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10);
						this.emit('targetTemperature', Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10);

						this.targetTemperature = Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10;
					}

					if (result.thermostatInfo.activeState || result.thermostatInfo.activeState === -1) {
						this.emit('temperatureState', Object.keys(this.states).filter(key => this.states[key] === result.thermostatInfo.activeState)[0]);
						this.temperatureState = Object.keys(this.states).filter(key => this.states[key] === result.thermostatInfo.activeState)[0];
					}
				} else this._debug('no new temperature data available');

				this._debug('get status complete');

				if (initialized) this.emit('initialized', this);

				return resolve({
					measureTemperature: this.measureTemperature,
					targetTemperature: this.targetTemperature,
					meterPower: this.meterPower,
					meterGas: this.meterGas,
					temperatureState: this.temperatureState,
				});
			}).catch(err => {
				this._debug('failed to get status, electricity or gas', err.stack);
				return reject(err);
			});
		});
	}

	/**
	 * PUTs to the Toon API to set a new target temperature
	 * @param temperature temperature attribute of type integer.
	 */
	setTargetTemperature(temperature, preventRetry) {
		return new Promise((resolve, reject) => {

			if (!temperature) {
				this._error('no temperature provided');
				return reject(new Error('missing_temperature_argument'));
			}

			this._debug(`set target temperature to ${temperature}`);

			this._put('temperature', { value: temperature * 100 }).then(() => {
				this._debug(`success setting temperature to ${temperature}`);
				this.targetTemperature = temperature;
				return resolve(temperature);
			}).catch(err => {
				this._error(`failed to set temperature to ${temperature}`, err.stack);

				if (!preventRetry) {

					// Retry in 3 seconds without retry to prevent loop
					setTimeout(() => {
						this.setTargetTemperature(temperature, true)
							.then(temperatureRetry => resolve(temperatureRetry))
							.catch(err => reject(err));
					}, 3000);
				}
			});
		});
	}

	/**
	 * Queries the Toon API for the electricity consumption.
	 * TODO only use peak? What is it?
	 */
	getConsumptionElectricity() {
		return new Promise(resolve => {
			this._get('consumption/electricity/data')
				.then(result => {
					if (result && result.hours) {
						const latest = _.max(result.hours, entry => entry.timestamp);
						if (!latest) return resolve();
						if (typeof latest.peak !== 'undefined') {
							return resolve(latest.peak / 1000);
						}
						return resolve();
					}
					return resolve();
				})
				.catch(err => {
					this._error('error getConsumptionElectricity', err.stack);
					return resolve();
				});
		});
	}

	/**
	 * Queries the Toon API for the gas consumption.
	 */
	getConsumptionGas() {
		return new Promise(resolve => {
			this._get('consumption/gas/data')
				.then(result => {
					if (result && result.hours) {
						const latest = _.max(result.hours, entry => entry.timestamp);
						if (!latest) return resolve();
						if (typeof latest.value !== 'undefined') {
							return resolve(latest.value / 1000);
						}
						return resolve();
					}
					return resolve();
				})
				.catch(err => {
					this._error('error getConsumptionGas', err.stack);
					return resolve();
				});
		});
	}

	/**
	 * Fetches all agreements from the API, if there are more
	 * than one, the user may choose one.
	 */
	getAgreements(stop) {
		return new Promise((resolve, reject) => {
			this._debug('get agreements');

			this._get('agreements').then(agreements => {
				if (agreements) {

					this._debug(`got ${agreements.length} agreements`);

					return resolve(agreements);
				}

				// Check if allowed to retry
				if (!stop) {

					// Try fetching agreements again
					this.getAgreements(true)
						.then(result => resolve(result))
						.catch(err => reject(err));

				} else {
					this._error('failed to get agreements');
					return reject(new Error('failed_to_get_arguments'));
				}
			}).catch(err => {
				this._error('failed to get agreements', err.stack);
				return reject(err);
			});
		});
	}

	/**
	 * Selects an agreement and registers it to this
	 * Toon object, this is a connection to the device.
	 * @param agreementId
	 */
	setAgreement(agreementId) {
		return new Promise((resolve, reject) => {

			this.agreementId = agreementId;

			if (!agreementId) {
				this._error('no agreementId provided');
				return reject(new Error('missing agreementId argument'));
			}

			this._debug(`set agreement ${agreementId}`);

			// Make the request to set agreement
			this._post('agreements', { agreementId }).then(result => {
				this._debug('successful post of agreement');

				// Fetch initial data
				this.getStatus()
					.then(() => resolve(result))
					.catch(err => reject(err));
			}).catch(err => {
				this._error('failed to post agreement', err.stack);
				return reject(err);
			});
		});
	}

	/**
	 * Fetches an access token from the Toon API using the
	 * Athom callback service (redirect uri).
	 * @param code
	 * @param redirectUri
	 */
	getAccessTokens(code, redirectUri) {
		return new Promise((resolve, reject) => {

			if (!redirectUri) {
				this._error('no redirectUri provided when getting access tokens');
				return reject(new Error('missing_redirectUri_argument'));
			}

			if (!code) {
				this._error('no code provided when getting access tokens');
				return reject(new Error('missing_code_argument'));
			}

			// Request accessToken
			this._request({
				url: 'https://api.toonapi.com/token',
				method: 'POST',
				json: true,
				form: {
					grant_type: 'authorization_code',
					client_id: this.key,
					client_secret: this.secret,
					redirect_uri: redirectUri,
					code,
				},
			}).then(body => {

				// Check for invalid body
				if (!body || !body.hasOwnProperty('access_token') || !body.hasOwnProperty('refresh_token')) {
					this._error('error fetching access tokens');
					return reject(new ToonAPIError('incomplete_tokens_object_retrieved'));
				}

				this._debug('fetched new access tokens');

				// Store new tokens
				this.accessToken = body.access_token;
				this.refreshToken = body.refresh_token;

				// Emit refreshed event
				this.emit('refreshed', { access_token: this.accessToken, refresh_token: this.refreshToken });

				// Callback new tokens
				return resolve({
					access_token: body.access_token,
					refresh_token: body.refresh_token,
				});
			}).catch(err => reject(err));
		});
	}

	/**
	 * Uses the refresh token to fetch a new access token,
	 * stores all new tokens internally.
	 * @private
	 */
	refreshAccessToken() {

		// Already refresh promise pending
		if (this.refreshPromise) {

			// Create and return substitute promise
			return new Promise((resolve, reject) => {

				// Store it for later access
				this.refreshPromises.push({ resolve, reject });
			});
		}

		return new Promise((resolve, reject) => {

			if (!this.refreshToken) {
				this._error('no refreshToken provided');
				return reject(new Error('missing_refresh_token'));
			}

			this._debug('perform refresh request');

			this.refreshPromise = this._request({
				url: 'https://api.toonapi.com/token',
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				form: {
					client_secret: this.secret,
					client_id: this.key,
					grant_type: 'refresh_token',
					refresh_token: this.refreshToken,
				},
			}).then(body => {

				// Check for invalid body
				if (!body || !body.hasOwnProperty('access_token') || !body.hasOwnProperty('refresh_token')) {
					this._debug('error fetching refreshed tokens');
					return reject(new ToonAPIError('invalid_tokens_object_received'));
				}

				this._debug('fetched new access tokens');

				// Store new tokens
				this.accessToken = body.access_token;
				this.refreshToken = body.refresh_token;

				// Emit refreshed event
				this.emit('refreshed', { access_token: this.accessToken, refresh_token: this.refreshToken });

				// Resolve all queued promises
				this.refreshPromises.forEach(promise => {
					promise.resolve({
						access_token: body.access_token,
						refresh_token: body.refresh_token,
					});
				});

				// Reset this promise to open for new requests
				this.refreshPromise = null;

				// Callback new tokens
				return resolve({
					access_token: body.access_token,
					refresh_token: body.refresh_token,
				});

			}).catch(err => {

				// Resolve all queued promises
				this.refreshPromises.forEach(promise => {
					promise.reject(err);
				});

				// Reset this promise to open for new requests
				this.refreshPromise = null;
				return reject(err);
			});
		});
	}

	/**
	 * Convenience method that provides a basic PUT
	 * to the Toon API.
	 * @param command Desired command to be PUT
	 * @param body Data to be updated
	 * @private
	 */
	_put(command, body) {
		if (!command) return Promise.reject(new Error('missing_command_argument'));
		if (!body) return Promise.reject(new Error('missing_body_argument'));
		if (!this.accessToken) return Promise.reject(new Error('missing_access_token'));

		// Perform the request, if it fails retry (max three times)
		return this._request({
			url: `${apiBaseUrl}${command}`,
			method: 'PUT',
			headers: {
				authorization: `Bearer ${this.accessToken}`,
				Accept: 'application/json',
			},
			json: body,
		});
	}

	/**
	 * Convenience method that provides a basic GET
	 * to the Toon API.
	 * @param command Desired command to be GET
	 * @private
	 */
	_get(command) {
		if (!command) return Promise.reject(new Error('missing_command_argument'));
		if (!this.accessToken) return Promise.reject(new Error('missing_access_token'));

		// Perform the request, if it fails retry (max three times)
		return this._request({
			url: `${apiBaseUrl}${command}`,
			json: true,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: 'application/json',
			},
		});
	}

	/**
	 * Convenience method that provides a basic POST
	 * to the Toon API.
	 * @param command Desired command to be POST
	 * @param data Data to POST
	 * @private
	 */
	_post(command, data) {
		if (!command) return Promise.reject(new Error('missing_command_argument'));
		if (!data) return Promise.reject(new Error('missing_body_argument'));
		if (!this.accessToken) return Promise.reject(new Error('missing_access_token_argument'));

		// Perform the request, if it fails retry (max three times)
		return this._request({
			url: `${apiBaseUrl}${command}`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: 'application/json',
			},
			json: data,
		});
	}

	/**
	 * Mark device as online.
	 * @private
	 */
	_markAsOnline() {
		this.offline = false;
		this._debug('device back online');
		this.emit('online');
	}

	/**
	 * Mark device as offline.
	 * @private
	 */
	_markAsOffline() {
		this.offline = true;
		this._debug('communicationError received, device offline');
		this.emit('offline');
	}

	/**
	 * Convenience method that performs a request to
	 * the Toon api, using the options provided in the
	 * parameter options.
	 * @param options Request options
	 * @private
	 */
	_request(options) {
		if (!options) return Promise.reject(new Error('missing_options_argument'));

		return new Promise((resolve, reject) => {

			// Add it to the promiseQueue to prevent multiple simultaneous calls
			this.promiseQueue.add(() => request(options))
				.then(response => {
					this._debug('success response', response);
					if (typeof response !== 'undefined' && this.offline) this._markAsOnline()
					return resolve(response);
				})
				.catch(this._handleRequestError.bind(this))
				.catch(err => {
					// Error handler could not solve the error
					this._error('failed to handle error', err.stack);
					return reject(err);
				});
		});
	}

	/**
	 * Error handler, will parse the provided error object
	 * and determine whether it is a server or client error
	 * and act accordingly. This method will return a rejected
	 * Promise or throw an Error if it failed to recognize or handle
	 * the Error. It will resolve when the Error handler did its job
	 * and it is safe to retry the request.
	 * @param error
	 * @returns {Mixed}
	 * @private
	 */
	_handleRequestError(error) {

		this._error('error response');
		this._error(error.statusCode, error.stack);
		const statusCode = error.statusCode;
		const errorObject = error.error;
		errorObject.statusCode = statusCode;

		// Client error
		if (statusCode >= 400 && statusCode < 500) {
			return this._handleClientRequestError(errorObject);

		} // Server error
		else if (statusCode >= 500) {
			return this._handleServerRequestError(errorObject);
		}

		throw new ToonAPIError(errorObject.message, { statusCode: errorObject.statusCode });
	}

	_handleClientRequestError(error) {
		return new Promise((resolve, reject) => {

			// Unauthorized
			if (error.statusCode === 401) {

				// Refresh, if succeeded then
				this.refreshAccessToken()
					.then(() => resolve(new ToonAPIError(error, { statusCode: error.statusCode })))
					.catch(err => reject(err));
			} else if (error.statusCode === 429) { // Too many requests
				// TODO clear queue, abort requests and wait
				this.promiseQueue.abort();
				// setTimeout(() => {
				return reject(new ToonAPIError(error, { statusCode: error.statusCode }));
				// }, 10000);
			}

			// Could not handle this error
			return reject(new ToonAPIError(error, { statusCode: error.statusCode }));
		});
	}


	_handleServerRequestError(error) {
		return new Promise((resolve, reject) => {

			// Internal server error
			if (error.statusCode === 500) {

				// Handle offline device
				if (error.type === 'communicationError' || error.errorCode === 'communicationError') {
					this._markAsOffline();

					// Device is offline no need to retry
					return reject(new ToonAPIError(error.message, { statusCode: error.statusCode }));
				}

				// Agreement might have expired, try to reset once
				this.setAgreement(this.agreementId)
					.then(() => resolve(new ToonAPIError(error, { statusCode: error.statusCode })))
					.catch(err => reject(err));
			}

			// Could not handle this error
			return reject(new ToonAPIError(error, { statusCode: error.statusCode }));
		});
	}

	/**
	 * Debug method that will enable logging when
	 * debug: true is provided in the main options
	 * object.
	 * @private
	 */
	_debug() {
		if (DEBUG) {
			const args = Array.prototype.slice.call(arguments);
			args.unshift(Toon.logTime(), '[dbg] node-toon:');
			console.log.apply(null, args);
		}
	}

	/**
	 * Error method that will enable logging when
	 * debug: true is provided in the main options
	 * object.
	 * @private
	 */
	_error() {
		if (DEBUG) {
			const args = Array.prototype.slice.call(arguments);
			args.unshift(Toon.logTime(), '[err] node-toon:');
			console.error.apply(null, args);
		}
	}

	/**
	 * Log time method for debug logging.
	 * @returns {string}
	 */
	static logTime() {
		const date = new Date();
		let mm = date.getMonth() + 1;
		mm = (mm < 10 ? `0${mm}` : mm);
		let dd = date.getDate();
		dd = (dd < 10 ? `0${dd}` : dd);
		let hh = date.getHours();
		hh = (hh < 10 ? `0${hh}` : hh);
		let min = date.getMinutes();
		min = (min < 10 ? `0${min}` : min);
		let sec = date.getSeconds();
		sec = (sec < 10 ? `0${sec}` : sec);
		return `${date.getFullYear()}-${mm}-${dd} ${hh}:${min}:${sec}`;
	}
}

module.exports = Toon;

class ToonAPIError extends Error {
	constructor(message, options) {
		super(message);
		if (options && options.hasOwnProperty('statusCode')) this.message = `HTTP(${options.statusCode}), ${message}`;
		else this.message = message;
		this.name = 'ToonAPIError';
	}
}
