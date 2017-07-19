'use strict';

const Homey = require('homey');
const _ = require('underscore');
const OAuth2Device = require('homey-wifidriver').OAuth2Device;

// States map
const states = {
	comfort: 0,
	home: 1,
	sleep: 2,
	away: 3,
	none: -1,
};

class ToonDevice extends OAuth2Device {

	/**
	 * This method will be called when a new device has been added
	 * or when the driver reboots with installed devices. It creates
	 * a new ToonAPI client and sets the correct agreement.
	 */
	async onInit() {
		await super.onInit({
			apiBaseUrl: 'https://api.toonapi.com/toon/api/v1/',
			throttle: 200,
			rateLimit: {
				max: 15,
				per: 60000,
			},
		}).catch(err => {
			this.error('Error onInit', err.stack);
			return err;
		});

		this.log('init ToonDevice');

		this.setUnavailable(Homey.__('connecting'));

		// Migrate access token
		this.migrateToSDKv2();

		// Register capability listeners
		this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
		this.registerCapabilityListener('temperature_state', this.onCapabilityTemperatureState.bind(this));

		// Initialize this ToonDevice, if it fails start back off strategy which retries until resolved
		this.registerBackOffStrategy({
			id: 'initialisation',
			onBackOffReady: this.initialize.bind(this),
			initialDelay: 15000,
			maxDelay: 15 * 60 * 1000,
			startImmediately: true,
		});
	}

	/**
	 * Call serveral async methods that will initialize this device.
	 * @returns {Promise}
	 */
	async initialize() {
		await this.setAgreement();
		await this.getTemperatureData();
		await this.registerPollIntervals();
	}

	/**
	 * Register several polling intervals.
	 */
	registerPollIntervals() {
		this.registerPollInterval({
			id: 'temperatureData',
			fn: this.getTemperatureData.bind(this),
			interval: 30000, // 30 sec
		});

		// this.registerPollInterval({
		// 	id: 'getGasData',
		// 	fn: this.getGasData.bind(this),
		// 	interval: 300000, // 5 min
		// });
		//
		// this.registerPollInterval({
		// 	id: 'getElectricityData',
		// 	fn: this.getElectricityData().bind(this),
		// 	interval: 300000, // 5 min
		// });
	}

	/**
	 * Migrate access tokens from SDKv1 format to SDKv2 format
	 */
	migrateToSDKv2() {
		// Migration from pre-apps sdk v2
		if (Homey.ManagerSettings.get(`toon_${this.getData().id}_access_token`) &&
			Homey.ManagerSettings.get(`toon_${this.getData().id}_refresh_token`)) {
			this.oauth2Account.setTokens({
				accessToken: Homey.ManagerSettings.get(`toon_${this.getData().id}_access_token`),
				refreshToken: Homey.ManagerSettings.get(`toon_${this.getData().id}_refresh_token`),
				expiresIn: new Date(), // Expire date not known, refresh now
			});
			setTimeout(() => {
				Homey.ManagerSettings.unset(`toon_${this.getData().id}_access_token`);
				Homey.ManagerSettings.unset(`toon_${this.getData().id}_refresh_token`);
			}, 5000);
		}
	}

	/**
	 * This method will be called when the device has been deleted, it makes
	 * sure the client is properly destroyed and left over settings are removed.
	 */
	onDeleted() {
		this.log('onDeleted()');

		// Delete used account
		this.getDriver().oauth2Client.deleteAccount(this.oauth2Account);
		super.onDeleted();
	}

	/**
	 * This method will be called when the target temperature needs to be changed.
	 * @param temperature
	 * @param options
	 * @returns {Promise}
	 */
	onCapabilityTargetTemperature(temperature, options) {
		this.log('onCapabilityTargetTemperature()', 'temperature:', temperature, 'options:', options);
		return this.setTargetTemperature(Math.round(temperature * 2) / 2);
	}

	/**
	 * This method will be called when the temperature state needs to be changed.
	 * @param state
	 * @param resumeProgram Abort or resume program
	 * @returns {Promise}
	 */
	onCapabilityTemperatureState(state, resumeProgram) {
		this.log('onCapabilityTemperatureState()', 'state:', state, 'resumeProgram:', resumeProgram);
		return this.updateState(state, resumeProgram);
	}

	/**
	 * This method will retrieve temperature, gas and electricity data from the Toon API.
	 * @returns {Promise}
	 */
	getTemperatureData() {
		let initialized = false;
		return this.apiCallGet({
			uri: 'status',
		})
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
						this.measureTemperature = Math.round((result.thermostatInfo.currentTemp / 100) * 10) / 10;
						this.log('measure_temperature', this.measureTemperature);
						this.setCapabilityValue('measure_temperature', this.measureTemperature);
					}

					if (typeof result.thermostatInfo.currentSetpoint !== 'undefined') {
						this.targetTemperature = Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10;
						this.log('target_temperature', this.targetTemperature);
						this.setCapabilityValue('target_temperature', this.targetTemperature);
					}

					if (typeof result.thermostatInfo.activeState !== 'undefined') {
						this.temperatureState = Object.keys(states).filter(key => states[key] === result.thermostatInfo.activeState)[0];
						this.log('temperature_state', this.temperatureState)
						this.setCapabilityValue('temperature_state', this.temperatureState);
					}
				} else this.log('no new temperature data available');
			})
			.then(() => {
				this.log('get status complete');

				if (initialized) this.setAvailable();

				return {
					measureTemperature: this.measureTemperature,
					targetTemperature: this.targetTemperature,
					meterPower: this.meterPower,
					meterGas: this.meterGas,
					temperatureState: this.temperatureState,
				};
			})
			.catch(err => {
				this.log('failed to get temperature data', err.stack);
				throw err;
			});
	}

	getElectricityData() {
		return this.getConsumptionElectricity()
			.then(electricity => {
				if (typeof electricity !== 'undefined') {
					this.log('measure_power', electricity);
					this.measurePower = electricity;
					this.setCapabilityValue('measure_power', electricity);
				} else this.log('no new electricity data available');
			})
			.catch(err => {
				this.log('failed to get electricity data', err.stack);
				throw err;
			});
	}

	getGasData() {
		return this.getConsumptionGas()
			.then(gas => {
				if (typeof gas !== 'undefined') {
					this.log('meter_gas', gas);
					this.meterGas = gas;
					this.setCapabilityValue('meter_gas', gas);
				} else this.log('no new gas data available');
			})
			.catch(err => {
				this.log('failed to get gas data', err.stack);
				throw err;
			});
	}

	/**
	 * Set the state of the device, overrides the program.
	 * @param state ['away', 'home', 'sleep', ['comfort']
	 * @param keepProgram - if true program will resume after state change
	 */
	updateState(state, keepProgram) {

		const data = { temperatureState: states[state] };

		if (keepProgram) data.state = 2;

		this.log(`set state to ${state} (${states[state]}), data:${JSON.stringify(data)}`);

		return this.apiCallPut({ uri: 'temperature/states' }, data);
	}

	/**
	 * Enable the temperature program.
	 * @returns {*}
	 */
	enableProgram() {
		this.log('enable program');

		return this.apiCallPut({ uri: 'temperature/states' }, { state: 1 });
	}

	/**
	 * Disable the temperature program.
	 * @returns {*}
	 */
	disableProgram() {
		this.log('disable program');

		return this.apiCallPut({ uri: 'temperature/states' }, { state: 0 });
	}

	/**
	 * PUTs to the Toon API to set a new target temperature
	 * @param temperature temperature attribute of type integer.
	 */
	setTargetTemperature(temperature) {
		this.log(`set target temperature to ${temperature}`);

		if (!temperature) {
			this.error('no temperature provided');
			return Promise.reject(new Error('missing_temperature_argument'));
		}

		return this.apiCallPut({ uri: 'temperature' }, { value: temperature * 100 })
			.then(() => {
				this.log(`success setting temperature to ${temperature}`);
				this.targetTemperature = temperature;
				return temperature;
			}).catch(err => {
				this.error(`failed to set temperature to ${temperature}`, err.stack);
				throw err;
			});
	}

	/**
	 * Queries the Toon API for the electricity consumption.
	 */
	getConsumptionElectricity() {
		this.log('get consumption electricity');

		return this.apiCallGet({ uri: 'consumption/electricity/flows' })
			.then(result => {
				if (result && result.hours) {
					const latest = _.max(result.hours, entry => entry.timestamp);
					if (!latest) return null;
					if (typeof latest.value !== 'undefined') {
						if (latest.value < 0) latest.value = 0;
						return latest.value;
					}
					return null;
				}
				return null;
			})
			.catch(err => {
				this.error('error getConsumptionElectricity', err.stack);
				throw err;
			});
	}

	/**
	 * Queries the Toon API for the gas consumption.
	 */
	getConsumptionGas() {
		this.log('get consumption gas');

		return this.apiCallGet({ uri: 'consumption/gas/flows' })
			.then(result => {
				if (result && result.hours) {
					const latest = _.max(result.hours, entry => entry.timestamp);
					if (!latest) return null;
					if (typeof latest.value !== 'undefined') {
						if (latest.value < 0) latest.value = 0;
						return latest.value / 1000;
					}
					return null;
				}
				return null;
			})
			.catch(err => {
				this.error('error getConsumptionGas', err.stack);
				return null;
			});
	}

	/**
	 * Fetches all agreements from the API, if there are more
	 * than one, the user may choose one.
	 */
	getAgreements() {
		this.log('get agreements');

		return this.apiCallGet({ uri: 'agreements' })
			.then(agreements => {
				if (agreements) {
					this.log(`got ${agreements.length} agreements`);
					return agreements;
				}
				this.error('failed to get agreements');
				throw new Error('failed_to_get_arguments');
			})
			.catch(err => {
				this.error('failed to get agreements', err.stack);
				throw err;
			});
	}

	/**
	 * Selects an agreement and registers it to this
	 * Toon object, this is a connection to the device.
	 * @returns {*}
	 */
	setAgreement(retryOnFail = false) {
		this.log(`set agreement ${this.getData().agreementId} (retryOnFail: ${retryOnFail})`);

		if (!this.getData().agreementId) {
			this.error('no agreementId found');
			return Promise.reject(new Error('missing agreementId argument'));
		}

		// Make the request to set agreement
		return this.apiCallPost({
			uri: 'agreements',
			retryOnFail: retryOnFail
		}, { agreementId: this.getData().agreementId })
			.then(result => {
				this.log('successful post of agreement');

				// Fetch initial data
				this.getTemperatureData()
					.then(() => result)
					.catch(err => {
						throw err;
					});
			})
			.catch(err => {
				this.error('failed to post agreement', err.stack);
				throw err;
			});
	}

	/**
	 * Response handler middleware, which will be called on each successful API request.
	 * @param res
	 * @returns {*}
	 */
	webAPIResponseHandler(res) {
		// Mark device as available after being unavailable
		if (this.getAvailable() === false) this.setAvailable();
		return res;
	}

	/**
	 * Response handler middleware, which will be called on each failed API request.
	 * @param err
	 * @returns {*}
	 */
	webAPIErrorHandler(err) {
		this.error('webAPIErrorHandler', err);

		// Detect error that is returned when Toon is offline
		if (err.name === 'WebAPIServerError' && err.statusCode === 500) {

			if (err.errorResponse.type === 'communicationError' || err.errorResponse.errorCode === 'communicationError') {
				return this.setUnavailable(Homey.__('offline'))
					.then(() => Promise.reject('device_offline'));
			}

			this.log('webAPIErrorHandler -> retry setAgreement');

			// Set agreement and retry failed request
			return this.setAgreement()
				.then(() => this.apiCall(err.requestOptions))
				.then(() => this.log('set agreement and retry succeeded'))
				.catch(err => {
					this.error('set agreement succeeded retry failed', err)
					throw err;
				});

		}
		throw err;
	}
}

module.exports = ToonDevice;
