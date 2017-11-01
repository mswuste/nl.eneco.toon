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

		process.on('unhandledRejection', r => this.error(r.stack));

		this.log('init ToonDevice');

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

		// Set agreement and then continue with fetching data
		await this.setAgreement();
		await this.getTemperatureData();
		await this.getGasUsageCumulative(this.getSetting('meter_gas_from_time'));
		await this.getMeterPowerCumulative(this.getSetting('meter_power_from_time'));
	}

	/**
	 * Create an epoch timestamp in ms from last midnight.
	 * @returns {number}
	 */
	get currentDayStartTimestamp() {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}

	/**
	 * Create an epoch timestamp in ms from the start of the current month.
	 * @returns {number}
	 */
	get currentMonthStartTimestamp() {
		const date = new Date();
		const d = new Date(date.getFullYear(), date.getMonth(), 1);
		return d.getTime();
	}

	/**
	 * Create an epoch timestamp in ms from the start of the current year.
	 * @returns {number}
	 */
	get currentYearStartTimestamp() {
		const d = new Date(new Date().getFullYear(), 0, 1);
		return d.getTime();
	}

	/**
	 * Convert user setting to epoch timestamp in ms.
	 * @param {string} input - ['day', 'month', 'year']
	 * @returns {number}
	 */
	convertSettingToTimestamp(input) {
		switch (input) {
			case 'day':
				return this.currentDayStartTimestamp;
			case 'month':
				return this.currentMonthStartTimestamp;
			case 'year':
				return this.currentYearStartTimestamp;
			default:
				this.log('warning invalid setting value provided, use default day timestamp', input);
				return this.currentDayStartTimestamp;
		}
	}

	/**
	 * Parse incoming gas/electricity data.
	 * @param data
	 */
	parseData(data = {}) {
		if (data.hasOwnProperty('hours') && Array.isArray(data.hours)) {

			// Sort array from most recent to oldest
			data.hours = data.hours.sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);

			// Calculate appropriate units
			for (let entry of data.hours) {

				// TODO remove this
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

				// TODO remove this
				delete entry.timestamp;
			}
		}
		return data;
	}

	/**
	 * This method performs an API call to retrieve the measure_power data. It will update the capability if a new data
	 * entry is received, this is matched on timestamp.
	 * @returns {Promise.<*>}
	 */
	async getElectricityFlows() {
		let electricityFlows = await this.apiCallGet({ uri: `consumption/electricity/flows` });
		electricityFlows = this.parseData(electricityFlows);

		this.log(`getElectricityFlows() -> processing ${electricityFlows.hours.length} items`);

		if (electricityFlows && Array.isArray(electricityFlows.hours)) {
			if (electricityFlows.hours[0].timestamp > this.electricityFlowTimestamp ||
				typeof this.electricityFlowTimestamp === 'undefined') {

				this.setCapabilityValue('measure_power', electricityFlows.hours[0].value);
				this.log(`getElectricityFlows() -> update measure_power to ${electricityFlows.hours[0].value}`);
			}

			// Update last known timestamp
			this.electricityFlowTimestamp = electricityFlows.hours[0].timestamp;
		}
		return electricityFlows;
	}

	/**
	 * This method performs an API call to retrieve the meter_power data. It will calculate the cumulative value based
	 * on historical data (max one year back, approx. 10000 items).
	 * @param {number} fromTime - Timestamp in epoch ms.
	 * @param {number} toTime - Timestamp in epoch ms.
	 * @returns {Promise.<number>}
	 */
	async getMeterPowerCumulative(fromTime = this.currentDayStartTimestamp, toTime = (new Date).getTime()) {
		this.log(`getMeterPowerCumulative() -> ${fromTime}`);

		// Determine fromTime from settings
		fromTime = this.convertSettingToTimestamp(fromTime);

		// Retrieve and parse electricity data
		let electricityData = await this.apiCallGet({ uri: `consumption/electricity/data?fromTime=${fromTime}&toTime=${toTime}` });
		electricityData = this.parseData(electricityData);
		if (!electricityData || !Array.isArray(electricityData.hours)) return null;

		this.log(`getMeterPowerCumulative() -> processing ${electricityData.hours.length} items`);
		this.log(electricityData.hours.splice(0, 10));

		// Add all historical values
		let meterPowerCumulative = electricityData.hours.reduce((a, b) => a + b.value, 0);
		this.log(`getMeterPowerCumulative() -> update meter_power to ${meterPowerCumulative}`);

		// Explicitly destroy data object as it can be very large
		electricityData = null;

		// Update capability
		this.setCapabilityValue('meter_power', meterPowerCumulative);
		return meterPowerCumulative;
	}

	/**
	 * This method performs an API call to retrieve the meter_gas data. It will calculate the cumulative value based
	 * on historical data (max one year back, approx. 10000 items).
	 * @param {number} fromTime - Timestamp in epoch ms.
	 * @param {number} toTime - Timestamp in epoch ms.
	 * @returns {Promise.<number>}
	 */
	async getGasUsageCumulative(fromTime = this.currentDayStartTimestamp, toTime = (new Date).getTime()) {
		this.log(`getGasUsageCumulative() -> ${fromTime}`);

		// Determine fromTime from settings
		fromTime = this.convertSettingToTimestamp(fromTime);

		// Retrieve and parse gas usage data
		let gasUsageData = await this.apiCallGet({ uri: `consumption/gas/flows?fromTime=${fromTime}&toTime=${toTime}` });
		gasUsageData = this.parseData(gasUsageData);
		if (!gasUsageData || !Array.isArray(gasUsageData.hours)) return null;

		this.log(`getGasUsageCumulative() -> processing ${gasUsageData.hours.length} items`);
		this.log(gasUsageData.hours.splice(0, 10));

		// Add all historical values
		let gasMeterCumulative = gasUsageData.hours.reduce((a, b) => a + b.value, 0);
		this.log(`getGasUsageCumulative() -> update meter_gas to ${gasMeterCumulative}`);

		// Explicitly destroy data object as it can be very large
		gasUsageData = null;

		// Update capability
		this.setCapabilityValue('meter_gas', gasMeterCumulative);
		return gasMeterCumulative;
	}

	/**
	 * Register several polling intervals.
	 */
	async registerPollIntervals() {

		// target_temperature & measure_temperature
		this.registerPollInterval({
			id: 'temperatureData',
			fn: this.getTemperatureData.bind(this),
			interval: 30000, // every 30 sec
		});

		// meter_gas
		this.registerPollInterval({
			id: 'gasFlow',
			fn: () => {
				return this.getGasUsageCumulative(this.getSetting('meter_gas_from_time'));
			},
			interval: 60 * 60 * 1000, // every hour
		});

		// meter_power
		this.registerPollInterval({
			id: 'electricityData',
			fn: () => {
				return this.getMeterPowerCumulative(this.getSetting('meter_power_from_time'));
			},
			interval: 60 * 60 * 1000, // every hour
		});

		// measure_power
		this.registerPollInterval({
			id: 'electricityFlow',
			fn: this.getElectricityFlows.bind(this),
			interval: 5 * 60 * 1000, // every 5 minutes
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
	 * This method will be called when a setting was changed by the user. It will then update the meter_power and
	 * meter_gas cumulative periods accordingly.
	 * @param oldSettingsObj
	 * @param newSettingsObj
	 * @param changedKeysArr
	 * @returns {Promise.<T>}
	 */
	async onSettings(oldSettingsObj, newSettingsObj, changedKeysArr = []) {
		if (changedKeysArr.includes('meter_power_from_time')) {
			this.getMeterPowerCumulative(newSettingsObj['meter_power_from_time']);
		}
		if (changedKeysArr.includes('meter_gas_from_time')) {
			this.getGasUsageCumulative(newSettingsObj['meter_gas_from_time']);
		}

		return Promise.resolve();
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
