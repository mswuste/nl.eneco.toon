'use strict';

const Homey = require('homey');

const ToonDevice = require('./device.js');
const WifiDriver = require('homey-wifidriver').Driver;
const ToonAPI = require('./../../lib/node-toon');

const oauth2ClientConfig = {
	url: `https://api.toonapi.com/authorize?response_type=code&client_id=${Homey.env.TOON_KEY}&redirect_uri=https://callback.athom.com/oauth2/callback/`,
	tokenEndpoint: 'https://api.toonapi.com/token',
	key: Homey.env.TOON_KEY,
	secret: Homey.env.TOON_SECRET,
	allowMultipleAccounts: false,
};

class ToonDriver extends WifiDriver {

	/**
	 * This method will be called when the driver initializes, it initializes Flow Cards.
	 */
	onInit() {

		// Start OAuth2Client
		super.onInit({
			oauth2ClientConfig,
		});

		new Homey.FlowCardCondition('temperature_state_is')
			.on('run', (args, state, callback) => {
				const temperatureState = args.device.getCapabilityValue('temperature_state');
				return callback(null, temperatureState === args.state);
			})
			.register();

		new Homey.FlowCardAction('set_temperature_state')
			.on('run', (args, state, callback) =>
				args.device.onCapabilityTemperatureState(args.state, (args.resume_program === 'yes'))
					.then(() => callback(null, true))
					.catch(err => callback(err)))
			.register();

		new Homey.FlowCardAction('enable_program')
			.on('run', (args, state, callback) => args.device.toonAPI.enableProgram()
				.then(() => callback(null, true))
				.catch(err => callback(err)))
			.register();

		new Homey.FlowCardAction('disable_program')
			.on('run', (args, state, callback) => args.device.toonAPI.disableProgram()
				.then(() => callback(null, true))
				.catch(err => callback(err)))
			.register();

		this.log('onInit() -> complete, Flow Cards registered');
	}

	/**
	 * The method will be called during pairing when a list of devices is needed. Only when this class
	 * extends WifiDriver and provides a oauth2ClientConfig onInit. The data parameter contains an
	 * temporary OAuth2 account that can be used to fetch the devices from the users account.
	 * @param data {Object}
	 * @returns {Promise}
	 */
	onPairOAuth2ListDevices(data) {

		// Create temporary toonAPI client with temporary account
		const authenticationClientToonAPI = new ToonAPI({
			oauth2Account: data.oauth2Account,
			log: this.log,
			error: this.error,
		});

		// Return promise that fetches devices from account
		return this.fetchDevices(authenticationClientToonAPI, data)
			.then(tempDevices => {
				authenticationClientToonAPI.destroy();
				return tempDevices;
			})
			.catch(err => this.error(err.stack));
	}

	/**
	 * Always use ToonDevice as device for this driver.
	 * @returns {ToonDevice}
	 */
	mapDeviceClass() {
		return ToonDevice;
	}

	/**
	 * This method will be called during pairing to retrieve a list of devices
	 * connected to the user's account.
	 * @param authenticationClientToonAPI
	 * @returns {Promise}
	 */
	fetchDevices(authenticationClientToonAPI, data) {
		return authenticationClientToonAPI.getAgreements().then(agreements => {
			if (Array.isArray(agreements)) {
				return agreements.map(agreement => ({
					name: (agreements.length > 1) ? `Toon®: ${agreement.street} 
												${agreement.houseNumber} , ${agreement.postalCode} 
												${agreement.city.charAt(0)}${agreement.city.slice(1).toLowerCase()}` : 'Toon®',
					data: {
						id: agreement.displayCommonName,
						agreementId: agreement.agreementId,
					},
					store: {
						tempOAuth2Account: Object.assign({
							accessToken: data.oauth2Account.accessToken,
							refreshToken: data.oauth2Account.refreshToken,
							// id: <insert_username>, // Add a id property if you know this device is from a different account and if multiple accounts are allowed
						}, oauth2ClientConfig),
					},
				}));
			}
			return [];
		});
	}
}

module.exports = ToonDriver;
