'use strict';

const Homey = require('homey');
const ToonAPI = require('./../../lib/node-toon');


class ToonDevice extends Homey.HomeyDevice {

	onInit() {
		this.log('onInit()');
		this.initialized = false;

		this.setUnavailable(Homey.__('connecting'));
		this.toonAPI = new ToonAPI({ key: Homey.env.TOON_KEY, secret: Homey.env.TOON_SECRET, polling: true });

		// Retrieve access tokens from memory
		this.getAccessTokensFromMemory();
		this.bindEventListeners();
		this.promiseRetry(3, this.setAgreement.bind(this))
			.then(() => {
				this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
				this.registerCapabilityListener('temperature_state', this.onCapabilityTemperatureState.bind(this));
				this.initialized = true;
			})
			.catch(err => {
				this.error(err.stack);
				this.setUnavailable(Homey.__('initialization_error', {error: err.message}));
			});
	}

	/**
	 * This method will be called when the device has been deleted, it makes
	 * sure the client is properly destroyed and left over settings are removed.
	 */
	onDeleted() {
		this.log('onDeleted()');
		Homey.HomeyManagerSettings.unset(`toon_${this._data.id}_access_token`);
		Homey.HomeyManagerSettings.unset(`toon_${this._data.id}_refresh_token`);
		this.toonAPI.destroy();
	}

	/**
	 * This method will be called when the target temperature needs to be changed.
	 * @param temperature
	 * @param options
	 * @returns {Promise}
	 */
	onCapabilityTargetTemperature(temperature, options) {
		this.log(`onCapabilityTargetTemperature()`, 'temperature:', temperature, 'options:', options);
		return this.toonAPI.setTargetTemperature(Math.round(temperature * 2) / 2);
	}

	/**
	 * This method will be called when the temperature state needs to be changed.
	 * @param state
	 * @param resume Abort or resume program
	 * @returns {Promise}
	 */
	onCapabilityTemperatureState(state, resume) {
		this.log('onCapabilityTemperatureState()', 'state:', state);
		return this.toonAPI.updateState(state, (resume === false) ? false : true);
	}

	/**
	 * Check if access tokens are stored in memory,
	 * if so retrieve them and store them in the toonAPI instance.
	 */
	getAccessTokensFromMemory() {
		this.log('getAccessTokensFromMemory()');

		// Retrieve access tokens from memory
		if (Homey.HomeyManagerSettings.get(`toon_${this._data.id}_access_token`)) {
			this.toonAPI.accessToken = Homey.HomeyManagerSettings.get(`toon_${this._data.id}_access_token`);
		} else {
			this.error(`getAccessTokensFromMemory() -> could not find accessToken for id: ${this._data.id}`);
		}

		if (Homey.HomeyManagerSettings.get(`toon_${this._data.id}_refresh_token`)) {
			this.toonAPI.refreshToken = Homey.HomeyManagerSettings.get(`toon_${this._data.id}_refresh_token`);
		} else {
			this.error(`getAccessTokensFromMemory() -> could not find refreshToken for id: ${this._data.id}`);
		}
	}

	/**
	 * Set agreement, retries every 15 seconds
	 * if it fails, with 3 maximum number of retries.
	 */
	setAgreement() {
		this.log('setAgreement()', this._data.agreementId);
		return new Promise((resolve, reject) => {

			// Store newly set agreement
			this.toonAPI.setAgreement(this._data.agreementId).then(() => {
				return resolve();
			}).catch(err => {
				this.error(`setAgreement() failed, retrying...`, err.stack);
				return reject(new Error(`failed_to_set_agreement`));
			});
		});
	}

	/**
	 * Wrapper function that enables promise retrying.
	 * @param maxRetries
	 * @param promise
	 * @returns {*}
	 */
	promiseRetry(maxRetries, promise) {
		let p = promise();
		for (let i = 0; i < maxRetries; i++) {
			p = p.catch(promise);
		}
		return p;
	}

	/**
	 * This method will bind several listeners to the ToonAPI instance.
	 */
	bindEventListeners() {
		this.toonAPI
			.on('refreshed', tokens => {
				this.log('tokens are refreshed');
				// Store access token in settings
				Homey.HomeyManagerSettings.set(`toon_${this._data.id}_access_token`, tokens.access_token);
				Homey.HomeyManagerSettings.set(`toon_${this._data.id}_refresh_token`, tokens.refresh_token);
			})
			.on('initialized', data => {
				this.log('all data received');
				this.setCapabilityValue('target_temperature', data['targetTemperature']);
				this.setCapabilityValue('measure_temperature', data['measureTemperature']);
				this.setCapabilityValue('meter_gas', data['meterGas']);
				this.setCapabilityValue('meter_power', data['meterPower']);
				this.setCapabilityValue('temperature_state', data['temperatureState']);

				this.setAvailable();
			})
			.on('measureTemperature', measureTemperature => {
				this.log('new measureTemperature', measureTemperature);
				this.setCapabilityValue('measure_temperature', measureTemperature)
			})
			.on('targetTemperature', targetTemperature => {
				this.log('new targetTemperature', targetTemperature);
				this.setCapabilityValue('target_temperature', targetTemperature)
			})
			.on('meterGas', meterGas => {
				this.log('new meterGas', meterGas);
				this.setCapabilityValue('meter_gas', meterGas)
			})
			.on('meterPower', meterPower => {
				this.log('new meterPower', meterPower);
				this.setCapabilityValue('meter_power', meterPower)
			})
			.on('temperatureState', temperatureState => {
				this.log('new temperatureState', temperatureState);
				this.setCapabilityValue('temperature_state', temperatureState)
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
			})
			.on('unauthenticated', () => {
				this.log('unauthenticated event received');
				this.setUnavailable(Homey.__('unauthenticated')).catch(err => this.error('could not setUnavailable()', err));
			});
	}
}

module.exports = ToonDevice;