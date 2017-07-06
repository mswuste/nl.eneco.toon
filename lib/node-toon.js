'use strict';

const EventEmitter = require('events').EventEmitter;

const _ = require('underscore');
const PromiseQueue = require('promise-queue');
const request = require('request-promise-native');

const apiBaseUrl = 'https://api.toonapi.com/toon/api/v1/';

class Toon extends EventEmitter {

	/**
	 * Toon constructor, provide the API key and secret.
	 * @constructor
	 */
	constructor(options) {
		super();

		options = options || {};

		// Store key and secret for authorization later on
		this._oauth2Account = options.oauth2Account;
		this._logMethod = options.log;
		this._errorLogMethod = options.log;

		// Defaults
		this.targetTemperature = undefined;
		this.measureTemperature = undefined;
		this.meterGas = undefined;
		this.meterPower = undefined;
		this.temperatureState = undefined;
		this.offline = undefined;

		// States map
		this.states = {
			comfort: 0,
			home: 1,
			sleep: 2,
			away: 3,
			none: -1,
		};

		this.promiseQueue = new PromiseQueue(); // Default concurrency of 1


		// Hijack log method
		this.log = function () {
			const args = Array.prototype.slice.call(arguments);
			args.unshift('[node-toon]');
			this._logMethod.apply(null, args);
		};

		// Hijack log method
		this.error = function () {
			const args = Array.prototype.slice.call(arguments);
			args.unshift('[node-toon]');
			this._errorLogMethod.apply(null, args);
		};

		this.log('new Toon constructed');
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

		this.log(`set state to ${state} (${this.states[state]}), body:${JSON.stringify(body)}`);

		return this._put('temperature/states', body);
	}

	/**
	 * Enable the temperature program.
	 * @returns {*}
	 */
	enableProgram() {

		this.log('enable program');

		return this._put('temperature/states', {
			state: 1,
		});
	}

	/**
	 * Disable the temperature program.
	 * @returns {*}
	 */
	disableProgram() {

		this.log('disable program');

		return this._put('temperature/states', {
			state: 0,
		});
	}

	/**
	 * Destroy client, clean up.
	 */
	destroy() {
		return new Promise(resolve => {
			this.log('client destroyed');
			return resolve();
		});
	}

	/**
	 * Queries the Toon API for the display status.
	 * @param retry {Bool}
	 */
	getStatus(retry) {
		return new Promise((resolve, reject) => {

			this.log('get status');

			let initialized = false;
			this._get('status', retry)
				.then(result => {

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
						if (typeof result.thermostatInfo.currentTemp !== 'undefined') {
							this.log('store currentTemp', Math.round((result.thermostatInfo.currentTemp / 100) * 10) / 10);
							this.emit('measureTemperature', Math.round((result.thermostatInfo.currentTemp / 100) * 10) / 10);

							this.measureTemperature = Math.round((result.thermostatInfo.currentTemp / 100) * 10) / 10;
						}

						if (typeof result.thermostatInfo.currentSetpoint !== 'undefined') {
							this.log('store currentSetpoint', Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10);
							this.emit('targetTemperature', Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10);

							this.targetTemperature = Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10;
						}

						if (typeof result.thermostatInfo.activeState !== 'undefined') {
							this.emit('temperatureState', Object.keys(this.states).filter(key => this.states[key] === result.thermostatInfo.activeState)[0]);
							this.temperatureState = Object.keys(this.states).filter(key => this.states[key] === result.thermostatInfo.activeState)[0];
						}
					} else this.log('no new temperature data available');
				})
				.then(this.getConsumptionElectricity.bind(this))
				.then(electricity => {
					if (typeof electricity !== 'undefined') {
						this.log('store electricity', electricity);
						this.emit('measurePower', electricity);
						this.measurePower = electricity;
					} else this.log('no new electricity data available');
				})
				.then(this.getConsumptionGas.bind(this))
				.then(gas => {
					if (typeof gas !== 'undefined') {
						this.log('store gas', gas);
						this.emit('meterGas', gas);
						this.meterGas = gas;
					} else this.log('no new gas data available');
				})
				.then(() => {
					this.log('get status complete');

					if (initialized) this.emit('initialized', this);

					return resolve({
						measureTemperature: this.measureTemperature,
						targetTemperature: this.targetTemperature,
						meterPower: this.meterPower,
						meterGas: this.meterGas,
						temperatureState: this.temperatureState,
					});
				})
				.catch(err => {
					this.log('failed to get status, electricity or gas', err.stack);
					return reject(err);
				});
		});
	}

	/**
	 * PUTs to the Toon API to set a new target temperature
	 * @param temperature temperature attribute of type integer.
	 */
	setTargetTemperature(temperature) {
		return new Promise((resolve, reject) => {

			if (!temperature) {
				this.error('no temperature provided');
				return reject(new Error('missing_temperature_argument'));
			}

			this.log(`set target temperature to ${temperature}`);

			this._put('temperature', { value: temperature * 100 }).then(() => {
				this.log(`success setting temperature to ${temperature}`);
				this.targetTemperature = temperature;
				return resolve(temperature);
			}).catch(err => {
				this.error(`failed to set temperature to ${temperature}`, err.stack);
			});
		});
	}

	/**
	 * Queries the Toon API for the electricity consumption.
	 */
	getConsumptionElectricity() {
		return new Promise(resolve => {
			this._get('consumption/electricity/flows')
				.then(result => {
					if (result && result.hours) {
						const latest = _.max(result.hours, entry => entry.timestamp);
						if (!latest) return resolve();
						if (typeof latest.value !== 'undefined') {
							if (latest.value < 0) latest.value = 0;
							return resolve(latest.value);
						}
						return resolve();
					}
					return resolve();
				})
				.catch(err => {
					this.error('error getConsumptionElectricity', err.stack);
					return resolve();
				});
		});
	}

	/**
	 * Queries the Toon API for the gas consumption.
	 */
	getConsumptionGas() {
		return new Promise(resolve => {
			this._get('consumption/gas/flows')
				.then(result => {
					if (result && result.hours) {
						const latest = _.max(result.hours, entry => entry.timestamp);
						if (!latest) return resolve();
						if (typeof latest.value !== 'undefined') {
							if (latest.value < 0) latest.value = 0;
							return resolve(latest.value / 1000);
						}
						return resolve();
					}
					return resolve();
				})
				.catch(err => {
					this.error('error getConsumptionGas', err.stack);
					return resolve();
				});
		});
	}

	/**
	 * Fetches all agreements from the API, if there are more
	 * than one, the user may choose one.
	 */
	getAgreements() {
		return new Promise((resolve, reject) => {
			this.log('get agreements');

			this._get('agreements')
				.then(agreements => {
					if (agreements) {
						this.log(`got ${agreements.length} agreements`);
						return resolve(agreements);
					}
					this.error('failed to get agreements');
					return reject(new Error('failed_to_get_arguments'));
				})
				.catch(err => {
					this.error('failed to get agreements', err.stack);
					return reject(err);
				});
		});
	}

	/**
	 * Selects an agreement and registers it to this
	 * Toon object, this is a connection to the device.
	 * @param agreementId
	 */
	setAgreement(agreementId, retry) {
		return new Promise((resolve, reject) => {

			this.agreementId = agreementId;

			if (!agreementId) {
				this.error('no agreementId provided');
				return reject(new Error('missing agreementId argument'));
			}

			this.log(`set agreement ${agreementId}`);

			// Make the request to set agreement
			this._post('agreements', { agreementId }, retry)
				.then(result => {
					this.log('successful post of agreement');

					// Fetch initial data
					this.getStatus(retry)
						.then(() => resolve(result))
						.catch(err => reject(err));
				})
				.catch(err => {
					this.error('failed to post agreement', err.stack);
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
	_put(command, body, retry) {
		if (!command) return Promise.reject(new Error('missing_command_argument'));
		if (!body) return Promise.reject(new Error('missing_body_argument'));
		if (!this._oauth2Account.accessToken) return Promise.reject(new Error('missing_access_token'));

		// Perform the request, if it fails retry (max three times)
		return this._request({
			url: `${apiBaseUrl}${command}`,
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${this._oauth2Account.accessToken}`,
				Accept: 'application/json',
			},
			json: body,
			allowRetry: retry,
		});
	}

	/**
	 * Convenience method that provides a basic GET
	 * to the Toon API.
	 * @param command Desired command to be GET
	 * @private
	 */
	_get(command, retry) {
		if (!command) return Promise.reject(new Error('missing_command_argument'));
		if (!this._oauth2Account.accessToken) return Promise.reject(new Error('missing_access_token'));

		// Perform the request, if it fails retry (max three times)
		return this._request({
			url: `${apiBaseUrl}${command}`,
			json: true,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${this._oauth2Account.accessToken}`,
				Accept: 'application/json',
			},
			allowRetry: retry,
		});
	}

	/**
	 * Convenience method that provides a basic POST
	 * to the Toon API.
	 * @param command Desired command to be POST
	 * @param data Data to POST
	 * @private
	 */
	_post(command, data, retry) {
		if (!command) return Promise.reject(new Error('missing_command_argument'));
		if (!data) return Promise.reject(new Error('missing_body_argument'));
		if (!this._oauth2Account.accessToken) return Promise.reject(new Error('missing_access_token_argument'));

		// Perform the request, if it fails retry (max three times)
		return this._request({
			url: `${apiBaseUrl}${command}`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this._oauth2Account.accessToken}`,
				Accept: 'application/json',
			},
			json: data,
			allowRetry: retry,
		});
	}

	/**
	 * Mark device as online.
	 * @private
	 */
	_markAsOnline() {
		this.offline = false;
		this.log('device back online');
		this.emit('online');
	}

	/**
	 * Mark device as offline.
	 * @private
	 */
	_markAsOffline() {
		this.offline = true;
		this.log('communicationError received, device offline');
		this.emit('offline');
	}

	/**
	 * Method that will check if an Authorization property is present
	 * and if so update it if the access token is not the most recent.
	 * @param options
	 * @returns {*}
	 * @private
	 */
	_updateAccessTokenInRequestObject(options) {
		if (options && options.hasOwnProperty('headers') && options.headers.hasOwnProperty('Authorization')
			&& options.headers['Authorization'] !== `Bearer ${this._oauth2Account.accessToken}`) {
			options.headers['Authorization'] = `Bearer ${this._oauth2Account.accessToken}`;
		}
		return options;
	}

	/**
	 * Convenience method that performs a request to
	 * the Toon API, using the options provided in the
	 * parameter options.
	 * @param options Request options
	 * @private
	 */
	_request(options) {
		if (!options) return Promise.reject(new Error('missing_options_argument'));
		if (typeof options.allowRetry === 'undefined') options.allowRetry = true;

		return new Promise((resolve, reject) => {

			// Add it to the promiseQueue to prevent multiple simultaneous calls
			this.promiseQueue.add(() => {
				// Update authorization token if previous request has refreshed it
				options = this._updateAccessTokenInRequestObject(options);
				return request(options);
			})
				.then(response => {
					this.log('request success');
					if (typeof response !== 'undefined' && this.offline) this._markAsOnline();
					return resolve(response);
				})
				.catch(error => {

					// Create ToonAPIError
					const toonAPIError = new ToonAPIError(JSON.stringify(error.error), {
						statusCode: error.statusCode || error.code,
						requestOptions: options,
						errorObject: error.error,
					});

					this.error('request error', toonAPIError);

					if (options.allowRetry) {
						this._handleRequestError(toonAPIError)
							.then(result => {
								this.log('request error handling succeeded');
								return resolve(result);
							})
							.catch(err => {
								this.error('request error handling failed');
								return reject(err);
							});
					} else {
						this.error('request error handling failed, no retry allowed');
						return reject(toonAPIError);
					}
				});
		});
	}

	/**
	 *
	 * @param error
	 * @returns {Promise}
	 * @private
	 */
	_handleRequestError(error) {
		this.log('_handleRequestError', error);

		return new Promise((resolve, reject) => {
			switch (error.statusCode) {
				case 401:
					// Make sure to retry only once to avoid loops
					if (error.requestOptions.allowRetry) {
						error.requestOptions.allowRetry = false;

						this.log('_handleRequestError() -> 401-> unauthorized, refresh access tokens');

						// Refresh, if succeeded then
						return this._oauth2Account.refreshAccessTokens()
							.then(() => {

								this.log('_handleRequestError() -> 401 -> refreshed tokens, retry request');

								// Update authorization header
								error.requestOptions = this._updateAccessTokenInRequestObject(error.requestOptions);
								error.requestOptions.allowRetry = false;

								// After successful refresh, retry request once
								return this._request(error.requestOptions)
									.then(resolve)
									.catch(reject);
							})
							.catch(err => {
								this.error('_handleRequestError() -> 401 -> refreshAccessToken failed', err);
								return reject(err);
							});
					}
					return reject(error);

				case 429:
					this.log('_handleRequestError() -> 429 -> too many request, abort queue');

					// Clear remaining queue
					this.promiseQueue.abort();

					// Reject
					return reject(error);
				case 500:
					// Handle offline device
					if (error.errorObject.type === 'communicationError' || error.errorObject.errorCode === 'communicationError') {

						this.log('_handleRequestError() -> 500 -> device is offline');

						this._markAsOffline();

						// Device is offline no need to retry
						return reject(error);
					}

					// Make sure to retry only once to avoid loops
					if (error.requestOptions.allowRetry) {
						error.requestOptions.allowRetry = false;

						this.log('_handleRequestError() -> 500 -> agreement not set, set agreement');

						// Agreement might have expired, try to reset once
						return this.setAgreement(this.agreementId, false)
							.then(() => {
								this.log('_handleRequestError() -> 500 -> success set agreement, retry request');

								// After successful refresh, retry request once
								return this._request(error.requestOptions)
									.then(resolve)
									.catch(reject);

							})
							.catch(err => {
								this.error('_handleRequestError() -> 500 -> setAgreement failed', err);
								return reject(err);
							});
					}
					return reject(error);
				default:
					return reject(error);
			}
		});
	}
}

module.exports = Toon;

class ToonAPIError extends Error {
	constructor(message, options) {
		super(message);
		this.requestOptions = options.requestOptions || {};
		this.errorObject = options.errorObject || {};
		if (options && options.hasOwnProperty('statusCode')) {
			this.statusCode = options.statusCode;
		}
		this.message = message;
		this.name = 'ToonAPIError';
	}
}
