'use strict';

const Homey = require('homey');
const _ = require('underscore');
const OAuth2Device = require('homey-wifidriver').OAuth2Device;

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

		// TODO make this resetable by user (on interval?)
		this.meterPowerCummulative = 0;
		this.meterGasCummulative = 0;

		// Keep track of temperature states
		this.temperatureStatesMap = {
			comfort: { id: 0, temperature: 20, },
			home: { id: 1, temperature: 18, },
			sleep: { id: 2, temperature: 15, },
			away: { id: 3, temperature: 12, },
			none: { id: -1, }
		};

		this.setUnavailable(Homey.__('connecting'));

		this.migrateToSDKv2();

		this.registerPollIntervals();
		this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
		this.registerCapabilityListener('temperature_state', this.onCapabilityTemperatureState.bind(this));

		this.setAgreement()
			.then(this.getTemperatureData.bind(this))
			.catch(err => {
				this.error(err.stack);
			});
	}

	/**
	 * Parse incoming gas/electricity data
	 * @param data
	 */
	parseData(data) {
		if (data.hasOwnProperty('hours') && Array.isArray(data.hours)) {
			data.hours = data.hours.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
			for (let entry of data.hours) {
				entry.date = new Date(entry.timestamp).toString();
				if (entry.unit === 'l') {
					entry.value = Math.max(0, entry.value / 1000);
					entry.unit = 'm3';
				} else if (entry.unit === 'lh') {
					entry.value = Math.max(0, entry.value / 1000);
					entry.unit = 'm3h';
				} else if (entry.unit === 'W') {
					entry.value = Math.max(0, entry.value);
				} else if (entry.unit === 'Wh') {
					entry.value = Math.max(0, entry.peak / 1000);
					entry.unit = 'kWh';
				}
				delete entry.timestamp;
			}
			data.hours = data.hours.reverse();
		}
	}

	/**
	 * Create an epoch timestamp in ms 2 hours back.
	 * @returns {number}
	 */
	get fromTime() {
		let fromTime = new Date();
		fromTime.setHours(fromTime.getHours() - 2);
		fromTime = fromTime.getTime();
		return fromTime;
	}

	/**
	 * Create an epoch timestamp in ms.
	 * @returns {number}
	 */
	get toTime() {
		return (new Date).getTime();
	}

	/**
	 * Register several polling intervals.
	 */
	async registerPollIntervals() {

		this.registerPollInterval({
			id: 'temperatureData',
			fn: this.getTemperatureData.bind(this),
			interval: 30000, // 30 sec
		});

		// Meter gas check
		this.registerPollInterval({
			id: 'gasFlow',
			fn: async () => {
				const gasFlows = await this.apiCallGet({ uri: `consumption/gas/flows?fromTime=${this.fromTime}&toTime=${this.toTime}` });
				this.parseData(gasFlows);

				this.log('gasFlow');
				this.log(gasFlows.hours[0]);

				if (gasFlows && Array.isArray(gasFlows.hours)) {
					if (gasFlows.hours[0].timestamp > this.gasDataTimestamp || typeof this.gasDataTimestamp === 'undefined') {
						this.meterGasCummulative = this.meterGasCummulative + gasFlows.hours[0].value;
						this.setCapabilityValue('meter_gas', this.meterGasCummulative);
						this.log('meter_gas', this.meterGasCummulative);
					}
				}
				this.gasDataTimestamp = gasFlows.hours[0].timestamp;
			},
			interval: 5 * 60 * 1000,
		});

		// Meter power check
		this.registerPollInterval({
			id: 'electricityData',
			fn: async () => {
				const electricityData = await this.apiCallGet({ uri: `consumption/electricity/data?fromTime=${this.fromTime}&toTime=${this.toTime}` });
				this.parseData(electricityData);

				this.log('electricityData');
				this.log(electricityData.hours[0]);

				if (electricityData.hours[0].timestamp > this.electricityDataTimestamp || typeof this.electricityDataTimestamp === 'undefined') {
					this.meterPowerCummulative = this.meterPowerCummulative + electricityData.hours[0].value;
					this.setCapabilityValue('meter_power', this.meterPowerCummulative);
					this.log('meter_power', this.meterPowerCummulative);
				}
				this.electricityDataTimestamp = electricityData.hours[0].timestamp;
			},
			interval: 5 * 60 * 1000,
		});


		// Measure power check
		this.registerPollInterval({
			id: 'electricityFlow',
			fn: async () => {
				const electricityFlows = await this.apiCallGet({ uri: `consumption/electricity/flows?fromTime=${this.fromTime}&toTime=${this.toTime}` });
				this.parseData(electricityFlows);

				this.log('electricityFlows');
				this.log(electricityFlows.hours[0]);

				if (electricityFlows.hours[0].timestamp > this.electricityFlowTimestamp || typeof this.electricityFlowTimestamp === 'undefined') {
					this.setCapabilityValue('measure_power', electricityFlows.hours[0].value);
					this.log('measure_power', electricityFlows.hours[0].value);
				}
				this.electricityFlowTimestamp = electricityFlows.hours[0].timestamp;
			},
			interval: 5 * 60 * 1000,
		});
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

				// Check for data
				if (result) {

					// Check for thermostat information
					if (result.thermostatInfo) {

						// Store new values
						if (typeof result.thermostatInfo.currentDisplayTemp !== 'undefined') {
							this.measureTemperature = Math.round((result.thermostatInfo.currentDisplayTemp / 100) * 10) / 10;
							// this.log('measure_temperature', this.measureTemperature);
							this.setCapabilityValue('measure_temperature', this.measureTemperature);
						}

						if (typeof result.thermostatInfo.currentSetpoint !== 'undefined') {
							this.targetTemperature = Math.round((result.thermostatInfo.currentSetpoint / 100) * 10) / 10;
							// this.log('target_temperature', this.targetTemperature);
							this.setCapabilityValue('target_temperature', this.targetTemperature);
						}

						if (typeof result.thermostatInfo.activeState !== 'undefined') {
							this.temperatureState = _.findKey(this.temperatureStatesMap, { id: result.thermostatInfo.activeState });
							// this.log('temperature_state', this.temperatureState);
							this.setCapabilityValue('temperature_state', this.temperatureState);
						}
					}

					// Check for updated thermostat states
					if (result.thermostatStates && result.thermostatStates.hasOwnProperty('state')) {

						// Update state temperature map
						const states = result.thermostatStates.state;
						for (let i in this.temperatureStatesMap) {
							const state = this.temperatureStatesMap[i];
							if (state.hasOwnProperty('temperature')) {
								state.temperature = Math.round((_.findWhere(states, { id: state.id }).tempValue / 100) * 10) / 10;
							}
						}
					}
				}
			})
			.then(() => {
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
	 * @param state ['away', 'home', 'sleep', 'comfort']
	 * @param keepProgram - if true program will resume after state change
	 */
	updateState(state, keepProgram) {

		const stateObj = this.temperatureStatesMap[state];
		const data = { temperatureState: stateObj.id };

		if (keepProgram) data.state = 2;

		this.log(`set state to ${stateObj.id} (${state}), data:${JSON.stringify(data)}`);

		// Directly update target temperature
		if (stateObj.hasOwnProperty('temperature')) {
			this.setCapabilityValue('target_temperature', stateObj.temperature);
		}

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
	setAgreement() {
		this.log(`set agreement ${this.getData().agreementId}`);

		if (!this.getData().agreementId) {
			this.error('no agreementId found');
			return Promise.reject(new Error('missing agreementId argument'));
		}

		// Make the request to set agreement
		return this.apiCallPost({ uri: 'agreements' }, { agreementId: this.getData().agreementId })
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
				return this.setUnavailable(Homey.__('offline')).catch(err => this.error('could not setUnavailable()', err));
			}

			// Set agreement and retry failed request
			return this.setAgreement(false)
				.then(() => this.apiCall(err.requestOptions))
				.then(() => this.log('set agreement and retry succeeded'))
				.catch(err => this.error('set agreement succeeded retry failed', err));
		}

		// Let OAuth2/WebAPIDevice handle the error
		super.webAPIErrorHandler(err);
	}
}

module.exports = ToonDevice;
