'use strict';

const Homey = require('homey');
const OAuth2Device = require('homey-wifidriver').OAuth2Device;
const ToonAPI = require('./../../lib/node-toon');

class ToonDevice extends OAuth2Device {

	/**
	 * This method will be called when a new device has been added
	 * or when the driver reboots with installed devices. It creates
	 * a new ToonAPI client and sets the correct agreement.
	 */
	onInit() {
		this.log('onInit()');

		this.initialized = false;

		this.setUnavailable(Homey.__('connecting'));

		// Construct Toon API object
		this.toonAPI = new ToonAPI({
			oauth2Account: this.getOAuth2Account(),
			polling: true,
			log: this.log,
			error: this.error,
		});

		// Register status poll interval
		this.registerPollInterval({
			id: 'status',
			fn: this.toonAPI.getStatus.bind(this.toonAPI),
			interval: 30000,
		});

		this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
		this.registerCapabilityListener('temperature_state', this.onCapabilityTemperatureState.bind(this));

		this.bindEventListeners();
		this.setAgreement()
			.then(() => {
				this.initialized = true;
			})
			.catch(err => {
				this.error(err.stack);
			});
	}

	/**
	 * This method will be called when the device has been deleted, it makes
	 * sure the client is properly destroyed and left over settings are removed.
	 */
	onDeleted() {
		this.log('onDeleted()');
		this.toonAPI.destroy();
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
		return this.toonAPI.setTargetTemperature(Math.round(temperature * 2) / 2);
	}

	/**
	 * This method will be called when the temperature state needs to be changed.
	 * @param state
	 * @param resumeProgram Abort or resume program
	 * @returns {Promise}
	 */
	onCapabilityTemperatureState(state, resumeProgram) {
		this.log('onCapabilityTemperatureState()', 'state:', state, 'resumeProgram:', resumeProgram);
		return this.toonAPI.updateState(state, resumeProgram);
	}

	/**
	 * Set agreement, retries every 15 seconds
	 * if it fails, with 3 maximum number of retries.
	 */
	setAgreement() {
		this.log('setAgreement()', this.getData().agreementId);
		return new Promise((resolve, reject) => {

			// Store newly set agreement
			this.toonAPI.setAgreement(this.getData().agreementId)
				.then(resolve)
				.catch(err => {
					this.error('setAgreement() failed', err.stack);
					return reject(new Error('failed_to_set_agreement'));
				});
		});
	}

	/**
	 * This method will bind several listeners to the ToonAPI instance.
	 */
	bindEventListeners() {
		this.toonAPI
			.on('initialized', data => {
				this.log('all data received');
				this.setCapabilityValue('target_temperature', data.targetTemperature);
				this.setCapabilityValue('measure_temperature', data.measureTemperature);
				this.setCapabilityValue('meter_gas', data.meterGas);
				this.setCapabilityValue('meter_power', data.meterPower);
				this.setCapabilityValue('temperature_state', data.temperatureState);

				this.setAvailable();
			})
			.on('measureTemperature', measureTemperature => {
				this.log('new measureTemperature', measureTemperature);
				this.setCapabilityValue('measure_temperature', measureTemperature);
			})
			.on('targetTemperature', targetTemperature => {
				this.log('new targetTemperature', targetTemperature);
				this.setCapabilityValue('target_temperature', targetTemperature);
			})
			.on('meterGas', meterGas => {
				this.log('new meterGas', meterGas);
				this.setCapabilityValue('meter_gas', meterGas);
			})
			.on('measurePower', measurePower => {
				this.log('new measurePower', measurePower);
				this.setCapabilityValue('measure_power', measurePower);
			})
			.on('temperatureState', temperatureState => {
				this.log('new temperatureState', temperatureState);
				this.setCapabilityValue('temperature_state', temperatureState);
			})
			.on('offline', () => {
				this.log('offline event received');
				this.setUnavailable(Homey.__('offline')).catch(err => this.error('could not setUnavailable()', err));
			})
			.on('online', () => {
				this.log('online event received');
				// If device was initialized while not online, retry again when online
				if (!this.initialized) this.onInit();
				this.setAvailable().catch(err => this.error('could not setAvailable()', err));
			});
	}
}

module.exports = ToonDevice;
